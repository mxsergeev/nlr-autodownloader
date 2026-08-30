import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./db.service.js";
import {
  DOWNLOADS_DIR,
  TEMP_DOWNLOADS_DIR,
  isValidPdfFile,
  sanitizeFileName,
} from "./file.service.js";
import { reconcileQueryStateInTransaction } from "./query-state.service.js";
import { metadataQueue, searchQueue, downloadQueue } from "../queue.js";
import { addMetadataJob } from "../queues/metadata.queue.js";
import { addSearchJob } from "../queues/search.queue.js";
import { addDownloadJobBulk } from "../queues/download.queue.js";

// A process that crashed can leave jobs in `active` as well as waiting or
// delayed.  No retained job is trusted during startup: recovery recreates the
// exact work implied by SQLite and the files that survived the crash.
const RETAINED_JOB_STATES = ["waiting", "active", "delayed", "prioritized", "paused"];
const METADATA_STATUSES = new Set(["pending", "fetching_metadata"]);
const SEARCH_STATUSES = new Set(["fetching_results"]);
const DOWNLOAD_STATUSES = new Set(["download_queued", "downloading"]);
const TERMINAL_STATUSES = new Set(["search_failed", "download_blocked"]);

/**
 * Reconciles persisted query state with the files that survived a process
 * restart, then recreates only the work that is still required. This function
 * is deliberately awaited by index.js before worker modules are imported.
 *
 * The database remains authoritative for logical identity. A physical file is
 * evidence of completion only when it is a valid PDF at the canonical
 * <queryId>/<itemId>.pdf path (or can be safely migrated from the old
 * title-based path).
 *
 * @param {{
 *   db?: import("@prisma/client").PrismaClient,
 *   queues?: { metadataQueue?: object, searchQueue?: object, downloadQueue?: object },
 *   enqueue?: { addMetadataJob?: Function, addSearchJob?: Function, addDownloadJobBulk?: Function },
 *   downloadsDir?: string,
 *   tempDownloadsDir?: string,
 * }} [options]
 * @returns {Promise<{ queries: number, queued: number, migrated: number }>} recovery summary
 */
export async function recoverOnStartup({
  db = prisma,
  queues = {},
  enqueue = {},
  downloadsDir = DOWNLOADS_DIR,
  tempDownloadsDir = path.join(downloadsDir, path.basename(TEMP_DOWNLOADS_DIR)),
} = {}) {
  const queueSet = {
    metadataQueue: queues.metadataQueue ?? metadataQueue,
    searchQueue: queues.searchQueue ?? searchQueue,
    downloadQueue: queues.downloadQueue ?? downloadQueue,
  };
  const enqueueFns = {
    addMetadataJob: enqueue.addMetadataJob ?? addMetadataJob,
    addSearchJob: enqueue.addSearchJob ?? addSearchJob,
    addDownloadJobBulk: enqueue.addDownloadJobBulk ?? addDownloadJobBulk,
  };

  await fs.mkdir(downloadsDir, { recursive: true, mode: 0o775 });
  await cleanTemporaryFiles(tempDownloadsDir);

  const queries = await db.query.findMany({
    include: { searchResults: true },
    orderBy: { id: "asc" },
  });
  const queryById = new Map(queries.map((query) => [Number(query.id), query]));
  // Jobs retained by Redis belong to the previous process. Remove every
  // waiting/delayed job before scheduling the deterministic recovery set. This
  // also removes jobs for deleted queries and jobs from old generations.
  await removeObsoleteJobs(queueSet);

  let migrated = 0;
  let queued = 0;

  for (const query of queries) {
    const files = await reconcileQueryFiles(query, { downloadsDir });
    migrated += files.migrated;

    const recovered = await reconcileQueryDatabase(db, query.id, files.validItemIds);
    if (!recovered) continue;

    const shouldQueue = await queueRecoveryWork(recovered, enqueueFns);
    if (shouldQueue) queued += 1;
  }

  // A directory can outlive its query after deletion. It has no logical owner
  // and must not be mistaken for work belonging to a newly created query.
  await cleanOrphanQueryDirectories(queryById, { downloadsDir, tempDownloadsDir });

  return { queries: queries.length, queued, migrated };
}

// Use the shorter name as the public entry point for callers that describe
// this operation as startup recovery rather than reconciliation.
export const recoverStartup = recoverOnStartup;

/**
 * Reconciles one query's physical files. File operations are completed before
 * the database transaction; if the process stops after a legacy rename, the
 * next startup sees the canonical file and deterministically completes it.
 *
 * @param {{ id: number, searchResults: Array<{ id: number, fileName: string }> }} query
 * @returns {Promise<{ validItemIds: Set<number>, migrated: number }>}
 */
async function reconcileQueryFiles(query, { downloadsDir = DOWNLOADS_DIR } = {}) {
  const queryDirectory = getQueryDownloadDir(downloadsDir, query.id);
  const entries = await readDirectory(queryDirectory);
  const itemsById = new Map(query.searchResults.map((item) => [Number(item.id), item]));
  const canonicalNames = new Set([...itemsById.keys()].map((id) => `${id}.pdf`));
  const validItemIds = new Set();

  // Canonical ID paths always win over title-based paths. An invalid physical
  // file is removed so a later download can atomically replace it.
  for (const [itemId] of itemsById) {
    const filePath = getDownloadedFilePath(downloadsDir, query.id, itemId);
    if (await isValidPdfFile(filePath)) {
      validItemIds.add(itemId);
    } else if (await pathExists(filePath)) {
      await fs.rm(filePath, { recursive: true, force: true });
    }
  }

  const legacyMatches = buildLegacyMatches(query.searchResults);
  let migrated = 0;

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".pdf") continue;
    if (canonicalNames.has(entry.name)) continue;

    const matches = legacyMatches.get(entry.name.toLocaleLowerCase()) ?? [];
    if (matches.length !== 1) {
      // An ambiguous title is not evidence for any row. Removing it avoids
      // repeatedly reconsidering an orphan and forces those rows to download
      // into their stable ID paths. Invalid legacy files are treated alike.
      await fs.rm(path.join(queryDirectory, entry.name), { force: true });
      continue;
    }

    const sourcePath = path.join(queryDirectory, entry.name);
    if (!(await isValidPdfFile(sourcePath))) {
      await fs.rm(sourcePath, { force: true });
      continue;
    }

    const itemId = matches[0];
    const destinationPath = getDownloadedFilePath(downloadsDir, query.id, itemId);
    if (validItemIds.has(itemId)) {
      // A canonical file is authoritative; the legacy duplicate is an orphan.
      await fs.rm(sourcePath, { force: true });
    } else {
      await atomicRename(sourcePath, destinationPath);
      validItemIds.add(itemId);
      migrated += 1;
    }
  }

  // Remove anything that is neither a valid canonical item file nor the
  // directory itself. This covers old display-name files, temp leftovers,
  // partial files, and physical files for deleted SearchResults.
  const finalEntries = await readDirectory(queryDirectory);
  const validCanonicalNames = new Set([...validItemIds].map((itemId) => `${itemId}.pdf`));
  for (const entry of finalEntries) {
    if (entry.isFile() && validCanonicalNames.has(entry.name)) continue;
    await fs.rm(path.join(queryDirectory, entry.name), { recursive: true, force: true });
  }

  return { validItemIds, migrated };
}

/**
 * Applies all child repairs and parent reconciliation in one transaction.
 * Missing files reset completed/downloading rows to pending; paused and
 * terminal rows remain untouched so recovery cannot silently resume them.
 */
async function reconcileQueryDatabase(db, queryId, validItemIds) {
  return db.$transaction(async (tx) => {
    const current = await tx.query.findUnique({
      where: { id: Number(queryId) },
      include: { searchResults: true },
    });
    if (!current) return null;

    for (const item of current.searchResults) {
      const itemId = Number(item.id);
      const hasValidFile = validItemIds.has(itemId);
      let nextStatus = item.status;

      if (hasValidFile) {
        nextStatus = "completed";
      } else if (item.status === "completed" || item.status === "downloading") {
        // A missing file after a crash means the logical completion did not
        // survive. Downloading is also reset because its worker was lost.
        nextStatus = "pending";
      }

      if (nextStatus !== item.status) {
        await tx.searchResult.update({
          where: { id: itemId },
          data: { status: nextStatus },
        });
      }
    }

    const reconciled = await reconcileQueryStateInTransaction(tx, Number(queryId), {
      allowPaused: true,
    });

    // `search_failed` is an explicit failure of the metadata/search stage,
    // rather than a derived download state. Keep it retryable even if an old
    // database happens to contain result rows from an earlier attempt. The
    // counters are still reconciled by the call above.
    if (current.status === "search_failed" && reconciled?.status !== "search_failed") {
      await tx.query.update({
        where: { id: Number(queryId) },
        data: { status: "search_failed" },
      });
    }

    const repaired = await tx.query.findUnique({
      where: { id: Number(queryId) },
      include: { searchResults: { select: { id: true, status: true } } },
    });
    if (!repaired) return null;

    return {
      originalStatus: current.status,
      generation: Number(repaired.generation),
      status: repaired.status,
      queryId: Number(queryId),
      pendingItemIds: repaired.searchResults
        .filter((item) => item.status === "pending")
        .map((item) => Number(item.id)),
    };
  });
}

async function queueRecoveryWork(recovered, enqueueFns) {
  const { originalStatus, queryId, generation } = recovered;

  // Pause and terminal failure are explicit user-visible states. Recovery may
  // repair their counters/files, but it must never create new work for them.
  if (originalStatus === "paused" || TERMINAL_STATUSES.has(originalStatus)) return false;

  if (METADATA_STATUSES.has(originalStatus)) {
    return Boolean(await enqueueFns.addMetadataJob({ queryId, generation }));
  }

  if (SEARCH_STATUSES.has(originalStatus)) {
    return Boolean(await enqueueFns.addSearchJob({ queryId, generation }));
  }

  if (DOWNLOAD_STATUSES.has(originalStatus) && recovered.pendingItemIds.length > 0) {
    return Boolean(await enqueueFns.addDownloadJobBulk({ queryId, generation }));
  }

  // A completed query only gets work when physical reconciliation downgraded
  // one or more rows to pending. The helper rechecks files and statuses before
  // writing jobs, so this branch is safe even if all files survived.
  if (originalStatus === "completed" && recovered.pendingItemIds.length > 0) {
    return Boolean(await enqueueFns.addDownloadJobBulk({ queryId, generation }));
  }

  return false;
}

function buildLegacyMatches(items) {
  const matches = new Map();

  for (const item of items) {
    const names = new Set();
    const sanitized = sanitizeFileName(String(item.fileName ?? "")).trim();
    if (sanitized) {
      // This is the exact filename produced by the pre-package-4 scraper.
      names.add(`${sanitized}.pdf`);
      // Accommodate installations that already stored the extension in
      // fileName while still avoiding duplicate candidate names.
      if (/\.pdf$/i.test(sanitized)) names.add(sanitized);
    }

    for (const name of names) {
      const key = name.toLocaleLowerCase();
      const ids = matches.get(key) ?? [];
      if (!ids.includes(Number(item.id))) ids.push(Number(item.id));
      matches.set(key, ids);
    }
  }

  return matches;
}

async function removeObsoleteJobs(queues) {
  for (const queue of Object.values(queues)) {
    if (!queue?.getJobs) continue;
    const jobs = await queue.getJobs(RETAINED_JOB_STATES).catch(() => []);
    for (const job of jobs) {
      // The queue is not authoritative. This also removes jobs for deleted
      // queries and terminal/paused queries before workers can claim them.
      await Promise.resolve(job?.remove?.()).catch(() => null);
    }
  }
}

async function cleanOrphanQueryDirectories(
  queryById,
  { downloadsDir = DOWNLOADS_DIR, tempDownloadsDir = TEMP_DOWNLOADS_DIR } = {}
) {
  const entries = await readDirectory(downloadsDir);
  const liveQueryIds = new Set([...queryById.keys()].map(String));
  const downloadsRoot = path.resolve(downloadsDir);
  const tempRoot = path.resolve(tempDownloadsDir);

  for (const entry of entries) {
    // DOWNLOADS_DIR may be a user-provided folder such as ~/Downloads. Only
    // remove directories matching the app's numeric query-directory shape;
    // unrelated files, folders, and symlinks are user data and stay intact.
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

    const entryPath = path.resolve(downloadsRoot, entry.name);
    if (entryPath === tempRoot || liveQueryIds.has(entry.name)) continue;

    await fs.rm(entryPath, { recursive: true, force: true });
  }
}

async function cleanTemporaryFiles(tempDownloadsDir) {
  await fs.rm(tempDownloadsDir, { recursive: true, force: true });
  await fs.mkdir(tempDownloadsDir, { recursive: true, mode: 0o775 });
}

function getQueryDownloadDir(downloadsDir, queryId) {
  return path.join(downloadsDir, String(queryId));
}

function getDownloadedFilePath(downloadsDir, queryId, itemId) {
  return path.join(getQueryDownloadDir(downloadsDir, queryId), `${itemId}.pdf`);
}

async function readDirectory(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicRename(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    // POSIX rename replaces a destination atomically. Windows can report
    // EEXIST/EPERM instead, so remove only a known-invalid destination before
    // retrying. Package 4 runs in a single startup process, so no worker can
    // observe the brief fallback gap.
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
    await fs.rm(destinationPath, { recursive: true, force: true });
    await fs.rename(sourcePath, destinationPath);
  }
}

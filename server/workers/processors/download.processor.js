import { promises as fs } from "fs";
import path from "path";
import { scrapeDownload } from "../../services/scraper.service.js";
import { config } from "../../config.js";
import { addDownloadRetryJob } from "../../queues/download.queue.js";
import { prisma } from "../../services/db.service.js";
import { getCurrentQuery, parseJobIdentifiers } from "../../services/query-generation.service.js";
import { completeSearchResult, setSearchResultStatus } from "../../services/query-state.service.js";
import {
  getDownloadTempPath,
  getDownloadedFilePath,
  getQueryDownloadDir,
  isValidPdfFile,
} from "../../services/file.service.js";

const {
  concurrentDownloads: CONCURRENT_DOWNLOADS,
  maxDownloadAttempts: MAX_DOWNLOAD_ATTEMPTS,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: RETRY_MAX_DELAY_MS,
} = config;

export { CONCURRENT_DOWNLOADS };

/**
 * BullMQ processor for download jobs. Jobs contain only immutable identifiers;
 * href/fileName are loaded from the current SearchResult row.
 *
 * Browser output is always written to the global temporary area. Finalization
 * validates the output, rechecks the lifecycle generation, atomically moves
 * the file to its ID-based path, and completes the item in the same guarded
 * state transition.
 *
 * @param {import('bullmq').Job} job
 */
export async function processDownloadJob(job) {
  const identifiers = parseJobIdentifiers(job?.data, { itemRequired: true });
  if (!identifiers) return null;

  const { queryId, generation, itemId } = identifiers;
  const query = await getCurrentQuery(queryId, generation);
  if (!query) return null;

  const item = query.searchResults.find((result) => result.id === itemId);
  if (!item) return null;

  // Only a pending item can be claimed by a fresh job. In particular, an
  // item-level pause makes an active old job unable to claim/finish work.
  const markedDownloading = await setSearchResultStatus(itemId, "downloading", {
    generation,
    expectedStatuses: ["pending"],
  });
  if (!markedDownloading) return null;

  const temporaryFilePath = getDownloadTempPath(job?.id ?? `download-${itemId}-g${generation}`);
  await fs.mkdir(getTemporaryDirectory(temporaryFilePath), { recursive: true });

  try {
    // The real scraper returns this path. The undefined/no-file branch keeps
    // direct package-3 lifecycle tests that stub browser work compatible when
    // their query has already become stale. A live job with no output is a
    // genuine download failure and must reject so BullMQ can run its retry
    // policy instead of leaving the item stuck in `downloading`.
    await scrapeDownload(item, temporaryFilePath);
    if (!(await fileExists(temporaryFilePath))) {
      const current = await getCurrentQuery(queryId, generation);
      const currentItem = current?.searchResults.find((result) => result.id === itemId);
      if (!currentItem || currentItem.status !== "downloading") return null;
      throw new Error("Downloaded file is missing");
    }

    if (!(await isValidPdfFile(temporaryFilePath))) {
      throw new Error("Downloaded file is not a valid PDF");
    }

    return await finalizeDownload({
      queryId,
      generation,
      itemId,
      temporaryFilePath,
    });
  } finally {
    await fs.rm(temporaryFilePath, { force: true }).catch(() => null);
  }
}

/**
 * Finalizes a validated temporary file and completes its SearchResult.
 *
 * The transaction takes a SQLite write lock through a conditional no-op item
 * update before creating the query directory or renaming the file. Pause,
 * delete, and generation changes therefore either win before finalization or
 * wait until this whole physical/logical commit has completed. A stale worker
 * never creates a final file after deletion, and a failed completion removes a
 * file moved by this invocation.
 *
 * @param {{ queryId: number, generation: number, itemId: number, temporaryFilePath: string }} params
 * @returns {Promise<object|null>}
 */
export async function finalizeDownload({ queryId, generation, itemId, temporaryFilePath }) {
  const finalPath = getDownloadedFilePath(queryId, itemId);
  let moved = false;

  if (!(await isValidPdfFile(temporaryFilePath))) {
    throw new Error("Downloaded file is not a valid PDF");
  }

  try {
    const completed = await prisma.$transaction(async (tx) => {
      let query = await getCurrentQuery(queryId, generation, { tx });
      if (!query) return null;

      let item = query.searchResults.find((result) => result.id === itemId);
      if (!item || item.status !== "downloading") return null;

      // This conditional write is both a final item/generation guard and a
      // write-lock acquisition for SQLite lifecycle transactions.
      const lock = await tx.searchResult.updateMany({
        where: { id: itemId, queryId, status: "downloading" },
        data: { status: "downloading" },
      });
      if (lock.count !== 1) return null;

      // Re-read immediately after acquiring the write lock. This is the last
      // point at which a pause/delete/retry can invalidate this worker.
      query = await getCurrentQuery(queryId, generation, { tx });
      if (!query) return null;
      item = query.searchResults.find((result) => result.id === itemId);
      if (!item || item.status !== "downloading") return null;

      await fs.mkdir(getQueryDownloadDir(queryId), { recursive: true });

      // A valid final file can be reused after a crash that happened between
      // rename and the database commit. Otherwise rename is atomic within the
      // same filesystem and replaces any invalid partial file.
      if (await isValidPdfFile(finalPath)) {
        await fs.rm(temporaryFilePath, { force: true });
      } else {
        await fs.rename(temporaryFilePath, finalPath);
        moved = true;
      }

      const result = await completeSearchResult(itemId, { generation, tx });
      if (!result) throw new Error("Download became stale before completion");
      return result;
    });

    return completed;
  } catch (error) {
    if (moved) await fs.rm(finalPath, { force: true }).catch(() => null);
    throw error;
  }
}

export async function handleDownloadJobFailure(job, err) {
  const identifiers = parseJobIdentifiers(job?.data, { itemRequired: true });
  if (!identifiers) return;

  const { queryId, generation, itemId } = identifiers;
  const query = await getCurrentQuery(queryId, generation);
  const item = query?.searchResults.find((result) => result.id === itemId);
  if (!query || !item) return;

  const attempt = Number(job.data.attempt ?? 1);
  if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
    // A paused/deleted/superseded query or item fails this conditional
    // transition and therefore cannot be marked blocked by stale work.
    await setSearchResultStatus(itemId, "download_blocked", {
      generation,
      expectedStatuses: ["pending", "downloading"],
    }).catch(() => null);
  } else {
    const nextAttempt = attempt + 1;
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);

    // Return the item to pending before scheduling the retry. Both operations
    // are generation-aware; the queue helper repeats the check immediately
    // before creating the next job.
    const reset = await setSearchResultStatus(itemId, "pending", {
      generation,
      expectedStatuses: ["downloading"],
    });
    if (reset) {
      await addDownloadRetryJob({
        queryId,
        generation,
        itemId,
        attempt: nextAttempt,
        delay,
      });
    }
  }

  console.error(
    `[Download] Job ${job?.id} (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}) failed for ${item.fileName}:`,
    err?.message ?? err
  );
}

/**
 * Completion is committed by processDownloadJob before BullMQ emits its
 * completed event. Keeping this handler observational prevents a second,
 * unvalidated state transition after the physical commit.
 */
export function handleDownloadJobCompleted(job) {
  console.log(`[Download] Job ${job?.id} completed`);
}

function getTemporaryDirectory(temporaryFilePath) {
  return path.dirname(temporaryFilePath);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

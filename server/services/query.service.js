import { promises as fs } from "fs";
import path from "path";
import { getMetadata, upsertMetadata, prisma } from "./db.service.js";
import {
  deleteSearchResultAndReconcile,
  reconcileQueryStateInTransaction,
  setSearchResultStatus,
} from "./query-state.service.js";
import { DOWNLOADS_DIR, queryToString, deleteDownloadedFile } from "./file.service.js";
import { metadataQueue, searchQueue } from "../queue.js";
import { addMetadataJob } from "../queues/metadata.queue.js";
import { addSearchJob } from "../queues/search.queue.js";
import {
  addDownloadJobBulk,
  cancelDownloadJobs,
  cancelQueryDownloadJobs,
} from "../queues/download.queue.js";
import { RETRYABLE_STATUSES } from "../../shared/constants.js";

const PAUSABLE_STATUSES = [
  "pending",
  "fetching_metadata",
  "fetching_results",
  "download_queued",
  "downloading",
];
const JOB_STATES = ["waiting", "delayed", "prioritized", "paused"];

/**
 * Creates or returns an existing Query record. Re-queues a previous
 * search_failed query as a new lifecycle generation.
 *
 * @param {{ url: string }} params
 * @param {{ order?: number }} [options]
 * @returns {Promise<import('../../shared/types.js').Query>}
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await getMetadata(params);

  if (!existing) {
    return upsertMetadata(
      { url: params.url },
      {
        results: null,
        resultsPerPart: null,
        parts: null,
        pageUrl: params.url,
        order: Date.now() + order,
        status: "pending",
        generation: 1,
        resumeStatus: null,
      }
    );
  }

  if (existing.status !== "search_failed") return existing;

  await prisma.query.update({
    where: { id: existing.id },
    data: {
      results: null,
      resultsPerPart: null,
      parts: null,
      pageUrl: params.url,
      createdAt: new Date(),
      order: BigInt(Date.now() + order),
      status: "pending",
      resumeStatus: null,
      generation: { increment: 1 },
    },
  });

  return getMetadata({ id: existing.id });
}

/**
 * Removes a query. Logical invalidation is committed before queue/file
 * cleanup, so active workers can only observe a missing query after this
 * operation succeeds. Filesystem cleanup remains the package-3 behaviour;
 * atomic temp/final-write protection belongs to package 4.
 *
 * @param {{ id: number }} params
 * @param {{ removeDownloads?: boolean }} [options]
 */
export async function removeQuery(params, { removeDownloads = true } = {}) {
  const queryId = Number(params.id);
  const metadata = await getMetadata({ id: queryId });
  if (!metadata) return;

  await prisma.$transaction(async (tx) => {
    const current = await tx.query.findUnique({ where: { id: queryId } });
    if (!current) return;

    // Advance generation before deleting the row. This is mostly documentary
    // for a hard delete, but makes the invalidation ordering explicit and
    // protects any transaction that has already loaded the query.
    await tx.query.update({
      where: { id: queryId },
      data: { generation: { increment: 1 } },
    });
    await tx.query.delete({ where: { id: queryId } });
  });

  await cancelQueryJobs(metadataQueue, queryId);
  await cancelQueryJobs(searchQueue, queryId);
  await Promise.allSettled(
    (metadata.searchResults ?? []).map((item) => cancelDownloadJobs(item.id))
  );
  await cancelQueryDownloadJobs(queryId);

  if (removeDownloads) {
    const dir = path.join(DOWNLOADS_DIR, queryToString(params));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Re-queues a retryable query as a new generation.
 * Throws NOT_FOUND or NOT_RETRYABLE errors for the HTTP controller.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function retryQuery(id) {
  const queryId = Number(id);
  const metadata = await getMetadata({ id: queryId });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (!RETRYABLE_STATUSES.includes(metadata.status)) {
    const err = new Error(`Cannot retry query with status '${metadata.status}'`);
    err.code = "NOT_RETRYABLE";
    err.retryableStatuses = RETRYABLE_STATUSES;
    throw err;
  }

  await cancelQueryJobs(metadataQueue, queryId);
  await cancelQueryJobs(searchQueue, queryId);
  await Promise.allSettled(
    (metadata.searchResults ?? []).map((item) => cancelDownloadJobs(item.id))
  );
  await cancelQueryDownloadJobs(queryId);

  if (metadata.status === "download_blocked") {
    const restarted = await prisma.$transaction(async (tx) => {
      const current = await tx.query.findUnique({
        where: { id: queryId },
        select: { generation: true, status: true },
      });
      if (!current || current.status !== "download_blocked") return null;

      const generation = Number(current.generation) + 1;
      await tx.searchResult.updateMany({
        where: { queryId, status: "download_blocked" },
        data: { status: "pending" },
      });
      await tx.query.update({
        where: { id: queryId },
        data: { generation, resumeStatus: null },
      });
      await reconcileQueryStateInTransaction(tx, queryId);
      return generation;
    });

    if (restarted == null) return;
    await addDownloadJobBulk({ queryId, generation: restarted });
    return;
  }

  const restarted = await prisma.$transaction(async (tx) => {
    const current = await tx.query.findUnique({
      where: { id: queryId },
      select: { generation: true, status: true },
    });
    if (!current || current.status !== "search_failed") return null;

    const generation = Number(current.generation) + 1;
    await tx.query.update({
      where: { id: queryId },
      data: { generation, status: "pending", resumeStatus: null },
    });
    return generation;
  });

  if (restarted != null) await addMetadataJob({ queryId, generation: restarted });
}

/**
 * Toggles pause/resume for a query. Pause records the exact stage in
 * resumeStatus and advances generation; active workers are allowed to finish
 * browser work but become logically stale.
 *
 * @param {number} id
 * @returns {Promise<{ paused: boolean, id: number, status: string }>}
 */
export async function togglePause(id) {
  const queryId = Number(id);
  const metadata = await getMetadata({ id: queryId });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (metadata.status === "paused") {
    return resumeQuery(queryId);
  }

  if (!PAUSABLE_STATUSES.includes(metadata.status)) {
    const err = new Error(`Cannot pause query with status '${metadata.status}'`);
    err.code = "NOT_PAUSABLE";
    throw err;
  }

  const paused = await prisma.$transaction(async (tx) => {
    const current = await tx.query.findUnique({
      where: { id: queryId },
      select: { generation: true, status: true },
    });
    if (!current || !PAUSABLE_STATUSES.includes(current.status)) return null;

    const nextGeneration = Number(current.generation) + 1;
    await tx.query.update({
      where: { id: queryId },
      data: {
        resumeStatus: current.status,
        status: "paused",
        generation: nextGeneration,
      },
    });

    // A claimed download is stale after this point. Converting it to paused
    // makes resume deterministic and prevents a stale active worker leaving a
    // permanently downloading item behind.
    await tx.searchResult.updateMany({
      where: { queryId, status: { in: ["pending", "downloading"] } },
      data: { status: "paused" },
    });

    return { generation: nextGeneration };
  });

  if (!paused) {
    const err = new Error("Query is no longer pausable");
    err.code = "NOT_PAUSABLE";
    throw err;
  }

  await cancelQueryJobs(metadataQueue, queryId);
  await cancelQueryJobs(searchQueue, queryId);
  await Promise.allSettled(
    (metadata.searchResults ?? []).map((item) => cancelDownloadJobs(item.id))
  );
  await cancelQueryDownloadJobs(queryId);

  return { paused: true, id: queryId, status: "paused" };
}

async function resumeQuery(queryId) {
  const resumed = await prisma.$transaction(async (tx) => {
    const current = await tx.query.findUnique({
      where: { id: queryId },
      include: { searchResults: true },
    });
    if (!current || current.status !== "paused") return null;

    const previousStatus = current.resumeStatus || "pending";
    const nextGeneration = Number(current.generation) + 1;
    let nextStatus = previousStatus;
    let shouldQueueDownloads = false;

    if (["download_queued", "downloading"].includes(previousStatus)) {
      await tx.searchResult.updateMany({
        where: { queryId, status: "paused" },
        data: { status: "pending" },
      });
      nextStatus = "download_queued";
      shouldQueueDownloads = true;
    } else if (previousStatus === "download_blocked") {
      nextStatus = "download_blocked";
    } else if (["pending", "fetching_metadata"].includes(previousStatus)) {
      nextStatus = previousStatus;
    } else if (previousStatus === "fetching_results") {
      nextStatus = "fetching_results";
    } else if (previousStatus === "completed") {
      // A completed query should not normally be pausable, but do not revive
      // one created by an older implementation if it appears in the database.
      nextStatus = "completed";
    } else {
      nextStatus = "pending";
    }

    await tx.query.update({
      where: { id: queryId },
      data: {
        status: nextStatus,
        resumeStatus: null,
        generation: nextGeneration,
      },
    });

    return { generation: nextGeneration, previousStatus, shouldQueueDownloads, nextStatus };
  });

  if (!resumed) {
    const err = new Error("Query not found or is not paused");
    err.code = "NOT_FOUND";
    throw err;
  }

  const { generation, previousStatus, shouldQueueDownloads, nextStatus } = resumed;
  if (["pending", "fetching_metadata"].includes(previousStatus)) {
    await addMetadataJob({ queryId, generation });
  } else if (previousStatus === "fetching_results") {
    await addSearchJob({ queryId, generation });
  } else if (shouldQueueDownloads) {
    await addDownloadJobBulk({ queryId, generation });
  }

  return { paused: false, id: queryId, status: nextStatus };
}

/**
 * Toggles pause on a single SearchResult. Item pause uses status as its local
 * cancellation token; query generation is reserved for operations that
 * invalidate the whole pipeline.
 */
export async function toggleItemPause(queryId, itemId) {
  const id = Number(queryId);
  const resultId = Number(itemId);
  const metadata = await getMetadata({ id });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const item = (metadata.searchResults ?? []).find((result) => result.id === resultId);
  if (!item) {
    const err = new Error("Item not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (!["pending", "downloading", "paused"].includes(item.status)) {
    const err = new Error(`Cannot pause item with status '${item.status}'`);
    err.code = "NOT_PAUSABLE";
    throw err;
  }

  if (item.status === "paused") {
    if (metadata.status === "paused") {
      const err = new Error("Cannot resume an item while its query is paused");
      err.code = "NOT_PAUSABLE";
      throw err;
    }

    const resumed = await setSearchResultStatus(resultId, "pending", {
      expectedStatuses: ["paused"],
    });
    if (!resumed) return { paused: false, id: resultId };
    await addDownloadJobBulk({ queryId: id, generation: metadata.generation, itemIds: [resultId] });
    return { paused: false, id: resultId };
  }

  await cancelDownloadJobs(resultId);
  await setSearchResultStatus(resultId, "paused", {
    expectedStatuses: ["pending", "downloading"],
  });
  return { paused: true, id: resultId };
}

/**
 * Removes a SearchResult, invalidating the query generation before deleting
 * it so an active search/download worker cannot recreate or advance it.
 */
export async function removeItem(queryId, itemId) {
  const id = Number(queryId);
  const resultId = Number(itemId);
  const metadata = await getMetadata({ id });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const item = (metadata.searchResults ?? []).find((result) => result.id === resultId);
  if (!item) {
    const err = new Error("Item not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  await cancelDownloadJobs(resultId);
  await deleteSearchResultAndReconcile(resultId, { invalidateGeneration: true });

  try {
    await deleteDownloadedFile(id, item.fileName);
  } catch (err) {
    console.warn(`Could not delete file for item ${resultId}:`, err.message);
  }
}

async function cancelQueryJobs(queue, queryId) {
  const jobs = await queue.getJobs(JOB_STATES).catch(() => []);
  for (const job of jobs) {
    if (Number(job.data?.queryId) !== Number(queryId)) continue;
    const state = await job.getState().catch(() => null);
    if (JOB_STATES.includes(state)) await job.remove().catch(() => null);
  }
}

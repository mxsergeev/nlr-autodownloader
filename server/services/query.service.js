import { promises as fs } from "fs";
import path from "path";
import {
  getMetadata,
  upsertMetadata,
  deleteMetadata,
  updateSearchResult,
  deleteSearchResult,
} from "./db.service.js";
import { DOWNLOADS_DIR, queryToString } from "./file.service.js";
import { searchQueue, downloadQueue } from "../queue.js";
import { addMetadataJob } from "../queues/metadata.queue.js";
import { addDownloadJobBulk } from "../queues/download.queue.js";
import { RETRYABLE_STATUSES } from "../../shared/constants.js";

/**
 * Creates or returns an existing Query record. Re-creates if the existing record has
 * status 'search_failed' (allows re-queuing failed queries).
 * @param {{ url: string }} params
 * @param {{ order?: number }} [options]
 * @returns {Promise<import('../../shared/types.js').Query>}
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await getMetadata(params);

  if (existing && existing.status !== "search_failed") return existing;

  return upsertMetadata(
    { url: params.url },
    {
      results: null,
      resultsPerPart: null,
      parts: null,
      pageUrl: params.url,
      createdAt: new Date(),
      order: Date.now() + order,
      status: "pending",
    }
  );
}

/**
 * Removes a query: cancels its pending BullMQ jobs, deletes the DB record,
 * and optionally removes downloaded files.
 * Silently resolves if the query does not exist.
 * @param {{ id: number }} params
 * @param {{ removeDownloads?: boolean }} [options]
 */
export async function removeQuery(params, { removeDownloads = true } = {}) {
  const metadata = await getMetadata({ id: Number(params.id) });

  if (!metadata) return;

  const searchJob = await searchQueue.getJob(`search-${metadata.id.toString()}`);
  try {
    if (searchJob) await searchJob.remove();

    if (metadata.searchResults?.length > 0) {
      const downloadJobs = (
        await Promise.allSettled(
          metadata.searchResults.map((j) => downloadQueue.getJob(`download-${j.id.toString()}`))
        )
      )
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value);

      await Promise.allSettled(downloadJobs.map((j) => j.remove()));
    }
  } catch (err) {
    console.error(`Error removing jobs for query ${metadata.id}:`, err);
  }

  await deleteMetadata({ id: Number(params.id) });

  if (removeDownloads) {
    const dir = path.join(DOWNLOADS_DIR, queryToString(params));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Re-queues a query for processing.
 * Throws an Error with `code: 'NOT_FOUND'` if the query does not exist.
 * Throws an Error with `code: 'NOT_RETRYABLE'` (and `.retryableStatuses`) if the status is not retryable.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function retryQuery(id) {
  const metadata = await getMetadata({ id: Number(id) });

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

  if (metadata.status === "download_blocked") {
    await addDownloadJobBulk({ metadata, searchResults: metadata.searchResults });
  } else {
    await addMetadataJob({ url: metadata.pageUrl });
  }
}

/**
 * Toggles pause on a query.
 * On pause: removes waiting/delayed BullMQ download jobs for all pending items and marks them 'paused'.
 * On resume: re-queues BullMQ download jobs for all paused items and marks them 'pending'.
 * In-progress downloads are allowed to finish in both directions.
 * @param {number} id
 * @returns {Promise<{ paused: boolean, id: number, status: string }>}
 */
export async function togglePause(id) {
  const metadata = await getMetadata({ id: Number(id) });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const results = metadata.searchResults ?? [];

  if (metadata.status === "paused") {
    // --- Resume ---
    const pausedItems = results.filter((r) => r.status === "paused");
    const newStatus = pausedItems.length > 0 ? "downloading" : "pending";

    // Write parent status first so background polls see the correct state immediately,
    // even while the per-item DB writes and BullMQ job creation are still in progress.
    await upsertMetadata({ id: Number(id) }, { ...metadata, status: newStatus });

    if (pausedItems.length > 0) {
      await Promise.all(
        pausedItems.map((item) => updateSearchResult(item.id, { status: "pending" }))
      );
      await addDownloadJobBulk({ metadata, searchResults: pausedItems });
    }

    return { paused: false, id: Number(id), status: newStatus };
  } else {
    // --- Pause ---
    // Write parent status first — same reason as resume above.
    await upsertMetadata({ id: Number(id) }, { ...metadata, status: "paused" });

    const pendingItems = results.filter((r) => r.status === "pending");

    for (const item of pendingItems) {
      const job = await downloadQueue.getJob(`download-${item.id}`);
      if (job) {
        const state = await job.getState();
        if (state === "waiting" || state === "delayed") {
          await job.remove();
        }
      }
      await updateSearchResult(item.id, { status: "paused" });
    }

    return { paused: true, id: Number(id), status: "paused" };
  }
}

/**
 * Toggles pause on a single SearchResult.
 * If the item is 'pending': removes its waiting BullMQ job and marks it 'paused'.
 * If the item is 'paused': re-queues its BullMQ job and marks it 'pending'.
 * Throws NOT_FOUND if the query or item does not exist.
 * Throws NOT_PAUSABLE if the item status is not 'pending' or 'paused'.
 * @param {number} queryId
 * @param {number} itemId
 * @returns {Promise<{ paused: boolean, id: number }>}
 */
export async function toggleItemPause(queryId, itemId) {
  const metadata = await getMetadata({ id: Number(queryId) });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const item = (metadata.searchResults ?? []).find((r) => r.id === Number(itemId));

  if (!item) {
    const err = new Error("Item not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (!["pending", "paused"].includes(item.status)) {
    const err = new Error(`Cannot pause item with status '${item.status}'`);
    err.code = "NOT_PAUSABLE";
    throw err;
  }

  if (item.status === "paused") {
    // Resume
    await updateSearchResult(Number(itemId), { status: "pending" });
    await addDownloadJobBulk({ metadata, searchResults: [item] });
    return { paused: false, id: Number(itemId) };
  } else {
    // Pause
    const job = await downloadQueue.getJob(`download-${itemId}`);
    if (job) {
      const state = await job.getState();
      if (state === "waiting" || state === "delayed") {
        await job.remove();
      }
    }
    await updateSearchResult(Number(itemId), { status: "paused" });
    return { paused: true, id: Number(itemId) };
  }
}

/**
 * Removes a single SearchResult: cancels its waiting BullMQ job, deletes the DB record,
 * and decrements Query.results.
 * Throws NOT_FOUND if the query or item does not exist.
 * @param {number} queryId
 * @param {number} itemId
 */
export async function removeItem(queryId, itemId) {
  const metadata = await getMetadata({ id: Number(queryId) });

  if (!metadata) {
    const err = new Error("Query not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const item = (metadata.searchResults ?? []).find((r) => r.id === Number(itemId));

  if (!item) {
    const err = new Error("Item not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const job = await downloadQueue.getJob(`download-${itemId}`);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
    }
  }

  await deleteSearchResult(Number(itemId));

  if (metadata.results != null && metadata.results > 0) {
    await upsertMetadata({ id: Number(queryId) }, { ...metadata, results: metadata.results - 1 });
  }
}

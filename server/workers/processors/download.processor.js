import path from "path";
import { scrapeDownload } from "../../services/scraper.service.js";
import { config, downloadsDir } from "../../config.js";
import { addDownloadRetryJob } from "../../queues/download.queue.js";
import { getCurrentQuery, parseJobIdentifiers } from "../../services/query-generation.service.js";
import {
  setSearchResultStatus,
  completeSearchResult,
  blockSearchResult,
} from "../../services/query-state.service.js";

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
 * @param {import("bullmq").Job} job
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

  // The query/item can be paused or deleted immediately after the claim. The
  // browser operation may finish, but its completion handler will reject the
  // stale generation/status and cannot commit logical state.
  const storageDir = path.join(downloadsDir, queryId.toString());
  await scrapeDownload(item, storageDir);
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
    await blockSearchResult(itemId, { generation }).catch(() => null);
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

export async function handleDownloadJobCompleted(job) {
  const identifiers = parseJobIdentifiers(job?.data, { itemRequired: true });
  if (!identifiers) return;

  const { queryId, generation, itemId } = identifiers;
  const query = await getCurrentQuery(queryId, generation);
  const item = query?.searchResults.find((result) => result.id === itemId);
  if (!query || !item) return;

  // Completion is conditional on both lifecycle generation and the item still
  // being downloading. Item pause/delete therefore rejects stale completion.
  await completeSearchResult(itemId, { generation }).catch(() => null);

  console.log(`[Download] Job ${job?.id} completed for ${item.fileName}`);
}

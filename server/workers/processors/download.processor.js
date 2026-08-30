import path from "path";
import { scrapeDownload } from "../../services/scraper.service.js";
import { config, downloadsDir } from "../../config.js";
import { downloadQueue } from "../../queue.js";
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

async function updateSearchResultStatus(item, status) {
  await setSearchResultStatus(item.id, status);
}

/**
 * BullMQ processor for download jobs, separated from Worker construction for
 * deterministic unit and race testing.
 * @param {import("bullmq").Job} job
 */
export async function processDownloadJob(job) {
  const { metadata, item } = job.data;

  const storageDir = path.join(downloadsDir, metadata.id.toString());

  // The parent is promoted by the same transaction that marks this item
  // downloading. A paused query remains paused during reconciliation.
  await updateSearchResultStatus(item, "downloading").catch(() => null);
  await scrapeDownload(item, storageDir);
}

export async function handleDownloadJobFailure(job, err) {
  const { metadata, item, attempt = 1 } = job.data || {};

  if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
    // All retries exhausted — mark the item blocked and reconcile its parent
    // in the same transaction.
    if (item) await blockSearchResult(item.id).catch(() => null);
  } else {
    // Retries remain — re-queue with higher priority so it jumps ahead of new jobs
    const nextAttempt = attempt + 1;
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
    await downloadQueue
      .add(
        "download",
        { metadata, item, attempt: nextAttempt },
        {
          jobId: `download-${item.id}-r${nextAttempt}`,
          attempts: 1,
          delay,
          priority: 1,
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
      .catch(() => null);
    if (item) await updateSearchResultStatus(item, "pending").catch(() => null);
  }

  console.error(
    `[Download] Job ${job?.id} (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}) failed for ${item?.fileName}:`,
    err.message
  );
}

export async function handleDownloadJobCompleted(job) {
  const { item } = job.data || {};

  if (item) await completeSearchResult(item.id).catch(() => null);

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`);
}

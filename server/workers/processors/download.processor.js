import path from "path";
import { scrapeDownload } from "../../services/scraper.service.js";
import { config, downloadsDir } from "../../config.js";
import { downloadQueue } from "../../queue.js";
import {
  getQueryStats,
  incrementDownloaded,
  updateSearchResult,
  upsertMetadata,
} from "../../services/db.service.js";

const {
  concurrentDownloads: CONCURRENT_DOWNLOADS,
  maxDownloadAttempts: MAX_DOWNLOAD_ATTEMPTS,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: RETRY_MAX_DELAY_MS,
} = config;

export { CONCURRENT_DOWNLOADS };

async function updateSearchResultStatus(item, status) {
  await updateSearchResult(item.id, { status });
}

/**
 * Atomically increments Query.downloaded by 1, then resolves the new status.
 * Using DB-level increment eliminates the read-modify-write race that occurred
 * when multiple download workers completed simultaneously.
 */
async function updateMetadataStatus(md, status) {
  const updated = await incrementDownloaded(md.id).catch(() => null);
  if (!updated) return;

  const total = updated.results || 1;
  const downloadCount = updated.downloaded;

  let newStatus;
  if (downloadCount >= total) {
    newStatus = "completed";
  } else if (updated.status === "paused") {
    newStatus = "paused";
  } else {
    newStatus = status;
  }

  await upsertMetadata(
    { id: md.id },
    {
      status: newStatus,
      downloadProgress: parseFloat(((downloadCount / total) * 100).toFixed(2)) + "%",
    }
  ).catch(() => null);
}

/**
 * BullMQ processor for download jobs, separated from Worker construction for
 * deterministic unit and race testing.
 * @param {import("bullmq").Job} job
 */
export async function processDownloadJob(job) {
  const { metadata, item } = job.data;

  const storageDir = path.join(downloadsDir, metadata.id.toString());

  // Promote query from "download_queued" to "downloading" when a worker actually starts.
  // Only promote if still queued — avoids overriding a user-initiated "paused" status.
  const stats = await getQueryStats(metadata.id).catch(() => null);
  if (stats?.status === "download_queued") {
    await upsertMetadata({ id: metadata.id }, { status: "downloading" }).catch(() => null);
  }
  await updateSearchResultStatus(item, "downloading").catch(() => null);
  await scrapeDownload(item, storageDir);
}

export async function handleDownloadJobFailure(job, err) {
  const { metadata, item, attempt = 1 } = job.data || {};

  if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
    // All retries exhausted — mark as permanently blocked
    upsertMetadata(
      { id: metadata?.id },
      { status: "download_blocked", lastAttempt: new Date() }
    ).catch(() => null);
    updateSearchResultStatus(item, "download_blocked").catch(() => null);
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
    updateSearchResultStatus(item, "pending").catch(() => null);
  }

  console.error(
    `[Download] Job ${job?.id} (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}) failed for ${item?.fileName}:`,
    err.message
  );
}

export function handleDownloadJobCompleted(job) {
  const { metadata, item } = job.data || {};

  updateMetadataStatus(metadata, "downloading").catch(() => null);
  updateSearchResultStatus(item, "completed").catch(() => null);

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`);
}

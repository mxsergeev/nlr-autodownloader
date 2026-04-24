import { Worker } from "bullmq";
import path from "path";
import { connection, downloadQueue } from "../queue.js";
import { scrapeDownload } from "../services/scraper.service.js";
import { DOWNLOADS_DIR } from "../services/file.service.js";
import {
  getQueryStats,
  incrementDownloaded,
  updateSearchResult,
  upsertMetadata,
} from "../services/db.service.js";

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || "2", 10) || 1;
const MAX_DOWNLOAD_ATTEMPTS = parseInt(process.env.MAX_DOWNLOAD_ATTEMPTS || "10", 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || "5000", 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.RETRY_MAX_DELAY_MS || "30000", 10);

async function updateSearchResultStatus(item, status) {
  await updateSearchResult(item.id, { status });
}

/**
 * Atomically increments Query.downloaded by 1, then resolves the new status.
 * Using DB-level increment eliminates the read-modify-write race that occurred when
 * multiple download workers completed simultaneously and both read the same stale count.
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

export const downloadWorker = new Worker(
  "downloadQueue",
  async (job) => {
    const { metadata, item } = job.data;

    const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString());

    // Promote query from "download_queued" to "downloading" when a worker actually starts.
    // Only promote if still queued — avoids overriding a user-initiated "paused" status.
    const stats = await getQueryStats(metadata.id).catch(() => null);
    if (stats?.status === "download_queued") {
      await upsertMetadata({ id: metadata.id }, { status: "downloading" }).catch(() => null);
    }
    await updateSearchResultStatus(item, "downloading").catch(() => null);
    await scrapeDownload(item, storageDir);
  },
  { connection, concurrency: CONCURRENT_DOWNLOADS }
);

downloadWorker.on("failed", async (job, err) => {
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
});

downloadWorker.on("completed", async (job) => {
  const { metadata, item } = job.data || {};

  updateMetadataStatus(metadata, "downloading").catch(() => null);
  updateSearchResultStatus(item, "completed").catch(() => null);

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`);
});

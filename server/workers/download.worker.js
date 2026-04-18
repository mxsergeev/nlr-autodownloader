import { Worker } from "bullmq";
import path from "path";
import { connection } from "../queue.js";
import { scrapeDownload } from "../services/scraper.service.js";
import { DOWNLOADS_DIR } from "../services/file.service.js";
import { incrementDownloaded, updateSearchResult, upsertMetadata } from "../services/db.service.js";

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || "2", 10) || 1;

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

    await updateSearchResultStatus(item, "downloading").catch(() => null);
    await scrapeDownload(item, storageDir);
  },
  { connection, concurrency: CONCURRENT_DOWNLOADS }
);

downloadWorker.on("failed", async (job, err) => {
  const { metadata, item } = job.data || {};

  if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    // Do NOT call incrementDownloaded here — the file was NOT successfully written.
    upsertMetadata(
      { id: metadata?.id },
      { status: "download_blocked", lastAttempt: new Date() }
    ).catch(() => null);
    updateSearchResultStatus(item, "download_blocked").catch(() => null);
  }

  console.error(
    `[Download] Job ${job?.id} (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? 1}) failed for ${item?.fileName}:`,
    err.message
  );
});

downloadWorker.on("completed", async (job) => {
  const { metadata, item } = job.data || {};

  updateMetadataStatus(metadata, "downloading").catch(() => null);
  updateSearchResultStatus(item, "completed").catch(() => null);

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`);
});

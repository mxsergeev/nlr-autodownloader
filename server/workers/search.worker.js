import { Worker } from "bullmq";
import { connection } from "../queue.js";
import {
  scrapeSearchResults,
  verifySearchResults,
  deduplicateResults,
} from "../services/scraper.service.js";
import {
  getQueryStats,
  getSearchResults,
  saveSearchResults,
  upsertMetadata,
} from "../services/db.service.js";
import { addDownloadJobBulk } from "../queues/download.queue.js";

export const searchWorker = new Worker(
  "searchQueue",
  async (job) => {
    const { metadata: jobMetadata } = job.data;
    let metadata = jobMetadata;

    // Guard: exit cleanly if the query was deleted while this job was queued.
    const current = await getQueryStats(metadata.id);
    if (!current) return;

    await upsertMetadata({ id: metadata.id }, { status: "fetching_results" });

    let results;
    let searchWarnings = [];

    const existing = await getSearchResults({ queryId: metadata.id });

    const existingCheck =
      existing.length > 0 ? verifySearchResults(existing, metadata) : { ok: false, warnings: [] };
    if (existingCheck.ok && existingCheck.warnings.length === 0) {
      // Cache hit: existing DB results match exactly — use them directly (already have IDs)
      results = existing;
    } else {
      results = await scrapeSearchResults(metadata);

      const { ok, warnings } = verifySearchResults(results, metadata);
      searchWarnings = warnings;

      if (warnings.length > 0) {
        warnings.forEach((w) => console.warn(`[Search] ${job.id}: ${w}`));
      }

      if (!ok) {
        throw new Error(`Search verification failed: ${warnings.join("; ")}`);
      }

      // Deduplicate if needed
      results = deduplicateResults(results);

      // Update metadata.results to match actual scraped count
      if (results.length !== metadata.results) {
        await upsertMetadata({ id: metadata.id }, { results: results.length });
        metadata = { ...metadata, results: results.length };
      }

      try {
        await saveSearchResults({ queryId: metadata.id }, results);
        // Re-fetch after upsert to get DB-assigned IDs for any newly inserted rows
        results = await getSearchResults({ queryId: metadata.id });
      } catch (err) {
        // Query was deleted mid-Playwright scrape (FK violation P2003 or record-not-found P2025).
        // Exit cleanly — no retry needed.
        if (err.code === "P2003" || err.code === "P2025") return;
        throw err;
      }
    }

    // Persist warnings (or clear old ones) so the UI can display them
    await upsertMetadata(
      { id: metadata.id },
      {
        status: "download_queued",
        warnings: searchWarnings.length > 0 ? searchWarnings.join("\n") : null,
      }
    );

    const hasJobs = await addDownloadJobBulk({ metadata, searchResults: results });

    if (!hasJobs) {
      // All files are already on disk — no download jobs to run, mark completed immediately
      await upsertMetadata({ id: metadata.id }, { status: "completed" });
    }

    return { metadata, searchResults: results };
  },
  { connection, concurrency: 1 }
);

searchWorker.on("failed", async (job, err) => {
  const { metadata } = job?.data || {};

  if (metadata && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    await upsertMetadata(
      { id: metadata.id },
      {
        status: "search_failed",
        lastAttempt: new Date(),
      }
    ).catch(() => null);
  }

  console.error(`[Search] Job ${job?.id} failed:`, err.message);
});

searchWorker.on("completed", (job) => {
  console.log(`[Search] Job ${job?.id} completed`);
});

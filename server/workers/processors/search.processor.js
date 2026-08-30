import {
  scrapeSearchResults,
  verifySearchResults,
  deduplicateResults,
} from "../../services/scraper.service.js";
import {
  getQueryStats,
  getSearchResults,
  saveSearchResults,
  upsertMetadata,
} from "../../services/db.service.js";
import { addDownloadJobBulk } from "../../queues/download.queue.js";
import { reconcileQueryState, setSearchResultStatus } from "../../services/query-state.service.js";

/**
 * BullMQ processor for search jobs. Kept separate from Worker construction so
 * it can be driven directly by deterministic tests.
 * @param {import("bullmq").Job} job
 */
export async function processSearchJob(job) {
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

  // Check if the user paused this query while we were scraping
  const freshState = await getQueryStats(metadata.id);
  if (freshState?.status === "paused") {
    // Save warnings but keep status as paused — downloads will queue on resume
    if (searchWarnings.length > 0) {
      await upsertMetadata({ id: metadata.id }, { warnings: searchWarnings.join("\n") });
    }
    console.log(
      `[Search] Job ${job.id}: query ${metadata.id} was paused during scrape, skipping downloads`
    );
    return { metadata, searchResults: results };
  }

  // Persist warnings (or clear old ones) so the UI can display them
  await upsertMetadata(
    { id: metadata.id },
    {
      status: "download_queued",
      warnings: searchWarnings.length > 0 ? searchWarnings.join("\n") : null,
    }
  );

  // Normalize the denormalized counters from the rows that were just loaded.
  // The queue decision below still uses the existing filesystem behavior; it
  // must not be allowed to write a parent status independently of child state.
  await reconcileQueryState(metadata.id);

  const hasJobs = await addDownloadJobBulk({ metadata, searchResults: results });

  if (!hasJobs) {
    // Existing files are the current physical-download shortcut. Reflect that
    // shortcut through child state so reconciliation, rather than this worker,
    // derives the completed parent status.
    for (const item of results) {
      await setSearchResultStatus(item.id, "completed");
    }
  }

  return { metadata, searchResults: results };
}

export async function handleSearchJobFailure(job, err) {
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
}

export function handleSearchJobCompleted(job) {
  console.log(`[Search] Job ${job?.id} completed`);
}

import {
  scrapeSearchResults,
  verifySearchResults,
  deduplicateResults,
} from "../../services/scraper.service.js";
import { getSearchResults, saveSearchResults } from "../../services/db.service.js";
import { addDownloadJobBulk } from "../../queues/download.queue.js";
import { reconcileQueryState, setSearchResultStatus } from "../../services/query-state.service.js";
import {
  getCurrentQuery,
  isCurrentGeneration,
  parseJobIdentifiers,
  updateQueryForGeneration,
} from "../../services/query-generation.service.js";

/**
 * BullMQ processor for search jobs. The queue payload contains only queryId
 * and generation; metadata is always reloaded from SQLite.
 *
 * @param {import("bullmq").Job} job
 */
export async function processSearchJob(job) {
  const identifiers = parseJobIdentifiers(job?.data);
  if (!identifiers) return null;

  const { queryId, generation } = identifiers;
  let query = await getCurrentQuery(queryId, generation);
  if (!query) return null;

  // Never revive a paused query through a surviving search job.
  const markedActive = await updateQueryForGeneration(queryId, generation, {
    status: "fetching_results",
  });
  if (!markedActive) return null;

  query = await getCurrentQuery(queryId, generation);
  if (!query) return null;

  let results;
  let searchWarnings = [];
  const existing = await getSearchResults({ queryId });

  const existingCheck =
    existing.length > 0 ? verifySearchResults(existing, query) : { ok: false, warnings: [] };

  if (existingCheck.ok && existingCheck.warnings.length === 0) {
    // Cache hit: existing rows already have stable database IDs.
    results = existing;
  } else {
    const scraped = await scrapeSearchResults(query);

    // The scrape may finish after pause/retry/delete. Its result is stale and
    // must not be persisted or used to advance the pipeline.
    if (!(await isCurrentGeneration(queryId, generation))) return null;

    const { ok, warnings } = verifySearchResults(scraped, query);
    searchWarnings = warnings;

    if (warnings.length > 0) {
      warnings.forEach((warning) => console.warn(`[Search] ${job.id}: ${warning}`));
    }

    if (!ok) {
      throw new Error(`Search verification failed: ${warnings.join("; ")}`);
    }

    results = deduplicateResults(scraped);

    // Persist the complete scrape atomically and conditionally on generation.
    // A false result means pause/retry/delete invalidated this worker.
    if (!(await isCurrentGeneration(queryId, generation))) return null;
    const saved = await saveSearchResults({ queryId, generation }, results);
    if (!saved) return null;

    results = await getSearchResults({ queryId });
    if (!(await isCurrentGeneration(queryId, generation))) return null;
  }

  // Keep the denormalized expected count current, but only for this lifecycle.
  if (results.length !== query.results) {
    const countUpdated = await updateQueryForGeneration(queryId, generation, {
      results: results.length,
    });
    if (!countUpdated) return null;
    query = countUpdated;
  }

  if (!(await isCurrentGeneration(queryId, generation))) return null;
  const queued = await updateQueryForGeneration(queryId, generation, {
    warnings: searchWarnings.length > 0 ? searchWarnings.join("\n") : null,
  });
  if (!queued) return null;

  const reconciled = await reconcileQueryState(queryId, { generation });
  if (!reconciled) return null;

  // Queue only after the status transition and a fresh lifecycle check. The
  // queue helper performs its own final check immediately before addBulk.
  if (!(await isCurrentGeneration(queryId, generation))) return null;
  const hasJobs = await addDownloadJobBulk({
    queryId,
    generation,
  });

  if (!hasJobs) {
    // Existing files are the package-3-era physical shortcut. Mark rows
    // complete through generation-aware state transitions so a pause cannot
    // turn this stale shortcut into a DB commit.
    for (const item of results) {
      if (["paused", "download_blocked"].includes(item.status)) continue;
      if (!(await isCurrentGeneration(queryId, generation))) return null;
      if (!(await setSearchResultStatus(item.id, "completed", { generation }))) return null;
    }
  }

  return { queryId, generation, searchResults: results };
}

export async function handleSearchJobFailure(job, err) {
  const identifiers = parseJobIdentifiers(job?.data);
  if (!identifiers) return;

  const { queryId, generation } = identifiers;
  const query = await getCurrentQuery(queryId, generation);

  if (query && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    await updateQueryForGeneration(queryId, generation, {
      status: "search_failed",
      lastAttempt: new Date(),
    }).catch(() => null);
  }

  console.error(`[Search] Job ${job?.id} failed:`, err?.message ?? err);
}

export function handleSearchJobCompleted(job) {
  console.log(`[Search] Job ${job?.id} completed`);
}

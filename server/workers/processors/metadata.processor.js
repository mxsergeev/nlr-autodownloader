import { addSearchJob } from "../../queues/search.queue.js";
import { scrapeMetadata } from "../../services/scraper.service.js";
import {
  getCurrentQuery,
  isCurrentGeneration,
  parseJobIdentifiers,
  updateQueryForGeneration,
} from "../../services/query-generation.service.js";

/**
 * BullMQ processor for metadata jobs, separated from Worker construction so
 * it can be driven directly by deterministic tests.
 *
 * Metadata jobs intentionally contain only queryId + generation. The query
 * URL and all other mutable fields are read from SQLite at every stage.
 *
 * @param {import("bullmq").Job} job
 */
export async function processMetadataJob(job) {
  const identifiers = parseJobIdentifiers(job?.data);
  if (!identifiers) return null;

  const { queryId, generation } = identifiers;
  const query = await getCurrentQuery(queryId, generation);
  if (!query) return null;

  // A metadata worker must never revive a paused query, even if an old job
  // managed to survive queue cancellation.
  if (query.status === "paused") return null;

  // If the database already contains the complete result set, metadata was
  // previously obtained. Advance only through a generation-conditional
  // write, then enqueue search using the same immutable generation.
  if (query.results > 0 && query.searchResults.length === query.results) {
    const advanced = await updateQueryForGeneration(queryId, generation, {
      status: "fetching_results",
    });
    if (!advanced) return null;
    if (!(await isCurrentGeneration(queryId, generation))) return null;

    await addSearchJob({ queryId, generation });
    return advanced;
  }

  // Mark the query active before entering Playwright. If pause/retry/delete
  // won the race, updateMany affects no row and the browser is never started.
  const markedActive = await updateQueryForGeneration(queryId, generation, {
    status: "fetching_metadata",
  });
  if (!markedActive) return null;

  const scraped = await scrapeMetadata({ url: query.pageUrl });

  // Scraping is allowed to finish after invalidation, but its result is not.
  if (!(await isCurrentGeneration(queryId, generation))) return null;

  const updated = await updateQueryForGeneration(queryId, generation, {
    // pageUrl is the stable user-supplied key; searchUrl is the resolved URL
    // used to construct pagination URLs.
    searchUrl: scraped.pageUrl,
    results: scraped.results,
    resultsPerPart: scraped.resultsPerPart,
    parts: scraped.parts,
    status: "fetching_results",
  });
  if (!updated) return null;

  if (updated.results > 0) {
    if (!(await isCurrentGeneration(queryId, generation))) return null;
    await addSearchJob({ queryId, generation });
  }

  return updated;
}

export async function handleMetadataJobFailure(job, err) {
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

  console.error(`[Metadata] Job ${job?.id} failed:`, err?.message ?? err);
}

export function handleMetadataJobCompleted(job) {
  console.log(`[Metadata] Job ${job?.id} completed`);
}

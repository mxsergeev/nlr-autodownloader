import { downloadQueue } from "../queue.js";
import { getMetadata } from "../services/db.service.js";
import { getCurrentQuery, isCurrentGeneration } from "../services/query-generation.service.js";
import { getDownloadedFileIds, verifyDownloads } from "../services/file.service.js";

/**
 * Queues download jobs for all search result items whose file does not yet exist on disk.
 * Each job carries only immutable query/generation/item identifiers.  The
 * worker reloads href and display metadata from SQLite when it starts.
 * @returns {Promise<boolean>} true if jobs were added, false if all files are already present.
 */
export async function addDownloadJobBulk({
  queryId,
  generation,
  itemIds,
  metadata,
  searchResults,
} = {}) {
  const id = Number(queryId ?? metadata?.id);
  if (!Number.isInteger(id)) return false;

  const query = await getMetadata({ id });
  if (!query) return false;

  const currentGeneration = Number(generation ?? query.generation);
  const current = await getCurrentQuery(id, currentGeneration);
  if (!current) return false;

  const requestedIds = itemIds
    ? new Set(itemIds.map((itemId) => Number(itemId)))
    : searchResults
      ? new Set(searchResults.map((item) => Number(item.id)))
      : null;
  const currentItems = (current.searchResults ?? []).filter(
    (item) => (!requestedIds || requestedIds.has(item.id)) && item.status === "pending"
  );

  const downloads = await getDownloadedFileIds(current);
  const { missingFiles } = verifyDownloads(downloads, currentItems);

  if (missingFiles.length === 0) {
    console.log(`[Download] All files for ${id} are already downloaded.`);
    return false;
  }

  const jobs = missingFiles.map((item) => ({
    name: "download",
    data: {
      queryId: id,
      generation: currentGeneration,
      itemId: item.id,
    },
    opts: {
      jobId: `download-${item.id}-g${currentGeneration}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  }));

  // Recheck immediately before the queue write. A pause/retry/delete that
  // committed while the filesystem was being inspected owns the query now.
  if (!(await isCurrentGeneration(id, currentGeneration))) return false;

  await downloadQueue.addBulk(jobs);
  return true;
}

/**
 * Queues one retry using the same immutable lifecycle identifiers as an
 * initial download. The retry is rejected if its generation is no longer
 * current, so a pause/delete/restart cannot be resurrected by failure logic.
 */
export async function addDownloadRetryJob({ queryId, generation, itemId, attempt, delay }) {
  const id = Number(queryId);
  const item = Number(itemId);
  if (
    !Number.isInteger(id) ||
    !Number.isInteger(item) ||
    !Number.isInteger(Number(generation)) ||
    !Number.isInteger(Number(attempt))
  ) {
    return false;
  }

  if (!(await isCurrentGeneration(id, Number(generation)))) return false;

  const jobId = `download-${item}-g${Number(generation)}-r${Number(attempt)}`;
  const existing = await downloadQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => null);
    } else {
      return true;
    }
  }

  if (!(await isCurrentGeneration(id, Number(generation)))) return false;

  await downloadQueue.add(
    "download",
    { queryId: id, generation: Number(generation), itemId: item, attempt: Number(attempt) },
    {
      jobId,
      attempts: 1,
      delay,
      priority: 1,
      removeOnComplete: true,
      removeOnFail: true,
    }
  );

  return true;
}

/**
 * Removes all waiting/delayed download jobs for an item, including retries
 * from older generations.  Filtering by payload rather than guessing retry
 * suffixes keeps cancellation correct as retry policy changes.
 * Active jobs are intentionally left alone; generation/status guards make
 * their eventual result stale.
 *
 * @param {number} itemId
 * @returns {Promise<number>} number of jobs removed
 */
export async function cancelDownloadJobs(itemId) {
  const jobs = await downloadQueue
    .getJobs(["waiting", "delayed", "prioritized", "paused"])
    .catch(() => []);
  let removed = 0;

  for (const job of jobs) {
    if (Number(job.data?.itemId) !== Number(itemId)) continue;

    const state = await job.getState().catch(() => null);
    if (["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      await job
        .remove()
        .then(() => {
          removed += 1;
        })
        .catch(() => null);
    }
  }

  return removed;
}

/**
 * Removes all non-active download jobs belonging to a query. This complements
 * cancelDownloadJobs(itemId) for query-level invalidation when a search stage
 * may have created rows after the caller's initial query snapshot.
 */
export async function cancelQueryDownloadJobs(queryId) {
  const jobs = await downloadQueue
    .getJobs(["waiting", "delayed", "prioritized", "paused"])
    .catch(() => []);
  let removed = 0;

  for (const job of jobs) {
    if (Number(job.data?.queryId) !== Number(queryId)) continue;

    const state = await job.getState().catch(() => null);
    if (["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      await job
        .remove()
        .then(() => {
          removed += 1;
        })
        .catch(() => null);
    }
  }

  return removed;
}

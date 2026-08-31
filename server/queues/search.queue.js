import { searchQueue } from "../queue.js";
import { getCurrentQuery, isCurrentGeneration } from "../services/query-generation.service.js";

/**
 * Queue search work by immutable query identity.  The processor reloads all
 * metadata from SQLite, so mutable metadata snapshots never cross the queue.
 *
 * @param {{ queryId?: number, generation?: number, metadata?: { id: number, generation?: number } }} params
 * @returns {Promise<boolean>} whether a job was queued
 */
export async function addSearchJob({ queryId, generation, metadata } = {}) {
  const id = Number(queryId ?? metadata?.id);
  const currentGeneration = Number(generation ?? metadata?.generation);

  if (!Number.isInteger(id) || !Number.isInteger(currentGeneration)) return false;

  const current = await getCurrentQuery(id, currentGeneration);
  if (!current) return false;

  const jobId = `search-${id}-g${currentGeneration}`;

  // Remove any stale completed/failed job so the same query can always be re-processed.
  const existing = await searchQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => null);
    }
  }

  // The existing-job lookup/removal above can yield to a pause/retry/delete.
  // Recheck in the final gap immediately before creating the next-stage job.
  if (!(await isCurrentGeneration(id, currentGeneration))) return false;

  await searchQueue.add(
    "search",
    { queryId: id, generation: currentGeneration },
    {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );

  return true;
}

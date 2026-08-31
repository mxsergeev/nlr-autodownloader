import { metadataQueue } from "../queue.js";
import { getMetadata } from "../services/db.service.js";
import { getCurrentQuery, isCurrentGeneration } from "../services/query-generation.service.js";

/**
 * Queue metadata work by query identity.  The URL is deliberately not part of
 * the job payload: pageUrl can be refreshed by the metadata stage and jobs
 * must always load the current query from SQLite.
 *
 * @param {{ queryId?: number, generation?: number, url?: string }} params
 * @returns {Promise<boolean>} whether a job was queued
 */
export async function addMetadataJob({ queryId, generation, url } = {}) {
  let id = queryId == null ? null : Number(queryId);
  let currentGeneration = generation == null ? null : Number(generation);

  if (id == null && url) {
    const query = await getMetadata({ url });
    id = query?.id ?? null;
    currentGeneration = query?.generation ?? null;
  }

  if (id == null || currentGeneration == null) return false;

  const current = await getCurrentQuery(id, currentGeneration);
  if (!current) return false;

  const jobId = `metadata-${id}-g${currentGeneration}`;

  // Remove any completed/failed job for this generation so it can be
  // explicitly retried without colliding with BullMQ's deterministic id.
  const existing = await metadataQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => null);
    }
  }

  // The existing-job lookup/removal above can yield to a pause/retry/delete.
  // Recheck in the final gap immediately before creating the next-stage job.
  if (!(await isCurrentGeneration(id, currentGeneration))) return false;

  await metadataQueue.add(
    "metadata",
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

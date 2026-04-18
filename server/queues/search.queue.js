import { searchQueue } from "../queue.js";

export async function addSearchJob({ metadata }) {
  const jobId = `search-${metadata.id}`;

  // Remove any stale completed/failed job so the same query can always be re-processed.
  const existing = await searchQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => null);
    }
  }

  await searchQueue.add(
    "search",
    { metadata },
    {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

import { searchQueue } from "../queue.js";

export async function addSearchJob({ metadata }) {
  await searchQueue.add(
    "search",
    { metadata },
    {
      jobId: `search-${metadata.id}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    }
  );
}

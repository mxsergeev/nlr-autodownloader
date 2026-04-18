import { createHash } from "crypto";
import { metadataQueue } from "../queue.js";

export async function addMetadataJob({ url }) {
  const jobId = `metadata-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;

  // Remove any stale completed/failed job so the same URL can always be re-queued.
  const existing = await metadataQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => null);
    }
  }

  await metadataQueue.add(
    "metadata",
    { url },
    {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

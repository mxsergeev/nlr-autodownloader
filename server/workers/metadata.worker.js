import { Worker } from "bullmq";
import { connection } from "../queue.js";
import {
  processMetadataJob,
  handleMetadataJobFailure,
  handleMetadataJobCompleted,
} from "./processors/metadata.processor.js";

export const metadataWorker = new Worker("metadataQueue", processMetadataJob, {
  connection,
  concurrency: 1,
});

metadataWorker.on("failed", handleMetadataJobFailure);

metadataWorker.on("completed", handleMetadataJobCompleted);

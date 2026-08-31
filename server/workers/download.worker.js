import { Worker } from "bullmq";
import { connection } from "../queue.js";
import {
  processDownloadJob,
  handleDownloadJobFailure,
  handleDownloadJobCompleted,
  CONCURRENT_DOWNLOADS,
} from "./processors/download.processor.js";

export const downloadWorker = new Worker("downloadQueue", processDownloadJob, {
  connection,
  concurrency: CONCURRENT_DOWNLOADS,
});

downloadWorker.on("failed", handleDownloadJobFailure);

downloadWorker.on("completed", handleDownloadJobCompleted);

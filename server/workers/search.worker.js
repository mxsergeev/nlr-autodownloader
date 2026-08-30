import { Worker } from "bullmq";
import { connection } from "../queue.js";
import {
  processSearchJob,
  handleSearchJobFailure,
  handleSearchJobCompleted,
} from "./processors/search.processor.js";

export const searchWorker = new Worker("searchQueue", processSearchJob, {
  connection,
  concurrency: 1,
});

searchWorker.on("failed", handleSearchJobFailure);

searchWorker.on("completed", handleSearchJobCompleted);

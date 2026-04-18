import express from "express";
import { getAllMetadata, getMetadataById } from "../services/db.service.js";
import { addMetadataJob } from "../queues/metadata.queue.js";
import {
  removeQuery,
  retryQuery,
  togglePause,
  queueQuery,
  toggleItemPause,
  removeItem,
} from "../services/query.service.js";

const router = express.Router();

router.get("/queue", async (req, res) => {
  try {
    const queue = await getAllMetadata();
    res.json({ queue });
  } catch (error) {
    console.error("Queue retrieval error:", error);
    res
      .status(500)
      .json({ error: "Failed to retrieve queue", message: error.message, name: error.name });
  }
});

router.get("/queue/:id", async (req, res) => {
  try {
    const item = await getMetadataById(Number(req.params.id));
    if (!item) return res.status(404).json({ error: "Query not found" });
    res.json({ item });
  } catch (error) {
    console.error("Queue item retrieval error:", error);
    res.status(500).json({ error: "Failed to retrieve queue item", message: error.message });
  }
});

router.post("/queue", async (req, res) => {
  try {
    const { queries = [] } = req.body;

    if (queries.length === 0) {
      return res.status(400).json({ error: "No queries provided" });
    }

    const ops = queries.map(async (q, index) => {
      if (!q.url) {
        return Promise.reject(new Error(`Query at index ${index} is missing 'url' field`));
      }
      await queueQuery({ url: q.url }, { order: index });
      return addMetadataJob({ url: q.url });
    });

    const qsResults = await Promise.allSettled(ops);
    const queue = await getAllMetadata();

    res.json({
      failed: qsResults.filter((r) => r.status === "rejected").map((r) => r.reason),
      queue,
    });
  } catch (error) {
    console.error("Queue error:", error);
    res.status(500).json({ error: "Queueing failed", message: error.message, name: error.name });
  }
});

router.delete("/queue/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await removeQuery({ id: Number(id) });
    res.json({ removed: Number(id) });
  } catch (error) {
    console.error("Query removal error:", error);
    res.status(500).json({ error: "Failed to remove query", message: error.message });
  }
});

router.post("/queue/:id/retry", async (req, res) => {
  try {
    const { id } = req.params;
    await retryQuery(Number(id));
    res.json({ retried: Number(id) });
  } catch (error) {
    if (error.code === "NOT_FOUND") return res.status(404).json({ error: error.message });
    if (error.code === "NOT_RETRYABLE") {
      return res
        .status(400)
        .json({ error: error.message, retryableStatuses: error.retryableStatuses });
    }
    console.error("Query retry error:", error);
    res.status(500).json({ error: "Failed to retry query", message: error.message });
  }
});

router.post("/queue/:id/pause", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await togglePause(Number(id));
    res.json(result);
  } catch (error) {
    if (error.code === "NOT_FOUND") return res.status(404).json({ error: error.message });
    console.error("Query pause error:", error);
    res.status(500).json({ error: "Failed to pause query", message: error.message });
  }
});

router.post("/queue/:id/items/:itemId/pause", async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const result = await toggleItemPause(Number(id), Number(itemId));
    res.json(result);
  } catch (error) {
    if (error.code === "NOT_FOUND") return res.status(404).json({ error: error.message });
    if (error.code === "NOT_PAUSABLE") return res.status(400).json({ error: error.message });
    console.error("Item pause error:", error);
    res.status(500).json({ error: "Failed to pause item", message: error.message });
  }
});

router.delete("/queue/:id/items/:itemId", async (req, res) => {
  try {
    const { id, itemId } = req.params;
    await removeItem(Number(id), Number(itemId));
    res.json({ removed: Number(itemId) });
  } catch (error) {
    if (error.code === "NOT_FOUND") return res.status(404).json({ error: error.message });
    console.error("Item removal error:", error);
    res.status(500).json({ error: "Failed to remove item", message: error.message });
  }
});

export default router;

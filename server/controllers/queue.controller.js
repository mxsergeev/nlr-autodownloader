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
import { createZipStream, findDownloadedFile } from "../services/file.service.js";

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

router.get("/queue/:id/download", async (req, res) => {
  try {
    const { id } = req.params;
    const item = await getMetadataById(Number(id));
    if (!item) return res.status(404).json({ error: "Query not found" });
    if (item.status === "downloading") {
      return res
        .status(409)
        .json({ error: "Download in progress. Pause or wait for it to complete." });
    }
    if (!item.downloaded || item.downloaded === 0) {
      return res.status(404).json({ error: "No files have been downloaded yet." });
    }

    const zipStream = createZipStream(item.id);
    res.setHeader("Content-Disposition", `attachment; filename="query-${id}.zip"`);
    res.setHeader("Content-Type", "application/zip");
    zipStream.on("error", (err) => {
      console.error("ZIP creation error:", err);
    });
    zipStream.pipe(res);
  } catch (error) {
    console.error("Download error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to prepare download", message: error.message });
    }
  }
});

router.get("/queue/:id/items/:itemId/download", async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const query = await getMetadataById(Number(id));
    if (!query) return res.status(404).json({ error: "Query not found" });

    const item = (query.searchResults ?? []).find((r) => r.id === Number(itemId));
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== "completed") {
      return res.status(409).json({ error: "File has not been downloaded yet." });
    }

    const filePath = await findDownloadedFile(Number(id), item.fileName);
    if (!filePath) {
      return res.status(404).json({ error: "File not found on disk." });
    }

    const ext = filePath.split(".").pop();
    const filename = `${item.fileName}${ext ? `.${ext}` : ""}`;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.sendFile(filePath);
  } catch (error) {
    console.error("Item download error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to prepare download", message: error.message });
    }
  }
});

export default router;

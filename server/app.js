import express from "express";
import QueueController from "./controllers/queue.controller.js";

const app = express();

app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api", QueueController);

export default app;

import express from "express";
import QueueController from "./controllers/queue.controller.js";
import { config } from "./config.js";
import { checkReadiness } from "./services/health.service.js";

/**
 * Creates the HTTP application with injectable readiness checks. Keeping the
 * dependency boundary here makes health behavior testable without starting
 * Redis, Playwright, or a real HTTP listener.
 *
 * @param {{ readinessCheck?: typeof checkReadiness }} [options]
 */
export function createApp({ readinessCheck = checkReadiness } = {}) {
  const app = express();

  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    let result;
    try {
      result = await readinessCheck();
    } catch (error) {
      result = {
        ready: false,
        checks: { application: { status: "error", message: error.message } },
      };
    }
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
    });
  });

  app.use("/api", QueueController);

  // Keep malformed/oversized JSON responses machine-readable. Route handlers
  // already handle their own operational errors; this catches parser errors
  // before Express reaches them.
  app.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large" });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
    return next(error);
  });

  return app;
}

const app = createApp();
export default app;

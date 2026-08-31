import { metadataQueue, searchQueue, downloadQueue, connection } from "./queue.js";
import { prisma } from "./services/db.service.js";
import { shutdownBrowser } from "./services/browser.service.js";

const DEFAULT_QUEUES = [metadataQueue, searchQueue, downloadQueue];

/**
 * Creates an idempotent shutdown function for one running application.
 * Shutdown stages are deliberately sequential:
 *
 * HTTP → workers → queues → browser → Redis → SQLite
 *
 * This prevents new requests from adding work while workers are being closed,
 * and prevents a database/Redis client from disappearing underneath a worker
 * that is still draining. Every stage is attempted even when an earlier
 * resource reports an error.
 *
 * @param {{
 *   server?: object,
 *   workers?: unknown,
 *   queues?: unknown,
 *   browser?: () => Promise<unknown>,
 *   redis?: object,
 *   database?: object,
 *   logger?: Pick<Console, "error">,
 * }} [options]
 * @returns {(reason?: string) => Promise<void>}
 */
export function createShutdownHandler({
  server,
  workers = [],
  queues = DEFAULT_QUEUES,
  browser = shutdownBrowser,
  redis = connection,
  database = prisma,
  logger = console,
} = {}) {
  let shutdownPromise;

  return async function shutdown(reason = "shutdown") {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      await closeResource("HTTP server", () => closeHttpServer(server), logger, reason);
      await closeResources("worker", collectResources(workers), logger, reason);
      await closeResources("queue", collectResources(queues), logger, reason);
      await closeResource("browser", browser, logger, reason);
      await closeResource("Redis", () => closeRedis(redis), logger, reason);
      await closeResource("SQLite", () => disconnectDatabase(database), logger, reason);
    })();

    return shutdownPromise;
  };
}

/**
 * Registers the only process-level shutdown hooks used by the application.
 * Browser services intentionally do not register their own hooks; this
 * function owns the complete dependency order and returns an unregister
 * function for tests and embedded callers.
 *
 * @param {(signal?: string) => Promise<void>} shutdown
 * @param {{ process?: NodeJS.Process, logger?: Pick<Console, "error"> }} [options]
 * @returns {() => void}
 */
export function installShutdownHandlers(
  shutdown,
  { process: processObject = process, logger = console } = {}
) {
  const handlers = new Map();

  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => {
      void shutdown(signal).catch((error) => {
        logger.error(`[Lifecycle] ${signal} shutdown failed:`, error);
      });
    };
    handlers.set(signal, handler);
    processObject.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      processObject.removeListener(signal, handler);
    }
  };
}

/**
 * Extracts closeable resources from either resource instances or ES module
 * namespaces returned by dynamic worker imports.
 *
 * @param {unknown} value
 * @returns {object[]}
 */
export function collectResources(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const resources = [];

  for (const candidate of candidates) {
    if (candidate && typeof candidate.close === "function") {
      resources.push(candidate);
      continue;
    }

    if (candidate && typeof candidate === "object") {
      resources.push(
        ...Object.values(candidate).filter(
          (resource) => resource && typeof resource.close === "function"
        )
      );
    }
  }

  return [...new Set(resources)];
}

async function closeResources(kind, resources, logger, reason) {
  for (const resource of resources) {
    await closeResource(kind, () => resource.close(), logger, reason);
  }
}

async function closeResource(kind, operation, logger, reason) {
  if (typeof operation !== "function") return;

  try {
    await operation();
  } catch (error) {
    // Shutdown is best-effort but ordered: a broken worker must not prevent
    // Redis and SQLite from being released.
    logger.error(`[Lifecycle] Failed to close ${kind} during ${reason}:`, error);
  }
}

async function closeHttpServer(server) {
  if (!server || typeof server.close !== "function") return;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };

    try {
      const result = server.close(finish);
      if (result && typeof result.then === "function") {
        result.then(() => finish(), finish);
      } else if (server.close.length === 0) {
        // Small fakes and embedded HTTP adapters often expose a synchronous
        // zero-argument close method rather than Node's callback API.
        finish();
      }
    } catch (error) {
      finish(error);
    }
  });
}

async function closeRedis(redis) {
  if (!redis) return;
  if (typeof redis.quit === "function") {
    await redis.quit();
  } else if (typeof redis.disconnect === "function") {
    redis.disconnect();
  }
}

async function disconnectDatabase(database) {
  if (database && typeof database.$disconnect === "function") {
    await database.$disconnect();
  }
}

import app from "./app.js";
import { config } from "./config.js";
import { recoverOnStartup } from "./services/startup-recovery.service.js";
import { createShutdownHandler, collectResources, installShutdownHandlers } from "./lifecycle.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const port = config.serverPort;

// Set umask to allow group write permissions for created files and directories
process.umask(0o002);

/**
 * Performs startup recovery before importing worker modules. Worker modules
 * construct BullMQ Workers as an import side effect, so keeping those imports
 * dynamic is what prevents a worker from accepting a retained Redis job while
 * SQLite/filesystem reconciliation is still in progress.
 *
 * @param {{
 *   listen?: boolean,
 *   recover?: typeof recoverOnStartup,
 *   loadWorkers?: () => Promise<unknown>,
 *   application?: typeof app,
 *   installSignals?: boolean,
 *   createShutdown?: typeof createShutdownHandler,
 *   registerShutdownHandlers?: typeof installShutdownHandlers,
 * }} [options]
 * @returns {Promise<import("http").Server|object>}
 */
export async function startApplication({
  listen = true,
  recover = recoverOnStartup,
  loadWorkers = loadWorkerModules,
  application = app,
  installSignals = listen,
  createShutdown = createShutdownHandler,
  registerShutdownHandlers = installShutdownHandlers,
} = {}) {
  await recover();

  const workers = await loadWorkers();

  if (!listen) return workers;

  const server = application.listen(port, () => {
    console.log(`NLR-AUTODOWNLOADER listening on port ${port}`);
  });

  const shutdown = createShutdown({
    server,
    workers: collectResources(workers),
  });
  const unregisterShutdownHandlers = installSignals ? registerShutdownHandlers(shutdown) : () => {};

  if (typeof server.once === "function") {
    server.once("close", unregisterShutdownHandlers);
  }

  // Keep the normal Node HTTP server return value while exposing lifecycle
  // controls for embedding and deterministic tests.
  server.shutdown = shutdown;
  server.unregisterShutdownHandlers = unregisterShutdownHandlers;
  return server;
}

async function loadWorkerModules() {
  return Promise.all([
    import("./workers/metadata.worker.js"),
    import("./workers/search.worker.js"),
    import("./workers/download.worker.js"),
  ]);
}

// Keep importing this module side-effect free for tests and tooling. The
// production `node index.js` entry point still starts the application here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startApplication();
}

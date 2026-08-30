/**
 * Runtime configuration shared by the HTTP server, workers, and services.
 *
 * Keeping environment parsing here makes the runtime boundary explicit and
 * lets tests provide isolated directories without changing application code.
 */
function parseInteger(value, fallback) {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value, fallback) {
  if (!value) return Object.freeze([...fallback]);

  const values = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return Object.freeze(values.length > 0 ? values : [...fallback]);
}

export const config = Object.freeze({
  serverPort: process.env.SERVER_PORT || "3333",
  serverHost: process.env.SERVER_HOST || "127.0.0.1",
  downloadsDir: process.env.DOWNLOADS_DIR || "/data/downloads",
  downloadsHostDir: process.env.DOWNLOADS_HOST_DIR || "./data/downloads",
  jsonBodyLimit: "32kb",
  maxQueueBatchSize: parseInteger(process.env.MAX_QUEUE_BATCH_SIZE, 100),
  readinessTimeoutMs: parseInteger(process.env.READINESS_TIMEOUT_MS, 1000),
  allowedNlrHosts: parseList(process.env.NLR_ALLOWED_HOSTS, ["primo.nlr.ru"]),
  concurrentDownloads: parseInteger(process.env.CONCURRENT_DOWNLOADS, 2) || 1,
  maxDownloadAttempts: parseInteger(process.env.MAX_DOWNLOAD_ATTEMPTS, 10),
  retryBaseDelayMs: parseInteger(process.env.RETRY_BASE_DELAY_MS, 5000),
  retryMaxDelayMs: parseInteger(process.env.RETRY_MAX_DELAY_MS, 30000),
  maxBrowserContexts: parseInteger(process.env.MAX_BROWSER_CONTEXTS, 3),
  downloadPreparationTimeoutMs: parseInteger(process.env.DOWNLOAD_PREPARATION_TIMEOUT_MS, 120_000),
  downloadEventTimeoutMs: parseInteger(process.env.DOWNLOAD_EVENT_TIMEOUT_MS, 30_000),
  playwrightHeadless:
    process.env.PLAYWRIGHT_HEADLESS === undefined || process.env.PLAYWRIGHT_HEADLESS === "true",
  scrapePageDelayMs: parseInteger(process.env.SCRAPE_PAGE_DELAY_MS, 1200),
  downloadStartJitterMs: parseInteger(process.env.DOWNLOAD_START_JITTER_MS, 1500),
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInteger(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInteger(process.env.REDIS_DB, 0),
  },
});

export const { downloadsDir } = config;

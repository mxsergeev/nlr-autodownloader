/**
 * Runtime configuration shared by the HTTP server, workers, and services.
 *
 * Keeping environment parsing here makes the runtime boundary explicit and
 * lets tests provide isolated directories without changing application code.
 */
function parseInteger(value, fallback) {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return parsed;
}

export const config = Object.freeze({
  serverPort: process.env.SERVER_PORT || "3333",
  downloadsDir: process.env.DOWNLOADS_DIR || "/data/downloads",
  concurrentDownloads: parseInteger(process.env.CONCURRENT_DOWNLOADS, 2) || 1,
  maxDownloadAttempts: parseInteger(process.env.MAX_DOWNLOAD_ATTEMPTS, 10),
  retryBaseDelayMs: parseInteger(process.env.RETRY_BASE_DELAY_MS, 5000),
  retryMaxDelayMs: parseInteger(process.env.RETRY_MAX_DELAY_MS, 30000),
  maxBrowserContexts: parseInteger(process.env.MAX_BROWSER_CONTEXTS, 3),
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

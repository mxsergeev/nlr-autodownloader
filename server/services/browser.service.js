import { firefox } from "playwright";
import UserAgent from "user-agents";
import { config } from "../config.js";

const MAX_BROWSER_CONTEXTS = config.maxBrowserContexts;

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
];

// Weighted toward Moscow to match expected Russian user geography
const TIMEZONES = [
  "Europe/Moscow",
  "Europe/Moscow",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Europe/Kaliningrad",
];

// Simple semaphore to limit concurrent browser contexts across all workers
let activeContexts = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeContexts < MAX_BROWSER_CONTEXTS) {
    activeContexts++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next();
  } else {
    activeContexts--;
  }
}

let browser;

async function startBrowser() {
  if (browser && browser.isConnected()) return;

  if (browser) {
    await shutdownBrowser();
  }

  // Firefox is much more consistent in headless mode than Chromium. The
  // Chromium-only command-line switches previously passed here do nothing for
  // Firefox and can obscure the real reason a root-owned test container fails
  // to start content processes. Keep sandboxing enabled by default; the
  // opt-in root fallback is limited to environments where the kernel forbids
  // Firefox's user-namespace sandbox (production Docker runs as non-root).
  const launchOptions = {
    headless: config.playwrightHeadless,
  };
  if (process.getuid?.() === 0 && process.env.MOZ_DISABLE_CONTENT_SANDBOX === undefined) {
    launchOptions.env = { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" };
  }

  browser = await firefox.launch(launchOptions);
}

/**
 * Closes the shared browser instance. Process signal ownership belongs to the
 * application lifecycle module so there is exactly one shutdown coordinator.
 */
export async function shutdownBrowser() {
  if (!browser) return;
  await browser.close().catch(() => {});
  browser = undefined;
}

/**
 * Runs a Playwright job in a fresh browser context with a random desktop user agent.
 * Restarts the browser automatically if it has disconnected.
 * Respects a global concurrency limit (MAX_BROWSER_CONTEXTS) to avoid overloading
 * low-resource hardware.
 * @template T
 * @param {(page: import('playwright').Page, context: import('playwright').BrowserContext) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runJob(fn) {
  await acquireSlot();

  try {
    if (!browser || !browser.isConnected()) await startBrowser();

    let context;

    const userAgent = new UserAgent({ deviceCategory: "desktop" });
    const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    const timezoneId = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
    const contextOptions = {
      userAgent: userAgent.toString(),
      viewport,
      timezoneId,
      locale: "ru-RU",
    };
    if (
      process.env.RUN_LIVE_NLR_TESTS === "1" &&
      process.env.NLR_LIVE_IGNORE_HTTPS_ERRORS === "1"
    ) {
      contextOptions.ignoreHTTPSErrors = true;
    }

    try {
      context = await browser.newContext(contextOptions);
    } catch {
      // try restarting once
      await shutdownBrowser();
      await startBrowser();
      context = await browser.newContext(contextOptions);
    }

    const page = await context.newPage();
    try {
      return await fn(page, context);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    releaseSlot();
  }
}

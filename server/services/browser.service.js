import { firefox } from "playwright";
import UserAgent from "user-agents";

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

let browser;

async function startBrowser() {
  if (browser && browser.isConnected()) return;

  if (browser) {
    await stopBrowser();
  }

  let headless;

  if (process.env.PLAYWRIGHT_HEADLESS !== undefined) {
    headless = process.env.PLAYWRIGHT_HEADLESS === "true";
  } else {
    headless = true;
  }

  // Firefox is much more consistent in headless mode than Chromium
  browser = await firefox.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

async function stopBrowser() {
  if (!browser) return;
  await browser.close().catch(() => {});
  browser = undefined;
}

/**
 * Runs a Playwright job in a fresh browser context with a random desktop user agent.
 * Restarts the browser automatically if it has disconnected.
 * @template T
 * @param {(page: import('playwright').Page, context: import('playwright').BrowserContext) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runJob(fn) {
  if (!browser || !browser.isConnected()) await startBrowser();

  let context;

  const userAgent = new UserAgent({ deviceCategory: "desktop" });
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
  const timezoneId = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
  const contextOptions = { userAgent: userAgent.toString(), viewport, timezoneId, locale: "ru-RU" };

  try {
    context = await browser.newContext(contextOptions);
  } catch {
    // try restarting once
    await stopBrowser();
    await startBrowser();
    context = await browser.newContext(contextOptions);
  }

  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await context.close().catch(() => {});
  }
}

import { chromium } from 'playwright'

/** @type {import('playwright').Browser | null} */
let browser = null

/** @type {import('playwright').Page | null} */
let page = null

/** @returns {Promise<void>} */
export async function startBrowser() {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage()
}

/** @returns {Promise<void>} */
export async function stopBrowser() {
  if (page) {
    await page.close()
    page = null
  }
  if (browser) {
    await browser.close()
    browser = null
  }
}

/**
 * Returns the current Playwright page instance.
 * Throws if the browser has not been started.
 * @returns {import('playwright').Page}
 */
export function getPage() {
  if (!page) throw new Error('Browser not started')
  return page
}

/**
 * Returns true if the browser is currently running.
 * @returns {boolean}
 */
export function isBrowserRunning() {
  return browser !== null && page !== null
}

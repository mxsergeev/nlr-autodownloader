import { firefox } from 'playwright'
import UserAgent from 'user-agents'

let browser

async function startBrowser() {
  if (browser && browser.isConnected()) return

  if (browser) {
    await stopBrowser()
  }

  let headless

  if (process.env.PLAYWRIGHT_HEADLESS !== undefined) {
    headless = process.env.PLAYWRIGHT_HEADLESS === 'true'
  } else {
    headless = true
  }

  // Firefox is much more consistent in headless mode than Chromium
  browser = await firefox.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
}

async function stopBrowser() {
  if (!browser) return
  await browser.close().catch(() => {})
  browser = undefined
}

/**
 * Runs a Playwright job in a fresh browser context with a random desktop user agent.
 * Restarts the browser automatically if it has disconnected.
 * @template T
 * @param {(page: import('playwright').Page, context: import('playwright').BrowserContext) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runJob(fn) {
  if (!browser || !browser.isConnected()) await startBrowser()

  let context

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })

  try {
    context = await browser.newContext({ userAgent: userAgent.toString() })
  } catch {
    // try restarting once
    await stopBrowser()
    await startBrowser()
    context = await browser.newContext({ userAgent: userAgent.toString() })
  }

  const page = await context.newPage()
  try {
    return await fn(page, context)
  } finally {
    await context.close().catch(() => {})
  }
}

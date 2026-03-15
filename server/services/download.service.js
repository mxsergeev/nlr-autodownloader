import { firefox } from 'playwright'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import UserAgent from 'user-agents'
import { getMetadata, upsertMetadata, deleteMetadata as dbDeleteQuery, saveSearchResults } from './db.service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR = path.join(__dirname, '..', '..', 'data')
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o775 })

export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads')
await fs.mkdir(DOWNLOADS_DIR, { recursive: true, mode: 0o775 })

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || '2', 10) || 1

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

async function runJob(fn) {
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

export async function scrapMetadata({ url } = {}) {
  return runJob(async (page) => {
    await page.goto(url)

    await page
      .getByRole('button', { name: 'Сортировать по Релевантность' })
      .click({ timeout: 5000 })
      .catch(() => {
        throw new Error('No results found for the given search criteria.')
      })
    await page.getByRole('option', { name: 'Дата выхода периодики (по возр.)' }).click()

    await page.waitForSelector('.item-title', { timeout: 15000 }).catch(() => {
      throw new Error('No results found for the given search criteria.')
    })

    const resultCount = await page.locator('.results-count', { hasText: 'результат' }).textContent()

    // Extract the number using regex
    const match = resultCount.match(/(\d+)/)
    const resultNumber = match ? parseInt(match[1], 10) : null

    const resultsPerPart = await page.locator('.item-title').count()

    const parts = resultNumber ? Math.ceil(resultNumber / resultsPerPart) : 1

    const finalUrl = page.url()

    const metadata = {
      results: resultNumber,
      resultsPerPart,
      parts,
      pageUrl: finalUrl,
    }

    return metadata
  })
}

/**
 * Queue a query without performing heavy scraping now.
 * Creates a minimal metadata record with status 'pending' so the query is resumed on server start or by the watcher.
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await getMetadata(params)

  if (existing && existing.status !== 'search_failed') return existing

  const metadata = {
    results: null,
    resultsPerPart: null,
    parts: null,
    pageUrl: params.url,
    createdAt: new Date(),
    order: Date.now() + order,
    status: 'pending',
  }

  const record = await upsertMetadata({ url: params.url }, metadata)

  return record
}

export async function scrapSearchResults(metadata, { doneParts = new Set(), scrapedUrls = new Set() } = {}) {
  return runJob(async (page) => {
    const seenUrls = new Set(scrapedUrls)
    const results = []

    for (let curPart = 1; curPart <= (metadata.parts || 1); curPart++) {
      await page.goto(metadata.pageUrl.replace(/offset=\d+/, `offset=${(curPart - 1) * metadata.resultsPerPart}`))

      await page.waitForSelector('.item-title', { timeout: 15000 })

      const headings = page.locator('.item-title')
      const headingData = await headings.evaluateAll((elements) => {
        return elements.map((element) => {
          const anchor = element.querySelector('a')
          const rawText = element.textContent.trim()
          const cleanText = rawText.replace(/^[=\s]+/, '').replace(/\s+/g, ' ')

          return {
            title: cleanText,
            href: anchor ? anchor.href : null,
          }
        })
      })

      headingData.forEach((item) => {
        item.fileName = sanitizeFileName(item.title)
      })

      for (const item of headingData) {
        if (item.href && !seenUrls.has(item.href)) {
          seenUrls.add(item.href)
          results.push(item)
        }
      }
    }

    // Persist results to DB
    await saveSearchResults({ queryId: metadata.id }, results)

    return results
  })
}

export function verifySearchResults(results, metadata) {
  const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null
  const isFresh = createdAt && createdAt > new Date(Date.now() - 24 * 60 * 60 * 1000)

  if (!isFresh) {
    console.warn(
      `[${queryToString({ id: metadata.id })}] Warning: Search results are older than 24 hours. Consider refreshing the search results.`,
    )
    return false
  }

  if (results.length !== metadata.results) {
    console.warn(
      `[${queryToString({ id: metadata.id })}] Warning: Expected ${metadata.results} results, but got ${results.length}.`,
    )
    return false
  }

  const seenUrls = new Set()
  const duplicates = []

  for (const item of results) {
    if (seenUrls.has(item.href)) {
      duplicates.push(item.href)
    } else {
      seenUrls.add(item.href)
    }
  }

  if (duplicates.length > 0) {
    console.warn(
      `[${queryToString({ id: metadata.id })}] Warning: Found ${duplicates.length} duplicate items in the results.`,
    )
    return false
  }

  return true
}

export async function removeQuery(params, { removeDownloads = true } = {}) {
  await dbDeleteQuery(params)
  if (removeDownloads) {
    const dir = path.join(DOWNLOADS_DIR, queryToString(params))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function sanitizeFileName(name = '') {
  name = name.replace(/[/\\?%*:|"<>]/g, '_')
  // Check if there a file extension
  const lastDotIndex = name.lastIndexOf('.')

  if (lastDotIndex > 0) {
    const base = name.substring(0, lastDotIndex).replace(/\./g, '')
    const ext = name.substring(lastDotIndex + 1)

    // Check if extension is valid (only letters) and not some garbage
    if (/^[a-zA-Z]+$/.test(ext)) {
      return base + '.' + ext
    } else {
      // If not a valid extension, treat as no extension
      return name.replace(/\./g, '')
    }
  } else {
    return name.replace(/\./g, '')
  }
}

export function queryToString(params) {
  // Prefer numeric id as canonical filesystem key
  if (typeof params === 'number') return String(params)
  if (params && params.id !== undefined && params.id !== null) return String(params.id)
  // Fallback to sanitized pageUrl if no id available (should be avoided)
  const url = params && (params.url || params.pageUrl)
  if (url)
    return url
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '_')
  return ''
}

export async function scrapDownload(item, storageDir) {
  return runJob(async (page) => {
    let page1 = null
    let page2 = null
    try {
      await page.goto(item.href)
      const page1Promise = page.waitForEvent('popup').catch(() => {})
      await page.getByLabel('Электронная копия').click()
      page1 = await page1Promise
      await page1.getByRole('link', { name: 'Карточка' }).click()
      await page1.locator('#btn-download').click()

      // Set up event listeners before clicking, but don't await yet
      const page2Promise = page1.waitForEvent('popup', { timeout: 30000 }).catch(() => {})
      const downloadPromise = page1.waitForEvent('download', { timeout: 30000 }).catch(() => {})

      await page1
        .getByLabel('Загрузка всего документа')
        .getByRole('link', { name: 'Скачать' })
        .click({ timeout: 30000 })
        .catch(() => {
          throw new Error('Download blocked')
        })

      page2 = await page2Promise
      const file = await downloadPromise

      const fileName = sanitizeFileName(item.fileName)
      const filePath = path.join(storageDir, `${fileName}.pdf`)
      await file.saveAs(filePath)

      await fs.chmod(filePath, 0o664)
    } finally {
      // Clean up opened pages to prevent lingering promises
      if (page2) await page2.close()
      if (page1) await page1.close()
    }
  })
}

export async function getDownloadedFileNames(metadata) {
  const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString())
  try {
    return new Set((await fs.readdir(storageDir)).map((file) => path.parse(file).name))
  } catch (err) {
    if (err.code === 'ENOENT') return new Set()
    throw err
  }
}

export function verifyDownloads(downloads = new Set(), searchResults) {
  const missingFiles = searchResults.filter((item) => !downloads.has(item.fileName))

  return { missingFiles }
}

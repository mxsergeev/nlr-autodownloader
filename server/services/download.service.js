import { firefox } from 'playwright'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import UserAgent from 'user-agents'
import {
  getQuery,
  upsertQuery,
  getAllQueries,
  deleteQuery as dbDeleteQuery,
  getSearchResults,
  saveSearchResults,
} from './db.service.js'

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

export async function loadQueriesMetadata() {
  return getAllQueries()
}

// Downloads watcher: periodically generates a README.md in DOWNLOADS_DIR with progress info
let downloadsWatcherIntervalId = null
let downloadsWatcherRunning = false
const DOWNLOADS_WATCHER_INTERVAL = parseInt(process.env.DOWNLOADS_WATCHER_INTERVAL || '60000', 10)

export function startDownloadsWatcher(intervalMs = DOWNLOADS_WATCHER_INTERVAL) {
  if (downloadsWatcherIntervalId) return

  async function checkDownloads() {
    if (downloadsWatcherRunning) return
    downloadsWatcherRunning = true
    try {
      await generateDownloadsReport()
    } catch (err) {
      console.error('Error while generating downloads report:', err)
    } finally {
      downloadsWatcherRunning = false
    }
  }

  // Run immediately, then periodically
  checkDownloads()
  downloadsWatcherIntervalId = setInterval(checkDownloads, intervalMs)
  console.log(`Downloads watcher started (interval: ${intervalMs}ms)`)
}

export function stopDownloadsWatcher() {
  if (!downloadsWatcherIntervalId) return
  clearInterval(downloadsWatcherIntervalId)
  downloadsWatcherIntervalId = null
  downloadsWatcherRunning = false
  console.log('Downloads watcher stopped')
}

async function generateDownloadsReport() {
  const metadataList = await loadQueriesMetadata()
  // Convert prisma records into a map keyed by the query id string. Ensure order is a Number for in-memory sorting.
  const metadataMap = new Map(
    metadataList.map((m) => [queryToString({ id: m.id }), { ...m, order: m.order !== undefined ? Number(m.order) : 0 }]),
  )

  const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  const rows = []

  for (const dirName of dirs) {
    const meta = metadataMap.get(dirName)

    const storageDir = path.join(DOWNLOADS_DIR, dirName)
    let downloaded = 0
    try {
      downloaded = (await fs.readdir(storageDir)).length
    } catch {
      downloaded = 0
    }

    if (!meta) {
      // No metadata -> completed. Report actual downloaded file count and mark as completed.
      rows.push({
        name: dirName,
        status: 'completed',
        downloaded,
        total: downloaded,
        progress: '100%',
        order: Number.MAX_SAFE_INTEGER,
      })
      continue
    }

    const total = meta.results || 0
    const progress = total > 0 ? `${((downloaded / total) * 100).toFixed(2)}%` : 'N/A'
    rows.push({
      name: dirName,
      status: meta.status || 'pending',
      downloaded,
      total,
      progress,
      order: Number(meta.order) || 0,
    })
  }

  // Also include queries that have metadata but no folder yet
  for (const [name, meta] of metadataMap.entries()) {
    if (!dirs.includes(name)) {
      rows.push({
        name,
        status: meta.status || 'pending',
        downloaded: 0,
        total: meta.results || 0,
        progress: meta.results ? '0.00%' : 'N/A',
        order: Number(meta.order) || 0,
      })
    }
  }

  // Put completed downloads to the bottom; otherwise sort by order then name
  rows.sort((a, b) => {
    const aDone = a.status === 'completed' ? 1 : 0
    const bDone = b.status === 'completed' ? 1 : 0
    if (aDone !== bDone) return aDone - bDone

    const ao = a.order ?? 0
    const bo = b.order ?? 0
    if (ao !== bo) return ao - bo

    return a.name.localeCompare(b.name)
  })

  const header = `# Downloads report\n\nGenerated at: ${new Date().toISOString()}\n\n`
  const lines = rows.map((r) => `${r.name} | ${r.status} | ${r.downloaded}/${r.total} | ${r.progress}`).join('\n')

  const content = header + lines + '\n'

  // Write report atomically and only if contents changed to avoid frequent overwrites
  const reportName = process.env.DOWNLOADS_REPORT_NAME || 'progress.md'
  const finalPath = path.join(DOWNLOADS_DIR, reportName)

  try {
    const existing = await fs.readFile(finalPath, 'utf-8').catch(() => null)
    if (existing && existing.split(/Generated at: .+\n/)[1]?.trim() === content.split(/Generated at: .+\n/)[1].trim()) {
      // No change, skip writing to prevent Nextcloud/clients conflict
      return
    }
  } catch (err) {
    // ignore and proceed to write
  }

  const tmpPath = finalPath + '.tmp'
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.chmod(tmpPath, 0o664)
  await fs.rename(tmpPath, finalPath)
  console.log(`Downloads report updated: ${finalPath}`)
}

async function scrapMetadata(params) {
  // Try to find existing record to get pageUrl if needed
  const existing = await getQuery(params)
  const pageUrl = params && params.url ? params.url : existing?.pageUrl
  if (!pageUrl) throw new Error('No pageUrl provided to scrap metadata')

  console.log(`[${queryToString(params)}] Scraping metadata for ${pageUrl}`)

  return runJob(async (page) => {
    await page.goto(pageUrl)

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

export async function writeMetadata(params, metadata) {
  return upsertQuery(params, metadata)
}

export async function readMetadata(params) {
  return getQuery(params)
}

export async function loadMetadata(params) {
  const existingMetadata = await readMetadata(params)

  if (existingMetadata && existingMetadata.results !== null) {
    return existingMetadata
  }

  try {
    const metadata = await scrapMetadata(params)

    // Use Date objects in the new Prisma format for createdAt, and normalize order to Number for in-memory logic
    metadata.createdAt = existingMetadata?.createdAt ?? new Date()
    metadata.order = existingMetadata ? Number(existingMetadata.order) : Date.now()
    metadata.status = 'pending'

    // Persist metadata using pageUrl as key (upsert will create or update as needed)
    const updated = await upsertQuery({ url: metadata.pageUrl }, metadata)
    return updated
  } catch (err) {
    if (existingMetadata && err.message.includes('No results found')) {
      console.warn(`[${queryToString(params)}] No results found, removing query.`)
      await removeQuery(params)
    }

    throw new Error(err)
  }
}

/**
 * Queue a query without performing heavy scraping now.
 * Creates a minimal metadata record with status 'pending' so the query is resumed on server start or by the watcher.
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await readMetadata(params)
  if (existing && existing.status !== 'search_failed') return existing

  if (params && params.id) {
    // Re-queue existing record by id
    const meta = {
      results: existing?.results ?? null,
      resultsPerPart: existing?.resultsPerPart ?? null,
      parts: existing?.parts ?? null,
      pageUrl: existing?.pageUrl ?? null,
      createdAt: existing?.createdAt ?? new Date(),
      order: Date.now() + order,
      status: 'pending',
    }
    await upsertQuery({ id: params.id }, meta)
    return await readMetadata({ id: params.id })
  }

  if (params && params.url) {
    const metadata = {
      results: null,
      resultsPerPart: null,
      parts: null,
      pageUrl: params.url,
      createdAt: new Date(),
      order: Date.now() + order,
      status: 'pending',
    }

    const record = await upsertQuery({ url: params.url }, metadata)
    return record
  }

  throw new Error('Invalid params for queueQuery; expected id or url')
}

async function scrapSearchResults(params, { doneParts = new Set(), scrapedUrls = new Set() } = {}) {
  const metadata = await loadMetadata(params)

  console.log(`[${queryToString(params)}] Scraping search results for ${metadata.results} documents`)

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
    await saveSearchResults(params, results)

    return results
  })
}

function verifySearchResults(results, metadata) {
  const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null
  const isFresh = createdAt && createdAt > new Date(Date.now() - 24 * 60 * 60 * 1000)

  if (!isFresh) {
    console.warn(`[${queryToString({ id: metadata.id })}] Warning: Search results are older than 24 hours. Consider refreshing the search results.`)
    return false
  }

  if (results.length !== metadata.results) {
    console.warn(`[${queryToString({ id: metadata.id })}] Warning: Expected ${metadata.results} results, but got ${results.length}.`)
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
    console.warn(`[${queryToString({ id: metadata.id })}] Warning: Found ${duplicates.length} duplicate items in the results.`)
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

// No filesystem metadata: remove readMetadataByName/removeQueryByName helpers

export async function loadSearchResults(params = {}, { override = false } = {}) {
  if (!params || Object.keys(params).length === 0) {
    throw new Error('No search parameters provided.')
  }

  if (!override) {
    const cached = await getSearchResults(params)
    if (cached && cached.length > 0) {
      const metadata = await loadMetadata(params)
      if (verifySearchResults(cached, metadata)) {
        return cached
      }
    }
  }

  const results = await scrapSearchResults(params)

  const metadata = await loadMetadata(params)

  if (!verifySearchResults(results, metadata)) {
    throw new Error('Search results verification failed.')
  }

  return results
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
  if (params && (params.id !== undefined && params.id !== null)) return String(params.id)
  // Fallback to sanitized pageUrl if no id available (should be avoided)
  const url = params && (params.url || params.pageUrl)
  if (url) return url.toString().trim().replace(/[^a-zA-Z0-9]/g, '_')
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

export async function getDownloadedFileNames(params) {
  const storageDir = path.join(DOWNLOADS_DIR, queryToString(params))
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


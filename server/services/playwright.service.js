import { firefox } from 'playwright'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import UserAgent from 'user-agents'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR = path.join(__dirname, '..', '..', 'data')
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o775 })

const QUERY_DIR = path.join(DATA_DIR, 'queries')
await fs.mkdir(QUERY_DIR, { recursive: true, mode: 0o775 })

const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads')
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
  // find query subdirectories and look for metadata files inside each
  const entries = await fs.readdir(QUERY_DIR, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())

  const results = []

  for (const dir of dirs) {
    const dirPath = path.join(QUERY_DIR, dir.name)
    const files = await fs.readdir(dirPath, { withFileTypes: true })
    const metaFile = files.find((f) => f.isFile() && f.name.endsWith('.metadata.json'))

    if (!metaFile) continue

    const metaFilePath = path.join(dirPath, metaFile.name)
    try {
      const metadata = JSON.parse(await fs.readFile(metaFilePath, 'utf-8'))
      results.push(metadata)
    } catch (err) {
      console.warn(`Failed to read metadata for ${dir.name}:`, err.message)
    }
  }

  // Sort by creation date, oldest first
  results.sort((a, b) => a.order - b.order)

  return results
}

async function startExistingQueries() {
  let metadataList = (await loadQueriesMetadata()).filter((m) => m.status !== 'search_failed')
  let queriesCount = metadataList.length

  // Ensure all queries are marked as 'pending' before starting downloads
  for (const meta of metadataList) {
    if (meta.status === 'pending') {
      continue
    }

    meta.status = 'pending'
    try {
      await writeMetadata(meta.query, meta)
    } catch (err) {
      console.warn(`[${queryToString(meta.query)}] Failed to update status to 'pending': ${err.message}`)
    }
  }

  while (queriesCount > 0) {
    // Process all current queries with a concurrency limit so when one finishes we immediately
    // start the next one instead of waiting for the whole batch to complete.

    // Take a snapshot of the current queue
    const queue = metadataList.splice(0)
    const active = new Set()

    const startTask = async (metadata) => {
      try {
        console.log(`[${queryToString(metadata.query)}] Starting`)
        await download(metadata.query)
      } catch (err) {
        console.error(`[${queryToString(metadata.query)}] Error:`, err.message)
      }
    }

    let idx = 0

    // Start initial workers
    for (; idx < CONCURRENT_DOWNLOADS && idx < queue.length; idx++) {
      const metadata = queue[idx]
      const p = startTask(metadata).finally(() => active.delete(p))
      active.add(p)
    }

    // Whenever a worker finishes, start a new one until queue is exhausted
    while (idx < queue.length) {
      // Wait for any active promise to finish
      await Promise.race(active)
      const metadata = queue[idx++]
      const p = startTask(metadata).finally(() => active.delete(p))
      active.add(p)
    }

    // Wait for remaining active tasks to finish
    await Promise.all(active)

    metadataList = (await loadQueriesMetadata()).filter((m) => m.status !== 'search_failed')
    queriesCount = metadataList.length
  }
}

// Interval-based watcher for new queries
let queryWatcherIntervalId = null
let queryWatcherRunning = false
const QUERY_WATCHER_INTERVAL = parseInt(process.env.QUERY_WATCHER_INTERVAL || '60000', 10)

/**
 * Start a background watcher that periodically checks for new queries and resumes them.
 * intervalMs - milliseconds between checks (default from QUERY_WATCHER_INTERVAL env var)
 */
export function startQueryWatcher(intervalMs = QUERY_WATCHER_INTERVAL) {
  if (queryWatcherIntervalId) return

  async function checkForQueries() {
    if (queryWatcherRunning) return
    queryWatcherRunning = true
    try {
      await startExistingQueries()
    } catch (err) {
      console.error('Error while checking for new queries:', err)
    } finally {
      queryWatcherRunning = false
    }
  }

  // Run immediately, then periodically
  checkForQueries()
  queryWatcherIntervalId = setInterval(checkForQueries, intervalMs)
  console.log(`Query watcher started (interval: ${intervalMs}ms)`)
}

export function stopQueryWatcher() {
  if (!queryWatcherIntervalId) return
  clearInterval(queryWatcherIntervalId)
  queryWatcherIntervalId = null
  queryWatcherRunning = false
  console.log('Query watcher stopped')
}

// Downloads watcher: periodically generates a README.md in DOWNLOADS_DIR with progress info
let downloadsWatcherIntervalId = null
let downloadsWatcherRunning = false
const DOWNLOADS_WATCHER_INTERVAL = parseInt(process.env.DOWNLOADS_WATCHER_INTERVAL || '60000', 10)

/**
 * Start a background watcher that periodically scans DOWNLOADS_DIR and writes a README.md
 * The README contains a table with progress for each query folder. If a folder exists in
 * DOWNLOADS_DIR but has no corresponding metadata it is considered 'completed'.
 */
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
  const metadataMap = new Map(metadataList.map((m) => [queryToString(m.query), m]))

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
      order: meta.order || 0,
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
        order: meta.order || 0,
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
    if (existing === content) {
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
  console.log(`[${queryToString(params)}] Scraping metadata`)

  return runJob(async (page) => {
    await page.goto('https://primo.nlr.ru/')

    await page.getByRole('button', { name: 'Перейти к расширенному поиску' }).click()

    await page.getByRole('button', { name: 'Выберите точную операцию для сложного номера строки 1 содержит' }).click()
    await page.getByRole('option', { name: 'совпадает' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 1' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 1' }).fill(params.q)

    await page.getByRole('button', { name: 'Выберите поле поиска для сложного номера строки 2' }).click()
    await page.getByRole('option', { name: 'Год издания' }).click()
    await page.getByRole('button', { name: 'Выберите точную операцию для сложного номера строки 2 совпадает' }).click()
    await page.getByRole('option', { name: 'совпадает' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 2' }).click()
    await page
      .getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 2' })
      .fill(params.year.toString())

    await page.getByRole('button', { name: 'Отправить поиск' }).click()

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

    const pageUrl = page.url()

    const metadata = {
      query: params,
      results: resultNumber,
      resultsPerPart,
      parts,
      pageUrl,
    }

    return metadata
  })
}

async function writeMetadata(params, metadata) {
  await fs.mkdir(path.join(QUERY_DIR, queryToString(params)), { recursive: true, mode: 0o775 })
  const outputPath = path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.metadata.json`)
  await fs.writeFile(outputPath, JSON.stringify(metadata, null, 2))
}

async function readMetadata(params) {
  try {
    const metadataPath = path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.metadata.json`)
    const metadataContent = await fs.readFile(metadataPath, 'utf-8')
    return JSON.parse(metadataContent)
  } catch {
    return null
  }
}

async function loadMetadata(params) {
  const existingMetadata = await readMetadata(params)

  if (existingMetadata && existingMetadata.results !== null) {
    return existingMetadata
  }

  try {
    const metadata = await scrapMetadata(params)

    metadata.createdAt = existingMetadata?.createdAt ?? new Date().toISOString()
    metadata.order = existingMetadata?.order ?? Date.now()
    metadata.status = 'pending'

    await writeMetadata(params, metadata)

    return metadata
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
 * Creates a minimal metadata file with status 'pending' so the query is resumed on server start or by the watcher.
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await readMetadata(params)
  if (existing && existing.status !== 'search_failed') return existing

  const metadata = {
    query: params,
    results: null,
    resultsPerPart: null,
    parts: null,
    pageUrl: null,
    createdAt: new Date().toISOString(),
    order: Date.now() + order,
    status: 'pending',
  }

  await writeMetadata(params, metadata)
  return metadata
}

async function scrapSearchResults(params, { doneParts = new Set(), scrapedUrls = new Set() } = {}) {
  const metadata = await loadMetadata(params)

  console.log(`[${queryToString(params)}] Scraping search results for ${metadata.results} documents`)

  return runJob(async (page) => {
    const seenUrls = new Set(scrapedUrls)

    for (let curPart = 1; curPart <= metadata.parts; curPart++) {
      if (doneParts.has(curPart)) {
        continue
      }

      await page.goto(metadata.pageUrl.replace(/offset=\d+/, `offset=${(curPart - 1) * metadata.resultsPerPart}`))

      const part = []

      await page.waitForSelector('.item-title', { timeout: 15000 })

      const headings = page.locator('.item-title')
      const headingData = await headings.evaluateAll((elements) => {
        return elements.map((element) => {
          const anchor = element.querySelector('a')
          // Clean up text: remove leading special chars, trim, and normalize whitespace
          const rawText = element.textContent.trim()
          const cleanText = rawText.replace(/^[=\s]+/, '').replace(/\s+/g, ' ')

          return {
            title: cleanText,
            href: anchor ? anchor.href : null,
          }
        })
      })

      // Generate fileName in Node context where sanitizeFileName is defined
      headingData.forEach((item) => {
        item.fileName = sanitizeFileName(item.title)
      })

      // Only add items we haven't seen before
      for (const item of headingData) {
        if (item.href && !seenUrls.has(item.href)) {
          seenUrls.add(item.href)

          part.push(item)
        }
      }

      const outputPath = path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.part${curPart}.json`)
      await fs.writeFile(outputPath, JSON.stringify(part, null, 2))
    }
  })
}

async function getPartFileNames(params) {
  await fs.mkdir(path.join(QUERY_DIR, queryToString(params)), { recursive: true, mode: 0o775 })
  const dir = path.join(QUERY_DIR, queryToString(params))
  const partNames = (await fs.readdir(dir, { withFileTypes: true }))
    .filter(
      (f) =>
        f.isFile() &&
        // Only include files that follow the <query>.partN.json pattern
        f.name.startsWith(`${queryToString(params)}.part`) &&
        /\.part\d+\.json$/.test(f.name),
    )
    .map((f) => path.parse(f.name))
    // Sort by numeric part suffix (natural numeric order for .part1, .part2 ... .part10)
    .sort((a, b) => {
      const re = /\.part(\d+)$/
      const ma = a.name.match(re)
      const mb = b.name.match(re)

      if (ma && mb) {
        return parseInt(ma[1], 10) - parseInt(mb[1], 10)
      }

      // Fallback to name compare
      return a.name.localeCompare(b.name)
    })

  return partNames
}

function verifySearchResults(results, metadata) {
  const isFresh = metadata.createdAt && new Date(metadata.createdAt) > new Date(Date.now() - 24 * 60 * 60 * 1000)

  if (!isFresh) {
    console.warn(
      `[${queryToString(metadata.query)}] Warning: Search results are older than 24 hours. Consider refreshing the search results.`,
    )
    return false
  }

  if (results.length !== metadata.results) {
    console.warn(
      `[${queryToString(metadata.query)}] Warning: Expected ${metadata.results} results, but got ${results.length}.`,
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
      `[${queryToString(metadata.query)}] Warning: Found ${duplicates.length} duplicate items in the results.`,
    )
    return false
  }

  return true
}

async function removeQuery(params) {
  const dir = path.join(QUERY_DIR, queryToString(params))
  await fs.rm(dir, { recursive: true, force: true })
}

async function loadSearchResults(params = {}, { override = false } = {}) {
  if (Object.keys(params).length === 0) {
    throw new Error('No search parameters provided.')
  }

  const dir = path.join(QUERY_DIR, queryToString(params))

  const searchResults = override
    ? null
    : JSON.parse(await fs.readFile(path.join(dir, `${queryToString(params)}.json`), 'utf-8').catch(() => 'null'))

  if (searchResults && searchResults.length > 0) {
    const metadata = await loadMetadata(params)

    if (verifySearchResults(searchResults, metadata)) {
      return searchResults
    }
  }

  let partNames = await getPartFileNames(params)

  // Parse what parts are already done
  const doneParts = new Set()
  for (const part of partNames) {
    const match = part.name.match(/\.part(\d+)$/)
    if (match) {
      doneParts.add(parseInt(match[1], 10))
    }
  }

  await scrapSearchResults(params, { doneParts })

  partNames = await getPartFileNames(params)

  const resultParts = await Promise.all(
    partNames.map((p) => fs.readFile(path.join(dir, p.base), 'utf8').then(JSON.parse)),
  )

  const results = resultParts.flat()

  const metadata = await loadMetadata(params)

  if (!verifySearchResults(results, metadata)) {
    throw new Error('Search results verification failed.')
  }

  // Clean up query parts
  for (const part of partNames) {
    await fs.unlink(path.join(dir, part.base))
  }

  const outputPath = path.join(dir, `${queryToString(params)}.json`)
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2))

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

function queryToString(params) {
  return Object.entries(params)
    .map(([, value]) => value.toString().trim().replace(/\s+/g, '_'))
    .join('_')
}

async function scrapDownload(item, storageDir) {
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

async function getDownloadedFileNames(params) {
  const storageDir = path.join(DOWNLOADS_DIR, queryToString(params))
  try {
    return new Set((await fs.readdir(storageDir)).map((file) => path.parse(file).name))
  } catch (err) {
    if (err.code === 'ENOENT') return new Set()
    throw err
  }
}

function verifyDownloads(downloads = new Set(), searchResults) {
  const missingFiles = searchResults.filter((item) => !downloads.has(item.fileName))

  return { missingFiles }
}

async function download(params = {}) {
  let searchResults = null

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      searchResults = await loadSearchResults(params)
      break
    } catch (err) {
      console.log('err', err)
      if (attempt === 3) {
        console.error(`[${queryToString(params)}] Failed to load search results after multiple attempts.`)
        const metadata = await readMetadata(params)
        metadata.status = 'search_failed'
        await writeMetadata(params, metadata)
        return
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }

  const storageDir = path.join(DOWNLOADS_DIR, queryToString(params))
  await fs.mkdir(storageDir, { recursive: true, mode: 0o775 })

  // Track failure timestamps and abort only if 10 failures occur within the last 5 minutes
  const FAILURE_WINDOW_MS = 5 * 60 * 1000
  let failTimestamps = []

  while (searchResults !== null) {
    const now = Date.now()
    // Keep only failures within the sliding 5-minute window
    failTimestamps = failTimestamps.filter((t) => now - t <= FAILURE_WINDOW_MS)

    if (failTimestamps.length >= 10) {
      console.warn(
        `[${queryToString(params)}] Aborting downloads: ${failTimestamps.length} failures within the last ${FAILURE_WINDOW_MS / 60000} minutes.`,
      )
      break
    }

    let downloads = await getDownloadedFileNames(params)
    let { missingFiles } = verifyDownloads(downloads, searchResults)

    if (missingFiles.length === 0) {
      break
    }

    for (const item of missingFiles) {
      const metadata = await readMetadata(params)
      metadata.lastAttempt = new Date().toISOString()

      try {
        await scrapDownload(item, storageDir)

        console.log(`[${queryToString(params)}] Downloaded: ${item.fileName}`)

        downloads = await getDownloadedFileNames(params)
        missingFiles = verifyDownloads(downloads, searchResults).missingFiles

        const total = metadata.results || 1

        metadata.status = 'downloading'
        metadata.downloaded = downloads.size
        metadata.downloadProgress = parseFloat((((total - missingFiles.length) / total) * 100).toFixed(2)) + '%'

        console.log(
          `[${queryToString(params)}] Progress: ${downloads.size} / ${metadata.results} (${metadata.downloadProgress})`,
        )
      } catch (err) {
        // Record failure timestamp and log
        failTimestamps.push(Date.now())

        console.error(`[${queryToString(params)}] Failed to download: ${item.fileName}. Reason: ${err.message}`)

        metadata.status = 'download_blocked'

        break
      } finally {
        await writeMetadata(params, metadata)
      }
    }
  }

  const { missingFiles } = verifyDownloads(await getDownloadedFileNames(params), searchResults)

  let msg = ''

  if (missingFiles.length > 0) {
    msg = `[${queryToString(params)}] Failed to download ${missingFiles.length} items.}`

    console.warn(msg)
  } else {
    msg = `[${queryToString(params)}] All items downloaded successfully.`

    await removeQuery(params)

    console.log(msg)
  }
}

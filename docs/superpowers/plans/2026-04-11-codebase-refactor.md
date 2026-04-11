# Codebase Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split god files, decouple layers, thin the controller, and centralise frontend API calls — all without changing external behaviour (except renaming `/playwright/...` routes to `/api/...`).

**Architecture:** Server: extract `download.service.js` into four focused services (`browser`, `scraper`, `file`, `query`); strip BullMQ from `db.service.js`; rename and thin `playwright.controller.js` → `queue.controller.js`. Frontend: create `api/queue.api.js`, extract `QueueItem`, `DocumentList`, `StatusChip`, and `useQueueMutations` from the monolithic `QueueList.jsx`.

**Tech Stack:** Node.js ESM, Express, BullMQ, Prisma/PostgreSQL, Playwright, React 19, MUI v6, TanStack Query v5, react-window v2.

**Spec:** `docs/superpowers/specs/2026-04-11-codebase-refactor-design.md`

---

## File Map

### Created
- `shared/types.js` — JSDoc typedefs for `Query` and `SearchResult`
- `server/services/browser.service.js` — Playwright browser lifecycle
- `server/services/file.service.js` — FS utilities and constants
- `server/services/scraper.service.js` — All `scrap*` functions + `verifySearchResults`
- `server/services/query.service.js` — Query business logic: `queueQuery`, `removeQuery`, `retryQuery`, `togglePause`
- `server/controllers/queue.controller.js` — Thin HTTP adapter (replaces `playwright.controller.js`)
- `frontend/src/api/queue.api.js` — Centralised axios calls
- `frontend/src/hooks/useQueueMutations.js` — delete/retry/pause mutations + snackbar state
- `frontend/src/components/StatusChip.jsx` — Shared status chip (used in QueueItem and DocumentList)
- `frontend/src/components/DocumentList.jsx` — Expandable document list
- `frontend/src/components/QueueItem.jsx` — Single queue entry card

### Modified
- `server/services/db.service.js` — Remove BullMQ import; strip job cleanup from `deleteMetadata`
- `server/workers/metadata.worker.js` — Import from `scraper.service`, `query.service`
- `server/workers/search.worker.js` — Import from `scraper.service`
- `server/workers/download.worker.js` — Import from `scraper.service`, `file.service`
- `server/app.js` — Use `queue.controller.js`; mount at `/api`
- `frontend/vite.config.js` — Proxy `/api` instead of `/playwright`
- `frontend/src/App.jsx` — Use `queue.api.js`
- `frontend/src/components/QueueList.jsx` — Thin orchestrator only

### Deleted
- `server/services/download.service.js` — All contents extracted into new services
- `server/controllers/playwright.controller.js` — Replaced by `queue.controller.js`

---

## Task 1: Add `shared/types.js`

**Files:**
- Create: `shared/types.js`

- [ ] **Create `shared/types.js`** with the following content:

```js
/**
 * @typedef {Object} Query
 * @property {number} id
 * @property {string} pageUrl
 * @property {'pending'|'downloading'|'completed'|'download_blocked'|'search_failed'|'paused'} status
 * @property {number|null} results
 * @property {number|null} resultsPerPart
 * @property {number|null} parts
 * @property {number} downloaded
 * @property {string|null} downloadProgress
 * @property {Date|string|null} createdAt
 * @property {Date|string|null} lastAttempt
 * @property {number} order
 * @property {SearchResult[]} searchResults
 */

/**
 * @typedef {Object} SearchResult
 * @property {number} id
 * @property {number} queryId
 * @property {string} title
 * @property {string} href
 * @property {string} fileName
 * @property {string|null} status
 */

export {}
```

- [ ] **Commit**

```bash
git add shared/types.js
git commit -m "feat: add shared JSDoc type definitions for Query and SearchResult"
```

---

## Task 2: Create `server/services/file.service.js`

Extracts all filesystem utilities from `download.service.js`. No Playwright, no Prisma.

**Files:**
- Create: `server/services/file.service.js`

- [ ] **Create `server/services/file.service.js`**:

```js
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR = path.join(__dirname, '..', '..', 'data')
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o775 })

export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads')
await fs.mkdir(DOWNLOADS_DIR, { recursive: true, mode: 0o775 })

/**
 * Returns a Set of base file names (without extension) already downloaded for the given query.
 * Returns an empty Set if the directory does not exist.
 * @param {{ id: number }} metadata
 * @returns {Promise<Set<string>>}
 */
export async function getDownloadedFileNames(metadata) {
  const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString())
  try {
    return new Set((await fs.readdir(storageDir)).map((file) => path.parse(file).name))
  } catch (err) {
    if (err.code === 'ENOENT') return new Set()
    throw err
  }
}

/**
 * Returns search results that have not yet been downloaded.
 * @param {Set<string>} downloads
 * @param {import('../../shared/types.js').SearchResult[]} searchResults
 * @returns {{ missingFiles: import('../../shared/types.js').SearchResult[] }}
 */
export function verifyDownloads(downloads = new Set(), searchResults) {
  return { missingFiles: searchResults.filter((item) => !downloads.has(item.fileName)) }
}

/**
 * Sanitizes a string for use as a file name.
 * Removes invalid characters and cleans up dot-separated extensions.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFileName(name = '') {
  name = name.replace(/[/\\?%*:|"<>]/g, '_')
  const lastDotIndex = name.lastIndexOf('.')

  if (lastDotIndex > 0) {
    const base = name.substring(0, lastDotIndex).replace(/\./g, '')
    const ext = name.substring(lastDotIndex + 1)

    if (/^[a-zA-Z]+$/.test(ext)) {
      return base + '.' + ext
    } else {
      return name.replace(/\./g, '')
    }
  } else {
    return name.replace(/\./g, '')
  }
}

/**
 * Returns a canonical string identifier for a query, used as the filesystem directory name.
 * Prefers numeric id, falls back to sanitized URL.
 * @param {number | { id?: number, url?: string, pageUrl?: string }} params
 * @returns {string}
 */
export function queryToString(params) {
  if (typeof params === 'number') return String(params)
  if (params && params.id !== undefined && params.id !== null) return String(params.id)
  const url = params && (params.url || params.pageUrl)
  if (url) return url.toString().trim().replace(/[^a-zA-Z0-9]/g, '_')
  return ''
}
```

- [ ] **Lint**

```bash
cd server && npm run lint -- services/file.service.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/services/file.service.js
git commit -m "feat: extract file utilities into file.service.js"
```

---

## Task 3: Create `server/services/browser.service.js`

Extracts the Playwright browser singleton and `runJob` from `download.service.js`.

**Files:**
- Create: `server/services/browser.service.js`

- [ ] **Create `server/services/browser.service.js`**:

```js
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
```

- [ ] **Lint**

```bash
cd server && npm run lint -- services/browser.service.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/services/browser.service.js
git commit -m "feat: extract Playwright browser lifecycle into browser.service.js"
```

---

## Task 4: Create `server/services/scraper.service.js`

Extracts all `scrap*` functions and `verifySearchResults` from `download.service.js`.

**Key difference from current code:** `scrapSearchResults` no longer calls `saveSearchResults` — it returns the scraped data and callers decide what to persist. This removes a double-save that existed previously.

**Files:**
- Create: `server/services/scraper.service.js`

- [ ] **Create `server/services/scraper.service.js`**:

```js
import { promises as fs } from 'fs'
import path from 'path'
import { runJob } from './browser.service.js'
import { sanitizeFileName } from './file.service.js'

/**
 * Scrapes query metadata (result count, pagination) from a Primo result page.
 * @param {{ url: string }} params
 * @returns {Promise<{ results: number, resultsPerPart: number, parts: number, pageUrl: string }>}
 */
export async function scrapMetadata({ url } = {}) {
  return runJob(async (page) => {
    await page.goto(url)

    const sortButton = page.getByRole('button', { name: 'Сортировать по Релевантность' })
    const sortButtonExists = await sortButton.isVisible({ timeout: 3000 }).catch(() => false)

    if (sortButtonExists) {
      await sortButton.click({ timeout: 5000 })
      await page.getByRole('option', { name: 'Дата выхода периодики (по возр.)' }).click()
    }

    await page.waitForSelector('.item-title', { timeout: 15000 }).catch(() => {
      throw new Error('No results found for the given search criteria.')
    })

    const resultCount = await page.locator('.results-count', { hasText: 'результат' }).textContent()
    const match = resultCount.match(/(\d+)/)
    const resultNumber = match ? parseInt(match[1], 10) : null
    const resultsPerPart = await page.locator('.item-title').count()
    const parts = resultNumber ? Math.ceil(resultNumber / resultsPerPart) : 1
    const finalUrl = page.url()

    console.log(`[Metadata] Successfully scraped metadata: ${resultNumber} results, ${resultsPerPart} per page, ${parts} parts`)

    return { results: resultNumber, resultsPerPart, parts, pageUrl: finalUrl }
  })
}

/**
 * Scrapes all document links for a query across all pages.
 * Does NOT persist to the database — callers are responsible for saving results.
 * @param {import('../../shared/types.js').Query} metadata
 * @param {{ scrapedUrls?: Set<string> }} [options]
 * @returns {Promise<{ title: string, href: string, fileName: string }[]>}
 */
export async function scrapSearchResults(metadata, { scrapedUrls = new Set() } = {}) {
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
          return { title: cleanText, href: anchor ? anchor.href : null }
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

    return results
  })
}

/**
 * Downloads a single document PDF to the given storage directory.
 * Throws 'Download blocked' if the download button is inaccessible.
 * @param {{ href: string, fileName: string }} item
 * @param {string} storageDir  Absolute path to the directory where the PDF will be saved.
 */
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
      if (page2) await page2.close()
      if (page1) await page1.close()
    }
  })
}

/**
 * Returns true if the scraped results are fresh (< 24 h old) and match the expected count
 * with no duplicates. Logs warnings for each violated condition.
 * @param {import('../../shared/types.js').SearchResult[]} results
 * @param {import('../../shared/types.js').Query} metadata
 * @returns {boolean}
 */
export function verifySearchResults(results, metadata) {
  const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null
  const isFresh = createdAt && createdAt > new Date(Date.now() - 24 * 60 * 60 * 1000)

  if (!isFresh) {
    console.warn(`[${metadata.id}] Warning: Search results are older than 24 hours. Consider refreshing.`)
    return false
  }

  if (results.length !== metadata.results) {
    console.warn(`[${metadata.id}] Warning: Expected ${metadata.results} results, but got ${results.length}.`)
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
    console.warn(`[${metadata.id}] Warning: Found ${duplicates.length} duplicate items in the results.`)
    return false
  }

  return true
}
```

- [ ] **Lint**

```bash
cd server && npm run lint -- services/scraper.service.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/services/scraper.service.js
git commit -m "feat: extract Playwright scraping logic into scraper.service.js"
```

---

## Task 5: Create `server/services/query.service.js`

Business logic for the query lifecycle. Extracts `queueQuery` and `removeQuery` from `download.service.js`, and lifts `retryQuery` / `togglePause` out of the controller.

**Note:** `retryQuery` uses `metadata.pageUrl` (the correct field name). The original controller used `metadata.url` which was a latent bug — this fixes it.

**Files:**
- Create: `server/services/query.service.js`

- [ ] **Create `server/services/query.service.js`**:

```js
import { promises as fs } from 'fs'
import path from 'path'
import { getMetadata, upsertMetadata, deleteMetadata } from './db.service.js'
import { DOWNLOADS_DIR, queryToString } from './file.service.js'
import { searchQueue, downloadQueue } from '../queue.js'
import { addMetadataJob } from '../queues/metadata.queue.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'
import { RETRYABLE_STATUSES } from '../shared/constants.js'

/**
 * Creates or returns an existing Query record. Re-creates if the existing record has
 * status 'search_failed' (allows re-queuing failed queries).
 * @param {{ url: string }} params
 * @param {{ order?: number }} [options]
 * @returns {Promise<import('../../shared/types.js').Query>}
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await getMetadata(params)

  if (existing && existing.status !== 'search_failed') return existing

  return upsertMetadata(
    { url: params.url },
    {
      results: null,
      resultsPerPart: null,
      parts: null,
      pageUrl: params.url,
      createdAt: new Date(),
      order: Date.now() + order,
      status: 'pending',
    },
  )
}

/**
 * Removes a query: cancels its pending BullMQ jobs, deletes the DB record,
 * and optionally removes downloaded files.
 * Silently resolves if the query does not exist.
 * @param {{ id: number }} params
 * @param {{ removeDownloads?: boolean }} [options]
 */
export async function removeQuery(params, { removeDownloads = true } = {}) {
  const metadata = await getMetadata({ id: Number(params.id) })

  if (metadata) {
    const searchJob = await searchQueue.getJob(`search-${metadata.id.toString()}`)
    try {
      if (searchJob) await searchJob.remove()

      if (metadata.searchResults?.length > 0) {
        const downloadJobs = (
          await Promise.allSettled(
            metadata.searchResults.map((j) => downloadQueue.getJob(`download-${j.id.toString()}`)),
          )
        )
          .filter((r) => r.status === 'fulfilled' && r.value)
          .map((r) => r.value)

        await Promise.allSettled(downloadJobs.map((j) => j.remove()))
      }
    } catch (err) {
      console.error(`Error removing jobs for query ${metadata.id}:`, err)
    }
  }

  await deleteMetadata({ id: Number(params.id) })

  if (removeDownloads) {
    const dir = path.join(DOWNLOADS_DIR, queryToString(params))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * Re-queues a query for processing.
 * Throws an Error with `code: 'NOT_FOUND'` if the query does not exist.
 * Throws an Error with `code: 'NOT_RETRYABLE'` (and `.retryableStatuses`) if the status is not retryable.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function retryQuery(id) {
  const metadata = await getMetadata({ id: Number(id) })

  if (!metadata) {
    const err = new Error('Query not found')
    err.code = 'NOT_FOUND'
    throw err
  }

  if (!RETRYABLE_STATUSES.includes(metadata.status)) {
    const err = new Error(`Cannot retry query with status '${metadata.status}'`)
    err.code = 'NOT_RETRYABLE'
    err.retryableStatuses = RETRYABLE_STATUSES
    throw err
  }

  if (metadata.status === 'download_blocked') {
    await addDownloadJobBulk({ metadata, searchResults: metadata.searchResults })
  } else {
    await addMetadataJob({ url: metadata.pageUrl })
  }
}

/**
 * Toggles a query's status between 'paused' and 'pending'.
 * Throws an Error with `code: 'NOT_FOUND'` if the query does not exist.
 * @param {number} id
 * @returns {Promise<{ paused: boolean, id: number, status: string }>}
 */
export async function togglePause(id) {
  const metadata = await getMetadata({ id: Number(id) })

  if (!metadata) {
    const err = new Error('Query not found')
    err.code = 'NOT_FOUND'
    throw err
  }

  const newStatus = metadata.status === 'paused' ? 'pending' : 'paused'
  await upsertMetadata({ id: Number(id) }, { ...metadata, status: newStatus })

  return { paused: newStatus === 'paused', id: Number(id), status: newStatus }
}
```

- [ ] **Lint**

```bash
cd server && npm run lint -- services/query.service.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/services/query.service.js
git commit -m "feat: add query.service.js with queueQuery, removeQuery, retryQuery, togglePause"
```

---

## Task 6: Slim `server/services/db.service.js`

Remove the BullMQ import and strip job cleanup from `deleteMetadata` — that logic now lives in `query.service.removeQuery`.

**Files:**
- Modify: `server/services/db.service.js`

- [ ] **Remove BullMQ import** — delete this line at the top of `db.service.js`:

```js
import { downloadQueue, searchQueue } from '../queue.js'
```

- [ ] **Replace `deleteMetadata`** — replace the entire function with the pure Prisma version:

Replace:
```js
export async function deleteMetadata({ id }) {
  if (!id) {
    return null
  }

  const metadata = await getMetadata({ id: Number(id) })

  if (!metadata) {
    return null
  }

  const searchJob = await searchQueue.getJob(`search-${metadata.id.toString()}`)

  try {
    if (searchJob) {
      await searchJob.remove()
    }

    if (metadata.searchResults?.length > 0) {
      const downloadJobs = (
        await Promise.allSettled(metadata.searchResults.map((j) => downloadQueue.getJob(`download-${j.id.toString()}`)))
      )
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value)

      await Promise.allSettled(downloadJobs.map((j) => j.remove()))
    }

    return prisma.query.delete({ where: { id: Number(id) } }).catch(() => null)
  } catch (err) {
    console.error(`Error removing jobs for query ${metadata.id}:`, err)
    return null
  }
}
```

With:
```js
/**
 * Deletes the Query record and cascades to SearchResults.
 * Resolves to null if the record does not exist or id is missing.
 * Does NOT cancel BullMQ jobs — call query.service.removeQuery for that.
 * @param {{ id?: number }} params
 */
export async function deleteMetadata({ id }) {
  if (!id) return null
  return prisma.query.delete({ where: { id: Number(id) } }).catch(() => null)
}
```

- [ ] **Lint**

```bash
cd server && npm run lint -- services/db.service.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/services/db.service.js
git commit -m "refactor: decouple db.service from BullMQ — deleteMetadata is now pure Prisma"
```

---

## Task 7: Update workers and delete `download.service.js`

Update all three workers to import from the new services, then delete the now-empty `download.service.js`.

**Files:**
- Modify: `server/workers/metadata.worker.js`
- Modify: `server/workers/search.worker.js`
- Modify: `server/workers/download.worker.js`
- Delete: `server/services/download.service.js`

- [ ] **Rewrite `server/workers/metadata.worker.js`**:

```js
import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { getMetadata, upsertMetadata } from '../services/db.service.js'
import { addSearchJob } from '../queues/search.queue.js'
import { queueQuery } from '../services/query.service.js'
import { scrapMetadata } from '../services/scraper.service.js'

export const metadataWorker = new Worker(
  'metadataQueue',
  async (job) => {
    const { url } = job.data

    const existing = await queueQuery({ url })

    if (existing && existing.results > 0 && existing.searchResults.length === existing.results) {
      await addSearchJob({ metadata: existing })
      return existing
    }

    let metadata = await scrapMetadata({ url })

    metadata = await upsertMetadata({ url }, metadata)

    if (metadata && metadata.results > 0) {
      await addSearchJob({ metadata })
    }

    return metadata
  },
  { connection, concurrency: 1 },
)

metadataWorker.on('failed', async (job, err) => {
  const { url } = job?.data || {}
  const metadata = url ? await getMetadata({ url }) : null

  if (metadata && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    await upsertMetadata(
      { id: metadata.id },
      { ...metadata, status: 'search_failed', lastAttempt: new Date() },
    ).catch(() => null)
  }

  console.error(`[Metadata] Job ${job?.id} failed:`, err.message)
})

metadataWorker.on('completed', (job) => {
  console.log(`[Metadata] Job ${job?.id} completed`)
})
```

- [ ] **Rewrite `server/workers/search.worker.js`**:

```js
import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { scrapSearchResults, verifySearchResults } from '../services/scraper.service.js'
import { getMetadata, getSearchResults, saveSearchResults, upsertMetadata } from '../services/db.service.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'

export const searchWorker = new Worker(
  'searchQueue',
  async (job) => {
    const { metadata } = job.data

    let results

    const existing = await getSearchResults({ queryId: metadata.id })

    if (existing.length > 0 && verifySearchResults(existing, metadata)) {
      results = existing
    }

    if (!results) {
      results = await scrapSearchResults(metadata)

      if (verifySearchResults(results, metadata)) {
        await saveSearchResults({ queryId: metadata.id }, results)
      } else {
        throw new Error('Scraped search results do not match expected metadata')
      }
    }

    results = await getSearchResults({ queryId: metadata.id })

    await addDownloadJobBulk({ metadata, searchResults: results })

    return { metadata, searchResults: results }
  },
  { connection, concurrency: 1 },
)

searchWorker.on('failed', async (job, err) => {
  const { metadata } = job?.data || {}

  if (metadata && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    const record = await getMetadata({ id: metadata.id })

    if (record) {
      await upsertMetadata(
        { id: record.id },
        { ...record, status: 'search_failed', lastAttempt: new Date() },
      ).catch(() => null)
    }
  }

  console.error(`[Search] Job ${job?.id} failed:`, err.message)
})

searchWorker.on('completed', (job) => {
  console.log(`[Search] Job ${job?.id} completed`)
})
```

- [ ] **Rewrite `server/workers/download.worker.js`**:

```js
import { Worker } from 'bullmq'
import path from 'path'
import { connection } from '../queue.js'
import { scrapDownload } from '../services/scraper.service.js'
import { DOWNLOADS_DIR, getDownloadedFileNames } from '../services/file.service.js'
import { getMetadata, updateSearchResult, upsertMetadata } from '../services/db.service.js'

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || '2', 10) || 1

async function updateSearchResultStatus(item, status) {
  await updateSearchResult(item.id, { status })
}

async function updateMetadataStatus(md, status) {
  const metadata = await getMetadata({ id: md.id })

  const downloads = await getDownloadedFileNames(metadata)
  const total = metadata.results || 1

  metadata.lastAttempt = new Date()
  metadata.downloaded = downloads.size
  metadata.downloadProgress = parseFloat(((downloads.size / total) * 100).toFixed(2)) + '%'
  metadata.status = downloads.size >= total ? 'completed' : status

  await upsertMetadata({ id: metadata.id }, metadata).catch(() => null)
}

export const downloadWorker = new Worker(
  'downloadQueue',
  async (job) => {
    const { metadata, item } = job.data

    const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString())

    await scrapDownload(item, storageDir)
  },
  { connection, concurrency: CONCURRENT_DOWNLOADS },
)

downloadWorker.on('failed', async (job, err) => {
  const { metadata, item } = job.data || {}

  updateMetadataStatus(metadata, 'download_blocked').catch(() => null)
  updateSearchResultStatus(item, 'download_blocked').catch(() => null)

  console.error(`[Download] Job ${job?.id} failed for ${item?.fileName}:`, err.message)
})

downloadWorker.on('completed', async (job) => {
  const { metadata, item } = job.data || {}

  updateMetadataStatus(metadata, 'downloading').catch(() => null)
  updateSearchResultStatus(item, 'completed').catch(() => null)

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`)
})
```

- [ ] **Delete `server/services/download.service.js`**:

```bash
rm server/services/download.service.js
```

- [ ] **Lint all modified workers**

```bash
cd server && npm run lint -- workers/metadata.worker.js workers/search.worker.js workers/download.worker.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/workers/metadata.worker.js server/workers/search.worker.js server/workers/download.worker.js
git rm server/services/download.service.js
git commit -m "refactor: update workers to import from new services; delete download.service.js"
```

---

## Task 8: Create `queue.controller.js`, update `app.js`, delete `playwright.controller.js`

The controller becomes a thin HTTP adapter. All business decisions live in `query.service.js`.

**Files:**
- Create: `server/controllers/queue.controller.js`
- Modify: `server/app.js`
- Delete: `server/controllers/playwright.controller.js`

- [ ] **Create `server/controllers/queue.controller.js`**:

```js
import express from 'express'
import { getAllMetadata } from '../services/db.service.js'
import { addMetadataJob } from '../queues/metadata.queue.js'
import { removeQuery, retryQuery, togglePause } from '../services/query.service.js'

const router = express.Router()

router.get('/queue', async (req, res) => {
  try {
    const queue = await getAllMetadata()
    res.json({ queue })
  } catch (error) {
    console.error('Queue retrieval error:', error)
    res.status(500).json({ error: 'Failed to retrieve queue', message: error.message, name: error.name })
  }
})

router.post('/queue', async (req, res) => {
  try {
    const { queries = [] } = req.body

    if (queries.length === 0) {
      return res.status(400).json({ error: 'No queries provided' })
    }

    const ops = queries.map(async (q, index) => {
      if (!q.url) {
        return Promise.reject(new Error(`Query at index ${index} is missing 'url' field`))
      }
      return addMetadataJob({ url: q.url })
    })

    const qsResults = await Promise.allSettled(ops)
    const queue = await getAllMetadata()

    res.json({
      failed: qsResults.filter((r) => r.status === 'rejected').map((r) => r.reason),
      queue,
    })
  } catch (error) {
    console.error('Queue error:', error)
    res.status(500).json({ error: 'Queueing failed', message: error.message, name: error.name })
  }
})

router.delete('/queue/:id', async (req, res) => {
  try {
    const { id } = req.params
    await removeQuery({ id: Number(id) })
    res.json({ removed: Number(id) })
  } catch (error) {
    console.error('Query removal error:', error)
    res.status(500).json({ error: 'Failed to remove query', message: error.message })
  }
})

router.post('/queue/:id/retry', async (req, res) => {
  try {
    const { id } = req.params
    await retryQuery(Number(id))
    res.json({ retried: Number(id) })
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message })
    if (error.code === 'NOT_RETRYABLE') {
      return res.status(400).json({ error: error.message, retryableStatuses: error.retryableStatuses })
    }
    console.error('Query retry error:', error)
    res.status(500).json({ error: 'Failed to retry query', message: error.message })
  }
})

router.post('/queue/:id/pause', async (req, res) => {
  try {
    const { id } = req.params
    const result = await togglePause(Number(id))
    res.json(result)
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message })
    console.error('Query pause error:', error)
    res.status(500).json({ error: 'Failed to pause query', message: error.message })
  }
})

export default router
```

- [ ] **Replace all of `server/app.js`** with:

```js
import express from 'express'
import QueueController from './controllers/queue.controller.js'

const app = express()

app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api', QueueController)

export default app
```

- [ ] **Delete `server/controllers/playwright.controller.js`**:

```bash
rm server/controllers/playwright.controller.js
```

- [ ] **Lint**

```bash
cd server && npm run lint -- controllers/queue.controller.js app.js
```

Expected: no errors.

- [ ] **Commit**

```bash
git add server/controllers/queue.controller.js server/app.js
git rm server/controllers/playwright.controller.js
git commit -m "refactor: rename to queue.controller.js, mount at /api, thin HTTP adapter only"
```

---

## Task 9: Update Vite proxy

The frontend proxy must forward `/api` to the server instead of `/playwright`.

**Files:**
- Modify: `frontend/vite.config.js`

- [ ] **In `frontend/vite.config.js`, replace the proxy config**:

Replace:
```js
    proxy: {
      '/playwright': {
        // proxy target is now configurable via VITE_SERVER_HOST / VITE_SERVER_PORT
        target: targetBase,
        changeOrigin: true,
        secure: false,
      },
```

With:
```js
    proxy: {
      '/api': {
        // proxy target is now configurable via VITE_SERVER_HOST / VITE_SERVER_PORT
        target: targetBase,
        changeOrigin: true,
        secure: false,
      },
```

- [ ] **Commit**

```bash
git add frontend/vite.config.js
git commit -m "fix: update Vite proxy from /playwright to /api"
```

---

## Task 10: Create `frontend/src/api/queue.api.js` and update `App.jsx`

Centralise all axios calls in one module. Remove inline HTTP calls from `App.jsx`.

**Files:**
- Create: `frontend/src/api/queue.api.js`
- Modify: `frontend/src/App.jsx`

- [ ] **Create `frontend/src/api/queue.api.js`**:

```js
import axios from 'axios'

/** @returns {Promise<import('../../../shared/types.js').Query[]>} */
export const fetchQueue = () => axios.get('/api/queue').then((r) => r.data.queue ?? [])

/**
 * @param {string} url
 * @returns {Promise<{ failed: any[], queue: import('../../../shared/types.js').Query[] }>}
 */
export const addQuery = (url) => axios.post('/api/queue', { queries: [{ url }] }).then((r) => r.data)

/** @returns {Promise<{ removed: number }>} */
export const deleteQuery = (id) => axios.delete(`/api/queue/${id}`).then((r) => r.data)

/** @returns {Promise<{ retried: number }>} */
export const retryQuery = (id) => axios.post(`/api/queue/${id}/retry`).then((r) => r.data)

/** @returns {Promise<{ paused: boolean, id: number, status: string }>} */
export const pauseQuery = (id) => axios.post(`/api/queue/${id}/pause`).then((r) => r.data)
```

- [ ] **Update `frontend/src/App.jsx`** — replace the `fetchQueue` function and the `useMutation` `mutationFn` to use the new api module.

Remove these lines near the top of `App.jsx`:
```js
import axios from 'axios'
```
```js
const fetchQueue = async () => {
  const { data } = await axios.get('/playwright/queue')
  return data.queue || []
}
```

Add import at the top:
```js
import { fetchQueue, addQuery } from './api/queue.api.js'
```

Replace the mutation's `mutationFn`:
```js
    mutationFn: async (url) => {
      const { data } = await axios.post('/playwright/queue', {
        queries: [{ url }],
      })
      return data
    },
```
With:
```js
    mutationFn: (url) => addQuery(url),
```

- [ ] **Commit**

```bash
git add frontend/src/api/queue.api.js frontend/src/App.jsx
git commit -m "feat: add queue.api.js; remove inline axios calls from App.jsx"
```

---

## Task 11: Create `frontend/src/hooks/useQueueMutations.js`

Extract the delete/retry/pause mutations and snackbar state from `QueueList.jsx`.

**Files:**
- Create: `frontend/src/hooks/useQueueMutations.js`

- [ ] **Create `frontend/src/hooks/useQueueMutations.js`**:

```js
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteQuery, retryQuery, pauseQuery } from '../api/queue.api.js'

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, and pause queue actions, plus shared snackbar state.
 * @returns {{
 *   deleteMutation: import('@tanstack/react-query').UseMutationResult,
 *   retryMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseMutation: import('@tanstack/react-query').UseMutationResult,
 *   snackbar: SnackbarState,
 *   closeSnackbar: () => void,
 * }}
 */
export function useQueueMutations() {
  const qc = useQueryClient()
  const [snackbar, setSnackbar] = React.useState({ open: false, message: '', severity: 'success' })

  const closeSnackbar = () => setSnackbar((s) => ({ ...s, open: false }))

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuery(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: 'success' })
    },
    onError: (err) => {
      setSnackbar({ open: true, message: err?.message || 'Failed to remove query', severity: 'error' })
    },
  })

  const retryMutation = useMutation({
    mutationFn: (id) => retryQuery(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Retrying query ${id}`, severity: 'success' })
    },
    onError: (err) => {
      const serverMsg = err?.response?.data?.error
      setSnackbar({
        open: true,
        message: serverMsg || err?.message || 'Failed to retry query',
        severity: 'error',
      })
    },
  })

  const pauseMutation = useMutation({
    mutationFn: (id) => pauseQuery(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  return { deleteMutation, retryMutation, pauseMutation, snackbar, closeSnackbar }
}
```

- [ ] **Commit**

```bash
git add frontend/src/hooks/useQueueMutations.js
git commit -m "feat: extract queue mutations and snackbar state into useQueueMutations hook"
```

---

## Task 12: Create `frontend/src/components/StatusChip.jsx`

Small shared component used by both `QueueItem` and `DocumentList`. Extracted from `QueueList.jsx`.

**Files:**
- Create: `frontend/src/components/StatusChip.jsx`

- [ ] **Create `frontend/src/components/StatusChip.jsx`**:

```jsx
import { Chip } from '@mui/material'

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: 'default' },
  downloading: { label: 'Downloading', color: 'primary' },
  completed: { label: 'Completed', color: 'success' },
  download_blocked: { label: 'Download Blocked', color: 'error' },
  search_failed: { label: 'Search Failed', color: 'error' },
  paused: { label: 'Paused', color: 'warning' },
}

/**
 * @param {{ status: string | null | undefined }} props
 */
export default function StatusChip({ status }) {
  const key = (status ?? '').toLowerCase()
  const config = STATUS_CONFIG[key] ?? { label: status || 'Unknown', color: 'default' }

  return (
    <Chip
      label={config.label}
      color={config.color}
      size="small"
      variant={config.color === 'default' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600, fontSize: '0.7rem', height: 22, letterSpacing: '0.03em' }}
    />
  )
}
```

- [ ] **Commit**

```bash
git add frontend/src/components/StatusChip.jsx
git commit -m "feat: extract StatusChip into its own component"
```

---

## Task 13: Create `frontend/src/components/DocumentList.jsx`

Extracted from the `VirtualizedDocumentList` function and the expandable Collapse section in `QueueList.jsx`.

**Files:**
- Create: `frontend/src/components/DocumentList.jsx`

- [ ] **Create `frontend/src/components/DocumentList.jsx`**:

```jsx
import React from 'react'
import { List } from 'react-window'
import {
  Box,
  Collapse,
  Divider,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded'
import StatusChip from './StatusChip'

const ITEM_HEIGHT = 50

function DocumentRow({ index, style, documents }) {
  const doc = documents[index]

  return (
    <Box style={style} sx={{ px: 1, py: 0.5, boxSizing: 'border-box' }}>
      <ListItem
        sx={{
          px: 1,
          py: 0.5,
          alignItems: 'center',
          border: index < documents.length - 1 ? '1px solid' : 'none',
          borderColor: 'divider',
        }}
        secondaryAction={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StatusChip status={doc.status} />
          </Box>
        }
      >
        <ListItemText
          primary={
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 'calc(100% - 120px)',
                fontSize: '0.85rem',
              }}
            >
              {doc.fileName ?? doc.title ?? doc.href ?? 'Untitled'}
            </Typography>
          }
          secondary={
            doc.href ? (
              <Tooltip title={doc.href}>
                <Typography
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                    fontSize: '0.75rem',
                  }}
                >
                  {doc.href}
                </Typography>
              </Tooltip>
            ) : null
          }
        />
      </ListItem>
    </Box>
  )
}

/**
 * Expandable list of documents for a queue item.
 * @param {{
 *   searchResults: import('../../../shared/types.js').SearchResult[],
 *   isOpen: boolean,
 * }} props
 */
export default function DocumentList({ searchResults, isOpen }) {
  const documents = Array.isArray(searchResults) ? searchResults : []
  const height = Math.min(400, documents.length * ITEM_HEIGHT)

  const Row = React.useCallback(
    ({ index, style }) => <DocumentRow index={index} style={style} documents={documents} />,
    [documents],
  )

  return (
    <Collapse in={isOpen} timeout="auto" unmountOnExit>
      <Box sx={{ p: 1 }}>
        <Divider />
        <Box sx={{ px: 1, py: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <DescriptionRoundedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
              Documents ({documents.length})
            </Typography>
          </Box>

          {documents.length === 0 ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', ml: 4 }}>
              No documents found for this query.
            </Typography>
          ) : (
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <List
                defaultHeight={height}
                rowCount={documents.length}
                rowHeight={ITEM_HEIGHT}
                rowComponent={Row}
                rowProps={{}}
                style={{ width: '100%' }}
              />
            </Box>
          )}
        </Box>
      </Box>
    </Collapse>
  )
}
```

- [ ] **Commit**

```bash
git add frontend/src/components/DocumentList.jsx
git commit -m "feat: extract DocumentList component from QueueList"
```

---

## Task 14: Create `frontend/src/components/QueueItem.jsx`

Extracted from the `QueueItem` function in `QueueList.jsx`. Receives callbacks instead of owning mutations.

**Files:**
- Create: `frontend/src/components/QueueItem.jsx`

- [ ] **Create `frontend/src/components/QueueItem.jsx`**:

```jsx
import React from 'react'
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material'
import { styled } from '@mui/material/styles'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import { RETRYABLE_STATUSES } from '@shared/constants.js'
import StatusChip from './StatusChip'
import DocumentList from './DocumentList'

function formatTimestamp(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString()
}

function MetaItem({ icon, label, value, truncate = false }) {
  const content = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', flexShrink: 0 }}>{icon}</Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500, mr: 0.5, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: 'text.primary',
          ...(truncate
            ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
            : {}),
        }}
      >
        {value}
      </Typography>
    </Box>
  )

  return truncate ? (
    <Tooltip title={value} placement="bottom-start">
      <Box sx={{ minWidth: 0, flex: 1 }}>{content}</Box>
    </Tooltip>
  ) : (
    <Box>{content}</Box>
  )
}

const ExpandButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== 'expand',
})(({ theme, expand }) => ({
  transform: expand ? 'rotate(180deg)' : 'rotate(0deg)',
  transition: theme.transitions.create('transform', {
    duration: theme.transitions.duration.shortest,
  }),
  color: theme.palette.text.secondary,
}))

/**
 * @param {{
 *   item: import('../../../shared/types.js').Query & { isPending?: boolean, pendingError?: string },
 *   index: number,
 *   isDeleting: boolean,
 *   isRetrying: boolean,
 *   isPausing: boolean,
 *   onRequestDelete: (item: object) => void,
 *   onRetry: (item: object) => void,
 *   onPause: (id: number) => void,
 * }} props
 */
export default function QueueItem({ item, index, isDeleting, isRetrying, isPausing, onRequestDelete, onRetry, onPause }) {
  const [expanded, setExpanded] = React.useState(false)

  const label = item.pageUrl ?? `Query #${item.id ?? index + 1}`
  const created = formatTimestamp(item.createdAt)
  const resultsCount = Array.isArray(item.searchResults) ? item.searchResults.length : (item.results ?? 'N/A')
  const status = (item.status ?? '').toLowerCase()

  const isPaused = status === 'paused'
  const canPause = ['pending', 'downloading'].includes(status) || isPaused
  const canRetry = RETRYABLE_STATUSES.includes(status)
  const isActing = isDeleting || isRetrying || isPausing || item.isPending

  const handleDelete = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onRequestDelete?.(item)
  }

  const handleRetry = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onRetry?.(item)
  }

  const handlePause = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onPause?.(item.id)
  }

  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: 'divider',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        '&:hover': {
          borderColor: 'primary.main',
          boxShadow: (theme) => `0 0 0 1px ${theme.palette.primary.main}44`,
        },
      }}
    >
      <CardContent
        onClick={() => setExpanded((s) => !s)}
        sx={{
          p: '12px 16px !important',
          cursor: 'pointer',
          opacity: status === 'pending' ? 0.7 : 1,
          backgroundColor: status === 'search_failed' ? 'rgba(211, 47, 47, 0.08)' : 'transparent',
        }}
      >
        {/* Top row: URL label + status chip + action buttons + expand */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
            {status === 'pending' && <CircularProgress size={14} thickness={4} sx={{ flexShrink: 0 }} />}
            {status !== 'pending' && (
              <LinkRoundedIcon sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0, mt: '1px' }} />
            )}
            <Tooltip title={label} placement="top-start">
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: 'text.primary',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '0.82rem',
                }}
              >
                {label}
              </Typography>
            </Tooltip>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StatusChip status={item.status} />

            {canPause && (
              <Tooltip title={isPaused ? 'Resume' : 'Pause'}>
                <IconButton
                  size="small"
                  aria-label={isPaused ? 'Resume item' : 'Pause item'}
                  color={isPaused ? 'warning' : 'default'}
                  onClick={handlePause}
                  disabled={isActing}
                >
                  {isPaused ? (
                    <PlayArrowRoundedIcon sx={{ fontSize: 18 }} />
                  ) : (
                    <PauseRoundedIcon sx={{ fontSize: 18 }} />
                  )}
                </IconButton>
              </Tooltip>
            )}

            {canRetry && (
              <Tooltip title="Retry">
                <IconButton
                  size="small"
                  aria-label="Retry item"
                  color="primary"
                  onClick={handleRetry}
                  disabled={isActing}
                >
                  <ReplayRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Delete">
              <IconButton
                size="small"
                aria-label="Delete item"
                color="error"
                onClick={handleDelete}
                disabled={isActing}
              >
                <DeleteRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            <ExpandButton
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse item' : 'Expand item'}
              expand={expanded ? 1 : 0}
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((s) => !s)
              }}
            >
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            </ExpandButton>
          </Box>
        </Box>

        <Divider sx={{ mb: 1, borderColor: 'divider' }} />

        {status === 'search_failed' && (
          <Alert severity="error" sx={{ mb: 1, fontSize: '0.85rem' }}>
            {item.pendingError || 'This job failed. You can retry it.'}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: { xs: 1, sm: 2.5 }, alignItems: 'center' }}>
          <MetaItem icon={<LibraryBooksRoundedIcon sx={{ fontSize: 13 }} />} label="Results:" value={resultsCount} />
          <MetaItem icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />} label="Created:" value={created} />
        </Box>
      </CardContent>

      <DocumentList searchResults={item.searchResults} isOpen={expanded} />
    </Card>
  )
}
```

- [ ] **Commit**

```bash
git add frontend/src/components/QueueItem.jsx
git commit -m "feat: extract QueueItem component from QueueList"
```

---

## Task 15: Slim `frontend/src/components/QueueList.jsx`

Replace the entire file with the thin orchestrator version that delegates to `QueueItem`, `useQueueMutations`, `ConfirmDialog`, and `Snackbar`.

**Files:**
- Modify: `frontend/src/components/QueueList.jsx`

- [ ] **Replace the entire content of `frontend/src/components/QueueList.jsx`** with:

```jsx
import React from 'react'
import { Alert, Box, Snackbar, Typography } from '@mui/material'
import InboxRoundedIcon from '@mui/icons-material/InboxRounded'
import ConfirmDialog from './ConfirmDialog'
import QueueItem from './QueueItem'
import { useQueueMutations } from '../hooks/useQueueMutations'

/**
 * @param {{ queue: import('../../../shared/types.js').Query[] }} props
 */
export default function QueueList({ queue }) {
  const { deleteMutation, retryMutation, pauseMutation, snackbar, closeSnackbar } = useQueueMutations()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [selectedItem, setSelectedItem] = React.useState(null)

  const requestDelete = (item) => {
    setSelectedItem(item)
    setDialogOpen(true)
  }

  const requestRetry = (item) => {
    setSelectedItem(item)
    retryMutation.mutate(item.id, {
      onSettled: () => setSelectedItem(null),
    })
  }

  const requestPause = (id) => {
    setSelectedItem({ id })
    pauseMutation.mutate(id, {
      onSettled: () => setSelectedItem(null),
    })
  }

  const confirmDelete = () => {
    if (!selectedItem?.id) return
    deleteMutation.mutate(selectedItem.id, {
      onSettled: () => {
        setDialogOpen(false)
        setSelectedItem(null)
      },
    })
  }

  if (!queue || queue.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          py: 8,
          color: 'text.secondary',
        }}
      >
        <InboxRoundedIcon sx={{ fontSize: 40, opacity: 0.4 }} />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          The queue is empty
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.7 }}>
          Add a Primo URL above to get started.
        </Typography>
      </Box>
    )
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary', letterSpacing: '0.04em' }}>
          QUEUE
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {queue.length} {queue.length === 1 ? 'item' : 'items'}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {queue.map((item, index) => (
          <QueueItem
            key={item.id ?? item.pageUrl ?? `queue-item-${index}`}
            item={item}
            index={index}
            isDeleting={deleteMutation.isPending && selectedItem?.id === item.id}
            isRetrying={retryMutation.isPending && selectedItem?.id === item.id}
            isPausing={pauseMutation.isPending && selectedItem?.id === item.id}
            onRequestDelete={requestDelete}
            onRetry={requestRetry}
            onPause={requestPause}
          />
        ))}
      </Box>

      <ConfirmDialog
        open={dialogOpen}
        title="Remove query"
        content="Are you sure you want to remove this query from the queue? This action cannot be undone."
        itemLabel={selectedItem?.pageUrl ?? `Query #${selectedItem?.id ?? ''}`}
        loading={deleteMutation.isPending}
        onClose={() => {
          setDialogOpen(false)
          setSelectedItem(null)
        }}
        onConfirm={confirmDelete}
        confirmText="Remove"
        cancelText="Cancel"
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={closeSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={closeSnackbar} severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}
```

- [ ] **Commit**

```bash
git add frontend/src/components/QueueList.jsx
git commit -m "refactor: slim QueueList to thin orchestrator; delegate to QueueItem and useQueueMutations"
```

---

## Final Verification

- [ ] **Run server linter across all modified files**

```bash
cd server && npm run lint
```

Expected: no errors.

- [ ] **Verify the frontend builds without errors**

```bash
cd frontend && npm run build
```

Expected: build completes with no errors. Ignore bundle size warnings.

- [ ] **Confirm no references to the old paths remain**

```bash
grep -r '/playwright' server/ frontend/src/ --include='*.js' --include='*.jsx' --include='*.ts'
grep -r 'download\.service' server/ --include='*.js'
grep -r 'playwright\.controller' server/ --include='*.js'
```

Expected: zero matches in all three commands.

- [ ] **Final commit**

```bash
git add -A
git commit -m "chore: verify refactor complete — all old references removed"
```

---

## Summary of Changes

| Area | Before | After |
|---|---|---|
| `download.service.js` | 320-line god file | Deleted — split into 4 focused services |
| `db.service.js` | Imports BullMQ queues | Pure Prisma — no queue knowledge |
| `playwright.controller.js` | Mixed routing + business logic | Deleted — replaced by thin `queue.controller.js` |
| API route prefix | `/playwright/...` | `/api/...` |
| `retryQuery` bug | Used `metadata.url` (undefined) | Uses `metadata.pageUrl` (correct field) |
| `QueueList.jsx` | 540-line monolith | ~90-line orchestrator |
| Frontend API calls | Scattered in `App.jsx`, `QueueList.jsx`, `QueueItem` | Centralised in `api/queue.api.js` |

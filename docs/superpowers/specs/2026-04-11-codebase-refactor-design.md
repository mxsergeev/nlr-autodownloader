# Codebase Refactor Design

**Date:** 2026-04-11  
**Scope:** Server + Frontend  
**Driver:** Code quality / cleanup — reduce god files, separate concerns, improve layer clarity  
**Approach:** Layer cleanup (Approach B)

---

## Problem

The codebase has two god files that mix unrelated concerns, a coupled data/queue layer, business logic embedded in the HTTP controller, and scattered API calls on the frontend. The result is code that is hard to navigate, hard to change, and easy to break accidentally.

Specific pain points:
- `server/services/download.service.js` (320 lines) handles browser lifecycle, metadata scraping, search scraping, file downloading, FS utilities, and some DB writes.
- `frontend/src/components/QueueList.jsx` (540 lines) contains inline sub-components, all mutations, snackbar state, and virtualization logic.
- `server/services/db.service.js` imports BullMQ queues — the data layer should have no knowledge of job infrastructure.
- `server/controllers/playwright.controller.js` makes business decisions (retry path selection, status validation, pause toggle logic).
- API routes use `/playwright/...`, exposing an implementation detail as the domain name.
- `CONCURRENT_DOWNLOADS` is defined in two places.

---

## Goals

- Each file has one clear purpose.
- A reader can understand what a module does without reading its dependencies.
- The data layer (`db.service.js`) has no knowledge of BullMQ.
- The HTTP controller has no business logic — it translates HTTP to service calls.
- Frontend API calls are centralised in one module.
- No new framework or runtime dependencies are introduced.
- No tests added (out of scope).

---

## Architecture

### Server — After Refactor

```
server/
  app.js                         (unchanged — thin Express setup)
  index.js                       (unchanged)
  queue.js                       (unchanged — BullMQ queue instances)
  redis.js                       (unchanged)
  controllers/
    queue.controller.js          (renamed from playwright.controller.js; thin HTTP adapter only)
  services/
    browser.service.js           (NEW — Playwright browser lifecycle)
    scraper.service.js           (NEW — scrapMetadata, scrapSearchResults, scrapDownload, verifySearchResults)
    file.service.js              (NEW — DOWNLOADS_DIR, getDownloadedFileNames, verifyDownloads, sanitizeFileName, queryToString)
    query.service.js             (NEW — queueQuery, removeQuery, retryQuery, togglePause; owns retry/pause decisions)
    db.service.js                (MODIFIED — Prisma only, no BullMQ imports; deleteMetadata no longer removes jobs)
  workers/
    metadata.worker.js           (minor: import from scraper.service, query.service)
    search.worker.js             (minor: import from scraper.service)
    download.worker.js           (minor: remove duplicate CONCURRENT_DOWNLOADS; import from file.service)
  queues/
    (unchanged)
shared/
  constants.js                   (unchanged)
  types.js                       (NEW — JSDoc @typedef for Query and SearchResult)
```

### Frontend — After Refactor

```
frontend/src/
  App.jsx                        (MODIFIED — imports from api/queue.api.js)
  api/
    queue.api.js                 (NEW — all axios calls: fetchQueue, addQuery, deleteQuery, retryQuery, pauseQuery)
  components/
    AddQueryForm.jsx             (unchanged)
    ConfirmDialog.jsx            (unchanged)
    QueueList.jsx                (MODIFIED — thin: virtualized list + passes props; no mutations or snackbar state)
    QueueItem.jsx                (NEW — single queue entry card: status chip, metadata, action buttons)
    DocumentList.jsx             (NEW — expandable search-results list)
  hooks/
    useQueueMutations.js         (NEW — delete/retry/pause mutations, snackbar state)
  ThemeContext.jsx               (unchanged)
```

---

## Section Details

### 1. `browser.service.js`

Owns the singleton Firefox browser instance. Exports: `runJob(fn)`.

- `startBrowser()` and `stopBrowser()` are private.
- `runJob(fn)` ensures the browser is running, creates a fresh context with a random user agent, runs `fn(page, context)`, and always closes the context.
- No other module touches the `browser` variable.

### 2. `scraper.service.js`

Owns all Playwright scraping. Imports `runJob` from `browser.service.js`. Exports: `scrapMetadata`, `scrapSearchResults`, `scrapDownload`, `verifySearchResults`.

- `scrapMetadata` and `scrapSearchResults` no longer call `saveSearchResults` directly — they return data and let the worker decide what to persist. This removes the mixed DB write inside a scraper.
- This also fixes a pre-existing double-save: `scrapSearchResults` currently calls `saveSearchResults` internally, and the search worker calls it again. After the refactor only the worker saves.
- `scrapSearchResults` still de-dupes URLs internally.
- `verifySearchResults` moves here from `download.service.js` — it validates scraping output against metadata, which is the scraper's domain.

### 3. `file.service.js`

Owns the file system. Exports: `DOWNLOADS_DIR`, `getDownloadedFileNames`, `verifyDownloads`, `sanitizeFileName`, `queryToString`.

- `DOWNLOADS_DIR` and the `data/downloads` mkdir call move here (out of `download.service.js`).
- No Playwright, no Prisma.

### 4. `query.service.js`

Owns business logic for the query lifecycle. Exports: `queueQuery`, `removeQuery`, `retryQuery`, `togglePause`.

- `removeQuery`: deletes from DB via `db.service.js` and removes the download directory via `file.service.js`. It also removes related BullMQ jobs — this is the logic currently in `db.service.deleteMetadata`.
- `retryQuery`: decides which job to enqueue based on status (currently in the controller's `/retry` handler).
- `togglePause`: reads current status, flips it, writes back (currently in the controller's `/pause` handler).
- Workers that currently import `queueQuery` or `removeQuery` from `download.service.js` import from here instead.

### 5. `db.service.js` (modified)

Remove the `import { downloadQueue, searchQueue } from '../queue.js'` at the top. Move `deleteMetadata`'s BullMQ job cleanup to `query.service.removeQuery`. `db.service.js` becomes pure Prisma.

### 6. `queue.controller.js` (renamed + thinned)

Route definitions stay the same shape. Every handler:
1. Parses the request.
2. Calls the appropriate method on `query.service.js` or `db.service.js`.
3. Returns the result or a standard error response.

No status comparisons, no `RETRYABLE_STATUSES` checks, no `if paused then pending` logic — that all lives in `query.service.js`.

### 7. Route rename

`app.js`: change `app.use('/playwright', ...)` → `app.use('/api', ...)`.  
Frontend Vite config: update the proxy target path from `/playwright` to `/api`.  
All frontend `axios` calls: update to `/api/queue`.

### 8. `shared/types.js` (new)

JSDoc typedefs shared by server and frontend:

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
```

### 9. `api/queue.api.js` (new, frontend)

Centralises all HTTP calls. Each function returns the relevant data shape.

```js
export const fetchQueue = () => axios.get('/api/queue').then(r => r.data.queue)
export const addQuery = (url) => axios.post('/api/queue', { queries: [{ url }] }).then(r => r.data)
export const deleteQuery = (id) => axios.delete(`/api/queue/${id}`).then(r => r.data)
export const retryQuery = (id) => axios.post(`/api/queue/${id}/retry`).then(r => r.data)
export const pauseQuery = (id) => axios.post(`/api/queue/${id}/pause`).then(r => r.data)
```

### 10. Frontend component split

**`QueueItem.jsx`**: Receives a single `Query` object + callbacks (`onDelete`, `onRetry`, `onPause`). Renders the card with status chip, metadata rows, action icons, and the `DocumentList` toggle.

**`DocumentList.jsx`**: Receives `searchResults[]` and `isOpen` boolean. Renders the expandable `Collapse` with the list of documents.

**`useQueueMutations.js`**: Returns `{ deleteMutation, retryMutation, pauseMutation, snackbar, closeSnackbar }`. Wraps all `useMutation` calls and owns `snackbar` state. Used by `QueueList.jsx`.

**`QueueList.jsx`**: Imports `useQueueMutations`, renders the `List` (react-window), renders `Snackbar`, and renders `ConfirmDialog`. Passes callbacks into each `QueueItem`.

---

## Out of Scope

- TypeScript migration (may follow later)
- New tests
- Changing the data model or Prisma schema
- Changes to Docker / deployment config
- Domain restructuring into `scraping/`, `downloads/`, `queries/` folders (Approach C)

---

## Non-Goals

- No new features.
- No changes to external behaviour — the API surface (route paths aside) and the UI behaviour remain identical.
- No changes to BullMQ queue configuration or retry logic.

import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/**
 * Returns the Prisma Query record for the given params.
 * Supports lookup by id or by pageUrl (url).
 */
export async function getMetadata({ id, url }) {
  if (id) {
    const record = await prisma.query.findUnique({ where: { id: Number(id) }, include: { searchResults: true } })
    return toSerializableQuery(record)
  }

  if (url) {
    const record = await prisma.query.findUnique({ where: { pageUrl: url }, include: { searchResults: true } })
    return toSerializableQuery(record)
  }

  return null
}

/**
 * Creates or updates the query record from a Prisma-shaped object.
 * @param {{ id?: number, url?: string }} params
 * @param {object} metadata  Prisma-compatible fields (results, resultsPerPart, parts, pageUrl, createdAt, order, status, lastAttempt, downloaded, downloadProgress)
 */
export async function upsertMetadata({ id, url }, metadata) {
  const data = normalize(metadata)

  if (id) {
    const record = await prisma.query.update({ where: { id: Number(id) }, data })
    return toSerializableQuery(record)
  }

  if (url) {
    // pageUrl is unique in the schema - use upsert by pageUrl
    const record = await prisma.query.upsert({
      where: { pageUrl: url },
      create: { pageUrl: url, ...data },
      update: data,
    })
    return toSerializableQuery(record)
  }

  throw new Error('Invalid params for upsertQuery: need id or url')
}

/**
 * Returns all query records sorted by order ascending.
 */
export async function getAllMetadata() {
  const records = await prisma.query.findMany({
    orderBy: { order: 'asc' },
    include: { searchResults: true },
  })
  return records.map(toSerializableQuery)
}

/**
 * Deletes the query record (and its search results via CASCADE).
 */
export async function deleteMetadata({ id }) {
  await prisma.query.delete({ where: { id } })
}

/**
 * Returns all search results for a query as plain objects { title, href, fileName }.
 * Returns null if the query does not exist.
 * @param {{ queryId?: number, }} params  Lookup by queryId
 */
export async function getSearchResults({ queryId } = {}) {
  if (!queryId) return null

  const results = await prisma.searchResult.findMany({ where: { queryId: Number(queryId) } })

  return results
}

/**
 * Upserts search results for a query, keyed on (queryId, href).
 * - New results are inserted with status 'pending'.
 * - Existing results (matching href) have their title and fileName updated; status is preserved.
 * - Results no longer present in the new list are deleted.
 * @param {{ queryId: number }} params
 * @param {{ title: string, href: string, fileName: string }[]} results
 */
export async function saveSearchResults({ queryId }, results) {
  const hrefs = results.map((r) => r.href)

  await prisma.$transaction([
    // Remove items whose href is no longer in the scraped results
    prisma.searchResult.deleteMany({
      where: { queryId: Number(queryId), href: { notIn: hrefs } },
    }),
    // Upsert each result: insert new rows with status 'pending'; update title/fileName on conflict
    ...results.map((r) =>
      prisma.searchResult.upsert({
        where: { queryId_href: { queryId: Number(queryId), href: r.href } },
        create: {
          title: r.title,
          href: r.href,
          fileName: r.fileName,
          queryId: Number(queryId),
        },
        update: {
          title: r.title,
          fileName: r.fileName,
          // href is the conflict key — cannot change
          // status is intentionally NOT updated here to preserve completed/paused/blocked states
        },
      }),
    ),
  ])
}

export async function updateSearchResult(id, data) {
  await prisma.searchResult.update({ where: { id: Number(id) }, data })
}

/**
 * Deletes a single SearchResult by id.
 * @param {number} id
 */
export async function deleteSearchResult(id) {
  await prisma.searchResult.delete({ where: { id: Number(id) } })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a minimal { id, status, results } record for a query.
 * Avoids loading the full record (+ searchResults) for hot-path status checks.
 * @param {number} id
 */
export async function getQueryStats(id) {
  return prisma.query.findUnique({
    where: { id: Number(id) },
    select: { id: true, status: true, results: true },
  })
}

/**
 * Converts raw input to a Prisma-safe data object.
 * Only fields that are explicitly present on the input object are included;
 * omitting a field means Prisma will leave the DB column untouched.
 * This prevents callers from accidentally resetting status or counters.
 */
function normalize(metadata) {
  const result = {}

  if ('results' in metadata) result.results = metadata.results ?? null
  if ('resultsPerPart' in metadata) result.resultsPerPart = metadata.resultsPerPart ?? null
  if ('parts' in metadata) result.parts = metadata.parts ?? null
  if ('pageUrl' in metadata) result.pageUrl = metadata.pageUrl ?? null
  if ('searchUrl' in metadata) result.searchUrl = metadata.searchUrl ?? null
  if ('createdAt' in metadata) result.createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null
  if ('order' in metadata) result.order = metadata.order != null ? BigInt(metadata.order) : undefined
  if ('status' in metadata) result.status = metadata.status
  if ('lastAttempt' in metadata) result.lastAttempt = metadata.lastAttempt ? new Date(metadata.lastAttempt) : null
  if ('downloaded' in metadata) result.downloaded = metadata.downloaded ?? 0
  if ('downloadProgress' in metadata) result.downloadProgress = metadata.downloadProgress ?? null

  return result
}

function toSerializableQuery(record) {
  if (!record) return null

  return {
    ...record,
    order: typeof record.order === 'bigint' ? Number(record.order) : record.order,
  }
}

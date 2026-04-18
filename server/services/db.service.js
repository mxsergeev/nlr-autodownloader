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
 * Replaces all search results for a query in a single transaction.
 * @param {{ id?: number, url?: string }} params
 * @param {{ title: string, href: string, fileName: string }[]} results
 */
export async function saveSearchResults({ queryId }, results) {
  await prisma.$transaction([
    prisma.searchResult.deleteMany({ where: { queryId } }),
    prisma.searchResult.createMany({
      data: results.map((r) => ({
        title: r.title,
        href: r.href,
        fileName: r.fileName,
        queryId: Number(queryId),
      })),
    }),
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

function normalize(metadata) {
  return {
    results: metadata.results ?? null,
    resultsPerPart: metadata.resultsPerPart ?? null,
    parts: metadata.parts ?? null,
    pageUrl: metadata.pageUrl ?? null,
    searchUrl: metadata.searchUrl ?? null,
    createdAt: metadata.createdAt ? new Date(metadata.createdAt) : (metadata.createdAt ?? undefined),
    order: metadata.order !== undefined ? BigInt(metadata.order) : undefined,
    status: metadata.status ?? 'pending',
    lastAttempt: metadata.lastAttempt ? new Date(metadata.lastAttempt) : (metadata.lastAttempt ?? null),
    downloaded: metadata.downloaded ?? 0,
    downloadProgress: metadata.downloadProgress ?? null,
  }
}

function toSerializableQuery(record) {
  if (!record) return null

  return {
    ...record,
    order: typeof record.order === 'bigint' ? Number(record.order) : record.order,
  }
}

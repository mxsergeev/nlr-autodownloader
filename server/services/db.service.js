import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/**
 * Returns the Prisma Query record for the given params.
 * Supports lookup by id or by pageUrl (url).
 */
export async function getQuery(params) {
  if (!params) return null

  if (params.id !== undefined && params.id !== null) {
    const id = Number(params.id)
    const record = await prisma.query.findUnique({ where: { id } })
    return toSerializableQuery(record)
  }

  if (params.url) {
    const record = await prisma.query.findUnique({ where: { pageUrl: params.url } })
    return toSerializableQuery(record)
  }

  return null
}

/**
 * Creates or updates the query record from a Prisma-shaped object.
 * @param {{ id?: number, url?: string }} params
 * @param {object} metadata  Prisma-compatible fields (results, resultsPerPart, parts, pageUrl, createdAt, order, status, lastAttempt, downloaded, downloadProgress)
 */
export async function upsertQuery(params, metadata) {
  const data = normalize(metadata)

  if (params && params.id !== undefined && params.id !== null) {
    const record = await prisma.query.update({ where: { id: Number(params.id) }, data })
    return toSerializableQuery(record)
  }

  if (params && params.url) {
    // pageUrl is unique in the schema - use upsert by pageUrl
    const record = await prisma.query.upsert({
      where: { pageUrl: params.url },
      create: { pageUrl: params.url, ...data },
      update: data,
    })
    return toSerializableQuery(record)
  }

  throw new Error('Invalid params for upsertQuery: need id or url')
}

/**
 * Returns all query records sorted by order ascending.
 */
export async function getAllQueries() {
  const records = await prisma.query.findMany({ orderBy: { order: 'asc' } })
  return records.map(toSerializableQuery)
}

/**
 * Deletes the query record (and its search results via CASCADE).
 * Resolves to null if the record does not exist.
 * @param {{ id?: number, url?: string }} params
 */
export async function deleteQuery(params) {
  if (!params) return null

  if (params.id !== undefined && params.id !== null) {
    return prisma.query.delete({ where: { id: Number(params.id) } }).catch(() => null)
  }

  if (params.url) {
    const existing = await prisma.query.findUnique({ where: { pageUrl: params.url } })
    if (!existing) return null
    return prisma.query.delete({ where: { id: existing.id } }).catch(() => null)
  }

  return null
}

/**
 * Returns all search results for a query as plain objects { title, href, fileName }.
 * Returns null if the query does not exist.
 * @param {{ id?: number, url?: string }} params
 */
export async function getSearchResults(params) {
  if (!params) return null

  const record =
    params.id !== undefined && params.id !== null
      ? await prisma.query.findUnique({ where: { id: Number(params.id) }, include: { searchResults: true } })
      : await prisma.query.findUnique({ where: { pageUrl: params.url }, include: { searchResults: true } })

  if (!record) return null
  return record.searchResults.map(({ title, href, fileName }) => ({ title, href, fileName }))
}

/**
 * Replaces all search results for a query in a single transaction.
 * @param {{ id?: number, url?: string }} params
 * @param {{ title: string, href: string, fileName: string }[]} results
 */
export async function saveSearchResults(params, results) {
  if (!params) throw new Error('No params provided')

  const record =
    params.id !== undefined && params.id !== null
      ? await prisma.query.findUnique({ where: { id: Number(params.id) } })
      : await prisma.query.findUnique({ where: { pageUrl: params.url } })

  if (!record) throw new Error(`Query not found: ${params.id ?? params.url}`)

  await prisma.$transaction([
    prisma.searchResult.deleteMany({ where: { queryId: record.id } }),
    prisma.searchResult.createMany({
      data: results.map((r) => ({
        title: r.title,
        href: r.href,
        fileName: r.fileName,
        queryId: record.id,
      })),
    }),
  ])
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

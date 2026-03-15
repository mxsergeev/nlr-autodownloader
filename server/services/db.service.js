import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/**
 * Returns the Prisma Query record for the given params.
 * @param {{ q: string, year: number }} params
 */
export async function getQuery(params) {
  const record = await prisma.query.findUnique({
    where: { q_year: { q: params.q, year: Number(params.year) } },
  })
  return record ?? null
}

/**
 * Creates or updates the query record from a Prisma-shaped object.
 * @param {{ q: string, year: number }} params
 * @param {object} metadata  Prisma-compatible fields (results, resultsPerPart, parts, pageUrl, createdAt, order, status, lastAttempt, downloaded, downloadProgress)
 */
export async function upsertQuery(params, metadata) {
  const data = normalize(metadata)
  return prisma.query.upsert({
    where: { q_year: { q: params.q, year: Number(params.year) } },
    create: { q: params.q, year: Number(params.year), ...data },
    update: data,
  })
}

/**
 * Returns all query records sorted by order ascending.
 */
export async function getAllQueries() {
  const records = await prisma.query.findMany({ orderBy: { order: 'asc' } })
  return records
}

/**
 * Deletes the query record (and its search results via CASCADE).
 * Resolves to null if the record does not exist.
 * @param {{ q: string, year: number }} params
 */
export async function deleteQuery(params) {
  return prisma.query.delete({ where: { q_year: { q: params.q, year: Number(params.year) } } }).catch(() => null)
}

/**
 * Returns all search results for a query as plain objects { title, href, fileName }.
 * Returns null if the query does not exist.
 * @param {{ q: string, year: number }} params
 */
export async function getSearchResults(params) {
  const record = await prisma.query.findUnique({
    where: { q_year: { q: params.q, year: Number(params.year) } },
    include: { searchResults: true },
  })
  if (!record) return null
  return record.searchResults.map(({ title, href, fileName }) => ({ title, href, fileName }))
}

/**
 * Replaces all search results for a query in a single transaction.
 * @param {{ q: string, year: number }} params
 * @param {{ title: string, href: string, fileName: string }[]} results
 */
export async function saveSearchResults(params, results) {
  const record = await prisma.query.findUnique({
    where: { q_year: { q: params.q, year: Number(params.year) } },
  })
  if (!record) {
    throw new Error(`Query not found: ${params.q}_${params.year}`)
  }

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

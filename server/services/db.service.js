import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/**
 * Returns the query record for the given params, shaped like the legacy metadata JSON.
 * @param {{ q: string, year: number }} params
 */
export async function getQuery(params) {
  const record = await prisma.query.findUnique({
    where: { q_year: { q: params.q, year: Number(params.year) } },
  })
  return record ? toMetadata(record) : null
}

/**
 * Creates or updates the query record from a metadata-shaped object.
 * @param {{ q: string, year: number }} params
 * @param {object} metadata  Legacy metadata shape (see toMetadata / fromMetadata)
 */
export async function upsertQuery(params, metadata) {
  const data = fromMetadata(metadata)
  return prisma.query.upsert({
    where: { q_year: { q: params.q, year: Number(params.year) } },
    create: { q: params.q, year: Number(params.year), ...data },
    update: data,
  })
}

/**
 * Returns all query records sorted by order ascending, shaped like legacy metadata JSON.
 */
export async function getAllQueries() {
  const records = await prisma.query.findMany({ orderBy: { order: 'asc' } })
  return records.map(toMetadata)
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
// Shape converters
// ---------------------------------------------------------------------------

/** Maps a Prisma Query record to the legacy metadata JSON shape. */
function toMetadata(record) {
  return {
    query: { q: record.q, year: record.year },
    results: record.results,
    resultsPerPart: record.resultsPerPart,
    parts: record.parts,
    pageUrl: record.pageUrl,
    createdAt: record.createdAt?.toISOString() ?? null,
    order: Number(record.order),
    status: record.status,
    lastAttempt: record.lastAttempt?.toISOString() ?? null,
    downloaded: record.downloaded,
    downloadProgress: record.downloadProgress,
  }
}

/** Maps legacy metadata fields to Prisma-compatible data fields. */
function fromMetadata(metadata) {
  return {
    results: metadata.results ?? null,
    resultsPerPart: metadata.resultsPerPart ?? null,
    parts: metadata.parts ?? null,
    pageUrl: metadata.pageUrl ?? null,
    order: BigInt(metadata.order ?? 0),
    status: metadata.status ?? 'pending',
    lastAttempt: metadata.lastAttempt ? new Date(metadata.lastAttempt) : null,
    downloaded: metadata.downloaded ?? 0,
    downloadProgress: metadata.downloadProgress ?? null,
  }
}

import { PrismaClient } from "@prisma/client";
import { validatePrimoUrl } from "./url.service.js";

export const prisma = new PrismaClient();

/**
 * Returns the Prisma Query record for the given params.
 * Supports lookup by id or by pageUrl (url).
 */
export async function getMetadata({ id, url }) {
  if (id) {
    const record = await prisma.query.findUnique({
      where: { id: Number(id) },
      include: { searchResults: true },
    });
    return toSerializableQuery(record);
  }

  if (url) {
    const record = await prisma.query.findUnique({
      where: { pageUrl: url },
      include: { searchResults: true },
    });
    return toSerializableQuery(record);
  }

  return null;
}

/**
 * Creates or updates the query record from a Prisma-shaped object.
 * @param {{ id?: number, url?: string }} params
 * @param {object} metadata  Prisma-compatible metadata fields. Download
 * counters/progress are derived by query-state.service.js.
 */
export async function upsertMetadata({ id, url }, metadata) {
  const validatedUrl = url == null ? null : validatePrimoUrl(url, { label: "Query URL" }).href;
  const data = normalize(metadata);
  if (data.pageUrl != null)
    data.pageUrl = validatePrimoUrl(data.pageUrl, { label: "Query page URL" }).href;
  if (data.searchUrl != null)
    data.searchUrl = validatePrimoUrl(data.searchUrl, { label: "Query search URL" }).href;

  if (id) {
    const record = await prisma.query.update({ where: { id: Number(id) }, data });
    return toSerializableQuery(record);
  }

  if (validatedUrl) {
    // pageUrl is unique in the schema - use upsert by pageUrl
    const record = await prisma.query.upsert({
      where: { pageUrl: validatedUrl },
      create: { pageUrl: validatedUrl, ...data },
      update: data,
    });
    return toSerializableQuery(record);
  }

  throw new Error("Invalid params for upsertQuery: need id or url");
}

/**
 * Returns all query records sorted by order ascending (no searchResults — slim for polling).
 */
export async function getAllMetadata() {
  const records = await prisma.query.findMany({ orderBy: { order: "asc" } });
  return records.map(toSerializableQuery);
}

/**
 * Returns a single query record with its searchResults.
 * @param {number} id
 */
export async function getMetadataById(id) {
  const record = await prisma.query.findUnique({
    where: { id: Number(id) },
    include: { searchResults: true },
  });
  return record ? toSerializableQuery(record) : null;
}

/**
 * Deletes the query record (and its search results via CASCADE).
 */
export async function deleteMetadata({ id }) {
  await prisma.query.delete({ where: { id } });
}

/**
 * Returns all search results for a query as plain objects { title, href, fileName }.
 * Returns null if the query does not exist.
 * @param {{ queryId?: number, }} params  Lookup by queryId
 */
export async function getSearchResults({ queryId } = {}) {
  if (!queryId) return null;

  const results = await prisma.searchResult.findMany({ where: { queryId: Number(queryId) } });

  return results;
}

/**
 * Upserts search results for a query, keyed on (queryId, href).
 * - Results no longer present in the new list are deleted.
 * - New results are inserted with status 'pending'.
 * - Existing results (matching href) have their title and fileName updated; status is preserved.
 * Uses an interactive transaction for atomicity: pre-filters existing hrefs in the same
 * transaction to avoid conflicts, then inserts only genuinely new rows.
 * @param {{ queryId: number }} params
 * @param {{ title: string, href: string, fileName: string }[]} results
 */
export async function saveSearchResults({ queryId, generation }, results) {
  const normalizedResults = results.map((result, index) => ({
    ...result,
    href: validatePrimoUrl(result?.href, {
      label: `Search result at index ${index} URL`,
    }).href,
  }));
  const hrefs = normalizedResults.map((r) => r.href);
  let saved = false;

  // Interactive transaction: delete removed items, then insert only new ones.
  // We pre-filter existing hrefs manually because $transaction array mode does not
  // support createMany({ skipDuplicates }) for SQLite in Prisma 6.
  await prisma.$transaction(async (tx) => {
    const query = await tx.query.findUnique({
      where: { id: Number(queryId) },
      select: { generation: true, status: true },
    });

    // Generation-aware callers must never let a paused or superseded scrape
    // recreate SearchResult rows. Legacy callers (without generation) retain
    // the database service's original behaviour for characterization tests.
    if (
      !query ||
      (generation != null &&
        (Number(query.generation) !== Number(generation) || query.status === "paused"))
    ) {
      return;
    }

    const existing = await tx.searchResult.findMany({
      where: { queryId: Number(queryId), href: { in: hrefs } },
      select: { href: true },
    });
    const existingHrefs = new Set(existing.map((r) => r.href));
    const newResults = normalizedResults.filter((r) => !existingHrefs.has(r.href));

    await tx.searchResult.deleteMany({
      where: { queryId: Number(queryId), href: { notIn: hrefs } },
    });

    if (newResults.length > 0) {
      await tx.searchResult.createMany({
        data: newResults.map((r) => ({
          title: r.title,
          href: r.href,
          fileName: r.fileName,
          queryId: Number(queryId),
        })),
      });
    }

    // Keep display metadata in the same transaction as insertion/deletion so
    // a lifecycle invalidation cannot leave a partial stale scrape behind.
    await Promise.all(
      normalizedResults.map((r) =>
        tx.searchResult.updateMany({
          where: { queryId: Number(queryId), href: r.href },
          data: { title: r.title, fileName: r.fileName },
        })
      )
    );

    saved = true;
  });

  return saved;
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
    select: { id: true, status: true, results: true, generation: true, resumeStatus: true },
  });
}

/**
 * Converts raw input to a Prisma-safe data object.
 * Only fields that are explicitly present on the input object are included;
 * omitting a field means Prisma will leave the DB column untouched.
 * This prevents callers from accidentally resetting status or counters.
 */
function normalize(metadata) {
  const result = {};

  if ("results" in metadata) result.results = metadata.results ?? null;
  if ("resultsPerPart" in metadata) result.resultsPerPart = metadata.resultsPerPart ?? null;
  if ("parts" in metadata) result.parts = metadata.parts ?? null;
  if ("pageUrl" in metadata) result.pageUrl = metadata.pageUrl ?? null;
  if ("searchUrl" in metadata) result.searchUrl = metadata.searchUrl ?? null;
  if ("createdAt" in metadata)
    result.createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null;
  if ("order" in metadata)
    result.order = metadata.order != null ? BigInt(metadata.order) : undefined;
  if ("status" in metadata) result.status = metadata.status;
  if ("generation" in metadata) result.generation = Number(metadata.generation);
  if ("resumeStatus" in metadata) result.resumeStatus = metadata.resumeStatus ?? null;
  if ("lastAttempt" in metadata)
    result.lastAttempt = metadata.lastAttempt ? new Date(metadata.lastAttempt) : null;
  if ("warnings" in metadata) result.warnings = metadata.warnings ?? null;

  return result;
}

function toSerializableQuery(record) {
  if (!record) return null;

  return {
    ...record,
    order: typeof record.order === "bigint" ? Number(record.order) : record.order,
  };
}

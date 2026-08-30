import { prisma } from "./db.service.js";

/**
 * Reads the query represented by a job and verifies that the job still owns
 * the current lifecycle generation.  A deleted query and a paused query are
 * both treated as stale by default.
 *
 * Keeping this check in one place is intentional: every processor and every
 * retry/completion handler must apply the same cancellation rule.
 *
 * @param {number} queryId
 * @param {number} generation
 * @param {{ tx?: import("@prisma/client").Prisma.TransactionClient, allowPaused?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function getCurrentQuery(queryId, generation, { tx, allowPaused = false } = {}) {
  const client = tx ?? prisma;
  const query = await client.query.findUnique({
    where: { id: Number(queryId) },
    include: { searchResults: true },
  });

  if (!query || Number(query.generation) !== Number(generation)) return null;
  if (!allowPaused && query.status === "paused") return null;

  return query;
}

/**
 * Lightweight generation/status guard for points where loading all result
 * rows would be unnecessary.
 *
 * @param {number} queryId
 * @param {number} generation
 * @param {{ tx?: import("@prisma/client").Prisma.TransactionClient, allowPaused?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function isCurrentGeneration(queryId, generation, { tx, allowPaused = false } = {}) {
  const client = tx ?? prisma;
  const query = await client.query.findUnique({
    where: { id: Number(queryId) },
    select: { generation: true, status: true },
  });

  return Boolean(
    query &&
    Number(query.generation) === Number(generation) &&
    (allowPaused || query.status !== "paused")
  );
}

/**
 * Performs a conditional query update owned by a lifecycle generation.
 * updateMany is used deliberately: unlike update({ where: { id } }), it will
 * not write anything if pause/retry/delete has already advanced generation.
 *
 * @param {number} queryId
 * @param {number} generation
 * @param {object} data
 * @param {{ tx?: import("@prisma/client").Prisma.TransactionClient, allowPaused?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function updateQueryForGeneration(
  queryId,
  generation,
  data,
  { tx, allowPaused = false } = {}
) {
  const client = tx ?? prisma;
  const where = {
    id: Number(queryId),
    generation: Number(generation),
  };

  if (!allowPaused) where.status = { not: "paused" };

  const result = await client.query.updateMany({ where, data });
  if (result.count !== 1) return null;

  return client.query.findUnique({ where: { id: Number(queryId) } });
}

/**
 * Returns the immutable identifier payload used by all pipeline jobs.
 * Invalid payloads return null so stale/malformed jobs are harmless.
 *
 * @param {object} data
 * @param {{ itemRequired?: boolean }} [options]
 */
export function parseJobIdentifiers(data, { itemRequired = false } = {}) {
  const queryId = Number(data?.queryId);
  const generation = Number(data?.generation);
  const itemId = data?.itemId == null ? null : Number(data.itemId);

  if (!Number.isInteger(queryId) || queryId <= 0) return null;
  if (!Number.isInteger(generation) || generation <= 0) return null;
  if (itemRequired && (!Number.isInteger(itemId) || itemId <= 0)) return null;
  if (itemId != null && (!Number.isInteger(itemId) || itemId <= 0)) return null;

  return { queryId, generation, ...(itemId == null ? {} : { itemId }) };
}

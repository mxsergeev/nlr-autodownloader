import { prisma } from "./db.service.js";

/**
 * Recomputes the denormalized download fields and derived parent status from
 * the SearchResult rows. The caller must provide the transaction client when
 * this is part of a larger state transition.
 *
 * Query statuses before SearchResult rows exist are explicit pipeline states;
 * once rows exist, download status is derived exclusively from those rows.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {number} queryId
 * @param {{ lastAttempt?: Date, generation?: number, allowPaused?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function reconcileQueryStateInTransaction(
  tx,
  queryId,
  { lastAttempt, generation, allowPaused = false } = {}
) {
  const query = await tx.query.findUnique({
    where: { id: Number(queryId) },
    select: {
      id: true,
      generation: true,
      status: true,
      searchResults: { select: { status: true } },
    },
  });

  if (!query) return null;
  if (generation != null && Number(query.generation) !== Number(generation)) return null;
  if (generation != null && !allowPaused && query.status === "paused") return null;

  const statuses = query.searchResults.map((result) => result.status);
  const results = statuses.length;
  const downloaded = statuses.filter((status) => status === "completed").length;
  const downloadProgress = formatDownloadProgress(downloaded, results);

  const data = {
    results,
    downloaded,
    downloadProgress,
    status: deriveQueryStatus(query.status, statuses),
  };

  if (lastAttempt) data.lastAttempt = lastAttempt;

  return tx.query.update({
    where: { id: Number(queryId) },
    data,
  });
}

/**
 * Reconciles one query in a single Prisma transaction.
 *
 * @param {number} queryId
 * @param {{ generation?: number, allowPaused?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function reconcileQueryState(queryId, options = {}) {
  return prisma.$transaction((tx) => reconcileQueryStateInTransaction(tx, queryId, options));
}

/**
 * Changes a SearchResult status and reconciles its parent in the same
 * transaction. This is the only state transition API used by download work.
 * An optional transaction client lets callers compose this transition with
 * other writes without nesting transactions.
 *
 * @param {number} itemId
 * @param {string} status
 * @param {{ lastAttempt?: Date, generation?: number, expectedStatuses?: string[], tx?: import("@prisma/client").Prisma.TransactionClient }} [options]
 * @returns {Promise<object|null>}
 */
export async function setSearchResultStatus(
  itemId,
  status,
  { lastAttempt, generation, expectedStatuses, tx } = {}
) {
  const transition = async (transaction) => {
    const item = await transaction.searchResult.findUnique({
      where: { id: Number(itemId) },
      select: { queryId: true, status: true },
    });

    if (!item) return null;

    if (expectedStatuses && !expectedStatuses.includes(item.status)) return null;

    const query = await transaction.query.findUnique({
      where: { id: item.queryId },
      select: { generation: true, status: true },
    });

    if (!query) return null;
    if (generation != null && Number(query.generation) !== Number(generation)) return null;
    if (generation != null && query.status === "paused") return null;

    await transaction.searchResult.update({
      where: { id: Number(itemId) },
      data: { status },
    });

    return reconcileQueryStateInTransaction(transaction, item.queryId, {
      lastAttempt,
      generation,
    });
  };

  return tx ? transition(tx) : prisma.$transaction(transition);
}

/**
 * Marks a successfully written download complete and records its attempt in
 * the same transaction as parent reconciliation.
 *
 * @param {number} itemId
 * @param {{ generation?: number }} [options]
 * @returns {Promise<object|null>}
 */
export function completeSearchResult(itemId, { generation } = {}) {
  return setSearchResultStatus(itemId, "completed", {
    generation,
    expectedStatuses: ["downloading"],
    lastAttempt: new Date(),
  });
}

/**
 * Marks an exhausted download as permanently blocked and reconciles its
 * parent atomically.
 *
 * @param {number} itemId
 * @param {{ generation?: number }} [options]
 * @returns {Promise<object|null>}
 */
export function blockSearchResult(itemId, { generation } = {}) {
  return setSearchResultStatus(itemId, "download_blocked", {
    generation,
    expectedStatuses: ["pending", "downloading"],
    lastAttempt: new Date(),
  });
}

/**
 * Deletes a SearchResult and reconciles the parent in one transaction. File
 * deletion remains outside this logical-state transaction.
 *
 * @param {number} itemId
 * @param {{ invalidateGeneration?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function deleteSearchResultAndReconcile(
  itemId,
  { invalidateGeneration = false } = {}
) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.searchResult.findUnique({
      where: { id: Number(itemId) },
      select: { queryId: true },
    });

    if (!item) return null;

    if (invalidateGeneration) {
      await tx.query.update({
        where: { id: item.queryId },
        data: { generation: { increment: 1 } },
      });
    }

    await tx.searchResult.delete({ where: { id: Number(itemId) } });
    return reconcileQueryStateInTransaction(tx, item.queryId);
  });
}

function deriveQueryStatus(currentStatus, statuses) {
  // No document rows means metadata/search state is still authoritative. This
  // also prevents an empty result set from being mistaken for completion.
  if (statuses.length === 0) return currentStatus;
  if (currentStatus === "paused") return "paused";
  if (statuses.includes("downloading")) return "downloading";
  if (statuses.includes("pending")) return "download_queued";
  if (statuses.includes("download_blocked")) return "download_blocked";
  if (statuses.every((status) => status === "completed")) return "completed";

  // A paused individual item does not imply that the whole query is paused.
  // Preserve the existing parent stage until another child status gives us a
  // deterministic derived state.
  return currentStatus;
}

function formatDownloadProgress(downloaded, results) {
  if (results === 0) return null;
  return `${parseFloat(((downloaded / results) * 100).toFixed(2))}%`;
}

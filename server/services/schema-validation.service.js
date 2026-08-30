const BASELINE_QUERY_COLUMNS = Object.freeze([
  "id",
  "pageUrl",
  "searchUrl",
  "status",
  "results",
  "resultsPerPart",
  "parts",
  "order",
  "createdAt",
  "updatedAt",
  "lastAttempt",
  "downloaded",
  "downloadProgress",
  "warnings",
]);
const BASELINE_SEARCH_RESULT_COLUMNS = Object.freeze([
  "id",
  "title",
  "href",
  "fileName",
  "queryId",
  "status",
]);

/**
 * Verifies that an old `prisma db push` database has the tracked baseline
 * shape before the migration wrapper adopts its history. Column presence is
 * not enough here: the application relies on the baseline's uniqueness and
 * cascading relationship constraints too.
 *
 * @param {Set<string>} queryColumns
 * @param {Set<string>} searchResultColumns
 * @param {{
 *   queryIndexes?: Array<{ unique?: boolean, columns?: string[] }>,
 *   searchResultIndexes?: Array<{ unique?: boolean, columns?: string[] }>,
 *   searchResultForeignKeys?: Array<{
 *     table?: string,
 *     from?: string,
 *     to?: string,
 *     onDelete?: string,
 *     onUpdate?: string,
 *   }>,
 * }} [constraints]
 */
export function assertCompatibleLegacySchema(
  queryColumns,
  searchResultColumns,
  { queryIndexes = [], searchResultIndexes = [], searchResultForeignKeys = [] } = {}
) {
  const missingQueryColumns = BASELINE_QUERY_COLUMNS.filter((column) => !queryColumns.has(column));
  const missingSearchResultColumns = BASELINE_SEARCH_RESULT_COLUMNS.filter(
    (column) => !searchResultColumns.has(column)
  );
  const missingConstraints = [];

  if (!hasUniqueIndex(queryIndexes, ["pageUrl"])) {
    missingConstraints.push("unique Query.pageUrl index");
  }
  if (!hasUniqueIndex(searchResultIndexes, ["queryId", "href"])) {
    missingConstraints.push("unique SearchResult(queryId, href) index");
  }
  if (
    !searchResultForeignKeys.some(
      (foreignKey) =>
        foreignKey.table === "Query" &&
        foreignKey.from === "queryId" &&
        foreignKey.to === "id" &&
        String(foreignKey.onDelete).toUpperCase() === "CASCADE" &&
        String(foreignKey.onUpdate).toUpperCase() === "CASCADE"
    )
  ) {
    missingConstraints.push("SearchResult.queryId → Query.id cascading foreign key");
  }

  if (
    missingQueryColumns.length > 0 ||
    missingSearchResultColumns.length > 0 ||
    missingConstraints.length > 0
  ) {
    throw new Error(
      `Legacy database schema is incompatible with the tracked baseline (missing Query columns: ${missingQueryColumns.join(", ") || "none"}; missing SearchResult columns: ${missingSearchResultColumns.join(", ") || "none"}; missing constraints: ${missingConstraints.join(", ") || "none"}). Restore a backup and migrate it deliberately.`
    );
  }
}

function hasUniqueIndex(indexes, expectedColumns) {
  return indexes.some(
    (index) =>
      index.unique === true &&
      Array.isArray(index.columns) &&
      index.columns.length === expectedColumns.length &&
      index.columns.every((column, position) => column === expectedColumns[position])
  );
}

export const baselineQueryColumns = BASELINE_QUERY_COLUMNS;
export const baselineSearchResultColumns = BASELINE_SEARCH_RESULT_COLUMNS;

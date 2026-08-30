import { describe, expect, it } from "vitest";
import { assertCompatibleLegacySchema } from "../../services/schema-validation.service.js";

const queryColumns = new Set([
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
const searchResultColumns = new Set(["id", "title", "href", "fileName", "queryId", "status"]);
const baselineConstraints = {
  queryIndexes: [{ unique: true, columns: ["pageUrl"] }],
  searchResultIndexes: [{ unique: true, columns: ["queryId", "href"] }],
  searchResultForeignKeys: [
    {
      table: "Query",
      from: "queryId",
      to: "id",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
  ],
};

describe("legacy schema compatibility checks", () => {
  it("accepts the baseline columns and constraints", () => {
    expect(() =>
      assertCompatibleLegacySchema(queryColumns, searchResultColumns, baselineConstraints)
    ).not.toThrow();
  });

  it.each([
    ["the Query page URL uniqueness constraint", { queryIndexes: [] }],
    ["the SearchResult query/href uniqueness constraint", { searchResultIndexes: [] }],
    ["the cascading SearchResult foreign key", { searchResultForeignKeys: [] }],
  ])("rejects a legacy schema missing %s", (_description, missing) => {
    expect(() =>
      assertCompatibleLegacySchema(queryColumns, searchResultColumns, {
        ...baselineConstraints,
        ...missing,
      })
    ).toThrow(/missing constraints/);
  });
});

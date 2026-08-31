-- Baseline for the SQLite schema that existed before tracked migrations were
-- restored. Lifecycle fields are added by the following migration.
CREATE TABLE "Query" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pageUrl" TEXT NOT NULL,
    "searchUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "results" INTEGER,
    "resultsPerPart" INTEGER,
    "parts" INTEGER,
    "order" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastAttempt" DATETIME,
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "downloadProgress" TEXT,
    "warnings" TEXT
);

CREATE TABLE "SearchResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "queryId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT "SearchResult_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Query_pageUrl_key" ON "Query" ("pageUrl");
CREATE UNIQUE INDEX "SearchResult_queryId_href_key" ON "SearchResult" ("queryId", "href");

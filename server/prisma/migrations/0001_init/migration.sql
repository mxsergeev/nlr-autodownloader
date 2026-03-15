-- CreateEnum
CREATE TYPE "QueryStatus" AS ENUM ('pending', 'downloading', 'completed', 'download_blocked', 'search_failed');

-- CreateTable
CREATE TABLE "Query" (
    "id" SERIAL NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "status" "QueryStatus" NOT NULL DEFAULT 'pending',
    "results" INTEGER,
    "resultsPerPart" INTEGER,
    "parts" INTEGER,
    "order" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastAttempt" TIMESTAMP(3),
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "downloadProgress" TEXT,

    CONSTRAINT "Query_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchResult" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "queryId" INTEGER NOT NULL,

    CONSTRAINT "SearchResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Query_pageUrl_key" ON "Query"("pageUrl");

-- CreateIndex
CREATE UNIQUE INDEX "SearchResult_queryId_href_key" ON "SearchResult"("queryId", "href");

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

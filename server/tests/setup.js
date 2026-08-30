import { afterAll } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Use a unique directory for each Vitest worker. The setup is intentionally
// environment-driven so imported application services use the same database
// and downloads directory as the test fixture.
const runDirectory = await mkdtemp(path.join(os.tmpdir(), "nlr-autodownloader-tests-"));

process.env.DATABASE_URL = `file:${path.join(runDirectory, "nlr.db")}`;
process.env.DOWNLOADS_DIR = path.join(runDirectory, "downloads");
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";

await mkdir(process.env.DOWNLOADS_DIR, { recursive: true });

// Creating the small schema directly avoids shelling out to Prisma from a
// worker process. It keeps test startup local and deterministic while using
// the same generated Prisma client as the application.
const { PrismaClient } = await import("@prisma/client");
const setupPrisma = new PrismaClient();
await setupPrisma.$executeRawUnsafe(
  `CREATE TABLE "Query" (
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
  )`
);
await setupPrisma.$executeRawUnsafe(
  `CREATE TABLE "SearchResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "queryId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    FOREIGN KEY ("queryId") REFERENCES "Query" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`
);
await setupPrisma.$executeRawUnsafe(
  `CREATE UNIQUE INDEX "Query_pageUrl_key" ON "Query" ("pageUrl")`
);
await setupPrisma.$executeRawUnsafe(
  `CREATE UNIQUE INDEX "SearchResult_queryId_href_key" ON "SearchResult" ("queryId", "href")`
);
await setupPrisma.$disconnect();

afterAll(async () => {
  const { prisma } = await import("../services/db.service.js");
  await prisma.$disconnect();
  await rm(runDirectory, { recursive: true, force: true });
});

export { runDirectory };

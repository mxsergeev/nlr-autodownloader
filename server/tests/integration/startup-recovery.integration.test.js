import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";

const queues = vi.hoisted(() => {
  const makeQueue = () => ({
    getJobs: vi.fn().mockResolvedValue([]),
  });

  return {
    metadataQueue: makeQueue(),
    searchQueue: makeQueue(),
    downloadQueue: makeQueue(),
  };
});

const enqueue = vi.hoisted(() => ({
  addMetadataJob: vi.fn().mockResolvedValue(true),
  addSearchJob: vi.fn().mockResolvedValue(true),
  addDownloadJobBulk: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../queue.js", () => queues);
vi.mock("../../queues/metadata.queue.js", () => ({ addMetadataJob: enqueue.addMetadataJob }));
vi.mock("../../queues/search.queue.js", () => ({ addSearchJob: enqueue.addSearchJob }));
vi.mock("../../queues/download.queue.js", () => ({
  addDownloadJobBulk: enqueue.addDownloadJobBulk,
}));

const { prisma } = await import("../../services/db.service.js");
const { DOWNLOADS_DIR, getDownloadedFilePath, getQueryDownloadDir, isValidPdfFile } =
  await import("../../services/file.service.js");
const { recoverOnStartup } = await import("../../services/startup-recovery.service.js");
const { startApplication } = await import("../../index.js");

describe("startup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const queue of Object.values(queues)) queue.getJobs.mockResolvedValue([]);
    enqueue.addMetadataJob.mockResolvedValue(true);
    enqueue.addSearchJob.mockResolvedValue(true);
    enqueue.addDownloadJobBulk.mockResolvedValue(true);
  });

  afterEach(async () => {
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
    await fs.rm(DOWNLOADS_DIR, { recursive: true, force: true });
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  });

  it("repairs stale counters and marks a valid canonical file completed", async () => {
    const query = await createQuery({
      status: "download_queued",
      results: 99,
      downloaded: 99,
      downloadProgress: "100%",
    });
    const [completed, pending] = await createItems(query.id, [
      { fileName: "First" },
      { fileName: "Second" },
    ]);
    await writePdf(getDownloadedFilePath(query.id, completed.id));

    await expect(recoverOnStartup()).resolves.toMatchObject({ queries: 1, migrated: 0 });

    await expect(prisma.query.findUnique({ where: { id: query.id } })).resolves.toMatchObject({
      status: "download_queued",
      results: 2,
      downloaded: 1,
      downloadProgress: "50%",
    });
    await expect(
      prisma.searchResult.findUnique({ where: { id: completed.id } })
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      prisma.searchResult.findUnique({ where: { id: pending.id } })
    ).resolves.toMatchObject({ status: "pending" });
    expect(enqueue.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation,
    });
  });

  it("downgrades a completed item with a missing or invalid file and requeues it", async () => {
    const query = await createQuery({
      status: "completed",
      results: 1,
      downloaded: 1,
      downloadProgress: "100%",
    });
    const [item] = await createItems(query.id, [{ status: "completed", fileName: "Broken" }]);
    const filePath = getDownloadedFilePath(query.id, item.id);
    await writePdf(filePath, "<html>not a PDF</html>");

    await recoverOnStartup();

    expect(await isValidPdfFile(filePath)).toBe(false);
    await expect(prisma.query.findUnique({ where: { id: query.id } })).resolves.toMatchObject({
      status: "download_queued",
      results: 1,
      downloaded: 0,
      downloadProgress: "0%",
    });
    await expect(prisma.searchResult.findUnique({ where: { id: item.id } })).resolves.toMatchObject(
      { status: "pending" }
    );
    expect(enqueue.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation,
    });
  });

  it("recovers an interrupted download without treating it as completed", async () => {
    const query = await createQuery({ status: "downloading", results: 1 });
    const [item] = await createItems(query.id, [{ status: "downloading" }]);

    await recoverOnStartup();

    await expect(prisma.searchResult.findUnique({ where: { id: item.id } })).resolves.toMatchObject(
      { status: "pending" }
    );
    await expect(prisma.query.findUnique({ where: { id: query.id } })).resolves.toMatchObject({
      status: "download_queued",
      downloaded: 0,
      downloadProgress: "0%",
    });
    expect(enqueue.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation,
    });
  });

  it.each([
    ["paused", "paused"],
    ["search_failed", "pending"],
    ["download_blocked", "download_blocked"],
  ])("does not create automatic jobs for %s queries", async (status, itemStatus) => {
    const query = await createQuery({ status, results: 1 });
    await createItems(query.id, [{ status: itemStatus }]);

    await recoverOnStartup();

    expect(enqueue.addMetadataJob).not.toHaveBeenCalled();
    expect(enqueue.addSearchJob).not.toHaveBeenCalled();
    expect(enqueue.addDownloadJobBulk).not.toHaveBeenCalled();
    await expect(prisma.query.findUnique({ where: { id: query.id } })).resolves.toMatchObject({
      status,
    });
  });

  it("requeues interrupted metadata and search stages with the current generation", async () => {
    const metadataQuery = await createQuery({ status: "fetching_metadata" });
    const searchQuery = await createQuery({
      status: "fetching_results",
      pageUrl: "https://primo.nlr.ru/discovery/search?query=startup-search",
    });

    await recoverOnStartup();

    expect(enqueue.addMetadataJob).toHaveBeenCalledWith({
      queryId: metadataQuery.id,
      generation: metadataQuery.generation,
    });
    expect(enqueue.addSearchJob).toHaveBeenCalledWith({
      queryId: searchQuery.id,
      generation: searchQuery.generation,
    });
  });

  it("migrates unique legacy title files to stable item IDs", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [first, second] = await createItems(query.id, [
      { fileName: "Legacy First" },
      { fileName: "Legacy Second" },
    ]);
    const firstLegacy = path.join(getQueryDownloadDir(query.id), "Legacy First.pdf");
    const secondLegacy = path.join(getQueryDownloadDir(query.id), "Legacy Second.pdf");
    await writePdf(firstLegacy, "%PDF-1.7 first legacy");
    await writePdf(secondLegacy, "%PDF-1.7 second legacy");

    await expect(recoverOnStartup()).resolves.toMatchObject({ migrated: 2 });

    expect(await isValidPdfFile(getDownloadedFilePath(query.id, first.id))).toBe(true);
    expect(await isValidPdfFile(getDownloadedFilePath(query.id, second.id))).toBe(true);
    expect(await fs.stat(firstLegacy).catch(() => null)).toBeNull();
    expect(await fs.stat(secondLegacy).catch(() => null)).toBeNull();
    await expect(prisma.query.findUnique({ where: { id: query.id } })).resolves.toMatchObject({
      status: "completed",
      downloaded: 2,
    });
    expect(enqueue.addDownloadJobBulk).not.toHaveBeenCalled();
  });

  it("does not complete multiple items from one colliding legacy title file", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [first, second] = await createItems(query.id, [
      { fileName: "Same Legacy Title" },
      { fileName: "Same Legacy Title" },
    ]);
    const legacyPath = path.join(getQueryDownloadDir(query.id), "Same Legacy Title.pdf");
    await writePdf(legacyPath);

    await expect(recoverOnStartup()).resolves.toMatchObject({ migrated: 0 });

    expect(await fs.stat(legacyPath).catch(() => null)).toBeNull();
    expect(await fs.stat(getDownloadedFilePath(query.id, first.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getDownloadedFilePath(query.id, second.id)).catch(() => null)).toBeNull();
    await expect(prisma.searchResult.findMany({ where: { queryId: query.id } })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "pending" }),
        expect.objectContaining({ id: second.id, status: "pending" }),
      ])
    );
    expect(enqueue.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation,
    });
  });

  it("cleans orphan query directories and retained queue jobs before recovery", async () => {
    const query = await createQuery({ status: "completed" });
    const orphanDirectory = path.join(DOWNLOADS_DIR, "999999");
    await fs.mkdir(orphanDirectory, { recursive: true });
    await writePdf(path.join(orphanDirectory, "1.pdf"));

    const staleJob = { remove: vi.fn().mockResolvedValue(undefined) };
    queues.metadataQueue.getJobs.mockResolvedValue([staleJob]);

    await recoverOnStartup();

    expect(await fs.stat(orphanDirectory).catch(() => null)).toBeNull();
    expect(staleJob.remove).toHaveBeenCalledOnce();
    expect(queues.metadataQueue.getJobs).toHaveBeenCalledWith([
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "paused",
    ]);
    expect(enqueue.addMetadataJob).not.toHaveBeenCalled();
    expect(query).toBeDefined();
  });
});

describe("worker startup ordering", () => {
  it("awaits recovery before loading workers", async () => {
    const events = [];

    await expect(
      startApplication({
        listen: false,
        recover: async () => {
          events.push("recovery-start");
          await Promise.resolve();
          events.push("recovery-complete");
        },
        loadWorkers: async () => {
          events.push("workers-loaded");
          return { workers: true };
        },
      })
    ).resolves.toEqual({ workers: true });

    expect(events).toEqual(["recovery-start", "recovery-complete", "workers-loaded"]);
  });
});

async function createQuery(overrides = {}) {
  const fixture = makeQueryFixture({
    pageUrl: `https://primo.nlr.ru/discovery/search?query=startup-${Date.now()}-${Math.random()}`,
    ...overrides,
  });

  return prisma.query.create({
    data: {
      ...fixture,
      order: BigInt(fixture.order),
    },
  });
}

async function createItems(queryId, overrides) {
  return Promise.all(
    overrides.map((itemOverrides, index) =>
      prisma.searchResult.create({
        data: {
          ...makeSearchResultFixture({
            href: `https://primo.nlr.ru/discovery/fulldisplay?docid=startup-${queryId}-${index}`,
            ...itemOverrides,
          }),
          queryId,
        },
      })
    )
  );
}

async function writePdf(filePath, contents = "%PDF-1.7 valid document") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

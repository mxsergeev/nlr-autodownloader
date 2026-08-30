import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";
import { deferred } from "../helpers/deferred.js";
import {
  getMetadataById,
  prisma,
  saveSearchResults,
  upsertMetadata,
} from "../../services/db.service.js";
import { removeQuery, togglePause } from "../../services/query.service.js";
import {
  getDownloadedFilePath,
  getDownloadTempPath,
  getQueryDownloadDir,
  isValidPdfFile,
} from "../../services/file.service.js";
import { processDownloadJob } from "../../workers/processors/download.processor.js";

const queueFns = vi.hoisted(() => ({
  addDownloadRetryJob: vi.fn().mockResolvedValue(true),
  cancelDownloadJobs: vi.fn().mockResolvedValue(0),
  cancelQueryDownloadJobs: vi.fn().mockResolvedValue(0),
}));
const queues = vi.hoisted(() => {
  const makeQueue = () => ({ getJobs: vi.fn().mockResolvedValue([]) });
  return {
    metadataQueue: makeQueue(),
    searchQueue: makeQueue(),
    downloadQueue: makeQueue(),
  };
});
const scraperFns = vi.hoisted(() => ({
  scrapeDownload: vi.fn(),
}));

vi.mock("../../queues/download.queue.js", () => queueFns);
vi.mock("../../queue.js", () => queues);
vi.mock("../../services/scraper.service.js", () => scraperFns);

describe("ID-based download finalization", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
  });

  it("moves a valid temporary PDF to the item ID path and completes the item", async () => {
    const { query, item } = await createDownloadFixture();
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 valid document");
    });

    const job = downloadJob(query, item);
    await processDownloadJob(job);

    const finalPath = getDownloadedFilePath(query.id, item.id);
    expect(await isValidPdfFile(finalPath)).toBe(true);
    expect(await fs.stat(getDownloadTempPath(job.id)).catch(() => null)).toBeNull();
    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "completed",
      downloaded: 1,
      searchResults: [{ id: item.id, status: "completed" }],
    });
  });

  it("does not finalize a temporary file when the query is paused before release", async () => {
    const { query, item } = await createDownloadFixture();
    const wroteTemp = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 paused document");
      wroteTemp.resolve();
      await release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await wroteTemp.promise;
    await expect(togglePause(query.id)).resolves.toMatchObject({ paused: true });
    release.resolve();
    await processing;

    expect(await fs.stat(getDownloadedFilePath(query.id, item.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getDownloadTempPath(job.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getQueryDownloadDir(query.id)).catch(() => null)).toBeNull();
    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "paused",
      searchResults: [{ id: item.id, status: "paused" }],
    });
  });

  it("does not recreate a deleted query directory after a temporary write", async () => {
    const { query, item } = await createDownloadFixture();
    const wroteTemp = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 deleted document");
      wroteTemp.resolve();
      await release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await wroteTemp.promise;
    await removeQuery({ id: query.id });
    release.resolve();
    await processing;

    expect(await fs.stat(getDownloadedFilePath(query.id, item.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getQueryDownloadDir(query.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getDownloadTempPath(job.id)).catch(() => null)).toBeNull();
    await expect(getMetadataById(query.id)).resolves.toBeNull();
  });

  it("does not finalize when the generation becomes stale after the temporary write", async () => {
    const { query, item } = await createDownloadFixture();
    const wroteTemp = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 stale document");
      wroteTemp.resolve();
      await release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await wroteTemp.promise;
    await prisma.query.update({
      where: { id: query.id },
      data: { generation: query.generation + 1 },
    });
    release.resolve();
    await processing;

    expect(await fs.stat(getDownloadedFilePath(query.id, item.id)).catch(() => null)).toBeNull();
    expect(await fs.stat(getDownloadTempPath(job.id)).catch(() => null)).toBeNull();
    await expect(prisma.searchResult.findUnique({ where: { id: item.id } })).resolves.toMatchObject(
      {
        status: "downloading",
      }
    );
  });

  it.each(["", "<html>not a PDF</html>", "%PDF"])(
    "rejects invalid browser output (%s) before completion",
    async (contents) => {
      const { query, item } = await createDownloadFixture();
      scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
        await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });
        await fs.writeFile(temporaryFilePath, contents);
      });

      await expect(processDownloadJob(downloadJob(query, item))).rejects.toThrow(
        "Downloaded file is not a valid PDF"
      );
      expect(await fs.stat(getDownloadedFilePath(query.id, item.id)).catch(() => null)).toBeNull();
      await expect(
        prisma.searchResult.findUnique({ where: { id: item.id } })
      ).resolves.toMatchObject({
        status: "downloading",
      });
    }
  );
});

async function createDownloadFixture() {
  const query = await upsertMetadata(
    { url: `https://primo.nlr.ru/discovery/download-test?query=${Date.now()}-${Math.random()}` },
    makeQueryFixture({ status: "download_queued", results: 1 })
  );
  await saveSearchResults({ queryId: query.id }, [
    makeSearchResultFixture({ href: `https://primo.nlr.ru/item/${query.id}` }),
  ]);
  const fullQuery = await getMetadataById(query.id);
  return { query: fullQuery, item: fullQuery.searchResults[0] };
}

function downloadJob(query, item) {
  return {
    id: `download-${item.id}-g${query.generation}`,
    data: { queryId: query.id, generation: query.generation, itemId: item.id, attempt: 1 },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";
import { deferred } from "../helpers/deferred.js";
import {
  getMetadataById,
  prisma,
  saveSearchResults,
  upsertMetadata,
} from "../../services/db.service.js";
import {
  toggleItemPause,
  togglePause,
  removeItem,
  removeQuery,
  retryQuery,
} from "../../services/query.service.js";
import { processMetadataJob } from "../../workers/processors/metadata.processor.js";
import {
  handleDownloadJobCompleted,
  handleDownloadJobFailure,
  processDownloadJob,
} from "../../workers/processors/download.processor.js";
import { processSearchJob } from "../../workers/processors/search.processor.js";

const queues = vi.hoisted(() => {
  const makeQueue = () => ({
    getJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
  });

  return {
    metadataQueue: makeQueue(),
    searchQueue: makeQueue(),
    downloadQueue: makeQueue(),
  };
});

const queueFns = vi.hoisted(() => ({
  addMetadataJob: vi.fn().mockResolvedValue(true),
  addSearchJob: vi.fn().mockResolvedValue(true),
  addDownloadJobBulk: vi.fn().mockResolvedValue(true),
  addDownloadRetryJob: vi.fn().mockResolvedValue(true),
  cancelDownloadJobs: vi.fn().mockResolvedValue(0),
  cancelQueryDownloadJobs: vi.fn().mockResolvedValue(0),
}));

const scraperFns = vi.hoisted(() => ({
  scrapeMetadata: vi.fn(),
  scrapeSearchResults: vi.fn(),
  verifySearchResults: vi.fn(),
  deduplicateResults: vi.fn((results) => results),
  scrapeDownload: vi.fn(),
}));

vi.mock("../../queue.js", () => queues);
vi.mock("../../queues/metadata.queue.js", () => ({ addMetadataJob: queueFns.addMetadataJob }));
vi.mock("../../queues/search.queue.js", () => ({ addSearchJob: queueFns.addSearchJob }));
vi.mock("../../queues/download.queue.js", () => queueFns);
vi.mock("../../services/scraper.service.js", () => scraperFns);

describe("generation-based query lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scraperFns.verifySearchResults.mockImplementation((results) => ({
      ok: results.length > 0,
      warnings: [],
    }));
    scraperFns.deduplicateResults.mockImplementation((results) => results);
    queueFns.addDownloadJobBulk.mockResolvedValue(true);
    queueFns.addDownloadRetryJob.mockResolvedValue(true);
    queues.metadataQueue.getJobs.mockResolvedValue([]);
    queues.searchQueue.getJobs.mockResolvedValue([]);
    queues.downloadQueue.getJobs.mockResolvedValue([]);
  });

  afterEach(async () => {
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
  });

  it("pausing during metadata prevents stale metadata and search advancement", async () => {
    const query = await createQuery({ status: "pending" });
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeMetadata.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });

    const processing = processMetadataJob(jobFor(query));
    await started.promise;
    await expect(togglePause(query.id)).resolves.toMatchObject({ paused: true });

    release.resolve({
      results: 1,
      resultsPerPart: 1,
      parts: 1,
      pageUrl: "https://primo.nlr.ru/discovery/search?resolved=true",
    });
    await processing;

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "paused",
      generation: query.generation + 1,
      resumeStatus: "fetching_metadata",
      results: null,
      searchResults: [],
    });
    expect(queueFns.addSearchJob).not.toHaveBeenCalled();
  });

  it("pausing during search prevents stale results and download advancement", async () => {
    const query = await createQuery({ status: "fetching_results", results: 1 });
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeSearchResults.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });

    const processing = processSearchJob(jobFor(query));
    await started.promise;
    await expect(togglePause(query.id)).resolves.toMatchObject({ paused: true });

    release.resolve([
      makeSearchResultFixture({
        href: "https://primo.nlr.ru/discovery/fulldisplay?docid=stale",
      }),
    ]);
    await processing;

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "paused",
      generation: query.generation + 1,
      resumeStatus: "fetching_results",
      searchResults: [],
    });
    expect(queueFns.addDownloadJobBulk).not.toHaveBeenCalled();
  });

  it("pausing during an active download prevents stale completion status", async () => {
    const query = await createQuery({ status: "download_queued", results: 1 });
    const [item] = await saveOneResult(query.id);
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await started.promise;
    await expect(togglePause(query.id)).resolves.toMatchObject({ paused: true });

    release.resolve();
    await processing;
    await handleDownloadJobCompleted(job);

    await expect(getMetadataById(query.id)).resolves.toMatchObject({ status: "paused" });
    const state = await prisma.searchResult.findUnique({ where: { id: item.id } });
    expect(state.status).toBe("pending");
  });

  it("item pause wins a race with an active download claim", async () => {
    const query = await createQuery({ status: "download_queued", results: 1 });
    const [item] = await saveOneResult(query.id);
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await started.promise;
    await expect(toggleItemPause(query.id, item.id)).resolves.toMatchObject({ paused: true });

    release.resolve();
    await processing;
    await handleDownloadJobCompleted(job);

    await expect(prisma.searchResult.findUnique({ where: { id: item.id } })).resolves.toMatchObject(
      {
        status: "paused",
      }
    );
  });

  it("deleting during an active download prevents stale DB progress", async () => {
    const query = await createQuery({ status: "download_queued", results: 1 });
    const [item] = await saveOneResult(query.id);
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });

    const job = downloadJob(query, item);
    const processing = processDownloadJob(job);
    await started.promise;
    await removeQuery({ id: query.id }, { removeDownloads: false });

    release.resolve();
    await processing;
    await handleDownloadJobCompleted(job);

    await expect(getMetadataById(query.id)).resolves.toBeNull();
    expect(queueFns.cancelDownloadJobs).toHaveBeenCalledWith(item.id);
  });

  it("deleting an item requeues a pending sibling under the new generation", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [deleted, survivor] = await saveResults(query.id, 2);
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 surviving document");
    });

    await removeItem(query.id, deleted.id);

    const refreshed = await getMetadataById(query.id);
    expect(refreshed).toMatchObject({
      generation: query.generation + 1,
      status: "download_queued",
      results: 1,
      downloaded: 0,
    });
    expect(queueFns.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 1,
    });

    await processDownloadJob(downloadJob(refreshed, survivor));

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "completed",
      downloaded: 1,
      results: 1,
    });
    await expect(
      prisma.searchResult.findUnique({ where: { id: survivor.id } })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("deleting an item resets an active sibling and lets fresh work complete", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [deleted, survivor] = await saveResults(query.id, 2);
    const started = deferred();
    const release = deferred();
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      started.resolve();
      await release.promise;
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 surviving document");
    });

    const staleJob = downloadJob(query, survivor);
    const staleProcessing = processDownloadJob(staleJob);
    await started.promise;
    await expect(
      prisma.searchResult.findUnique({ where: { id: survivor.id } })
    ).resolves.toMatchObject({ status: "downloading" });

    await removeItem(query.id, deleted.id);
    await expect(
      prisma.searchResult.findUnique({ where: { id: survivor.id } })
    ).resolves.toMatchObject({ status: "pending" });

    release.resolve();
    await expect(staleProcessing).resolves.toBeNull();

    const refreshed = await getMetadataById(query.id);
    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 surviving document");
    });
    await processDownloadJob(downloadJob(refreshed, survivor));

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "completed",
      downloaded: 1,
      results: 1,
    });
    await expect(
      prisma.searchResult.findUnique({ where: { id: survivor.id } })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("deleting an item preserves a paused sibling until it is explicitly resumed", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [deleted, survivor] = await saveResults(query.id, 2);
    await expect(toggleItemPause(query.id, survivor.id)).resolves.toMatchObject({ paused: true });

    await removeItem(query.id, deleted.id);

    await expect(
      prisma.searchResult.findUnique({ where: { id: survivor.id } })
    ).resolves.toMatchObject({ status: "paused" });
    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      generation: query.generation + 1,
      status: "download_queued",
      results: 1,
    });
    expect(queueFns.addDownloadJobBulk).not.toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 1,
    });

    scraperFns.scrapeDownload.mockImplementation(async (_item, temporaryFilePath) => {
      await fs.writeFile(temporaryFilePath, "%PDF-1.7 surviving document");
    });
    await expect(toggleItemPause(query.id, survivor.id)).resolves.toMatchObject({ paused: false });
    const resumed = await getMetadataById(query.id);
    await processDownloadJob(downloadJob(resumed, survivor));

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "completed",
      downloaded: 1,
      results: 1,
    });
  });

  it("whole-query pause/resume preserves an independently paused child", async () => {
    const query = await createQuery({ status: "download_queued", results: 2 });
    const [individuallyPaused, pending] = await saveResults(query.id, 2);
    await expect(toggleItemPause(query.id, individuallyPaused.id)).resolves.toMatchObject({
      paused: true,
    });

    await expect(togglePause(query.id)).resolves.toMatchObject({ paused: true });
    await expect(togglePause(query.id)).resolves.toMatchObject({
      paused: false,
      status: "download_queued",
    });

    await expect(
      prisma.searchResult.findUnique({ where: { id: individuallyPaused.id } })
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      prisma.searchResult.findUnique({ where: { id: pending.id } })
    ).resolves.toMatchObject({ status: "pending" });
    expect(queueFns.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 2,
    });
  });

  it("resumes metadata-stage queries using a fresh generation", async () => {
    const query = await createQuery({ status: "pending" });
    await togglePause(query.id);
    queueFns.addMetadataJob.mockClear();

    await expect(togglePause(query.id)).resolves.toMatchObject({
      paused: false,
      status: "pending",
    });
    const resumed = await getMetadataById(query.id);
    expect(resumed.generation).toBe(query.generation + 2);
    expect(queueFns.addMetadataJob).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 2,
    });
  });

  it("resumes search-stage queries using a fresh generation", async () => {
    const query = await createQuery({ status: "fetching_results" });
    await togglePause(query.id);
    queueFns.addSearchJob.mockClear();

    await expect(togglePause(query.id)).resolves.toMatchObject({
      paused: false,
      status: "fetching_results",
    });
    expect(queueFns.addSearchJob).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 2,
    });
  });

  it("resumes download-stage queries by queuing pending items only", async () => {
    const query = await createQuery({ status: "download_queued", results: 1 });
    const [item] = await saveOneResult(query.id);
    await togglePause(query.id);
    queueFns.addDownloadJobBulk.mockClear();

    await expect(togglePause(query.id)).resolves.toMatchObject({
      paused: false,
      status: "download_queued",
    });
    expect(queueFns.addDownloadJobBulk).toHaveBeenCalledWith({
      queryId: query.id,
      generation: query.generation + 2,
    });
    await expect(prisma.searchResult.findUnique({ where: { id: item.id } })).resolves.toMatchObject(
      {
        status: "pending",
      }
    );
  });

  it("does not retry stale download work after an explicit restart", async () => {
    const query = await createQuery({ status: "download_blocked", results: 1 });
    const [item] = await saveOneResult(query.id);
    await prisma.searchResult.update({
      where: { id: item.id },
      data: { status: "download_blocked" },
    });

    const staleJob = downloadJob(query, item);
    await retryQuery(query.id);
    queueFns.addDownloadRetryJob.mockClear();
    await handleDownloadJobFailure(staleJob, new Error("stale failure"));

    const state = await getMetadataById(query.id);
    expect(state.generation).toBe(query.generation + 1);
    expect(state.searchResults[0].status).toBe("pending");
    expect(queueFns.addDownloadRetryJob).not.toHaveBeenCalled();
  });
});

async function createQuery(overrides = {}) {
  return upsertMetadata(
    { url: "https://primo.nlr.ru/discovery/search?query=lifecycle" },
    makeQueryFixture(overrides)
  );
}

async function saveOneResult(queryId) {
  await saveSearchResults({ queryId }, [
    makeSearchResultFixture({ href: `https://primo.nlr.ru/item/${queryId}` }),
  ]);
  return prisma.searchResult.findMany({ where: { queryId } });
}

async function saveResults(queryId, count) {
  await saveSearchResults(
    { queryId },
    Array.from({ length: count }, (_, index) =>
      makeSearchResultFixture({
        title: `Lifecycle document ${index + 1}`,
        fileName: `Lifecycle document ${index + 1}`,
        href: `https://primo.nlr.ru/item/${queryId}-${index + 1}`,
      })
    )
  );
  return prisma.searchResult.findMany({ where: { queryId }, orderBy: { id: "asc" } });
}

function jobFor(query) {
  return { id: `job-${query.id}`, data: { queryId: query.id, generation: query.generation } };
}

function downloadJob(query, item) {
  return {
    id: `download-${item.id}`,
    data: { queryId: query.id, generation: query.generation, itemId: item.id, attempt: 1 },
  };
}

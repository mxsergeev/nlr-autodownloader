import { beforeEach, describe, expect, it, vi } from "vitest";

const queues = vi.hoisted(() => {
  const makeQueue = () => ({
    getJob: vi.fn(),
    add: vi.fn(),
    addBulk: vi.fn(),
  });

  return {
    metadataQueue: makeQueue(),
    searchQueue: makeQueue(),
    downloadQueue: makeQueue(),
  };
});

const db = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) },
}));
const lifecycle = vi.hoisted(() => ({
  getCurrentQuery: vi.fn(),
  isCurrentGeneration: vi.fn(),
}));
const file = vi.hoisted(() => ({
  getDownloadedFileNames: vi.fn(),
  verifyDownloads: vi.fn(),
}));

vi.mock("../../queue.js", () => queues);
vi.mock("../../services/db.service.js", () => db);
vi.mock("../../services/query-generation.service.js", () => lifecycle);
vi.mock("../../services/file.service.js", () => file);

const [{ addMetadataJob }, { addSearchJob }, downloadQueueModule] = await Promise.all([
  import("../../queues/metadata.queue.js"),
  import("../../queues/search.queue.js"),
  import("../../queues/download.queue.js"),
]);
const { addDownloadJobBulk, addDownloadRetryJob } = downloadQueueModule;

describe("queue final generation barriers", () => {
  let generationValid;
  const query = {
    id: 12,
    generation: 4,
    pageUrl: "https://primo.nlr.ru/search",
    searchResults: [{ id: 99, status: "pending", fileName: "Book" }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    generationValid = true;
    db.getMetadata.mockResolvedValue(query);
    lifecycle.getCurrentQuery.mockResolvedValue(query);
    lifecycle.isCurrentGeneration.mockImplementation(async () => generationValid);
    queues.metadataQueue.getJob.mockResolvedValue(null);
    queues.searchQueue.getJob.mockResolvedValue(null);
    queues.downloadQueue.getJob.mockResolvedValue(null);
    queues.metadataQueue.add.mockResolvedValue(undefined);
    queues.searchQueue.add.mockResolvedValue(undefined);
    queues.downloadQueue.add.mockResolvedValue(undefined);
    queues.downloadQueue.addBulk.mockResolvedValue(undefined);
    file.getDownloadedFileNames.mockResolvedValue(new Set());
    file.verifyDownloads.mockImplementation((_downloads, searchResults) => ({
      missingFiles: searchResults,
    }));
  });

  it("does not create metadata work if invalidation wins after job lookup", async () => {
    queues.metadataQueue.getJob.mockImplementation(async () => {
      generationValid = false;
      return null;
    });

    await expect(addMetadataJob({ queryId: query.id, generation: query.generation })).resolves.toBe(
      false
    );
    expect(queues.metadataQueue.add).not.toHaveBeenCalled();
  });

  it("does not create search work if invalidation wins after job lookup", async () => {
    queues.searchQueue.getJob.mockImplementation(async () => {
      generationValid = false;
      return null;
    });

    await expect(addSearchJob({ queryId: query.id, generation: query.generation })).resolves.toBe(
      false
    );
    expect(queues.searchQueue.add).not.toHaveBeenCalled();
  });

  it("does not create bulk download work if invalidation wins after file inspection", async () => {
    file.getDownloadedFileNames.mockImplementation(async () => {
      generationValid = false;
      return new Set();
    });

    await expect(
      addDownloadJobBulk({ queryId: query.id, generation: query.generation })
    ).resolves.toBe(false);
    expect(queues.downloadQueue.addBulk).not.toHaveBeenCalled();
  });

  it("does not create retry work when invalidation wins between lookup and add", async () => {
    queues.downloadQueue.getJob.mockImplementation(async () => {
      generationValid = false;
      return null;
    });

    await expect(
      addDownloadRetryJob({
        queryId: query.id,
        generation: query.generation,
        itemId: 99,
        attempt: 2,
        delay: 100,
      })
    ).resolves.toBe(false);
    expect(queues.downloadQueue.add).not.toHaveBeenCalled();
  });
});

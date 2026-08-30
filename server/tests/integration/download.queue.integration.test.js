import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";
import {
  getMetadataById,
  prisma,
  saveSearchResults,
  upsertMetadata,
} from "../../services/db.service.js";
import { getDownloadedFilePath, getQueryDownloadDir } from "../../services/file.service.js";

const downloadQueue = vi.hoisted(() => ({
  addBulk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../queue.js", () => ({ downloadQueue }));

const { addDownloadJobBulk } = await import("../../queues/download.queue.js");

describe("download queue reconciliation", () => {
  let queryId;

  afterEach(async () => {
    vi.clearAllMocks();
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
    if (queryId != null) {
      await fs.rm(getQueryDownloadDir(queryId), { recursive: true, force: true });
    }
    queryId = undefined;
  });

  it("completes a pending item with a valid file and queues only the missing item", async () => {
    const query = await upsertMetadata(
      { url: `https://primo.nlr.ru/discovery/queue-reconcile?query=${Date.now()}` },
      makeQueryFixture({ status: "download_queued", results: 2 })
    );
    queryId = query.id;
    await saveSearchResults({ queryId: query.id }, [
      makeSearchResultFixture({
        title: "Already present",
        fileName: "Already present",
        href: `https://primo.nlr.ru/item/${query.id}-present`,
      }),
      makeSearchResultFixture({
        title: "Needs download",
        fileName: "Needs download",
        href: `https://primo.nlr.ru/item/${query.id}-missing`,
      }),
    ]);
    const [present, missing] = await prisma.searchResult.findMany({
      where: { queryId: query.id },
      orderBy: { id: "asc" },
    });
    await fs.mkdir(getQueryDownloadDir(query.id), { recursive: true });
    await fs.writeFile(getDownloadedFilePath(query.id, present.id), "%PDF-1.7 existing PDF");

    await expect(
      addDownloadJobBulk({ queryId: query.id, generation: query.generation })
    ).resolves.toBe(true);

    await expect(
      prisma.searchResult.findUnique({ where: { id: present.id } })
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      prisma.searchResult.findUnique({ where: { id: missing.id } })
    ).resolves.toMatchObject({ status: "pending" });
    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "download_queued",
      results: 2,
      downloaded: 1,
      downloadProgress: "50%",
    });

    expect(downloadQueue.addBulk).toHaveBeenCalledOnce();
    expect(downloadQueue.addBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "download",
        data: {
          queryId: query.id,
          generation: query.generation,
          itemId: missing.id,
        },
      }),
    ]);
  });
});

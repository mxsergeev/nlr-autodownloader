import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryFixture } from "../fixtures/query.fixture.js";
import { deferred } from "../helpers/deferred.js";
import { prisma, getMetadataById, upsertMetadata } from "../../services/db.service.js";
import { processSearchJob } from "../../workers/processors/search.processor.js";
import { scrapeSearchResults } from "../../services/scraper.service.js";
import { addDownloadJobBulk } from "../../queues/download.queue.js";

vi.mock("../../services/scraper.service.js", () => ({
  scrapeSearchResults: vi.fn(),
  verifySearchResults: (results) => ({ ok: results.length > 0, warnings: [] }),
  deduplicateResults: (results) => results,
}));

vi.mock("../../queues/download.queue.js", () => ({
  addDownloadJobBulk: vi.fn(),
}));

describe("search processor integration", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
  });

  it("persists scraped results and queues downloads through the extracted processor", async () => {
    const fixture = makeQueryFixture({ results: 2, resultsPerPart: 2, parts: 1 });
    const query = await upsertMetadata({ url: fixture.pageUrl }, fixture);
    const scrapedResults = [
      {
        title: "First document",
        href: "https://primo.nlr.ru/first",
        fileName: "First document",
      },
      {
        title: "Second document",
        href: "https://primo.nlr.ru/second",
        fileName: "Second document",
      },
    ];
    scrapeSearchResults.mockResolvedValue(scrapedResults);
    addDownloadJobBulk.mockResolvedValue(true);

    await processSearchJob({ id: "search-1", data: { metadata: { ...fixture, id: query.id } } });

    const persistedQuery = await getMetadataById(query.id);
    expect(persistedQuery.status).toBe("download_queued");
    expect(persistedQuery.searchResults).toHaveLength(2);
    expect(addDownloadJobBulk).toHaveBeenCalledWith({
      metadata: expect.objectContaining({ id: query.id }),
      searchResults: expect.arrayContaining([
        expect.objectContaining({ href: "https://primo.nlr.ru/first" }),
        expect.objectContaining({ href: "https://primo.nlr.ru/second" }),
      ]),
    });
  });

  it("observes a pause at the processor barrier before queuing downloads", async () => {
    const fixture = makeQueryFixture({ results: 1, resultsPerPart: 1, parts: 1 });
    const query = await upsertMetadata({ url: fixture.pageUrl }, fixture);
    const scrapeStarted = deferred();
    const releaseScrape = deferred();
    const scrapedResults = [
      {
        title: "Paused document",
        href: "https://primo.nlr.ru/paused",
        fileName: "Paused document",
      },
    ];

    scrapeSearchResults.mockImplementation(async () => {
      scrapeStarted.resolve();
      return releaseScrape.promise;
    });

    const processing = processSearchJob({
      id: "search-paused",
      data: { metadata: { ...fixture, id: query.id } },
    });

    await scrapeStarted.promise;
    await upsertMetadata({ id: query.id }, { status: "paused" });
    releaseScrape.resolve(scrapedResults);
    await processing;

    const persistedQuery = await getMetadataById(query.id);
    expect(persistedQuery.status).toBe("paused");
    expect(persistedQuery.searchResults).toEqual([
      expect.objectContaining({ href: "https://primo.nlr.ru/paused" }),
    ]);
    expect(addDownloadJobBulk).not.toHaveBeenCalled();
  });
});

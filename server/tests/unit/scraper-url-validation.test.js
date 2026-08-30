import { beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ runJob: vi.fn() }));

vi.mock("../../services/browser.service.js", () => browser);

const { scrapeMetadata, scrapeSearchResults } = await import("../../services/scraper.service.js");

describe("scraper navigation validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a navigation that redirects to an untrusted host before scraping", async () => {
    const page = makeMetadataPage("https://127.0.0.1/private");
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeMetadata({ url: "https://primo.nlr.ru/discovery/search?query=redirect" })
    ).rejects.toThrow("allowed NLR host");
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it("accepts a same-host redirect and records the final allowed URL", async () => {
    const page = makeMetadataPage("https://primo.nlr.ru/discovery/search?canonical=1");
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeMetadata({ url: "https://primo.nlr.ru/discovery/search?query=redirect" })
    ).resolves.toMatchObject({
      results: 1,
      resultsPerPart: 1,
      parts: 1,
      pageUrl: "https://primo.nlr.ru/discovery/search?canonical=1",
    });
  });

  it("rejects an untrusted document link extracted from search results", async () => {
    const page = {
      goto: vi.fn(),
      url: () => "https://primo.nlr.ru/discovery/search?offset=0",
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        evaluateAll: vi
          .fn()
          .mockResolvedValue([{ title: "A document", href: "https://attacker.example/document" }]),
      })),
    };
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeSearchResults({
        searchUrl: "https://primo.nlr.ru/discovery/search?query=documents",
        parts: 1,
        resultsPerPart: 1,
      })
    ).rejects.toThrow("allowed NLR host");
  });

  it("resolves a relative document link against the allowed result page", async () => {
    const page = {
      goto: vi.fn(),
      url: () => "https://primo.nlr.ru/discovery/search?offset=0",
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        evaluateAll: vi
          .fn()
          .mockResolvedValue([{ title: "A document", href: "/discovery/fulldisplay?docid=123" }]),
      })),
    };
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeSearchResults({
        searchUrl: "https://primo.nlr.ru/discovery/search?query=documents",
        parts: 1,
        resultsPerPart: 1,
      })
    ).resolves.toEqual([
      {
        title: "A document",
        href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123",
        fileName: "A document",
      },
    ]);
  });
});

function makeMetadataPage(finalUrl) {
  return {
    goto: vi.fn(),
    url: () => finalUrl,
    getByRole: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(false) })),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((selector) => {
      if (selector === ".results-count")
        return { textContent: vi.fn().mockResolvedValue("1 результат") };
      return { count: vi.fn().mockResolvedValue(1) };
    }),
  };
}

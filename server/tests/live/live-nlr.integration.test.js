import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrapeMetadata, scrapeSearchResults } from "../../services/scraper.service.js";
import { shutdownBrowser } from "../../services/browser.service.js";
import { validateNlrUrl, validateScrapedUrl } from "../../services/url.service.js";

const DEFAULT_SEARCH_URL = "https://primo.nlr.ru/primo-explore/search?query=any,contains,Pushkin";
const LIVE_TESTS_ENABLED = process.env.RUN_LIVE_NLR_TESTS === "1";
const SEARCH_URL = process.env.NLR_LIVE_SEARCH_URL || DEFAULT_SEARCH_URL;
const PROBE_TIMEOUT_MS = 15_000;

// Validate the configured URL before making any network request. This also
// guarantees that a typo or an untrusted override cannot turn the live gate
// into a general-purpose browser/fetch runner.
const validatedSearchUrl = LIVE_TESTS_ENABLED
  ? validateNlrUrl(SEARCH_URL, { label: "NLR_LIVE_SEARCH_URL" })
  : null;
const probe = LIVE_TESTS_ENABLED
  ? await probeLiveEndpoint(validatedSearchUrl)
  : { available: false, reason: "RUN_LIVE_NLR_TESTS is not set to 1" };

if (LIVE_TESTS_ENABLED && !probe.available) {
  console.warn(`[Live NLR] Gate not executed: ${probe.reason}`);
}

const liveSuite = describe.skipIf(!LIVE_TESTS_ENABLED);

liveSuite("live NLR scraper contract", () => {
  let metadata;
  let results;

  it("accepts the configured real NLR search URL", () => {
    expect(validatedSearchUrl).toBeInstanceOf(URL);
    expect(validatedSearchUrl.protocol).toBe("https:");
    expect(validatedSearchUrl.hostname).toBe("primo.nlr.ru");
  });

  describe.skipIf(!probe.available)("live selectors and navigation", () => {
    beforeAll(async () => {
      // Deliberately scrape metadata once and only the first result page.
      // A broad NLR query can contain many pages; this gate is a selector
      // check, not a bulk crawl or download test.
      metadata = await scrapeMetadata({ url: validatedSearchUrl.href });
      results = await scrapeSearchResults(
        {
          ...metadata,
          searchUrl: metadata.pageUrl,
          parts: 1,
        },
        { scrapedUrls: new Set() }
      );
    }, 60_000);

    afterAll(async () => {
      await shutdownBrowser();
    });

    it("reads result-count metadata and preserves an allowed final URL", () => {
      expect(metadata).toEqual(
        expect.objectContaining({
          results: expect.any(Number),
          resultsPerPart: expect.any(Number),
          parts: expect.any(Number),
          pageUrl: expect.any(String),
        })
      );
      expect(metadata.results).toBeGreaterThan(0);
      expect(metadata.resultsPerPart).toBeGreaterThan(0);
      expect(metadata.parts).toBeGreaterThan(0);
      expect(validateNlrUrl(metadata.pageUrl).hostname).toBe("primo.nlr.ru");
    });

    it("finds first-page document links and validates their download URLs", () => {
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(metadata.resultsPerPart);

      for (const result of results) {
        expect(result.title.trim()).not.toBe("");
        expect(result.fileName.trim()).not.toBe("");

        const documentUrl = validateScrapedUrl(result.href, metadata.pageUrl, {
          label: "Live NLR document URL",
        });
        expect(documentUrl.hostname).toBe("primo.nlr.ru");
        expect(documentUrl.protocol).toBe("https:");
      }
    });
  });
});

/**
 * Performs a small, non-browser availability probe so an expected firewall,
 * outage, or rate-limit does not look like a selector failure. Redirects are
 * not followed here; any browser navigation is still validated by the real
 * scraper after Playwright follows redirects.
 */
async function probeLiveEndpoint(url) {
  try {
    const response = await fetch(url.href, {
      redirect: "manual",
      headers: { "user-agent": "nlr-autodownloader-live-test/1.0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status >= 400) {
      return {
        available: false,
        reason: `NLR endpoint returned HTTP ${response.status}`,
      };
    }

    return { available: true, reason: `HTTP ${response.status}` };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

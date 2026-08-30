import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidPdfFile } from "../../services/file.service.js";
import {
  scrapeDownload,
  scrapeMetadata,
  scrapeSearchResults,
} from "../../services/scraper.service.js";
import { shutdownBrowser } from "../../services/browser.service.js";
import { validatePrimoUrl, validateScrapedUrl } from "../../services/url.service.js";

const DEFAULT_SEARCH_URL =
  "https://primo.nlr.ru/primo-explore/search?vid=07NLR_VU1&lang=ru_RU&search_scope=default_scope&tab=default_tab&query=any,contains,07NLR_LMS022470404";
const EXPECTED_RECORD_ID = "07NLR_LMS022470404";
const LIVE_TESTS_ENABLED = process.env.RUN_LIVE_NLR_TESTS === "1";
const SEARCH_URL = process.env.NLR_LIVE_SEARCH_URL || DEFAULT_SEARCH_URL;
const PROBE_TIMEOUT_MS = 15_000;

// Validate the configured URL before making any network request. This also
// guarantees that a typo or an untrusted override cannot turn the live gate
// into a general-purpose browser/fetch runner.
const validatedSearchUrl = LIVE_TESTS_ENABLED
  ? validatePrimoUrl(SEARCH_URL, { label: "NLR_LIVE_SEARCH_URL" })
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
  let targetResult;

  it("accepts the configured real NLR search URL", () => {
    expect(validatedSearchUrl).toBeInstanceOf(URL);
    expect(validatedSearchUrl.protocol).toBe("https:");
    expect(validatedSearchUrl.hostname).toBe("primo.nlr.ru");
  });

  describe.skipIf(!probe.available)("live selectors and navigation", () => {
    beforeAll(async () => {
      // Deliberately scrape metadata once and only the first result page.
      // A broad NLR query can contain many pages; this gate validates one
      // discovered document end-to-end rather than bulk-crawling the result set.
      metadata = await scrapeMetadata({ url: validatedSearchUrl.href });
      results = await scrapeSearchResults(
        {
          ...metadata,
          searchUrl: metadata.pageUrl,
          parts: 1,
        },
        { scrapedUrls: new Set() }
      );
      targetResult = results.find((result) => result.href.includes(EXPECTED_RECORD_ID));
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
      expect(validatePrimoUrl(metadata.pageUrl).hostname).toBe("primo.nlr.ru");
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

    it("discovers the real Primo record and downloads one full PDF through the application scraper", async () => {
      expect(targetResult).toEqual(
        expect.objectContaining({
          href: expect.stringContaining(EXPECTED_RECORD_ID),
        })
      );
      const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "nlr-live-application-download-")
      );
      const temporaryFilePath = path.join(temporaryDirectory, "document.pdf");

      try {
        await scrapeDownload(targetResult, temporaryFilePath);

        const contents = await fs.readFile(temporaryFilePath);
        expect(contents.length).toBeGreaterThan(0);
        expect(contents.subarray(0, 5).toString()).toBe("%PDF-");
        expect(contents.includes(Buffer.from("%%EOF"))).toBe(true);
        await expect(isValidPdfFile(temporaryFilePath)).resolves.toBe(true);

        console.log(
          `[Live NLR] Primo discovery + application Vivaldi download: ${contents.length} bytes saved`
        );
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }, 180_000);
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

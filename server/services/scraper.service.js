import { promises as fs } from "fs";
import path from "path";
import { runJob } from "./browser.service.js";
import { sanitizeFileName } from "./file.service.js";
import { config } from "../config.js";
import { validateFinalNavigation, validateNlrUrl, validateScrapedUrl } from "./url.service.js";

const SCRAPE_PAGE_DELAY_MS = config.scrapePageDelayMs;
const DOWNLOAD_START_JITTER_MS = config.downloadStartJitterMs;

/**
 * Scrapes query metadata (result count, pagination) from a Primo result page.
 * @param {{ url: string }} params
 * @returns {Promise<{ results: number, resultsPerPart: number, parts: number, pageUrl: string }>}
 */
export async function scrapeMetadata({ url } = {}) {
  const requestedUrl = validateNlrUrl(url, { label: "Metadata URL" });

  return runJob(async (page) => {
    await gotoAllowed(page, requestedUrl.href, "Metadata URL");

    const sortButton = page.getByRole("button", { name: "Сортировать по Релевантность" });
    const sortButtonExists = await sortButton.isVisible({ timeout: 3000 }).catch(() => false);

    if (sortButtonExists) {
      await sortButton.click({ timeout: 5000 });
      await page.getByRole("option", { name: "Дата выхода периодики (по возр.)" }).click();
      validateFinalNavigation(page, { label: "Metadata sort navigation URL" });
    }

    await page.waitForSelector(".item-title", { timeout: 15000 }).catch(() => {
      throw new Error("No results found for the given search criteria.");
    });

    const resultCount = await page
      .locator(".results-count", { hasText: "результат" })
      .textContent();
    const match = resultCount.match(/(\d+)/);
    const resultNumber = match ? parseInt(match[1], 10) : null;
    const resultsPerPart = await page.locator(".item-title").count();
    const parts = resultNumber ? Math.ceil(resultNumber / resultsPerPart) : 1;
    const finalUrl = validateFinalNavigation(page, { label: "Metadata final URL" }).href;

    console.log(
      `[Metadata] Successfully scraped metadata: ${resultNumber} results, ${resultsPerPart} per page, ${parts} parts`
    );

    return { results: resultNumber, resultsPerPart, parts, pageUrl: finalUrl };
  });
}

/**
 * Scrapes all document links for a query across all pages.
 * Does NOT persist to the database — callers are responsible for saving results.
 * @param {import('../../shared/types.js').Query} metadata
 * @param {{ scrapedUrls?: Set<string> }} [options]
 * @returns {Promise<{ title: string, href: string, fileName: string }[]>}
 */
export async function scrapeSearchResults(metadata, { scrapedUrls = new Set() } = {}) {
  const requestedUrl = validateNlrUrl(metadata.searchUrl || metadata.pageUrl, {
    label: "Search URL",
  });

  return runJob(async (page) => {
    const seenUrls = new Set(scrapedUrls);
    const results = [];
    const baseUrl = new URL(requestedUrl.href);

    for (let curPart = 1; curPart <= (metadata.parts || 1); curPart++) {
      baseUrl.searchParams.set("offset", String((curPart - 1) * metadata.resultsPerPart));
      await gotoAllowed(page, baseUrl.toString(), "Search page URL");
      await page.waitForSelector(".item-title", { timeout: 15000 });

      const headings = page.locator(".item-title");
      const headingData = await headings.evaluateAll((elements) => {
        return elements.map((element) => {
          const anchor = element.querySelector("a");
          const rawText = element.textContent.trim();
          const cleanText = rawText.replace(/^[=\s]+/, "").replace(/\s+/g, " ");
          return { title: cleanText, href: anchor ? anchor.href : null };
        });
      });

      for (const item of headingData) {
        if (!item.href) continue;

        // Validate links at the point they cross from page-controlled data
        // into application-controlled download work. Relative links are
        // resolved against the final URL of the page that contained them.
        item.href = validateScrapedUrl(item.href, page.url(), {
          label: "Scraped document URL",
        }).href;
        item.fileName = sanitizeFileName(item.title);
      }

      for (const item of headingData) {
        if (item.href && !seenUrls.has(item.href)) {
          seenUrls.add(item.href);
          results.push(item);
        }
      }

      if (curPart < (metadata.parts || 1)) {
        const delay = SCRAPE_PAGE_DELAY_MS + Math.floor(Math.random() * SCRAPE_PAGE_DELAY_MS);
        await page.waitForTimeout(delay);
      }
    }

    return results;
  });
}

/**
 * Downloads a single document PDF to the given global temporary path.
 * Throws 'Download blocked' if the download button is inaccessible.
 * @param {{ href: string, fileName: string }} item
 * @param {string} temporaryFilePath Absolute path in the global temporary area.
 * @returns {Promise<string>} The temporary file path.
 */
export async function scrapeDownload(item, temporaryFilePath) {
  const requestedUrl = validateNlrUrl(item?.href, { label: "Document URL" });

  return runJob(async (page) => {
    await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });

    if (DOWNLOAD_START_JITTER_MS > 0) {
      await page.waitForTimeout(Math.floor(Math.random() * DOWNLOAD_START_JITTER_MS));
    }

    let page1 = null;
    let page2 = null;
    try {
      await gotoAllowed(page, requestedUrl.href, "Document URL");
      const page1Promise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
      await page.getByLabel("Электронная копия").click();
      page1 = await page1Promise;
      if (!page1) throw new Error("Download blocked: detail page popup did not open");
      await waitForAllowedPage(page1, "Document popup URL");
      await page1.getByRole("link", { name: "Карточка" }).click();
      await waitForAllowedPage(page1, "Document card URL");
      await page1.locator("#btn-download").click();

      const page2Promise = page1.waitForEvent("popup", { timeout: 30000 }).catch(() => null);
      const downloadPromise = page1.waitForEvent("download", { timeout: 30000 }).catch(() => null);

      await page1
        .getByLabel("Загрузка всего документа")
        .getByRole("link", { name: "Скачать" })
        .click({ timeout: 30000 })
        .catch(() => {
          throw new Error("Download blocked");
        });

      page2 = await page2Promise;
      if (page2) await waitForAllowedPage(page2, "Download popup URL");
      const file = await downloadPromise;

      if (!file) {
        throw new Error("Download blocked: no download event received within timeout");
      }

      await file.saveAs(temporaryFilePath);
      await fs.chmod(temporaryFilePath, 0o664);
    } finally {
      if (page2) await page2.close();
      if (page1) await page1.close();
    }

    return temporaryFilePath;
  });
}

/**
 * Navigates only to an allow-listed URL and verifies the URL after redirects
 * have completed. Playwright follows redirects by default, so both checks
 * are required.
 */
async function gotoAllowed(page, requestedUrl, label) {
  validateNlrUrl(requestedUrl, { label });
  await page.goto(requestedUrl);
  validateFinalNavigation(page, { label: `Final ${label}` });
}

async function waitForAllowedPage(page, label) {
  if (typeof page.waitForLoadState === "function") {
    await page.waitForLoadState("domcontentloaded").catch(() => null);
  }
  validateFinalNavigation(page, { label });
}

/**
 * Returns true if the scraped results match the expected count with no duplicates.
 * Logs warnings for each violated condition.
 * @param {import('../../shared/types.js').SearchResult[]} results
 * @param {import('../../shared/types.js').Query} metadata
 * @returns {boolean}
 */
/**
 * Verifies scraped search results against expected metadata.
 * Returns an object with `ok` (whether to proceed) and `warnings` (diagnostic messages).
 * - Count mismatch: ok=true (proceed with what we have), warning logged
 * - Duplicates: ok=true (caller should deduplicate), warning logged
 * - Zero results: ok=false (genuine failure)
 * @param {Array} results
 * @param {{ results: number, id: number }} metadata
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function verifySearchResults(results, metadata) {
  const warnings = [];

  if (results.length === 0) {
    warnings.push(`Expected ${metadata.results} results, but got 0.`);
    return { ok: false, warnings };
  }

  if (results.length !== metadata.results) {
    warnings.push(
      `Expected ${metadata.results} results, but got ${results.length}. Proceeding with ${results.length}.`
    );
  }

  const seenUrls = new Set();
  const duplicates = [];

  for (const item of results) {
    if (seenUrls.has(item.href)) {
      duplicates.push(item.href);
    } else {
      seenUrls.add(item.href);
    }
  }

  if (duplicates.length > 0) {
    warnings.push(`Found ${duplicates.length} duplicate URL(s) — they will be deduplicated.`);
  }

  return { ok: true, warnings };
}

/**
 * Removes duplicate entries by href, keeping the first occurrence.
 * @param {Array<{ href: string }>} results
 * @returns {Array}
 */
export function deduplicateResults(results) {
  const seen = new Set();
  return results.filter((item) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

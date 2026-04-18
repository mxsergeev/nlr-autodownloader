import { promises as fs } from "fs";
import path from "path";
import { runJob } from "./browser.service.js";
import { sanitizeFileName } from "./file.service.js";

const SCRAPE_PAGE_DELAY_MS = parseInt(process.env.SCRAPE_PAGE_DELAY_MS || "1200", 10);
const DOWNLOAD_START_JITTER_MS = parseInt(process.env.DOWNLOAD_START_JITTER_MS || "1500", 10);

/**
 * Scrapes query metadata (result count, pagination) from a Primo result page.
 * @param {{ url: string }} params
 * @returns {Promise<{ results: number, resultsPerPart: number, parts: number, pageUrl: string }>}
 */
export async function scrapMetadata({ url } = {}) {
  return runJob(async (page) => {
    await page.goto(url);

    const sortButton = page.getByRole("button", { name: "Сортировать по Релевантность" });
    const sortButtonExists = await sortButton.isVisible({ timeout: 3000 }).catch(() => false);

    if (sortButtonExists) {
      await sortButton.click({ timeout: 5000 });
      await page.getByRole("option", { name: "Дата выхода периодики (по возр.)" }).click();
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
    const finalUrl = page.url();

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
export async function scrapSearchResults(metadata, { scrapedUrls = new Set() } = {}) {
  return runJob(async (page) => {
    const seenUrls = new Set(scrapedUrls);
    const results = [];
    const baseUrl = new URL(metadata.searchUrl || metadata.pageUrl);

    for (let curPart = 1; curPart <= (metadata.parts || 1); curPart++) {
      baseUrl.searchParams.set("offset", String((curPart - 1) * metadata.resultsPerPart));
      await page.goto(baseUrl.toString());
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

      headingData.forEach((item) => {
        item.fileName = sanitizeFileName(item.title);
      });

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
 * Downloads a single document PDF to the given storage directory.
 * Throws 'Download blocked' if the download button is inaccessible.
 * @param {{ href: string, fileName: string }} item
 * @param {string} storageDir  Absolute path to the directory where the PDF will be saved.
 */
export async function scrapDownload(item, storageDir) {
  return runJob(async (page) => {
    await fs.mkdir(storageDir, { recursive: true });

    if (DOWNLOAD_START_JITTER_MS > 0) {
      await page.waitForTimeout(Math.floor(Math.random() * DOWNLOAD_START_JITTER_MS));
    }

    let page1 = null;
    let page2 = null;
    try {
      await page.goto(item.href);
      const page1Promise = page.waitForEvent("popup").catch(() => {});
      await page.getByLabel("Электронная копия").click();
      page1 = await page1Promise;
      await page1.getByRole("link", { name: "Карточка" }).click();
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
      const file = await downloadPromise;

      if (!file) {
        throw new Error("Download blocked: no download event received within timeout");
      }

      const fileName = sanitizeFileName(item.fileName);
      const filePath = path.join(storageDir, `${fileName}.pdf`);
      await file.saveAs(filePath);
      await fs.chmod(filePath, 0o664);
    } finally {
      if (page2) await page2.close();
      if (page1) await page1.close();
    }
  });
}

/**
 * Returns true if the scraped results match the expected count with no duplicates.
 * Logs warnings for each violated condition.
 * @param {import('../../shared/types.js').SearchResult[]} results
 * @param {import('../../shared/types.js').Query} metadata
 * @returns {boolean}
 */
export function verifySearchResults(results, metadata) {
  if (results.length !== metadata.results) {
    console.warn(
      `[${metadata.id}] Warning: Expected ${metadata.results} results, but got ${results.length}.`
    );
    return false;
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
    console.warn(
      `[${metadata.id}] Warning: Found ${duplicates.length} duplicate items in the results.`
    );
    return false;
  }

  return true;
}

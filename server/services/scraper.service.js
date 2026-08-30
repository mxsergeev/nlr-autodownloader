import { promises as fs } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { runJob } from "./browser.service.js";
import { isValidPdfFile, sanitizeFileName } from "./file.service.js";
import { config } from "../config.js";
import {
  validateFinalNavigation,
  validatePrimoUrl,
  validateScrapedUrl,
  validateVivaldiDetailsUrl,
  validateVivaldiPartUrl,
  validateVivaldiViewerUrl,
  VIVALDI_NLR_HOST,
} from "./url.service.js";

const SCRAPE_PAGE_DELAY_MS = config.scrapePageDelayMs;
const DOWNLOAD_START_JITTER_MS = config.downloadStartJitterMs;

/**
 * Parses the result total shown by Primo's Russian UI.
 *
 * Primo may group thousands with an ASCII space, a non-breaking space, or a
 * narrow non-breaking space (for example, "1 234 результата"). Looking only
 * for the first run of digits would silently turn that value into 1.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseResultCount(value) {
  if (typeof value !== "string") return null;

  const groupedMatch = value.match(/(?:^|[^\d])(\d{1,3}(?:[\s\u00a0\u202f]\d{3})+)(?!\d)/u);
  const plainMatch = value.match(/(?:^|[^\d])(\d+)(?!\d)/u);
  const rawValue = groupedMatch?.[1] ?? plainMatch?.[1];
  if (!rawValue) return null;

  const parsed = Number(rawValue.replace(/[\s\u00a0\u202f]/gu, ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Scrapes query metadata (result count, pagination) from a Primo result page.
 * @param {{ url: string }} params
 * @returns {Promise<{ results: number, resultsPerPart: number, parts: number, pageUrl: string }>}
 */
export async function scrapeMetadata({ url } = {}) {
  const requestedUrl = validatePrimoUrl(url, { label: "Metadata URL" });

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
    const resultNumber = parseResultCount(resultCount);
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
  const requestedUrl = validatePrimoUrl(metadata.searchUrl || metadata.pageUrl, {
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
  const requestedUrl = validatePrimoUrl(item?.href, { label: "Document URL" });

  return runJob(async (page) => {
    await fs.mkdir(path.dirname(temporaryFilePath), { recursive: true });

    if (DOWNLOAD_START_JITTER_MS > 0) {
      await page.waitForTimeout(Math.floor(Math.random() * DOWNLOAD_START_JITTER_MS));
    }

    let page1 = null;
    const popupPages = [];
    try {
      await gotoAllowed(page, requestedUrl.href, "Document URL");
      const page1Promise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
      await page.getByLabel("Электронная копия").click();
      page1 = await page1Promise;
      if (!page1) throw new Error("Download blocked: detail page popup did not open");
      const viewerUrl = await waitForVivaldiViewerPage(page1, "Document viewer URL");
      await page1.getByRole("link", { name: "Карточка" }).click();
      const detailsUrl = await waitForVivaldiDetailsPage(page1, "Document card URL");
      if (getVivaldiDocumentId(viewerUrl) !== getVivaldiDocumentId(detailsUrl)) {
        throw new Error(
          "Download blocked: Vivaldi viewer and details pages refer to different documents"
        );
      }
      await downloadFromVivaldi(page1, temporaryFilePath, {
        detailsUrl,
        onPopup: (popup) => popupPages.push(popup),
      });
    } finally {
      await Promise.all(popupPages.map((popup) => popup.close().catch(() => {})));
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
  validatePrimoUrl(requestedUrl, { label });
  await page.goto(requestedUrl);
  validatePrimoUrl(page.url(), { label: `Final ${label}` });
}

async function waitForVivaldiViewerPage(page, label) {
  return waitForVivaldiRoute(page, validateVivaldiViewerUrl, label);
}

async function waitForVivaldiDetailsPage(page, label) {
  return waitForVivaldiRoute(page, validateVivaldiDetailsUrl, label);
}

async function waitForVivaldiRoute(page, validator, label) {
  let currentUrl;
  try {
    currentUrl = validator(page.url(), { label });
  } catch {
    if (typeof page.waitForURL !== "function") {
      if (typeof page.waitForLoadState === "function") {
        await page.waitForLoadState("domcontentloaded").catch(() => null);
      }
      return validator(page.url(), { label });
    }

    await page.waitForURL(
      (candidate) => {
        const candidateHref = candidate instanceof URL ? candidate.href : String(candidate);
        try {
          validator(candidateHref, { label });
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: config.downloadEventTimeoutMs,
        waitUntil: "commit",
      }
    );
    return validator(page.url(), { label });
  }

  if (typeof page.waitForLoadState === "function") {
    await page.waitForLoadState("domcontentloaded").catch(() => null);
  }
  return currentUrl;
}

/**
 * Completes the Vivaldi document-download flow after the Primo popup has
 * handed control to a Vivaldi details page. The page prepares every document
 * part through its own UI; the application never constructs or fetches an
 * arbitrary URL supplied by the caller. Multipart PDFs are merged in order so
 * one SearchResult still produces one whole-document PDF.
 */
async function downloadFromVivaldi(page, temporaryFilePath, { detailsUrl, onPopup } = {}) {
  const validatedDetailsUrl =
    detailsUrl ?? (await waitForVivaldiDetailsPage(page, "Vivaldi details URL"));
  const documentId = getVivaldiDocumentId(validatedDetailsUrl);
  const dialog = page.locator("#download-dialog");
  const partCount = parseVivaldiPartCount(await dialog.getAttribute("data-partscount"));

  await validateVivaldiDownloadEndpoints(page, dialog, validatedDetailsUrl, documentId);

  await page.locator("#btn-download").click({ timeout: config.downloadEventTimeoutMs });

  const partLinks = page.locator(".btn-download-part");
  const partPaths = [];
  try {
    for (let part = 0; part < partCount; part++) {
      const partLink = getPartLink(partLinks, part);
      await partLink.waitFor({
        state: "visible",
        timeout: config.downloadPreparationTimeoutMs,
      });

      const href = await partLink.getAttribute("href");
      const expectedPartUrl = validateVivaldiPartUrl(href, {
        label: `Vivaldi prepared part ${part} URL`,
        documentId,
        part,
      });
      const partPath = `${temporaryFilePath}.part-${part}`;
      partPaths.push(partPath);
      const file = await clickPreparedPartAndCaptureDownload(
        page,
        partLink,
        expectedPartUrl,
        onPopup
      );
      await file.saveAs(partPath);
      await fs.chmod(partPath, 0o664);
      if (!(await isValidPdfFile(partPath))) {
        throw new Error(`Downloaded Vivaldi part ${part} is not a valid PDF`);
      }
    }

    if (partCount === 1) {
      await fs.rename(partPaths[0], temporaryFilePath);
    } else {
      await mergePdfParts(partPaths, temporaryFilePath);
    }

    if (!(await isValidPdfFile(temporaryFilePath))) {
      throw new Error("Downloaded whole document is not a valid PDF");
    }
  } finally {
    await Promise.all(partPaths.map((partPath) => fs.rm(partPath, { force: true })));
  }
}

function parseVivaldiPartCount(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Download blocked: invalid Vivaldi document part count ${value ?? "none"}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Download blocked: invalid Vivaldi document part count ${value}`);
  }
  return count;
}

function getPartLink(partLinks, part) {
  if (typeof partLinks.nth === "function") return partLinks.nth(part);
  if (part === 0 && typeof partLinks.first === "function") return partLinks.first();
  throw new Error("Download blocked: Vivaldi prepared part link is unavailable");
}

async function mergePdfParts(partPaths, temporaryFilePath) {
  const mergedPath = `${temporaryFilePath}.merged`;
  try {
    const merged = await PDFDocument.create();
    for (const partPath of partPaths) {
      const bytes = await fs.readFile(partPath);
      const source = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    await fs.writeFile(mergedPath, await merged.save());
    await fs.chmod(mergedPath, 0o664);
    await fs.rename(mergedPath, temporaryFilePath);
  } finally {
    await fs.rm(mergedPath, { force: true });
  }
}

async function validateVivaldiDownloadEndpoints(page, dialog, detailsUrl, documentId) {
  const endpointAttributes = [
    [dialog, "data-register-url", "registerdownload"],
    [dialog, "data-prepare-download-url", "preparedownload"],
    [page.locator("#progressbar"), "data-progress", "downloadprogress"],
    [dialog, "data-part-download-url", "partfile"],
    [dialog, "data-cancel-url", "canceldownload"],
    [dialog, "data-keep-process-alive-url", "keepdownloadprocessalive"],
  ];

  for (const [locator, attribute, endpoint] of endpointAttributes) {
    const value = await locator.getAttribute(attribute);
    validateVivaldiEndpointUrl(value, detailsUrl, documentId, endpoint, attribute);
  }
}

function validateVivaldiEndpointUrl(value, detailsUrl, documentId, endpoint, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Download blocked: ${label} is missing`);
  }

  let parsed;
  try {
    parsed = new URL(value, detailsUrl.origin);
  } catch {
    throw new Error(`Download blocked: ${label} is not a valid URL`);
  }

  const expectedPath = `/pm${documentId}/${endpoint}`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== VIVALDI_NLR_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.origin !== detailsUrl.origin ||
    parsed.pathname !== expectedPath ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Download blocked: ${label} is outside the expected Vivaldi endpoint`);
  }

  return parsed;
}

async function clickPreparedPartAndCaptureDownload(page, partLink, expectedPartUrl, onPopup) {
  const downloadPromise = waitForBrowserEvent(page, "download");
  const popupPromise = waitForBrowserEvent(page, "popup");

  await partLink.click({ timeout: config.downloadEventTimeoutMs });
  const firstEvent = await Promise.race([
    downloadPromise.then((file) => ({ type: "download", file })),
    popupPromise.then((popup) => ({ type: "popup", popup })),
  ]);

  if (!firstEvent) {
    throw new Error("Download blocked: no download or part popup event received within timeout");
  }

  if (firstEvent.type === "download" && firstEvent.file) {
    validateDownloadedFileUrl(firstEvent.file, expectedPartUrl);
    return firstEvent.file;
  }

  if (firstEvent.type === "popup" && firstEvent.popup) {
    onPopup?.(firstEvent.popup);
    // A target="_blank" part link can navigate directly to an attachment.
    // Arm the popup listener before waiting for navigation or URL validation;
    // otherwise a fast response can emit the download event while the popup
    // is still being validated and the file is lost.
    const popupDownloadPromise = waitForBrowserEvent(firstEvent.popup, "download");
    const partPageUrl = await waitForVivaldiPartPage(
      firstEvent.popup,
      "Download popup URL",
      getVivaldiPartDocumentId(expectedPartUrl),
      getVivaldiPartNumber(expectedPartUrl)
    );
    if (partPageUrl.href !== expectedPartUrl.href) {
      throw new Error("Download blocked: download popup URL does not match the prepared part");
    }

    const popupResult = await Promise.race([
      downloadPromise.then((file) => ({ source: "opener", file })),
      popupDownloadPromise.then((file) => ({ source: "popup", file })),
    ]);
    if (popupResult?.file) {
      validateDownloadedFileUrl(popupResult.file, expectedPartUrl);
      return popupResult.file;
    }
  }

  throw new Error("Download blocked: no download event received within timeout");
}

function waitForBrowserEvent(target, event) {
  return target
    .waitForEvent(event, { timeout: config.downloadEventTimeoutMs })
    .then((value) => value || null)
    .catch(() => null);
}

async function waitForVivaldiPartPage(page, label, documentId, part) {
  return waitForVivaldiRoute(
    page,
    (value, options) =>
      validateVivaldiPartUrl(value, {
        ...options,
        documentId,
        part,
      }),
    label
  );
}

function getVivaldiPartNumber(url) {
  const part = url.searchParams.get("part");
  if (part == null) throw new Error("Download blocked: Vivaldi part number unavailable");
  return part;
}

function getVivaldiDocumentId(url) {
  const match = url.pathname.match(/^\/pm(\d+)\/(?:view|details)$/);
  if (!match) throw new Error("Download blocked: Vivaldi document ID unavailable");
  return match[1];
}

function getVivaldiPartDocumentId(url) {
  const match = url.pathname.match(/^\/pm(\d+)\/partfile$/);
  if (!match) throw new Error("Download blocked: Vivaldi part document ID unavailable");
  return match[1];
}

function validateDownloadedFileUrl(file, expectedPartUrl) {
  const actualUrl = typeof file?.url === "function" ? file.url() : null;
  if (!actualUrl) throw new Error("Download blocked: downloaded URL unavailable");

  const actualPartUrl = validateVivaldiPartUrl(actualUrl, {
    label: "Downloaded Vivaldi part URL",
    documentId: getVivaldiPartDocumentId(expectedPartUrl),
    part: getVivaldiPartNumber(expectedPartUrl),
  });
  if (actualPartUrl.href !== expectedPartUrl.href) {
    throw new Error("Download blocked: downloaded URL does not match the prepared part");
  }
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

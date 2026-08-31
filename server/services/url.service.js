import { config } from "../config.js";

/**
 * URLs accepted by the application are intentionally limited to the Primo
 * search service.  A crawler URL is user input, and a result URL is external
 * input, so both must pass the same allow-list before Playwright sees them.
 */
export const MAX_NLR_URL_LENGTH = 2048;
export const PRIMO_NLR_HOST = "primo.nlr.ru";
export const VIVALDI_NLR_HOST = "vivaldi.nlr.ru";

export const ALLOWED_NLR_HOSTS = Object.freeze(
  (config.allowedNlrHosts ?? ["primo.nlr.ru"]).map((host) => host.toLowerCase())
);

export class UrlValidationError extends Error {
  constructor(message, code = "INVALID_URL") {
    super(message);
    this.name = "UrlValidationError";
    this.code = code;
  }
}

/**
 * Validates an NLR URL and returns the parsed URL.  Exact host matching is
 * deliberate: allowing arbitrary subdomains would turn a typo or a
 * user-controlled DNS record into an SSRF primitive.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validateNlrUrl(value, { label = "URL" } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UrlValidationError(`${label} must be a non-empty URL`);
  }

  if (value.length > MAX_NLR_URL_LENGTH) {
    throw new UrlValidationError(
      `${label} exceeds the maximum length of ${MAX_NLR_URL_LENGTH} characters`
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UrlValidationError(`${label} is not a valid URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new UrlValidationError(`${label} must use HTTPS`);
  }

  if (parsed.username || parsed.password) {
    throw new UrlValidationError(`${label} must not contain credentials`);
  }

  if (!ALLOWED_NLR_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new UrlValidationError(`${label} host is not an allowed NLR host`);
  }

  // An alternate port is not needed by Primo and can expose a different
  // service behind an otherwise allowed host.  Empty and explicit 443 are
  // equivalent for HTTPS.
  if (parsed.port && parsed.port !== "443") {
    throw new UrlValidationError(`${label} must use the default HTTPS port`);
  }

  return parsed;
}

/**
 * Validates an end-user/search-result URL.  The queue and persisted
 * SearchResult rows intentionally remain Primo-only; Vivaldi is an internal
 * handoff used by the document scraper and is validated separately below.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validatePrimoUrl(value, { label = "Primo URL" } = {}) {
  const parsed = validateNlrUrl(value, { label });
  if (parsed.hostname.toLowerCase() !== PRIMO_NLR_HOST || parsed.port) {
    throw new UrlValidationError(`${label} must use the exact HTTPS Primo host`);
  }
  return parsed;
}

/**
 * Validates a Vivaldi viewer page reached from a Primo document link.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validateVivaldiViewerUrl(value, { label = "Vivaldi viewer URL" } = {}) {
  return validateVivaldiDocumentRoute(value, /^\/pm(\d+)\/view$/, label);
}

/**
 * Validates a Vivaldi document-details page reached from its viewer card.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validateVivaldiDetailsUrl(value, { label = "Vivaldi details URL" } = {}) {
  return validateVivaldiDocumentRoute(value, /^\/pm(\d+)\/details$/, label);
}

/**
 * Validates the prepared single-part Vivaldi download URL. If `documentId`
 * is provided, the part must belong to that exact document.
 *
 * @param {unknown} value
 * @param {{ label?: string, documentId?: string|number, part?: string|number }} [options]
 * @returns {URL}
 */
export function validateVivaldiPartUrl(
  value,
  { label = "Vivaldi part URL", documentId, part = 0 } = {}
) {
  const parsed = parseVivaldiUrl(value, label);
  const match = parsed.pathname.match(/^\/pm(\d+)\/partfile$/);
  const expectedPart = String(part);
  const actualPart = parsed.searchParams.get("part");
  if (
    !match ||
    (documentId != null && match[1] !== String(documentId)) ||
    !/^\d+$/.test(actualPart ?? "") ||
    !/^\d+$/.test(expectedPart) ||
    parsed.searchParams.size !== 1 ||
    actualPart !== expectedPart ||
    parsed.hash
  ) {
    throw new UrlValidationError(`${label} must be an exact Vivaldi part URL`);
  }
  return parsed;
}

function validateVivaldiDocumentRoute(value, pathPattern, label) {
  const parsed = parseVivaldiUrl(value, label);
  if (!pathPattern.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new UrlValidationError(`${label} is not an exact Vivaldi document route`);
  }
  return parsed;
}

function parseVivaldiUrl(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UrlValidationError(`${label} must be a non-empty URL`);
  }

  if (value.length > MAX_NLR_URL_LENGTH) {
    throw new UrlValidationError(
      `${label} exceeds the maximum length of ${MAX_NLR_URL_LENGTH} characters`
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UrlValidationError(`${label} is not a valid URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new UrlValidationError(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new UrlValidationError(`${label} must not contain credentials`);
  }
  if (parsed.hostname.toLowerCase() !== VIVALDI_NLR_HOST || parsed.port) {
    throw new UrlValidationError(`${label} must use the exact HTTPS Vivaldi host`);
  }

  return parsed;
}

/**
 * Boolean convenience wrapper for tests and callers that want to filter a
 * link without handling the validation exception themselves.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAllowedNlrUrl(value) {
  try {
    validateNlrUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a URL after Playwright navigation.  `page.goto()` follows
 * redirects, so checking only the requested URL is insufficient.
 *
 * @param {{ url: () => string }} page
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validateFinalNavigation(page, { label = "Navigation URL" } = {}) {
  if (!page || typeof page.url !== "function") {
    throw new UrlValidationError(`${label} could not be determined`, "NAVIGATION_URL_UNAVAILABLE");
  }

  return validateNlrUrl(page.url(), { label });
}

/**
 * Validate a link extracted from a page.  Relative links are resolved against
 * the page URL before applying the same host/protocol checks.
 *
 * @param {unknown} value
 * @param {string|URL} baseUrl
 * @param {{ label?: string }} [options]
 * @returns {URL}
 */
export function validateScrapedUrl(value, baseUrl, { label = "Scraped link" } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UrlValidationError(`${label} is empty`);
  }

  let absolute;
  try {
    absolute = new URL(value, baseUrl);
  } catch {
    throw new UrlValidationError(`${label} is not a valid URL`);
  }

  return validatePrimoUrl(absolute.href, { label });
}

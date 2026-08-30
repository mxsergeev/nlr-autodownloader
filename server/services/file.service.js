import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";
import { downloadsDir } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_PDF_SIZE_BYTES = 1024 * 1024 * 1024;
const PDF_HEADER = Buffer.from("%PDF-");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o775 });

export const DOWNLOADS_DIR = downloadsDir;
export const TEMP_DOWNLOADS_DIR = path.join(DOWNLOADS_DIR, ".tmp");
await fs.mkdir(DOWNLOADS_DIR, { recursive: true, mode: 0o775 });

/**
 * Returns the query directory used for finalized files.
 *
 * A query directory contains only files whose names are SearchResult IDs. It
 * is deliberately separate from TEMP_DOWNLOADS_DIR: deleting a query cannot
 * be undone by a stale browser job writing its temporary output.
 *
 * @param {number|string} queryId
 * @returns {string}
 */
export function getQueryDownloadDir(queryId) {
  return path.join(DOWNLOADS_DIR, String(requirePositiveInteger(queryId, "query ID")));
}

/**
 * Returns the canonical physical path for one SearchResult.
 *
 * @param {number|string} queryId
 * @param {number|string} itemId
 * @returns {string}
 */
export function getDownloadedFilePath(queryId, itemId) {
  return path.join(
    getQueryDownloadDir(queryId),
    `${requirePositiveInteger(itemId, "search result ID")}.pdf`
  );
}

/**
 * Returns the canonical query directory name. Query storage is always keyed
 * by the numeric query ID.
 *
 * @param {number|string|{ id?: number|string }} params
 * @returns {string}
 */
export function queryToString(params) {
  const queryId = typeof params === "object" ? params?.id : params;
  return String(requirePositiveInteger(queryId, "query ID"));
}

/**
 * Returns a global temporary path for one download job.
 *
 * BullMQ IDs are normally already safe path components. Restricting unusual
 * IDs here keeps a malformed job from escaping the temporary directory while
 * retaining the normal `<job-id>.pdf` name.
 *
 * @param {string|number} jobId
 * @returns {string}
 */
export function getDownloadTempPath(jobId) {
  const rawId = String(jobId ?? "").trim();
  const safeId = rawId.replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
  return path.join(TEMP_DOWNLOADS_DIR, `${safeId}.pdf`);
}

/**
 * Checks the physical file representation used as evidence of completion.
 * An accepted PDF must be a regular, non-empty, reasonably sized file whose
 * first five bytes are the PDF signature. Missing, directory, HTML, and
 * partial files are rejected.
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function isValidPdfFile(filePath, { maxBytes = MAX_PDF_SIZE_BYTES } = {}) {
  let handle;
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) return false;

    handle = await fs.open(filePath, "r");
    const header = Buffer.alloc(PDF_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === PDF_HEADER.length && header.equals(PDF_HEADER);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => null);
  }
}

// Keep a verb-oriented alias available to callers that prefer validation
// terminology. Both functions intentionally return a boolean rather than
// throwing for missing or malformed physical files.
export const validatePdfFile = isValidPdfFile;

/**
 * Returns valid downloaded base names in a query directory. Only canonical
 * ID-based PDFs are returned; display titles and any legacy title-based files
 * are deliberately ignored by the package-4 storage contract.
 *
 * @param {{ id: number|string }|number|string} metadata
 * @returns {Promise<Set<string>>}
 */
export async function getDownloadedFileNames(metadata) {
  const queryId = typeof metadata === "object" ? metadata?.id : metadata;
  if (queryId == null) return new Set();

  const storageDir = getQueryDownloadDir(queryId);
  let entries;
  try {
    entries = await fs.readdir(storageDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }

  const names = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".pdf") continue;
    const baseName = path.basename(entry.name, path.extname(entry.name));
    if (!/^\d+$/.test(baseName) || Number(baseName) <= 0) continue;
    const filePath = path.join(storageDir, entry.name);
    if (await isValidPdfFile(filePath)) names.add(baseName);
  }
  return names;
}

/**
 * Returns valid physical files whose canonical names are SearchResult IDs.
 * This is useful when a caller needs to distinguish new storage from legacy
 * title-based files without treating the latter as completed work.
 *
 * @param {{ id: number|string }|number|string} metadata
 * @returns {Promise<Set<string>>}
 */
export async function getDownloadedFileIds(metadata) {
  const names = await getDownloadedFileNames(metadata);
  return names;
}

/**
 * Returns search results that do not have a valid physical file.
 * SearchResult IDs are authoritative whenever present; the title fallback is
 * retained only for old unit callers that have no database ID at all.
 *
 * @param {Set<string|number>} downloads
 * @param {import('../../shared/types.js').SearchResult[]} searchResults
 * @returns {{ missingFiles: import('../../shared/types.js').SearchResult[] }}
 */
export function verifyDownloads(downloads = new Set(), searchResults = []) {
  const downloaded = downloads instanceof Set ? downloads : new Set(downloads);
  return {
    missingFiles: searchResults.filter((item) => {
      if (item?.id != null && Number.isInteger(Number(item.id)) && Number(item.id) > 0) {
        return !downloaded.has(String(item.id)) && !downloaded.has(Number(item.id));
      }
      return !downloaded.has(item?.fileName);
    }),
  };
}

/**
 * Sanitizes a string for use as a human-facing display name.
 * Removes invalid characters and cleans up dot-separated extensions. This
 * value must never be used as a physical storage identity.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFileName(name = "") {
  name = name.replace(/[/\\?%*:|"<>]/g, "_");
  const lastDotIndex = name.lastIndexOf(".");

  if (lastDotIndex > 0) {
    const base = name.substring(0, lastDotIndex).replace(/\./g, "");
    const ext = name.substring(lastDotIndex + 1);

    if (/^[a-zA-Z]+$/.test(ext)) {
      return base + "." + ext;
    } else {
      return name.replace(/\./g, "");
    }
  } else {
    return name.replace(/\./g, "");
  }
}

/**
 * Returns the sanitized human-facing PDF name for a SearchResult.
 *
 * @param {{ fileName?: string, title?: string, id?: number|string }} item
 * @returns {string}
 */
export function getDisplayFileName(item = {}) {
  const fallback = item.title || (item.id != null ? `document-${item.id}` : "document");
  const sanitized = sanitizeFileName(item.fileName || fallback).trim() || "document";
  return /\.pdf$/i.test(sanitized) ? sanitized.replace(/\.pdf$/i, ".pdf") : `${sanitized}.pdf`;
}

/**
 * Returns valid completed records for a query.
 *
 * @param {number|string} queryId
 * @param {import('../../shared/types.js').SearchResult[]} records
 * @returns {Promise<import('../../shared/types.js').SearchResult[]>}
 */
export async function getValidCompletedItems(queryId, records = []) {
  const valid = [];
  for (const record of records) {
    if (record?.status !== "completed" || record.id == null) continue;
    if (await isValidPdfFile(getDownloadedFilePath(queryId, record.id))) valid.push(record);
  }
  return valid;
}

/**
 * Creates and finalizes a ZIP stream containing only valid completed item
 * files. Entry names are display names, made unique without exposing the
 * numeric storage IDs to users.
 *
 * @param {number|string} queryId
 * @param {import('../../shared/types.js').SearchResult[]} records
 * @returns {Promise<import('archiver').Archiver>}
 */
export async function createZipStream(queryId, records = []) {
  const archive = archiver("zip", { zlib: { level: 0 } });
  const usedNames = new Set();
  let entryCount = 0;
  archive.entryNames = [];

  for (const record of records) {
    if (record?.status !== "completed" || record.id == null) continue;

    const storagePath = getDownloadedFilePath(queryId, record.id);
    if (!(await isValidPdfFile(storagePath))) continue;

    const entryName = makeUniqueDisplayName(getDisplayFileName(record), usedNames);
    archive.file(storagePath, { name: entryName });
    archive.entryNames.push(entryName);
    entryCount += 1;
  }

  // Metadata makes the result easy to inspect without changing Archiver's
  // stream contract and is useful to the HTTP controller for empty archives.
  archive.entryCount = entryCount;
  archive.finalize();
  return archive;
}

/**
 * Finds a valid finalized file by SearchResult ID. Display titles are never
 * interpreted as physical paths.
 *
 * @param {number|string} queryId
 * @param {number|string|{ id?: number|string }} item
 * @returns {Promise<string|null>}
 */
export async function findDownloadedFile(queryId, item) {
  if (typeof item === "object" && item !== null && item.id != null) {
    const filePath = getDownloadedFilePath(queryId, item.id);
    return (await isValidPdfFile(filePath)) ? filePath : null;
  }

  if (item != null && /^\d+$/.test(String(item))) {
    const filePath = getDownloadedFilePath(queryId, item);
    return (await isValidPdfFile(filePath)) ? filePath : null;
  }

  return null;
}

/**
 * Deletes a finalized file by SearchResult ID.
 *
 * @param {number|string} queryId
 * @param {number|string|{ id?: number|string }} item
 */
export async function deleteDownloadedFile(queryId, item) {
  let filePath;
  if (typeof item === "object" && item !== null && item.id != null) {
    filePath = getDownloadedFilePath(queryId, item.id);
  } else if (item != null && /^\d+$/.test(String(item))) {
    filePath = getDownloadedFilePath(queryId, item);
  }

  if (filePath) await fs.rm(filePath, { force: true });
}

function makeUniqueDisplayName(name, usedNames) {
  const normalized = name.toLocaleLowerCase();
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return name;
  }

  const extension = path.extname(name) || ".pdf";
  const base = name.slice(0, -extension.length);
  let suffix = 2;
  let candidate = `${base} (${suffix})${extension}`;
  while (usedNames.has(candidate.toLocaleLowerCase())) {
    suffix += 1;
    candidate = `${base} (${suffix})${extension}`;
  }
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return number;
}

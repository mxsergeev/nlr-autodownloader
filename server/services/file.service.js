import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.join(__dirname, "..", "..", "data");
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o775 });

export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
await fs.mkdir(DOWNLOADS_DIR, { recursive: true, mode: 0o775 });

/**
 * Returns a Set of base file names (without extension) already downloaded for the given query.
 * Returns an empty Set if the directory does not exist.
 * @param {{ id: number }} metadata
 * @returns {Promise<Set<string>>}
 */
export async function getDownloadedFileNames(metadata) {
  const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString());
  try {
    return new Set((await fs.readdir(storageDir)).map((file) => path.parse(file).name));
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

/**
 * Returns search results that have not yet been downloaded.
 * @param {Set<string>} downloads
 * @param {import('../../shared/types.js').SearchResult[]} searchResults
 * @returns {{ missingFiles: import('../../shared/types.js').SearchResult[] }}
 */
export function verifyDownloads(downloads = new Set(), searchResults) {
  return { missingFiles: searchResults.filter((item) => !downloads.has(item.fileName)) };
}

/**
 * Sanitizes a string for use as a file name.
 * Removes invalid characters and cleans up dot-separated extensions.
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
 * Returns a canonical string identifier for a query, used as the filesystem directory name.
 * Prefers numeric id, falls back to sanitized URL.
 * @param {number | { id?: number, url?: string, pageUrl?: string }} params
 * @returns {string}
 */
export function queryToString(params) {
  if (typeof params === "number") return String(params);
  if (params && params.id !== undefined && params.id !== null) return String(params.id);
  const url = params && (params.url || params.pageUrl);
  if (url)
    return url
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9]/g, "_");
  return "";
}

/**
 * Creates and returns an archiver zip stream for all files in the query's download directory.
 * The caller is responsible for piping the stream to a response.
 * @param {number} queryId
 * @returns {import('archiver').Archiver}
 */
export function createZipStream(queryId) {
  const archive = archiver("zip", { zlib: { level: 0 } });
  const storageDir = path.join(DOWNLOADS_DIR, queryId.toString());
  archive.directory(storageDir, false);
  archive.finalize();
  return archive;
}

/**
 * Finds the full path of a downloaded file for a given query and base file name.
 * Returns null if the file does not exist.
 * @param {number} queryId
 * @param {string} fileName  Base file name without extension (as stored in SearchResult.fileName)
 * @returns {Promise<string | null>}  Full path including extension, or null
 */
export async function findDownloadedFile(queryId, fileName) {
  const storageDir = path.join(DOWNLOADS_DIR, queryId.toString());
  try {
    const files = await fs.readdir(storageDir);
    const match = files.find((f) => path.parse(f).name === fileName);
    return match ? path.join(storageDir, match) : null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Deletes the downloaded file for a given query and base file name.
 * Silently succeeds if the file or directory does not exist.
 * @param {number} queryId
 * @param {string} fileName  Base file name without extension
 */
export async function deleteDownloadedFile(queryId, fileName) {
  const filePath = await findDownloadedFile(queryId, fileName);
  if (filePath) {
    await fs.rm(filePath, { force: true });
  }
}

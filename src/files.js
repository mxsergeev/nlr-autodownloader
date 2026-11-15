import { promises as fs } from 'fs'
import path from 'path'

const RESULTS_FILE = '.results.json'
// File systems allow 255 bytes; this leaves room for " (2)", " (10 of 12)" and ".pdf.part"
const MAX_NAME_BYTES = 200

/** Cut a name to MAX_NAME_BYTES of UTF-8 (a Cyrillic letter takes 2) without splitting a character. */
export function truncateFileName(name) {
  let result = ''
  for (const char of name) {
    if (Buffer.byteLength(result + char) > MAX_NAME_BYTES) break
    result += char
  }
  return result.trim()
}

/** Replace characters file systems don't allow; drop trailing dots and spaces (Windows strips them). */
export function sanitizeFileName(name = '') {
  return name
    .replace(/:/g, '-')
    .replace(/[/\\?*|"<>]/g, '_')
    .replace(/[. ]+$/, '')
}

/** Folder name for a search. Matches the old `<q>_<year>` layout so existing downloads are reused. */
export function searchDirName({ q, year }) {
  return `${q}_${year}`.trim().replace(/\s+/g, '_').replace(/[/\\]/g, '_')
}

/** @returns {Promise<{ version?: number, url?: string, total: number, items: { fileName: string }[] } | null>} */
export async function readResults(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, RESULTS_FILE), 'utf-8'))
  } catch {
    return null
  }
}

export async function writeResults(dir, results) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, RESULTS_FILE), JSON.stringify(results, null, 2))
}

/** File names (without .pdf and the " (1 of 3)" part suffix) of documents already downloaded into dir. */
export async function downloadedFileNames(dir) {
  const files = await fs.readdir(dir).catch(() => [])
  return new Set(files.filter((f) => f.endsWith('.pdf')).map((f) => f.replace(/( \(\d+ of \d+\))?\.pdf$/, '')))
}

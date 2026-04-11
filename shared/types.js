/**
 * @typedef {Object} Query
 * @property {number} id
 * @property {string} pageUrl
 * @property {'pending'|'downloading'|'completed'|'download_blocked'|'search_failed'|'paused'} status
 * @property {number|null} results
 * @property {number|null} resultsPerPart
 * @property {number|null} parts
 * @property {number} downloaded
 * @property {string|null} downloadProgress
 * @property {Date|string|null} createdAt
 * @property {Date|string|null} lastAttempt
 * @property {number} order
 * @property {SearchResult[]} searchResults
 */

/**
 * @typedef {Object} SearchResult
 * @property {number} id
 * @property {number} queryId
 * @property {string} title
 * @property {string} href
 * @property {string} fileName
 * @property {string|null} status
 */

export {}

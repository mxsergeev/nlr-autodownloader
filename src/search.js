import { setTimeout as sleep } from 'timers/promises'
import { sanitizeFileName } from './files.js'
import { assertOk } from './http.js'
import { log, warn } from './log.js'

// The same JSON API the primo.nlr.ru web page uses; a guest token is enough
const API = 'https://primo.nlr.ru/primo_library/libweb/webservices/rest'
const VIEW = { inst: '07NLR', vid: '07NLR_VU1', lang: 'ru_RU' }
const PAGE_SIZE = 100
const PAGE_DELAY_MS = 1000

/** Website URL of a search, for the log and for opening it in a browser. */
function websiteUrl({ queries, sort, mode, tab, scope }) {
  const url = new URL('https://primo.nlr.ru/primo-explore/search')
  for (const query of queries) url.searchParams.append('query', query)
  url.searchParams.set('tab', tab)
  url.searchParams.set('search_scope', scope)
  url.searchParams.set('sortby', sort)
  url.searchParams.set('vid', VIEW.vid)
  url.searchParams.set('mode', mode)
  return url.toString()
}

/**
 * Same as the site's advanced search with row 1 "совпадает" q (lsr24), row 2 "Год издания" "совпадает" year
 * (lsr07), sorted by "Дата выхода периодики (по возр.)" (lso04).
 */
export function querySearch({ q, year }) {
  const params = {
    queries: [`lsr24,exact,${q},AND`, `lsr07,exact,${year},AND`],
    sort: 'lso04',
    mode: 'advanced',
    tab: 'default_tab',
    scope: 'default_scope',
  }
  return { ...params, url: websiteUrl(params) }
}

/** Search parameters from a primo.nlr.ru results page URL. */
export function urlSearch(url) {
  const { searchParams } = new URL(url)

  const queries = searchParams.getAll('query')
  if (queries.length === 0) throw new Error(`No "query" parameter in ${url}`)

  const ignored = ['facet', 'pfilter', 'multiFacets'].filter((param) => searchParams.has(param))
  if (ignored.length) warn(`Filters in the URL are not supported and will be ignored: ${ignored.join(', ')}`)

  return {
    queries,
    sort: searchParams.get('sortby') ?? 'rank',
    mode: searchParams.get('mode') ?? 'basic',
    tab: searchParams.get('tab') ?? 'default_tab',
    scope: searchParams.get('search_scope') ?? 'default_scope',
    url,
  }
}

async function getJson(url, headers = {}) {
  return assertOk(await fetch(url, { headers }), url).json()
}

// The guest token expires after 24 h, so a long run gets a fresh one for each search
const fetchGuestToken = () =>
  getJson(`${API}/v1/guestJwt/${VIEW.inst}?isGuest=true&lang=${VIEW.lang}&viewId=${VIEW.vid}`)

async function fetchResultsPage(search, offset, token) {
  const params = new URLSearchParams({
    ...VIEW,
    q: search.queries.join(';'),
    sort: search.sort,
    mode: search.mode,
    tab: search.tab,
    scope: search.scope,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    skipDelivery: 'Y',
  })

  return getJson(`${API}/primo-explore/v1/pnxs?${params}`, { Authorization: `Bearer ${token}` })
}

/** "1234 с." → 1234, "[2], 63 с. ; 17 см." → 65, unknown → null */
function parsePages(format = '') {
  const pagesPart = format.split('с.')[0]
  if (pagesPart === format) return null

  const numbers = pagesPart.match(/\d+/g)
  return numbers ? numbers.reduce((sum, n) => sum + Number(n), 0) : null
}

/** One search result from the API (a PNX record). */
function toItem({ pnx }) {
  // Digitized documents link to the Vivaldi viewer: "$$Tvivaldi_open$$E07NLR_OPEN_VL$$1pn000115255"
  const viewerLink = pnx.links?.linktorsrc?.find((link) => link.includes('vivaldi'))
  const id = pnx.control.recordid[0]

  return {
    id,
    title: (pnx.display.title?.[0] ?? id).trim().replace(/\s+/g, ' '),
    vivaldiId: viewerLink?.match(/\$\$1([^$]+)/)?.[1] ?? null,
    pages: parsePages(pnx.display.format?.[0]),
  }
}

/** Give each item a unique file name; documents with identical titles get " (2)", " (3)"… */
function assignFileNames(items) {
  const counts = new Map()

  for (const item of items) {
    const base = sanitizeFileName(item.title)
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    item.fileName = n === 1 ? base : `${base} (${n})`
  }

  return items
}

/**
 * Fetch all results of a search.
 * @param {{ name: string, queries: string[], sort: string, mode: string, tab: string, scope: string }} search
 * @returns {Promise<{ total: number, items: { id: string, title: string, fileName: string, vivaldiId: string | null, pages: number | null }[] }>}
 */
export async function fetchSearchResults(search) {
  const token = await fetchGuestToken()
  const items = new Map()
  let total = 0

  for (let offset = 0; offset === 0 || offset < total; offset += PAGE_SIZE) {
    if (offset > 0) await sleep(PAGE_DELAY_MS)

    const results = await fetchResultsPage(search, offset, token)
    total = results.info.total
    for (const item of results.docs.map(toItem)) items.set(item.id, item)

    if (offset === 0) log(`[${search.name}] ${total} results`)
    if (results.docs.length === 0) break
  }

  return { total, items: assignFileNames([...items.values()]) }
}

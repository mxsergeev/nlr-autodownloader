#!/usr/bin/env node
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { parseArgs } from 'util'
import { downloadDocument, PrepareTimeoutError } from './download.js'
import { downloadedFileNames, readResults, searchDirName, writeResults } from './files.js'
import { error, log, report, setLogFile, warn } from './log.js'
import { runPool } from './pool.js'
import { fetchSearchResults, querySearch, urlSearch } from './search.js'

const USAGE = `Usage:
  nlr <query> --years <year | from-to> [options]
  nlr --url <primo search url> [--name <folder>] [options]

Options:
  -y, --years <y>       Year (1885) or range (1870-1920); one search per year
  -u, --url <url>       Download every result of an existing primo.nlr.ru search page
  -n, --name <name>     Folder name for --url downloads (default: url_<hash>)
  -p, --max-pages <n>   Skip documents with more pages than this (default: 500)
      --big             No page limit, and wait up to 3 min for big files to be prepared
  -d, --dry-run         Only list what would be downloaded
  -w, --workers <n>     Parallel downloads (default: 2; more than 2 often gets rate limited)
  -o, --out <dir>       Output directory (default: ./downloads)
  -h, --help            Show this help

Re-running the same command resumes: finished files are skipped.`

const RESULTS_VERSION = 5
const SEARCH_ATTEMPTS = 3
const PREPARE_TIMEOUT_MS = 30_000
const BIG_PREPARE_TIMEOUT_MS = 3 * 60_000

class UsageError extends Error {}

// fetch() only says "fetch failed"; the network reason (ECONNRESET, ...) is in the cause
const describe = (err) => (err.cause ? `${err.message} (${err.cause.code ?? err.cause.message})` : err.message)

function parseYears(value) {
  const match = value.match(/^(\d{4})(?:-(\d{4}))?$/)
  if (!match) throw new UsageError(`Invalid --years "${value}", expected e.g. 1885 or 1870-1920`)

  const from = Number(match[1])
  const to = Number(match[2] ?? match[1])
  if (to < from) throw new UsageError(`Invalid --years "${value}": end is before start`)

  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

function parsePositiveInt(value, option) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`Invalid ${option} "${value}"`)
  return n
}

function buildSearches(query, values) {
  if (values.url) {
    const name = values.name ?? `url_${createHash('sha1').update(values.url).digest('hex').slice(0, 8)}`
    try {
      return [{ name, label: name, ...urlSearch(values.url) }]
    } catch (err) {
      throw new UsageError(`Invalid --url: ${err.message}`)
    }
  }

  if (!query || !values.years) throw new UsageError('Provide a query with --years, or --url')

  return parseYears(values.years).map((year) => ({
    name: searchDirName({ q: query, year }),
    label: String(year),
    ...querySearch({ q: query, year }),
  }))
}

/** Cached result list if complete, otherwise a fresh search (retried a few times). */
async function loadResults(search, dir, { quiet }) {
  const cached = await readResults(dir)
  if (cached?.version === RESULTS_VERSION && cached.items.length === cached.total) return cached

  if (!quiet) log(`[${search.name}] Searching ${search.url}`)

  for (let attempt = 1; ; attempt++) {
    try {
      const results = { version: RESULTS_VERSION, url: search.url, ...(await fetchSearchResults(search)) }

      if (results.total === 0) return results
      if (results.items.length !== results.total) {
        warn(`[${search.name}] Site reports ${results.total} results, but ${results.items.length} were collected`)
      }

      await writeResults(dir, results)
      return results
    } catch (err) {
      if (attempt >= SEARCH_ATTEMPTS) throw err
      warn(`[${search.name}] Search failed (attempt ${attempt}/${SEARCH_ATTEMPTS}): ${describe(err)}`)
      await sleep(5000)
    }
  }
}

/** Split items into: already downloaded, to download, too big, not available online. */
function classify(items, downloaded, maxPages) {
  const groups = { downloaded: [], download: [], tooBig: [], notOnline: [] }

  for (const item of items) {
    if (downloaded.has(item.fileName)) groups.downloaded.push(item)
    else if (!item.vivaldiId) groups.notOnline.push(item)
    else if (item.pages > maxPages) groups.tooBig.push(item)
    else groups.download.push(item)
  }

  return groups
}

const formatPages = (item) => `${item.pages ?? '?'} p.`

/** "8 files, 1234 pages, 2 of unknown size. Skipped: 6 over 500 pages (add --big), 79 not online." */
function dryRunTotal(summary, maxPages) {
  const groups = summary.flatMap((s) => s.groups ?? [])
  const count = (key) => groups.reduce((n, g) => n + g[key].length, 0)

  const toDownload = groups.flatMap((g) => g.download)
  const pages = toDownload.reduce((n, item) => n + (item.pages ?? 0), 0)
  const unknownSize = toDownload.filter((item) => item.pages == null).length
  const skipped = [
    [count('downloaded'), 'already downloaded'],
    [count('tooBig'), `over ${maxPages} pages (add --big)`],
    [count('notOnline'), 'not online'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)

  return (
    `${plural(toDownload.length, 'file')}, ${plural(pages, 'page')}` +
    (unknownSize ? `, ${unknownSize} of unknown size.` : '.') +
    (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '')
  )
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** @returns {Promise<{ name: string, line?: string, groups?: object, ok: boolean, aborted?: boolean }>} */
async function processSearch(search, { out, workers, maxPages, prepareTimeout, dryRun }) {
  const dir = path.join(out, search.name)

  let results
  try {
    results = await loadResults(search, dir, { quiet: dryRun })
  } catch (err) {
    error(`[${search.name}] Search failed: ${describe(err)}`)
    return { name: search.name, line: `search failed: ${describe(err)}`, ok: false }
  }

  const groups = classify(results.items, await downloadedFileNames(dir), maxPages)

  if (dryRun) {
    for (const item of groups.download) report(`${search.label}  ${formatPages(item).padStart(7)}  ${item.fileName}`)
    return { name: search.name, groups, ok: true }
  }

  if (results.total === 0) {
    log(`[${search.name}] No results`)
    return { name: search.name, line: 'no results', ok: true }
  }

  const counts =
    (maxPages === Infinity ? '' : `${groups.tooBig.length} too big (over ${maxPages} pages), `) +
    `${groups.notOnline.length} not available online`

  log(
    `[${search.name}] ${results.items.length} results: ${groups.downloaded.length} already downloaded,`,
    `${groups.download.length} to download, ${counts}`,
  )

  let downloaded = groups.downloaded.length
  const downloadable = downloaded + groups.download.length
  const notPrepared = []

  const { failed, aborted } = await runPool(
    groups.download,
    workers,
    async (item) => {
      let parts
      try {
        parts = await downloadDocument(item, dir, {
          prepareTimeout,
          onPartReady: (ready) => log(`[${search.name}] ${item.fileName}: part ${ready} prepared, more to come`),
        })
      } catch (err) {
        // Without --big, a slow file is too big (its size is often unknown up front), not a sign of rate limiting
        if (!(err instanceof PrepareTimeoutError) || maxPages === Infinity) throw err
        notPrepared.push(item)
        warn(`[${search.name}] Too big: ${item.fileName}: ${err.message}. Add --big to download it.`)
        return
      }
      downloaded++
      const partsNote = parts > 1 ? ` (${parts} parts)` : ''
      log(`[${search.name}] (${downloaded}/${downloadable}) ${formatPages(item)}  ${item.fileName}${partsNote}`)
    },
    {
      onError: (item, err, { attempt, retrying, cooldown }) => {
        warn(
          `[${search.name}] Failed: ${item.fileName} (attempt ${attempt}): ${describe(err)}.`,
          retrying ? `Retrying later; pausing all workers ${cooldown / 1000}s.` : 'Giving up on this one.',
        )
      },
    },
  )

  for (const { item, error: err } of failed) {
    error(`[${search.name}] Not downloaded: ${item.fileName}: ${describe(err)}`)
  }

  const line =
    `${downloaded}/${downloadable} downloaded` +
    (failed.length ? `, ${failed.length} failed` : '') +
    (notPrepared.length ? `, ${notPrepared.length} too big to prepare in ${prepareTimeout / 1000}s (add --big)` : '') +
    `; ${counts}`
  return { name: search.name, line, ok: failed.length === 0, aborted }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      years: { type: 'string', short: 'y' },
      url: { type: 'string', short: 'u' },
      name: { type: 'string', short: 'n' },
      'max-pages': { type: 'string', short: 'p', default: '500' },
      big: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', short: 'd', default: false },
      workers: { type: 'string', short: 'w', default: '2' },
      out: { type: 'string', short: 'o', default: 'downloads' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    console.log(USAGE)
    return 0
  }

  const options = {
    workers: parsePositiveInt(values.workers, '--workers'),
    maxPages: values.big ? Infinity : parsePositiveInt(values['max-pages'], '--max-pages'),
    prepareTimeout: values.big ? BIG_PREPARE_TIMEOUT_MS : PREPARE_TIMEOUT_MS,
    dryRun: values['dry-run'],
    out: path.resolve(values.out),
  }
  const searches = buildSearches(positionals.join(' ').trim(), values)

  await fs.mkdir(options.out, { recursive: true })
  setLogFile(path.join(options.out, 'nlr.log'))

  if (!options.dryRun) {
    log(
      `${searches.length} search(es), ${options.workers} worker(s),`,
      `${options.maxPages === Infinity ? 'no page limit' : `max ${options.maxPages} pages`} → ${options.out}`,
    )
  }

  const summary = []
  for (const search of searches) {
    const result = await processSearch(search, options)
    summary.push(result)

    if (result.aborted) {
      error('Too many failures in a row, the site is probably rate limiting. Stopping; re-run later to resume.')
      break
    }
  }

  if (options.dryRun) {
    report(`\n${dryRunTotal(summary, options.maxPages)}`)
  } else {
    const width = Math.max(...summary.map((s) => s.name.length))
    log('Summary:\n' + summary.map((s) => `  ${s.name.padEnd(width)}  ${s.line}`).join('\n'))
  }

  const complete = summary.length === searches.length && summary.every((s) => s.ok)
  return complete ? 0 : 1
}

process.umask(0o002) // group-writable files, e.g. for a shared/synced downloads folder

process.on('SIGINT', () => {
  log('Interrupted. Re-run the same command to resume.')
  process.exit(130)
})

main().then(
  (code) => process.exit(code),
  (err) => {
    const isUsageError = err instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')
    console.error(isUsageError ? `${err.message}\n\n${USAGE}` : err)
    process.exit(2)
  },
)

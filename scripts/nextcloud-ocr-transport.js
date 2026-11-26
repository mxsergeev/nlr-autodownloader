#!/usr/bin/env node
// Moves the OCR work between Nextcloud and this PC, one year folder at a time: downloads the originals that aren't here yet into
// the `nlr ocr` input dir, binds a folder's quarters once all of its issues are OCRed, uploads the tomes (and the issue list) to
// <remote>/ocr/<folder>/, then deletes the folder's local originals, OCRed issues and tomes. Nothing on Nextcloud is deleted.
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { parseArgs } from 'util'
import { bindFolder } from '../src/bind.js'
import { readResults, truncateFileName } from '../src/files.js'
import { error, log, setLogFile, warn } from '../src/log.js'

const USAGE = `Usage:
  node scripts/nextcloud-ocr-transport.js --in <dir> --ocr <dir> --tomes <dir> [options]

  --in <dir>            Originals, <folder>_<year>/ with its .results.json: the input dir of nlr ocr
  --ocr <dir>           The output dir of nlr ocr
  --tomes <dir>         Where the quarters are bound; also gets nlr-transport.log and nlr-transport-status.json
  --remote <dir>        Folder on Nextcloud with the originals; tomes go to <remote>/ocr/ (default: nlr)
  --credentials <file>  JSON with url, user, password (default: ~/.nextcloud-dav.json)
  --years <y>           Year or range of the folders (default: 1901-1918)
  --ahead <n>           Download a folder only while fewer than n folders wait for OCR (default: 2)
  --settings <file>     JSON re-read every round; its "ahead" overrides --ahead
  --watch               Keep going, a round every minute, instead of stopping after one round`

const GB = 2 ** 30
const CHUNK_BYTES = 100 * 2 ** 20 // Nextcloud's chunked upload takes 5 MB to 5 GB per chunk
const MIN_FREE_DISK = 20 * GB // don't download into the last 20 GB
const ROUND_MS = 60_000
const RESULTS_FILE = '.results.json'

/** WebDAV client for one Nextcloud user. Errors name the method, path and HTTP status, never the credentials. */
function nextcloud({ url, user, password }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  const base = url.replace(/\/$/, '')
  const fileUrl = (remotePath) =>
    `${base}/remote.php/dav/files/${encodeURIComponent(user)}/` +
    remotePath.split('/').map(encodeURIComponent).join('/')
  const uploadUrl = (id, chunk = '') =>
    `${base}/remote.php/dav/uploads/${encodeURIComponent(user)}/${id}` + (chunk ? `/${chunk}` : '')

  async function request(method, target, label, { headers = {}, body, ok = [200, 201, 204, 207] } = {}) {
    const res = await fetch(target, { method, headers: { Authorization: auth, ...headers }, body })
    if (!ok.includes(res.status)) {
      await res.body?.cancel()
      throw new Error(`${method} ${label}: HTTP ${res.status}`)
    }
    return res
  }

  return {
    /** Files (name → size) and subfolders of a folder, or null if it doesn't exist. */
    async list(dir) {
      const res = await request('PROPFIND', fileUrl(dir) + '/', dir, { headers: { Depth: '1' }, ok: [207, 404] })
      if (res.status === 404) return null
      const files = new Map()
      const dirs = new Set()
      for (const [, response] of (await res.text()).matchAll(/<d:response>(.*?)<\/d:response>/gs)) {
        const href = response.match(/<d:href>(.*?)<\/d:href>/)[1]
        const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop())
        if (response.includes('<d:collection/>')) dirs.add(name)
        else files.set(name, Number(response.match(/<d:getcontentlength>(\d+)/)?.[1]))
      }
      dirs.delete(dir.split('/').pop()) // the folder itself
      return { files, dirs }
    },

    async mkdir(dir) {
      await request('MKCOL', fileUrl(dir), dir, { ok: [201, 405] }) // 405: exists already
    },

    /** Download to a hidden .part file next to `file` (nlr ocr ignores it), then rename into place. */
    async download(remotePath, file, onProgress) {
      const res = await request('GET', fileUrl(remotePath), remotePath)
      const size = Number(res.headers.get('content-length'))
      const partial = path.join(path.dirname(file), `.${path.basename(file)}.part`)
      const handle = await fs.open(partial, 'w')
      let received = 0
      try {
        for await (const chunk of res.body) {
          await handle.write(chunk)
          received += chunk.length
          onProgress(received, size)
        }
        await handle.sync() // on disk before the rename makes it look done, even if the power goes
      } finally {
        await handle.close()
      }
      if (received !== size) {
        await fs.rm(partial, { force: true })
        throw new Error(`GET ${remotePath}: got ${received} of ${size} bytes`)
      }
      await fs.rename(partial, file)
    },

    /** Nextcloud's chunked upload, which works for files of any size: chunks into an upload folder, then one MOVE. */
    async upload(file, remotePath, onProgress) {
      const { size } = await fs.stat(file)
      const id = `nlr-${randomUUID()}`
      const headers = { Destination: fileUrl(remotePath), 'OC-Total-Length': String(size) }
      await request('MKCOL', uploadUrl(id), remotePath, { headers })

      const handle = await fs.open(file, 'r')
      try {
        for (let offset = 0, n = 1; offset < size; n++) {
          const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset))
          await handle.read(buffer, 0, buffer.length, offset)
          await request('PUT', uploadUrl(id, n), remotePath, { headers, body: buffer })
          offset += buffer.length
          onProgress(offset, size)
        }
      } finally {
        await handle.close()
      }

      // Putting a big file together can outlast the request; what counts is the size it ends up with
      const moved = await request('MOVE', uploadUrl(id, '.file'), remotePath, {
        headers: { ...headers, Overwrite: 'T' },
      }).catch((err) => err)
      const remoteSize = (await this.list(path.posix.dirname(remotePath)))?.files.get(path.posix.basename(remotePath))
      if (remoteSize !== size) {
        throw moved instanceof Error
          ? moved
          : new Error(`${remotePath}: ${remoteSize ?? 'no'} bytes on Nextcloud, ${size} here`)
      }
    },
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      ocr: { type: 'string' },
      tomes: { type: 'string' },
      remote: { type: 'string', default: 'nlr' },
      credentials: { type: 'string', default: path.join(os.homedir(), '.nextcloud-dav.json') },
      years: { type: 'string', default: '1901-1918' },
      ahead: { type: 'string', default: '2' },
      settings: { type: 'string' },
      watch: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || !values.in || !values.ocr || !values.tomes) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }

  const dirs = { in: path.resolve(values.in), ocr: path.resolve(values.ocr), tomes: path.resolve(values.tomes) }
  const [from, to = from] = values.years.split('-').map(Number)
  const inYears = (folder) => {
    const year = Number(folder.match(/_(\d{4})$/)?.[1])
    return year >= from && year <= to
  }

  await fs.mkdir(dirs.tomes, { recursive: true })
  setLogFile(path.join(dirs.tomes, 'nlr-transport.log'))
  const statusFile = path.join(dirs.tomes, 'nlr-transport-status.json')

  const cloud = nextcloud(JSON.parse(await fs.readFile(values.credentials, 'utf8')))
  const remote = values.remote.replace(/^\/|\/$/g, '')
  const status = { started: new Date().toISOString(), updated: null, round: null, transfer: null, folders: {} }
  const done = new Map() // folder → tomes on Nextcloud, once its issue list is there too
  const warned = new Set()
  let lastWrite = 0
  let writing = Promise.resolve()

  /** Write the status file for the UI; one write at a time, progress updates at most every 2 s. */
  function writeStatus(force = true) {
    if (!force && Date.now() - lastWrite < 2000) return writing
    lastWrite = Date.now()
    writing = writing
      .then(async () => {
        status.updated = new Date().toISOString()
        const partial = statusFile + '.tmp'
        await fs.writeFile(partial, JSON.stringify(status, null, 2))
        await fs.rename(partial, statusFile)
      })
      .catch((err) => warn(`Couldn't write ${statusFile}: ${err.message}`))
    return writing
  }

  const transfer = (action, folder, name) => (bytes, size) => {
    status.transfer = { action, folder, name, bytes, size }
    writeStatus(false)
  }

  const localNames = async (dir) => new Set(await fs.readdir(dir).catch(() => []))
  const freeDisk = async () => {
    const stats = await fs.statfs(dirs.in)
    return stats.bavail * stats.bsize
  }

  /** Counts for a local folder, from its issue list (in the input dir, or the copy nlr ocr made). */
  async function inspect(folder) {
    const results = (await readResults(path.join(dirs.in, folder))) ?? (await readResults(path.join(dirs.ocr, folder)))
    const listed = results?.items.filter((item) => item.vivaldiId).map((item) => `${item.fileName}.pdf`) ?? []
    const [originals, ocred, tomes] = await Promise.all(
      [dirs.in, dirs.ocr, dirs.tomes].map((dir) => localNames(path.join(dir, folder))),
    )
    return {
      results,
      listed,
      originals: listed.filter((name) => originals.has(name)),
      ocred: listed.filter((name) => ocred.has(name)),
      tomes: [...tomes].filter((name) => name.endsWith('.pdf') && !name.startsWith('.')),
    }
  }

  async function upload(folder, local) {
    const remoteDir = `${remote}/ocr/${folder}`
    await cloud.mkdir(`${remote}/ocr`)
    await cloud.mkdir(remoteDir)
    const there = (await cloud.list(remoteDir)).files

    for (const name of local.tomes) {
      const file = path.join(dirs.tomes, folder, name)
      if (there.get(name) === (await fs.stat(file)).size) continue
      const started = Date.now()
      await cloud.upload(file, `${remoteDir}/${name}`, transfer('upload', folder, name))
      log(`[${folder}] Uploaded in ${((Date.now() - started) / 60_000).toFixed(1)} min  ${name}`)
    }

    // The issue list goes last: on Nextcloud it marks the folder as done. nlr ocr copied it along.
    await cloud.upload(path.join(dirs.ocr, folder, RESULTS_FILE), `${remoteDir}/${RESULTS_FILE}`, () => {})
    status.transfer = null
    done.set(folder, local.tomes.length)
    log(`[${folder}] Done: ${local.tomes.length} tome(s) on Nextcloud in ${remoteDir}`)
  }

  /** Delete the folder here, but only if every original here is on Nextcloud with the same size. */
  async function cleanUp(folder) {
    const originals = [...(await localNames(path.join(dirs.in, folder)))].filter((name) => name.endsWith('.pdf'))
    const there = (await cloud.list(`${remote}/${folder}`))?.files ?? new Map()
    const sizes = new Map(
      [...there].map(([name, size]) => [truncateFileName(name.replace(/\.pdf$/, '')) + '.pdf', size]),
    )
    const missing = originals.filter((name) => !sizes.has(name))
    const differ = []
    for (const name of originals.filter((name) => sizes.has(name))) {
      if (sizes.get(name) !== (await fs.stat(path.join(dirs.in, folder, name))).size) differ.push(name)
    }
    if (missing.length || differ.length) {
      const why = [
        missing.length && `${missing.length} original(s) missing on Nextcloud in ${remote}/${folder}`,
        differ.length && `${differ.length} of a different size there`,
      ]
        .filter(Boolean)
        .join(', ')
      if (!warned.has(folder)) {
        warn(`[${folder}] Kept the originals here: ${why}, e.g. ${missing[0] ?? differ[0]}`)
        warned.add(folder)
      }
      return `originals kept here: ${why}`
    }

    // The input folder first, so nlr ocr can't see the folder again while the rest goes
    for (const dir of [dirs.in, dirs.ocr, dirs.tomes]) {
      await fs.rm(path.join(dir, folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    }
    log(`[${folder}] Deleted here`)
    return null
  }

  /** Download what the folder is missing: listed, not here and not OCRed yet. Stops when the disk gets full. */
  async function download(folder, local) {
    const there = (await cloud.list(`${remote}/${folder}`))?.files
    if (!there) throw new Error(`no folder ${remote}/${folder} on Nextcloud`)
    const remoteNames = new Map(
      [...there.keys()].map((name) => [truncateFileName(name.replace(/\.pdf$/, '')) + '.pdf', name]),
    )

    const missing = local.listed.filter((name) => !local.originals.includes(name) && !local.ocred.includes(name))
    let fetched = 0
    for (const name of missing) {
      const remoteName = remoteNames.get(name)
      if (!remoteName) {
        warn(`[${folder}] Not on Nextcloud: ${name}`)
        continue
      }
      if ((await freeDisk()) - there.get(remoteName) < MIN_FREE_DISK) {
        log(`[${folder}] Waiting for disk space to download more`)
        return 'waiting for disk space'
      }
      await cloud.download(
        `${remote}/${folder}/${remoteName}`,
        path.join(dirs.in, folder, name),
        transfer('download', folder, name),
      )
      fetched++
    }
    status.transfer = null
    log(`[${folder}] Downloaded ${fetched} original(s)`)
    return null
  }

  async function round() {
    const settings = values.settings ? JSON.parse(await fs.readFile(values.settings, 'utf8').catch(() => '{}')) : {}
    const ahead = Number(settings.ahead ?? values.ahead)

    const remoteFolders = (await cloud.list(remote)).dirs
    const ocrFolders = (await cloud.list(`${remote}/ocr`))?.dirs ?? new Set()
    const localFolders = new Set()
    for (const dir of Object.values(dirs)) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) localFolders.add(entry.name)
      }
    }
    const folders = [...new Set([...remoteFolders, ...localFolders])].filter(inYears).sort()

    const states = {}
    for (const folder of folders) {
      if (!done.has(folder) && ocrFolders.has(folder)) {
        const there = (await cloud.list(`${remote}/ocr/${folder}`)).files
        if (there.has(RESULTS_FILE)) done.set(folder, [...there.keys()].filter((name) => name.endsWith('.pdf')).length)
      }
      const local = await inspect(folder)
      states[folder] = local
      const entry = {
        listed: local.listed.length,
        originals: local.originals.length,
        ocred: local.ocred.length,
        tomes: local.tomes.length,
        uploaded: done.get(folder) ?? null,
        step: null,
        note: status.folders[folder]?.note ?? null,
      }
      if (done.has(folder)) entry.step = 'done'
      else if (!local.results) entry.step = localFolders.has(folder) ? 'no issue list' : 'not here'
      else if (local.ocred.length === local.listed.length) entry.step = 'binding'
      else if (local.originals.length > local.ocred.length) entry.step = 'ocr'
      else entry.step = 'waiting'
      status.folders[folder] = entry
    }
    for (const folder of Object.keys(status.folders)) if (!folders.includes(folder)) delete status.folders[folder]
    await writeStatus()

    const step = async (folder, name, work) => {
      status.folders[folder].step = name
      await writeStatus()
      try {
        status.folders[folder].note = await work()
      } catch (err) {
        status.folders[folder].note = err.message
        status.transfer = null
        error(`[${folder}] ${name} failed: ${err.message}. Trying again next round.`)
      }
      await writeStatus()
    }

    for (const folder of folders) {
      const local = states[folder]
      const entry = status.folders[folder]

      if (entry.step === 'binding') {
        await step(folder, 'binding', async () => {
          const counts = await bindFolder({ inDir: dirs.ocr, outDir: dirs.tomes, folder })
          if (counts.waiting || counts.failed) return 'not all quarters bound, see the log'
          entry.step = 'uploading'
          Object.assign(local, await inspect(folder))
          entry.tomes = local.tomes.length
          await upload(folder, local)
          entry.uploaded = done.get(folder)
          entry.step = 'done'
          return null
        })
      }
      if (entry.step === 'done' && localFolders.has(folder)) await step(folder, 'done', () => cleanUp(folder))
    }

    // Keep up to `ahead` folders waiting for OCR; the next one is downloaded when there are fewer
    const waitingForOcr = folders.filter((folder) => status.folders[folder].step === 'ocr').length
    const next = folders.find((folder) => status.folders[folder].step === 'waiting')
    if (next && waitingForOcr < ahead) {
      await step(next, 'downloading', () => download(next, states[next]))
      status.folders[next].step = 'ocr'
      await writeStatus()
    }
  }

  for (;;) {
    status.round = new Date().toISOString()
    try {
      await round()
    } catch (err) {
      error(`Round failed: ${err.message}. Trying again next round.`)
    }
    if (!values.watch) return 0
    await sleep(ROUND_MS)
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)

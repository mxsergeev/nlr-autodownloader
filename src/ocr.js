import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { abbyyProcesses, checkSettings, runFineReader } from './finereader.js'
import { readResults, writeResults } from './files.js'
import { graftOcrText, splitPdf } from './graft.js'
import { error, log, warn } from './log.js'

const GB = 2 ** 30
const JOB_RAM = 1 * GB // FineReader per job,
const PAGE_RAM = 1 * GB // plus this per page in it
const MIN_FREE_RAM = 6 * GB // don't start a job that would leave Windows less than this
const KILL_FREE_RAM = 3 * GB // below this, stop the youngest job and queue it again
const CHECK_MS = 10_000
const RESCAN_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 15 * 60_000
const ATTEMPTS = 2
const TMP_DIR = '.ocr-tmp'

/**
 * OCR every PDF in inDir/<folder>_<year>/ (year in years) into outDir/<folder>/ under the same name. FineReader OCRs chunks of
 * `chunk` pages; its text is put onto the original pages (see graft.js), so the scans stay as they are. Files that already exist
 * in outDir are skipped. FineReader may use dayRam GB and the first dayCpus CPUs, or nightRam GB and nightCpus CPUs between
 * night[0] and night[1] h. A settings file (JSON with any of dayRam, nightRam, dayCpus, nightCpus, night: "0-8") is re-read every
 * few seconds and overrides these. With watch, it keeps looking for new files every few minutes instead of stopping.
 *
 * @returns {Promise<{ done: number, failed: number }>}
 */
export async function runOcr({ inDir, outDir, years, chunk, limits: initialLimits, settingsFile, watch, finereader }) {
  await checkSettings()

  const tmp = path.join(outDir, TMP_DIR)
  await removeDir(tmp)

  const pending = [] // issues found, not split yet
  const queue = [] // jobs waiting for FineReader
  const running = new Set()
  const taken = new Set() // output files of this run: done, in progress or failed
  const counts = { done: 0, failed: 0 }
  let measured = { ram: 0, gui: false }
  let lastCheck = 0
  let lastMode = null
  let limits = initialLimits
  let settingsText = null
  let guiWarned = false
  let grafting = Promise.resolve() // one graft at a time: it is CPU and memory heavy
  let nextId = 0

  process.on('exit', () => running.forEach((job) => job.run.kill()))

  const isNight = () => {
    const hour = new Date().getHours()
    const [from, to] = limits.night
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to
  }
  const mode = () => {
    const [name, ram, cpus] = isNight()
      ? ['night', limits.nightRam, limits.nightCpus]
      : ['day', limits.dayRam, limits.dayCpus]
    return { name, ram: ram * GB, cpus, mask: 2 ** cpus - 1 } // the first `cpus` logical CPUs
  }

  /** Take changed limits from the settings file; a broken file is reported once and changes nothing. */
  async function readSettings() {
    const text = await fs.readFile(settingsFile, 'utf8').catch(() => null)
    if (text === null || text === settingsText) return
    settingsText = text
    try {
      const updated = parseLimits(JSON.parse(text), limits)
      if (JSON.stringify(updated) === JSON.stringify(limits)) return
      limits = updated
      lastMode = null // log the limits again
    } catch (err) {
      warn(`Ignoring ${settingsFile}: ${err.message}`)
    }
  }
  const jobRam = JOB_RAM + chunk * PAGE_RAM // the last chunk of an issue may be smaller; close enough

  async function scan() {
    const found = (await findIssues(inDir, outDir, years)).filter((issue) => !taken.has(issue.out))
    for (const issue of found) taken.add(issue.out)
    pending.push(...found)
    if (found.length) log(`${found.length} file(s) to OCR`)
  }

  /** Split the issue into chunk files and queue a FineReader job for each. */
  async function prepare(issue) {
    issue.id = nextId++
    issue.dir = path.join(tmp, String(issue.id))
    issue.started = Date.now()

    try {
      const chunks = await splitPdf(await fs.readFile(issue.file), chunk)
      await fs.mkdir(issue.dir, { recursive: true })
      issue.jobs = await Promise.all(
        chunks.map(async (bytes, i) => {
          const input = path.join(issue.dir, `${i}.pdf`)
          await fs.writeFile(input, bytes)
          return { issue, input, output: path.join(issue.dir, `${i}.ocr.pdf`), attempts: 0 }
        }),
      )
      issue.remaining = issue.jobs.length
      queue.push(...issue.jobs)
    } catch (err) {
      fail(issue, err)
    }
  }

  function start(job) {
    job.started = Date.now()
    job.run = runFineReader(finereader, job.input, job.output, { timeout: JOB_TIMEOUT_MS })
    running.add(job)
    job.run.promise.then(
      () => finished(job),
      (err) => finished(job, err),
    )
  }

  function finished(job, err) {
    running.delete(job)
    lastCheck = 0 // measure again before starting the next job
    const { issue } = job
    if (issue.error) return

    if (err) {
      if (job.stoppedForMemory) {
        job.stoppedForMemory = false
        queue.unshift(job)
        return
      }
      if (++job.attempts < ATTEMPTS) {
        warn(`[${issue.folder}] ${issue.name}: FineReader failed (${err.message}), trying again`)
        queue.push(job)
      } else fail(issue, err)
      return
    }

    if (--issue.remaining === 0) grafting = grafting.then(() => finish(issue))
  }

  async function finish(issue) {
    try {
      const original = await fs.readFile(issue.file)
      const ocr = await Promise.all(issue.jobs.map((job) => fs.readFile(job.output)))
      const { bytes, pages } = await graftOcrText(original, ocr)

      const partial = path.join(path.dirname(issue.out), `.${path.basename(issue.out)}.tmp`)
      await fs.mkdir(path.dirname(issue.out), { recursive: true })
      const handle = await fs.open(partial, 'w')
      try {
        await handle.writeFile(bytes)
        await handle.sync() // on disk before the rename makes it look done, even if the power goes
      } finally {
        await handle.close()
      }
      await fs.rename(partial, issue.out)

      counts.done++
      const minutes = ((Date.now() - issue.started) / 60_000).toFixed(1)
      log(`[${issue.folder}] (${counts.done}/${taken.size}) ${pages.length} p. in ${minutes} min  ${issue.name}`)

      const unaligned = pages.flatMap((page, i) => (page.aligned ? [] : [i + 1]))
      if (unaligned.length) {
        warn(
          `[${issue.folder}] ${issue.name}: deskew direction unclear on page(s) ${unaligned.join(', ')}; text may be a few points off`,
        )
      }
    } catch (err) {
      fail(issue, err)
    }
    await removeDir(issue.dir)
  }

  function fail(issue, err) {
    issue.error = err
    counts.failed++
    if (watch) taken.delete(issue.out) // the next scan picks it up again
    error(
      `[${issue.folder}] Not OCRed: ${issue.name}: ${err.message}. ${watch ? 'Trying again later.' : 'Re-run to try again.'}`,
    )

    for (const job of issue.jobs ?? []) {
      const i = queue.indexOf(job)
      if (i >= 0) queue.splice(i, 1)
      if (running.has(job)) job.run.kill()
    }
    if (issue.dir) removeDir(issue.dir)
  }

  /** Pin FineReader to this mode's CPUs, measure its RAM, and stop the youngest job if Windows runs out of memory. */
  async function check() {
    if (Date.now() - lastCheck < CHECK_MS) return
    lastCheck = Date.now()
    if (settingsFile) await readSettings()

    const current = mode()
    if (current.name !== lastMode) {
      log(
        `${current.name === 'night' ? 'Night' : 'Day'}: up to ${current.ram / GB} GB and ${current.cpus} CPUs for FineReader` +
          ` (night ${limits.night.join('-')} h)`,
      )
      lastMode = current.name
    }

    try {
      measured = await abbyyProcesses(finereader, current.mask)
    } catch (err) {
      warn(`Couldn't measure FineReader's processes: ${err.message}`)
    }

    if (measured.gui && !guiWarned) {
      warn("FineReader's window is open. It can write its settings back; close it while OCR runs.")
      guiWarned = true
    }

    if (os.freemem() < KILL_FREE_RAM && running.size > 1) {
      const youngest = [...running].reduce((a, b) => (b.started > a.started ? b : a))
      warn(`Only ${(os.freemem() / GB).toFixed(1)} GB of memory left, stopping one FineReader job until there is more`)
      youngest.stoppedForMemory = true
      youngest.run.kill()
    }
  }

  /** Start jobs while they fit into the RAM budget (and leave Windows enough). Always keeps at least one running. */
  async function fill() {
    for (;;) {
      if (queue.length === 0 && pending.length > 0) {
        await prepare(pending.shift())
        continue
      }

      const job = queue[0]
      if (!job) return

      const reserved = running.size * jobRam
      const notYetUsed = Math.max(0, reserved - measured.ram) // just started jobs haven't allocated their memory yet
      const fits =
        Math.max(reserved, measured.ram) + jobRam <= mode().ram && os.freemem() - notYetUsed - jobRam >= MIN_FREE_RAM
      if (running.size > 0 && !fits) return

      queue.shift()
      start(job)
    }
  }

  await scan()
  for (;;) {
    await check()
    await fill()

    if (running.size === 0 && queue.length === 0 && pending.length === 0) {
      await grafting
      if (!watch) break
      await sleep(RESCAN_MS)
      await scan()
      continue
    }
    await sleep(1000)
  }

  await removeDir(tmp)
  log(`OCR done: ${counts.done} file(s)` + (counts.failed ? `, ${counts.failed} failed` : ''))
  return counts
}

/**
 * Check FineReader's limits: dayRam, nightRam (GB), dayCpus, nightCpus and night ("0-8" or [0, 8]). Missing ones come from base.
 *
 * @returns {{ dayRam: number, nightRam: number, dayCpus: number, nightCpus: number, night: number[] }}
 */
export function parseLimits(values, base = {}) {
  const cpus = os.availableParallelism()
  const number = (key, max) => {
    const value = Number(values[key] ?? base[key])
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${key} must be a whole number from 1 to ${max}`)
    return value
  }

  const night = values.night ?? base.night
  const hours = Array.isArray(night)
    ? night
    : String(night)
        .match(/^(\d{1,2})-(\d{1,2})$/)
        ?.slice(1)
        .map(Number)
  if (!hours || hours.some((hour) => hour > 24)) throw new Error(`night must be hours like 0-8, not "${night}"`)

  return {
    dayRam: number('dayRam', 1024),
    nightRam: number('nightRam', 1024),
    dayCpus: number('dayCpus', cpus),
    nightCpus: number('nightCpus', cpus),
    night: hours,
  }
}

/** PDFs in inDir/<folder>_<year>/ with year in years that don't exist in outDir/<folder>/ yet. */
async function findIssues(inDir, outDir, years) {
  const issues = []

  for (const dir of await fs.readdir(inDir, { withFileTypes: true })) {
    const year = Number(dir.name.match(/_(\d{4})$/)?.[1])
    if (!dir.isDirectory() || !years.includes(year)) continue

    // The list of the folder's issues goes along, so `nlr bind` can tell when a quarter is complete
    const results = await readResults(path.join(inDir, dir.name))
    if (results) await writeResults(path.join(outDir, dir.name), results)

    for (const name of await fs.readdir(path.join(inDir, dir.name))) {
      if (!name.endsWith('.pdf') || name.startsWith('.')) continue
      const out = path.join(outDir, dir.name, name)
      if (await fs.stat(out).catch(() => null)) continue
      issues.push({ folder: dir.name, name, file: path.join(inDir, dir.name, name), out })
    }
  }

  return issues
}

// FineReader can hold on to its files for a moment after it exits
const removeDir = (dir) =>
  fs
    .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    .catch((err) => warn(`Couldn't remove ${dir}: ${err.message}`))

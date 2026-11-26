#!/usr/bin/env node
// A small web page to watch and control the OCR work: starts and stops `nlr ocr` and the Nextcloud transport, shows their
// progress and logs, and changes FineReader's limits while it runs (through a settings file both of them re-read).
import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseArgs, promisify } from 'util'
import { parseLimits } from '../src/ocr.js'

const USAGE = `Usage:
  node scripts/nlr-ui.js --in <dir> --ocr <dir> --tomes <dir> [--port 8080]

Then open http://localhost:8080. --in, --ocr and --tomes are passed to nlr ocr and the transport script; the settings
are kept in <tomes>/nlr-settings.json. Any other options after -- go to the transport script, e.g. -- --remote nlr-test`

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const LOG_LINES = 40
const DEFAULT_SETTINGS = {
  dayRam: 20,
  nightRam: 36,
  dayCpus: 16,
  nightCpus: os.availableParallelism(),
  night: '0-8',
  ahead: 2,
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    in: { type: 'string' },
    ocr: { type: 'string' },
    tomes: { type: 'string' },
    port: { type: 'string', default: '8080' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (values.help || !values.in || !values.ocr || !values.tomes) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 2)
}

const dirs = { in: path.resolve(values.in), ocr: path.resolve(values.ocr), tomes: path.resolve(values.tomes) }
const port = Number(values.port)
const files = {
  settings: path.join(dirs.tomes, 'nlr-settings.json'),
  status: path.join(dirs.tomes, 'nlr-transport-status.json'),
  ocrLog: path.join(dirs.ocr, 'nlr-ocr.log'),
  transportLog: path.join(dirs.tomes, 'nlr-transport.log'),
}

const commands = {
  ocr: [path.join(ROOT, 'src', 'cli.js'), 'ocr', dirs.in, '--out', dirs.ocr, '--watch', '--settings', files.settings],
  transport: [
    path.join(HERE, 'nextcloud-ocr-transport.js'),
    ...['--in', dirs.in, '--ocr', dirs.ocr, '--tomes', dirs.tomes, '--watch', '--settings', files.settings],
    ...positionals,
  ],
}
const processes = { ocr: { child: null, exitCode: null }, transport: { child: null, exitCode: null } }

function start(name) {
  const entry = processes[name]
  if (entry.child) return
  const child = spawn(process.execPath, commands[name], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  Object.assign(entry, { child, startedAt: new Date().toISOString(), exitCode: null, stopping: false })
  child.on('exit', (code) => Object.assign(entry, { child: null, exitCode: entry.stopping ? null : code }))
}

/** Stop the process with everything it started (FineReader). Its outputs are only renamed into place when finished. */
async function stop(name) {
  const { child } = processes[name]
  if (!child) return
  processes[name].stopping = true
  if (process.platform === 'win32')
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {})
  else child.kill()
}

async function readSettings() {
  const saved = JSON.parse(await fs.readFile(files.settings, 'utf8').catch(() => '{}'))
  return { ...DEFAULT_SETTINGS, ...saved }
}

async function saveSettings(input) {
  const limits = parseLimits(input) // throws with a readable message
  const ahead = Number(input.ahead)
  if (!Number.isInteger(ahead) || ahead < 1 || ahead > 20) throw new Error('ahead must be a whole number from 1 to 20')
  const settings = { ...limits, night: limits.night.join('-'), ahead }
  await fs.writeFile(files.settings, JSON.stringify(settings, null, 2))
  return settings
}

async function tail(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  return text.trimEnd().split('\n').slice(-LOG_LINES)
}

/** FineReader's processes now: how many OCR jobs, and the memory of all of its processes. */
async function finereader() {
  if (process.platform !== 'win32') return null
  const { stdout } = await promisify(execFile)('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 16 * 2 ** 20 })
  let jobs = 0
  let ram = 0
  for (const line of stdout.split('\n')) {
    const [name, , , , memory] = line.split('","').map((cell) => cell.replace(/"/g, ''))
    if (!/^(finereaderocr|OcrEngine)/i.test(name ?? '')) continue
    if (/^finereaderocr/i.test(name)) jobs++
    ram += Number(memory.replace(/\D/g, '')) * 1024 // "1 234 K"
  }
  return { jobs, ram }
}

async function status() {
  const settings = await readSettings()
  const [from, to] = settings.night.split('-').map(Number)
  const hour = new Date().getHours()
  const night = from <= to ? hour >= from && hour < to : hour >= from || hour < to
  const disk = await fs.statfs(dirs.in).catch(() => null)

  return {
    processes: Object.fromEntries(
      Object.entries(processes).map(([name, { child, startedAt, exitCode }]) => [
        name,
        { running: !!child, startedAt: child ? startedAt : null, exitCode },
      ]),
    ),
    settings,
    system: {
      mode: night ? 'night' : 'day',
      freeRam: os.freemem(),
      totalRam: os.totalmem(),
      cpus: os.availableParallelism(),
      freeDisk: disk && disk.bavail * disk.bsize,
      finereader: await finereader().catch(() => null),
    },
    transport: JSON.parse(await fs.readFile(files.status, 'utf8').catch(() => 'null')),
    logs: { ocr: await tail(files.ocrLog), transport: await tail(files.transportLog) },
    dirs,
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  // Only this PC's browser: no other host names (DNS rebinding), and no plain form posts from other sites
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host))
    return json(res, 403, { error: 'forbidden' })
  if (req.method === 'POST' && req.headers['content-type'] !== 'application/json')
    return json(res, 415, { error: 'json only' })

  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(await fs.readFile(path.join(HERE, 'nlr-ui.html')))
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status())

    const action = req.method === 'POST' && url.pathname.match(/^\/api\/(start|stop)\/(ocr|transport)$/)
    if (action) {
      await (action[1] === 'start' ? start : stop)(action[2])
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = ''
      for await (const chunk of req) body += chunk
      try {
        return json(res, 200, await saveSettings(JSON.parse(body)))
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
    }
    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
})

await fs.mkdir(dirs.tomes, { recursive: true })
await fs.mkdir(dirs.ocr, { recursive: true })
if (!(await fs.stat(files.settings).catch(() => null))) await saveSettings(DEFAULT_SETTINGS)

const quit = async () => {
  await Promise.all(Object.keys(processes).map(stop))
  process.exit(0)
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

server.listen(port, '127.0.0.1', () => console.log(`NLR OCR: http://localhost:${port}  (Ctrl+C stops everything)`))

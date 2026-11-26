import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'

export const DEFAULT_FINEREADER = 'C:\\Software\\ABBYY FineReader PDF 16\\FineReaderOCR.exe'
const SETTINGS_FILE = path.join(process.env.APPDATA ?? '', 'ABBYY', 'FineReader', '16', 'fineUI.CommonSettings.xml')

// Image preprocessing that gave the best OCR on NLR's scans (see ocr-eval/); CorrectOrientation makes no difference
const REQUIRED_PREPROCESSING = ['CorrectSkew', 'ReduceIsoNoise']
const ALLOWED_PREPROCESSING = [...REQUIRED_PREPROCESSING, 'CorrectOrientation']

/** Throw unless FineReader's image preprocessing is set as REQUIRED_PREPROCESSING. Only reads the settings file. */
export async function checkSettings() {
  const xml = (await fs.readFile(SETTINGS_FILE)).toString('utf16le')
  const match = xml.match(
    /<preprocessOptions>[\s\S]*?<operations>[\s\S]*?<attributes>\s*(?:<set\/>|<set>([\s\S]*?)<\/set>)/,
  )
  if (!match) throw new Error(`Can't find the image preprocessing settings in ${SETTINGS_FILE}`)

  const set = [...(match[1] ?? '').matchAll(/<item>(\w+)<\/item>/g)].map((m) => m[1])
  const missing = REQUIRED_PREPROCESSING.filter((name) => !set.includes(name))
  const extra = set.filter((name) => !ALLOWED_PREPROCESSING.includes(name))

  if (missing.length || extra.length) {
    throw new Error(
      `FineReader's image preprocessing must be ${REQUIRED_PREPROCESSING.join(' + ')} only ` +
        `(found: ${set.join(', ') || 'none'}). Change it in FineReader's options, close FineReader, and run again.`,
    )
  }
}

/**
 * OCR input.pdf into output.pdf (searchable PDF). Old Russian spelling first: the documents are from before the 1918 reform.
 * @returns {{ promise: Promise<void>, kill: () => void }}
 */
export function runFineReader(exe, input, output, { timeout }) {
  let child
  const promise = new Promise((resolve, reject) => {
    child = execFile(
      exe,
      [input, '/lang', 'RussianOldSpelling', 'Russian', '/out', output],
      { timeout, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    )
  }).then(async () => {
    // It has been seen to exit without an error and without an output file
    if (!(await fs.stat(output).catch(() => null))) throw new Error('FineReader wrote no output')
  })

  return { promise, kill: () => child.kill() }
}

/**
 * Pin every process of the FineReader installation to the CPUs in mask (FineReader runs its engine in separate processes,
 * so pinning the one we start isn't enough) and measure them.
 * @returns {Promise<{ ram: number, gui: boolean }>} ram: their total working set in bytes; gui: FineReader's window is open
 */
export function abbyyProcesses(exe, mask) {
  const dir = path.dirname(exe).replace(/'/g, "''")
  const script =
    `$m = [IntPtr]${mask}; $ram = 0; $gui = 0; ` +
    `Get-Process | Where-Object { $_.Path -like '${dir}\\*' } | ForEach-Object { ` +
    `try { if ($_.ProcessorAffinity -ne $m) { $_.ProcessorAffinity = $m } } catch {}; ` +
    `$ram += $_.WorkingSet64; if ($_.ProcessName -eq 'FineReader') { $gui = 1 } }; "$ram $gui"`

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err)
        const [ram, gui] = stdout.trim().split(' ').map(Number)
        resolve({ ram, gui: gui === 1 })
      },
    )
  })
}

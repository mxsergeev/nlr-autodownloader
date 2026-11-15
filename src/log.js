import { appendFileSync } from 'fs'
import { format } from 'util'

let logFile = null

export function setLogFile(file) {
  logFile = file
}

function write(stream, screenLine, fileLine = screenLine) {
  stream.write(screenLine + '\n')
  if (logFile) appendFileSync(logFile, fileLine + '\n')
}

function timestamped(stream, args) {
  write(stream, `${new Date().toLocaleString('sv-SE')} ${format(...args)}`)
}

export const log = (...args) => timestamped(process.stdout, args)
export const warn = (...args) => timestamped(process.stderr, ['WARN', ...args])
export const error = (...args) => timestamped(process.stderr, ['ERROR', ...args])

/** Plain line without a timestamp; cut to the terminal width on screen, in full in the log file. */
export function report(line) {
  const width = process.stdout.columns
  write(process.stdout, width && line.length > width ? line.slice(0, width - 1) + '…' : line, line)
}

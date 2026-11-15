import { appendFileSync } from 'fs'
import { format } from 'util'

let logFile = null

export function setLogFile(file) {
  logFile = file
}

function write(stream, args) {
  const time = new Date().toLocaleString('sv-SE')
  const line = `${time} ${format(...args)}`
  stream.write(line + '\n')
  if (logFile) appendFileSync(logFile, line + '\n')
}

export const log = (...args) => write(process.stdout, args)
export const warn = (...args) => write(process.stderr, ['WARN', ...args])
export const error = (...args) => write(process.stderr, ['ERROR', ...args])

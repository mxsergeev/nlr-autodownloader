import { createWriteStream, promises as fs } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { setTimeout as sleep } from 'timers/promises'
import { assertOk } from './http.js'

const VIVALDI = 'https://vivaldi.nlr.ru'
const POLL_INTERVAL_MS = 5000
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'

/** HTTP client that keeps the cookies the site sets (its download state lives in the vivaldiSessionId session). */
function createSession(referer) {
  const cookies = new Map()

  return async function request(url, { method = 'GET', signal } = {}) {
    const response = await fetch(url, {
      method,
      signal,
      body: method === 'POST' ? '' : undefined, // the site rejects POSTs without Content-Length (HTTP 411)
      headers: {
        'User-Agent': USER_AGENT,
        Referer: referer,
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method === 'POST' && { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      },
    })

    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const i = pair.indexOf('=')
      cookies.set(pair.slice(0, i), pair.slice(i + 1))
    }

    return assertOk(response, url)
  }
}

/** Big documents come in several parts: "<name> (1 of 3).pdf"; single-part ones are just "<name>.pdf". */
export class PrepareTimeoutError extends Error {}

const partFileName = (fileName, part, parts) => (parts === 1 ? fileName : `${fileName} (${part + 1} of ${parts})`)

function refusalReason(text) {
  try {
    return JSON.parse(text).error ?? text
  } catch {
    return text
  }
}

/**
 * Download one digitized document into dir, doing the same requests as the "Скачать" button on its Vivaldi page:
 * register the download, start preparing the file, poll the progress until all parts are ready, fetch the parts.
 *
 * Preparing takes from seconds for small documents to minutes for year volumes; prepareTimeout limits that wait.
 * Parts are saved under temporary names and renamed together at the end, so an unfinished download never looks done.
 *
 * @param {{ vivaldiId: string, fileName: string }} item
 * @param {{ prepareTimeout: number, onPartReady?: (partsReady: number) => void }} options
 * @returns {Promise<number>} number of parts
 */
export async function downloadDocument(item, dir, { prepareTimeout, onPartReady = () => {} }) {
  const base = `${VIVALDI}/${item.vivaldiId}`
  const request = createSession(`${base}/details`)
  const post = (action) => request(`${base}/${action}`, { method: 'POST' })

  await request(`${base}/details`) // starts the session

  const registered = await (await post('registerdownload')).text()
  if (registered) throw new Error(`Download refused: ${refusalReason(registered)}`)

  try {
    return await prepareAndSave()
  } catch (err) {
    // A failed download must not keep holding its slot in the site's download queue
    await post('canceldownload').catch(() => {})
    throw err
  }

  async function prepareAndSave() {
    // This request only returns once everything is prepared; progress comes from polling instead
    const preparing = new AbortController()
    request(`${base}/preparedownload`, { signal: preparing.signal }).catch(() => {})

    const deadline = Date.now() + prepareTimeout
    let progress = { PartsReady: 0 }

    try {
      while (!progress.Done) {
        if (Date.now() > deadline) {
          throw new PrepareTimeoutError(
            `Not prepared after ${prepareTimeout / 1000}s (part ${progress.PartsReady + 1} at ${progress.PercentReady ?? 0}%)`,
          )
        }

        await sleep(POLL_INTERVAL_MS)
        const partsBefore = progress.PartsReady
        progress = await (await post('downloadprogress')).json()

        if (progress.somethingWrong) throw new Error('The site failed to prepare the file')
        if (!progress.Done && progress.PartsReady > partsBefore) onPartReady(progress.PartsReady)
      }
    } finally {
      preparing.abort()
    }

    await fs.mkdir(dir, { recursive: true })

    const parts = progress.PartsReady
    const files = []

    try {
      for (let part = 0; part < parts; part++) {
        const filePath = path.join(dir, `${partFileName(item.fileName, part, parts)}.pdf`)
        files.push(filePath)

        const response = await request(`${base}/partfile?part=${part}`)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath + '.part'))
      }
    } catch (err) {
      await Promise.all(files.map((filePath) => fs.rm(filePath + '.part', { force: true })))
      throw err
    }

    for (const filePath of files) await fs.rename(filePath + '.part', filePath)

    return parts
  }
}

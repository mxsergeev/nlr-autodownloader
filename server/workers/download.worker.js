import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import {
  scrapDownload,
  queryToString,
  DOWNLOADS_DIR,
  readMetadata,
  writeMetadata,
  getDownloadedFileNames,
  removeQuery,
} from '../services/download.service.js'
import path from 'path'

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || '2', 10) || 1

export const downloadWorker = new Worker(
  'downloadQueue',
  async (job) => {
    const { query, item } = job.data

    const storageDir = path.join(DOWNLOADS_DIR, queryToString(query))

    console.log(`[${queryToString(query)}] Downloading: ${item.fileName}`)

    await scrapDownload(item, storageDir)

    const metadata = await readMetadata(query)
    if (metadata) {
      // Use Date object for Prisma date field
      metadata.lastAttempt = new Date()
      metadata.status = 'downloading'

      const downloads = await getDownloadedFileNames(query)
      const total = metadata.results || 1

      metadata.downloaded = downloads.size
      metadata.downloadProgress = parseFloat(((downloads.size / total) * 100).toFixed(2)) + '%'

      if (downloads.size >= total) {
        metadata.status = 'completed'
        console.log(`[${queryToString(query)}] All items downloaded successfully.`)
        await removeQuery(query)
      }

      await writeMetadata(query, metadata)
    }

    return true
  },
  { connection, concurrency: CONCURRENT_DOWNLOADS },
)

downloadWorker.on('failed', async (job, err) => {
  const { query, item } = job.data || {}
  console.error(`[Download] Job ${job?.id} failed for ${item?.fileName}:`, err.message)

  if (query) {
    const metadata = await readMetadata(query).catch(() => null)
    if (metadata) {
      metadata.status = 'download_blocked'
      await writeMetadata(query, metadata).catch(() => null)
    }
  }
})

downloadWorker.on('completed', (job) => {
  const { query, item } = job.data || {}
  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`)
})

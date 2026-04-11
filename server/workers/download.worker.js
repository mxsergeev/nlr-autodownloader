import { Worker } from 'bullmq'
import path from 'path'
import { connection } from '../queue.js'
import { scrapDownload } from '../services/scraper.service.js'
import { DOWNLOADS_DIR, getDownloadedFileNames } from '../services/file.service.js'
import { getMetadata, updateSearchResult, upsertMetadata } from '../services/db.service.js'

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || '2', 10) || 1

async function updateSearchResultStatus(item, status) {
  await updateSearchResult(item.id, { status })
}

async function updateMetadataStatus(md, status) {
  const metadata = await getMetadata({ id: md.id })

  const downloads = await getDownloadedFileNames(metadata)
  const total = metadata.results || 1

  metadata.lastAttempt = new Date()
  metadata.downloaded = downloads.size
  metadata.downloadProgress = parseFloat(((downloads.size / total) * 100).toFixed(2)) + '%'

  if (downloads.size >= total) {
    metadata.status = 'completed'
  } else if (metadata.status !== 'paused') {
    metadata.status = status
  }
  // If paused, keep paused but still update progress counts

  await upsertMetadata({ id: metadata.id }, metadata).catch(() => null)
}

export const downloadWorker = new Worker(
  'downloadQueue',
  async (job) => {
    const { metadata, item } = job.data

    const storageDir = path.join(DOWNLOADS_DIR, metadata.id.toString())

    await scrapDownload(item, storageDir)
  },
  { connection, concurrency: CONCURRENT_DOWNLOADS },
)

downloadWorker.on('failed', async (job, err) => {
  const { metadata, item } = job.data || {}

  if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    updateMetadataStatus(metadata, 'download_blocked').catch(() => null)
    updateSearchResultStatus(item, 'download_blocked').catch(() => null)
  }

  console.error(
    `[Download] Job ${job?.id} (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? 1}) failed for ${item?.fileName}:`,
    err.message,
  )
})

downloadWorker.on('completed', async (job) => {
  const { metadata, item } = job.data || {}

  updateMetadataStatus(metadata, 'downloading').catch(() => null)
  updateSearchResultStatus(item, 'completed').catch(() => null)

  console.log(`[Download] Job ${job?.id} completed for ${item?.fileName}`)
})

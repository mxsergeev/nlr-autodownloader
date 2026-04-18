import { Worker } from 'bullmq'
import path from 'path'
import { connection } from '../queue.js'
import { scrapDownload } from '../services/scraper.service.js'
import { DOWNLOADS_DIR, getDownloadedFileNames } from '../services/file.service.js'
import { getQueryStats, updateSearchResult, upsertMetadata } from '../services/db.service.js'

const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS || '2', 10) || 1

async function updateSearchResultStatus(item, status) {
  await updateSearchResult(item.id, { status })
}

/**
 * Updates the parent Query's download progress and status after a download event.
 * Reads only { status, results } from the DB (not the full record) to minimise
 * the read-modify-write window. Status is only changed if the query is not paused.
 */
async function updateMetadataStatus(md, status) {
  const [current, downloads] = await Promise.all([getQueryStats(md.id), getDownloadedFileNames({ id: md.id })])

  if (!current) return

  const total = current.results || 1
  const downloadCount = downloads.size

  let newStatus
  if (downloadCount >= total) {
    newStatus = 'completed'
  } else if (current.status === 'paused') {
    newStatus = 'paused' // preserve paused — still update progress counts below
  } else {
    newStatus = status
  }

  await upsertMetadata({ id: md.id }, {
    lastAttempt: new Date(),
    downloaded: downloadCount,
    downloadProgress: parseFloat(((downloadCount / total) * 100).toFixed(2)) + '%',
    status: newStatus,
  }).catch(() => null)
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

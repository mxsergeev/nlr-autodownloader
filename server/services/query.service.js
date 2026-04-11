import { promises as fs } from 'fs'
import path from 'path'
import { getMetadata, upsertMetadata, deleteMetadata } from './db.service.js'
import { DOWNLOADS_DIR, queryToString } from './file.service.js'
import { searchQueue, downloadQueue } from '../queue.js'
import { addMetadataJob } from '../queues/metadata.queue.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'
import { RETRYABLE_STATUSES } from '../../shared/constants.js'

/**
 * Creates or returns an existing Query record. Re-creates if the existing record has
 * status 'search_failed' (allows re-queuing failed queries).
 * @param {{ url: string }} params
 * @param {{ order?: number }} [options]
 * @returns {Promise<import('../../shared/types.js').Query>}
 */
export async function queueQuery(params, { order = 0 } = {}) {
  const existing = await getMetadata(params)

  if (existing && existing.status !== 'search_failed') return existing

  return upsertMetadata(
    { url: params.url },
    {
      results: null,
      resultsPerPart: null,
      parts: null,
      pageUrl: params.url,
      createdAt: new Date(),
      order: Date.now() + order,
      status: 'pending',
    },
  )
}

/**
 * Removes a query: cancels its pending BullMQ jobs, deletes the DB record,
 * and optionally removes downloaded files.
 * Silently resolves if the query does not exist.
 * @param {{ id: number }} params
 * @param {{ removeDownloads?: boolean }} [options]
 */
export async function removeQuery(params, { removeDownloads = true } = {}) {
  const metadata = await getMetadata({ id: Number(params.id) })

  if (!metadata) return

  const searchJob = await searchQueue.getJob(`search-${metadata.id.toString()}`)
  try {
    if (searchJob) await searchJob.remove()

    if (metadata.searchResults?.length > 0) {
      const downloadJobs = (
        await Promise.allSettled(
          metadata.searchResults.map((j) => downloadQueue.getJob(`download-${j.id.toString()}`)),
        )
      )
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value)

      await Promise.allSettled(downloadJobs.map((j) => j.remove()))
    }
  } catch (err) {
    console.error(`Error removing jobs for query ${metadata.id}:`, err)
  }

  await deleteMetadata({ id: Number(params.id) })

  if (removeDownloads) {
    const dir = path.join(DOWNLOADS_DIR, queryToString(params))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * Re-queues a query for processing.
 * Throws an Error with `code: 'NOT_FOUND'` if the query does not exist.
 * Throws an Error with `code: 'NOT_RETRYABLE'` (and `.retryableStatuses`) if the status is not retryable.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function retryQuery(id) {
  const metadata = await getMetadata({ id: Number(id) })

  if (!metadata) {
    const err = new Error('Query not found')
    err.code = 'NOT_FOUND'
    throw err
  }

  if (!RETRYABLE_STATUSES.includes(metadata.status)) {
    const err = new Error(`Cannot retry query with status '${metadata.status}'`)
    err.code = 'NOT_RETRYABLE'
    err.retryableStatuses = RETRYABLE_STATUSES
    throw err
  }

  if (metadata.status === 'download_blocked') {
    await addDownloadJobBulk({ metadata, searchResults: metadata.searchResults })
  } else {
    await addMetadataJob({ url: metadata.pageUrl })
  }
}

/**
 * Toggles a query's status between 'paused' and 'pending'.
 * Throws an Error with `code: 'NOT_FOUND'` if the query does not exist.
 * @param {number} id
 * @returns {Promise<{ paused: boolean, id: number, status: string }>}
 */
export async function togglePause(id) {
  const metadata = await getMetadata({ id: Number(id) })

  if (!metadata) {
    const err = new Error('Query not found')
    err.code = 'NOT_FOUND'
    throw err
  }

  const newStatus = metadata.status === 'paused' ? 'pending' : 'paused'
  await upsertMetadata({ id: Number(id) }, { ...metadata, status: newStatus })

  return { paused: newStatus === 'paused', id: Number(id), status: newStatus }
}

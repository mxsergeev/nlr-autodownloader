import express from 'express'
import { removeQuery } from '../services/download.service.js'
import { getAllMetadata, getMetadata } from '../services/db.service.js'
import { addMetadataJob } from '../queues/metadata.queue.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'
import { RETRYABLE_STATUSES } from '../shared/constants.js'

const router = express.Router()

router.get('/queue', async (req, res) => {
  try {
    const queue = await getAllMetadata()

    res.json({ queue })
  } catch (error) {
    console.error('Queue retrieval error:', error)
    res.status(500).json({
      error: 'Failed to retrieve queue',
      message: error.message,
      name: error.name,
    })
  }
})

router.post('/queue', async (req, res) => {
  try {
    const { queries = [] } = req.body

    if (queries.length === 0) {
      return res.status(400).json({ error: 'No queries provided' })
    }

    const ops = queries.map(async (q, index) => {
      if (!q.url) {
        return Promise.reject(new Error(`Query at index ${index} is missing 'url' field`))
      }

      return addMetadataJob({ url: q.url })
    })

    const qsResults = await Promise.allSettled(ops)

    const queue = await getAllMetadata()

    res.json({ failed: qsResults.filter((r) => r.status === 'rejected').map((r) => r.reason), queue })
  } catch (error) {
    console.error('Queue error:', error)
    res.status(500).json({
      error: 'Queueing failed',
      message: error.message,
      name: error.name,
    })
  }
})

router.delete('/queue/:id', async (req, res) => {
  try {
    const { id } = req.params

    await removeQuery({ id: Number(id) })

    res.json({ removed: Number(id) })
  } catch (error) {
    console.error('Query removal error:', error)
    res.status(500).json({ error: 'Failed to remove query', message: error.message })
  }
})

router.post('/queue/:id/retry', async (req, res) => {
  try {
    const { id } = req.params
    const metadata = await getMetadata({ id: Number(id) })

    if (!metadata) {
      return res.status(404).json({ error: 'Query not found' })
    }

    if (!RETRYABLE_STATUSES.includes(metadata.status)) {
      return res.status(400).json({
        error: `Cannot retry query with status '${metadata.status}'`,
        retryableStatuses: RETRYABLE_STATUSES,
      })
    }

    if (metadata.status === 'download_blocked') {
      await addDownloadJobBulk({ metadata, searchResults: metadata.searchResults })
    } else {
      await addMetadataJob({ url: metadata.url })
    }

    res.json({ retried: Number(id) })
  } catch (error) {
    console.error('Query retry error:', error)
    res.status(500).json({ error: 'Failed to retry query', message: error.message })
  }
})

export default router

import express from 'express'
import { queryToString, removeQuery } from '../services/download.service.js'
import { metadataQueue, searchQueue } from '../queue.js'
import { getAllMetadata, getMetadata, upsertMetadata } from '../services/db.service.js'
import { addMetadataJob } from '../queues/metadata.queue.js'

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

router.get('/queue/:id', async (req, res) => {
  try {
    const { id } = req.params
    const metadata = await getMetadata({ id: Number(id) })

    if (!metadata) {
      return res.status(404).json({ error: 'Query not found' })
    }

    res.json({ metadata })
  } catch (error) {
    console.error('Query retrieval error:', error)
    res.status(500).json({ error: 'Failed to retrieve query', message: error.message })
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

    const retryableStatuses = ['download_blocked', 'search_failed', 'pending']
    if (!retryableStatuses.includes(metadata.status)) {
      return res.status(400).json({
        error: `Cannot retry query with status '${metadata.status}'`,
        retryableStatuses,
      })
    }

    const originalStatus = metadata.status
    metadata.status = 'pending'
    await upsertMetadata({ id: Number(id) }, metadata)

    if (originalStatus === 'download_blocked') {
      // Search data exists — re-queue search to identify and re-download missing files
      await searchQueue.add(
        queryToString({ id: Number(id) }),
        { query: { id: Number(id) } },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      )
    } else {
      // Full restart from metadata scraping
      await metadataQueue.add(
        queryToString({ id: Number(id) }),
        { query: { id: Number(id) } },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      )
    }

    const updated = await getMetadata({ id: Number(id) })
    res.json({ retried: Number(id), metadata: updated })
  } catch (error) {
    console.error('Query retry error:', error)
    res.status(500).json({ error: 'Failed to retry query', message: error.message })
  }
})

export default router

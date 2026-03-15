import express from 'express'
import {
  loadQueriesMetadata,
  queueQuery,
  queryToString,
  writeMetadata,
  readMetadata,
  removeQuery,
} from '../services/download.service.js'
import { metadataQueue, searchQueue } from '../queue.js'

const router = express.Router()

router.get('/queue', async (req, res) => {
  try {
    const queue = await loadQueriesMetadata()

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
      // Accept { id } or { url }
      if (q.id) {
        const record = await queueQuery({ id: q.id }, { order: index })
        await metadataQueue.add(queryToString({ id: record.id }), { query: { id: record.id } }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        })
        return { ok: true, id: record.id }
      }

      if (q.url) {
        const record = await queueQuery({ url: q.url }, { order: index })
        await metadataQueue.add(queryToString({ id: record.id }), { query: { id: record.id } }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        })
        return { ok: true, id: record.id }
      }

      return { ok: false, error: 'Invalid query object' }
    })

    const qsResults = await Promise.allSettled(ops)

    const queue = await loadQueriesMetadata()

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
    const metadata = await readMetadata({ id: Number(id) })

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
    const { removeDownloads } = req.query
    const metadata = await readMetadata({ id: Number(id) })

    if (!metadata) {
      return res.status(404).json({ error: 'Query not found' })
    }

    await removeQuery({ id: Number(id) }, { removeDownloads: removeDownloads === 'true' })

    res.json({ removed: Number(id) })
  } catch (error) {
    console.error('Query removal error:', error)
    res.status(500).json({ error: 'Failed to remove query', message: error.message })
  }
})

router.post('/queue/:id/retry', async (req, res) => {
  try {
    const { id } = req.params
    const metadata = await readMetadata({ id: Number(id) })

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
    await writeMetadata({ id: Number(id) }, metadata)

    if (originalStatus === 'download_blocked') {
      // Search data exists — re-queue search to identify and re-download missing files
      await searchQueue.add(queryToString({ id: Number(id) }), { query: { id: Number(id) } }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    } else {
      // Full restart from metadata scraping
      await metadataQueue.add(queryToString({ id: Number(id) }), { query: { id: Number(id) } }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }

    const updated = await readMetadata({ id: Number(id) })
    res.json({ retried: Number(id), metadata: updated })
  } catch (error) {
    console.error('Query retry error:', error)
    res.status(500).json({ error: 'Failed to retry query', message: error.message })
  }
})

export default router

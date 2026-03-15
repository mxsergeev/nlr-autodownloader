import express from 'express'
import { loadQueriesMetadata, queueQuery, queryToString } from '../services/download.service.js'
import { metadataQueue } from '../queue.js'

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

    const qs = queries
      .map((q) => {
        if (!q.q || !q.year) {
          return null
        }

        return { q: q.q, year: q.year }
      })
      .filter(Boolean)

    const qsResults = await Promise.allSettled(
      qs.map(async (q, index) => {
        await queueQuery(q, { order: index })
        await metadataQueue.add(queryToString(q), { query: q }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        })
      })
    )

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

export default router

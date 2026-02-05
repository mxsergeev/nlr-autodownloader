import express from 'express'
import { loadQueriesMetadata, queueQuery } from '../services/playwright.service.js'

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

    const qs = queries
      .map((q) => {
        if (!q.q || !q.year) {
          return null
        }

        return { q: q.q, year: q.year }
      })
      .filter(Boolean)

    const qsResults = await Promise.allSettled(
      qs.map((q) =>
        queueQuery(q).catch((err) => {
          throw Object.assign(err, { query: q })
        }),
      ),
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

import express from 'express'
import {
  loadQueriesMetadata,
  queueQuery,
  queryToString,
  readMetadataByName,
  removeQueryByName,
  writeMetadata,
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

router.get('/queue/:queryName', async (req, res) => {
  try {
    const { queryName } = req.params
    const metadata = await readMetadataByName(queryName)

    if (!metadata) {
      return res.status(404).json({ error: 'Query not found' })
    }

    res.json({ metadata })
  } catch (error) {
    console.error('Query retrieval error:', error)
    res.status(500).json({ error: 'Failed to retrieve query', message: error.message })
  }
})

router.delete('/queue/:queryName', async (req, res) => {
  try {
    const { queryName } = req.params
    const { removeDownloads } = req.query
    const metadata = await readMetadataByName(queryName)

    if (!metadata) {
      return res.status(404).json({ error: 'Query not found' })
    }

    await removeQueryByName(queryName, { removeDownloads: removeDownloads === 'true' })

    res.json({ removed: queryName })
  } catch (error) {
    console.error('Query removal error:', error)
    res.status(500).json({ error: 'Failed to remove query', message: error.message })
  }
})

router.post('/queue/:queryName/retry', async (req, res) => {
  try {
    const { queryName } = req.params
    const metadata = await readMetadataByName(queryName)

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

    const { query } = metadata
    const originalStatus = metadata.status
    metadata.status = 'pending'
    await writeMetadata(query, metadata)

    if (originalStatus === 'download_blocked') {
      // Search data exists — re-queue search to identify and re-download missing files
      await searchQueue.add(queryToString(query), { query }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    } else {
      // Full restart from metadata scraping
      await metadataQueue.add(queryToString(query), { query }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }

    const updated = await readMetadataByName(queryName)
    res.json({ retried: queryName, metadata: updated })
  } catch (error) {
    console.error('Query retry error:', error)
    res.status(500).json({ error: 'Failed to retry query', message: error.message })
  }
})

export default router

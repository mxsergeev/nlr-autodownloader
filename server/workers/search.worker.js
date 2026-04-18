import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { scrapSearchResults, verifySearchResults } from '../services/scraper.service.js'
import { getSearchResults, saveSearchResults, upsertMetadata } from '../services/db.service.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'

export const searchWorker = new Worker(
  'searchQueue',
  async (job) => {
    const { metadata } = job.data

    await upsertMetadata({ id: metadata.id }, { status: 'fetching_results' })

    let results

    const existing = await getSearchResults({ queryId: metadata.id })

    if (existing.length > 0 && verifySearchResults(existing, metadata)) {
      // Cache hit: existing DB results are valid — use them directly (already have IDs)
      results = existing
    } else {
      results = await scrapSearchResults(metadata)

      if (verifySearchResults(results, metadata)) {
        await saveSearchResults({ queryId: metadata.id }, results)
        // Re-fetch after upsert to get DB-assigned IDs for any newly inserted rows
        results = await getSearchResults({ queryId: metadata.id })
      } else {
        throw new Error('Scraped search results do not match expected metadata')
      }
    }

    await upsertMetadata({ id: metadata.id }, { status: 'downloading' })

    const hasJobs = await addDownloadJobBulk({ metadata, searchResults: results })

    if (!hasJobs) {
      // All files are already on disk — no download jobs to run, mark completed immediately
      await upsertMetadata({ id: metadata.id }, { status: 'completed' })
    }

    return { metadata, searchResults: results }
  },
  { connection, concurrency: 1 },
)

searchWorker.on('failed', async (job, err) => {
  const { metadata } = job?.data || {}

  if (metadata && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    await upsertMetadata(
      { id: metadata.id },
      {
        status: 'search_failed',
        lastAttempt: new Date(),
      },
    ).catch(() => null)
  }

  console.error(`[Search] Job ${job?.id} failed:`, err.message)
})

searchWorker.on('completed', (job) => {
  console.log(`[Search] Job ${job?.id} completed`)
})

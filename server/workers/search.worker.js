import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { scrapSearchResults, verifySearchResults } from '../services/download.service.js'
import { getSearchResults, saveSearchResults } from '../services/db.service.js'
import { addDownloadJobBulk } from '../queues/download.queue.js'

export const searchWorker = new Worker(
  'searchQueue',
  async (job) => {
    const { metadata } = job.data

    let results

    const existing = await getSearchResults({ queryId: metadata.id })

    if (existing.length > 0 && verifySearchResults(existing, metadata)) {
      results = existing
    }

    if (!results) {
      results = await scrapSearchResults(metadata)

      if (verifySearchResults(results, metadata)) {
        await saveSearchResults({ queryId: metadata.id }, results)
      } else {
        throw new Error('Scraped search results do not match expected metadata')
      }
    }

    results = await getSearchResults({ queryId: metadata.id })

    await addDownloadJobBulk({ metadata, searchResults: results })

    return { metadata, searchResults: results }
  },
  { connection, concurrency: 1 },
)

searchWorker.on('failed', (job, err) => {
  console.error(`[Search] Job ${job?.id} failed:`, err.message)
})

searchWorker.on('completed', (job) => {
  console.log(`[Search] Job ${job?.id} completed`)
})

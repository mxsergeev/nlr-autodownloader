import { Worker } from 'bullmq'
import { connection, searchQueue } from '../queue.js'
import { loadMetadata, queryToString } from '../services/download.service.js'

export const metadataWorker = new Worker(
  'metadataQueue',
  async (job) => {
    const { query } = job.data
    const metadata = await loadMetadata(query)

    if (metadata && metadata.results > 0) {
      await searchQueue.add(queryToString(query), { query }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }

    return metadata
  },
  { connection, concurrency: 1 },
)

metadataWorker.on('failed', (job, err) => {
  console.error(`[Metadata] Job ${job?.id} failed:`, err.message)
})

metadataWorker.on('completed', (job) => {
  console.log(`[Metadata] Job ${job?.id} completed`)
})

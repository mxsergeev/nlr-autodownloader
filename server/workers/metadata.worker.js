import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { getMetadata, upsertMetadata } from '../services/db.service.js'
import { addSearchJob } from '../queues/search.queue.js'
import { scrapMetadata } from '../services/download.service.js'

export const metadataWorker = new Worker(
  'metadataQueue',
  async (job) => {
    const { url } = job.data

    const existing = await getMetadata({ url })

    if (existing && existing.results > 0 && existing.searchResults.length === existing.results) {
      await addSearchJob({ metadata: existing })

      return existing
    }

    let metadata = await scrapMetadata({ url })

    metadata = await upsertMetadata({ url }, metadata)

    if (metadata && metadata.results > 0) {
      await addSearchJob({ metadata })
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

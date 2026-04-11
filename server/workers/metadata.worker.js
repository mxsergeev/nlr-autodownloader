import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { getMetadata, upsertMetadata } from '../services/db.service.js'
import { addSearchJob } from '../queues/search.queue.js'
import { queueQuery } from '../services/query.service.js'
import { scrapMetadata } from '../services/scraper.service.js'

export const metadataWorker = new Worker(
  'metadataQueue',
  async (job) => {
    const { url } = job.data

    const existing = await queueQuery({ url })

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

metadataWorker.on('failed', async (job, err) => {
  const { url } = job?.data || {}
  const metadata = url ? await getMetadata({ url }) : null

  if (metadata && job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    await upsertMetadata(
      { id: metadata.id },
      {
        ...metadata,
        status: 'search_failed',
        lastAttempt: new Date(),
      },
    ).catch(() => null)
  }

  console.error(`[Metadata] Job ${job?.id} failed:`, err.message)
})

metadataWorker.on('completed', (job) => {
  console.log(`[Metadata] Job ${job?.id} completed`)
})

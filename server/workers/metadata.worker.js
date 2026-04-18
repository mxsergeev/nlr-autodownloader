import { Worker } from 'bullmq'
import { connection } from '../queue.js'
import { getMetadata, upsertMetadata } from '../services/db.service.js'
import { addSearchJob } from '../queues/search.queue.js'
import { scrapMetadata } from '../services/scraper.service.js'

export const metadataWorker = new Worker(
  'metadataQueue',
  async (job) => {
    const { url } = job.data

    const existing = await getMetadata({ url })

    // Mark as actively fetching metadata
    if (existing) {
      await upsertMetadata({ id: existing.id }, { status: 'fetching_metadata' })
    }

    // Short-circuit: if all search results are already in the DB, skip metadata re-scrape
    if (existing && existing.results > 0 && existing.searchResults.length === existing.results) {
      await upsertMetadata({ id: existing.id }, { status: 'fetching_results' })
      await addSearchJob({ metadata: existing })
      return existing
    }

    const scraped = await scrapMetadata({ url })

    // Keep pageUrl as the stable user-supplied key; store the resolved (sorted) URL
    // separately so search pagination builds correct page URLs without mutating the key.
    const metadata = await upsertMetadata(
      { url },
      { ...scraped, pageUrl: url, searchUrl: scraped.pageUrl, status: 'fetching_results' },
    )

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

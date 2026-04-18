import { createHash } from 'crypto'
import { metadataQueue } from '../queue.js'

export async function addMetadataJob({ url }) {
  const jobId = `metadata-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
  await metadataQueue.add(
    'metadata',
    { url },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  )
}

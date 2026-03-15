import { metadataQueue } from '../queue.js'

export async function addMetadataJob({ url }) {
  await metadataQueue.add(
    'metadata',
    { url },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  )
}

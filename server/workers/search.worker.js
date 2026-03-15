import { Worker } from 'bullmq'
import { connection, downloadQueue } from '../queue.js'
import { loadSearchResults, getDownloadedFileNames, verifyDownloads, queryToString } from '../services/download.service.js'

export const searchWorker = new Worker(
  'searchQueue',
  async (job) => {
    const { query } = job.data
    
    const searchResults = await loadSearchResults(query)
    
    const downloads = await getDownloadedFileNames(query)
    const { missingFiles } = verifyDownloads(downloads, searchResults)
    
    if (missingFiles && missingFiles.length > 0) {
      const jobs = missingFiles.map((item) => ({
        name: `${queryToString(query)}-${item.fileName}`,
        data: { query, item },
        opts: {
          attempts: 10,
          backoff: { type: 'exponential', delay: 5000 },
        },
      }))
      
      await downloadQueue.addBulk(jobs)
    }

    return { total: searchResults.length, missing: missingFiles.length }
  },
  { connection, concurrency: 1 },
)

searchWorker.on('failed', (job, err) => {
  console.error(`[Search] Job ${job?.id} failed:`, err.message)
})

searchWorker.on('completed', (job, returnvalue) => {
  console.log(`[Search] Job ${job?.id} completed (Total: ${returnvalue.total}, Missing: ${returnvalue.missing})`)
})

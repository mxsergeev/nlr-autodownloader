import { downloadQueue } from '../queue.js'
import { getDownloadedFileNames, verifyDownloads } from '../services/file.service.js'

export async function addDownloadJobBulk({ metadata, searchResults } = {}) {
  const downloads = await getDownloadedFileNames(metadata)
  const { missingFiles } = verifyDownloads(downloads, searchResults)

  if (missingFiles.length === 0) {
    console.log(`[Download] All files for ${metadata.id} are already downloaded.`)
    return
  }

  const jobs = missingFiles.map((item) => ({
    name: 'download',
    data: { metadata, item },
    opts: {
      jobId: `download-${item.id}`,
      attempts: 10,
      backoff: { type: 'fixed', delay: 2000 },
    },
  }))

  await downloadQueue.addBulk(jobs)
}

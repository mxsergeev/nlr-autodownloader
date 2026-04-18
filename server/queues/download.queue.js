import { downloadQueue } from "../queue.js";
import { getDownloadedFileNames, verifyDownloads } from "../services/file.service.js";

/**
 * Queues download jobs for all search result items whose file does not yet exist on disk.
 * Each job carries only the minimal data the worker needs: metadata id and the item's
 * id, href, and fileName — not the full metadata or SearchResult objects.
 * @returns {Promise<boolean>} true if jobs were added, false if all files are already present.
 */
export async function addDownloadJobBulk({ metadata, searchResults } = {}) {
  const downloads = await getDownloadedFileNames(metadata);
  const { missingFiles } = verifyDownloads(downloads, searchResults);

  if (missingFiles.length === 0) {
    console.log(`[Download] All files for ${metadata.id} are already downloaded.`);
    return false;
  }

  const jobs = missingFiles.map((item) => ({
    name: "download",
    data: {
      metadata: { id: metadata.id },
      item: { id: item.id, href: item.href, fileName: item.fileName },
    },
    opts: {
      jobId: `download-${item.id}`,
      attempts: 10,
      backoff: { type: "exponential", delay: 5000 },
    },
  }));

  await downloadQueue.addBulk(jobs);
  return true;
}

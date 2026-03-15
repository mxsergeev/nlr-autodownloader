import app from './app.js'
import { startDownloadsWatcher } from './services/download.service.js'
import './workers/metadata.worker.js'
import './workers/search.worker.js'
import './workers/download.worker.js'

const port = process.env.SERVER_PORT || 3333

// Set umask to allow group write permissions for created files and directories
process.umask(0o002)

app.listen(port, () => {
  console.log(`NLR-AUTODOWNLOADER listening on port ${port}`)
})

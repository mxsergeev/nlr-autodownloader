import app from './app.js'
import { startQueryWatcher } from './services/playwright.service.js'

const port = process.env.SERVER_PORT || 3333

// Set umask to allow group write permissions for created files and directories
process.umask(0o002);

// Resume existing queries in the background
if (process.env.RUN_QUEUE_WATCHER === 'true') {
  startQueryWatcher()
}

app.listen(port, () => {
  console.log(`NLR-AUTODOWNLOADER listening on port ${port}`)
})

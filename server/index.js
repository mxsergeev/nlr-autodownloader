import app from './app.js'
import { startQueryWatcher } from './services/playwright.service.js'

const port = process.env.SERVER_PORT || 3333

// Resume existing queries in the background
if (process.env.RUN_QUEUE_WATCHER === 'true') {
  startQueryWatcher()
}

app.listen(port, () => {
  console.log(`NLR-AUTODOWNLOADER listening on port ${port}`)
})

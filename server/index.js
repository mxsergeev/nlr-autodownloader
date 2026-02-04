import app from './app.js'
import { startExistingQueries } from './services/playwright.service.js'

const port = process.env.SERVER_PORT || 3333

// Resume existing queries in the background
startExistingQueries().catch((err) => console.error('Error resuming queries:', err))

app.listen(port, () => {
  console.log(`NLR-AUTODOWNLOADER listening on port ${port}`)
})

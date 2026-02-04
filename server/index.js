import app from './app.js'
import { startExistingQueries } from './services/playwright.service.js'

const port = process.env.SERVER_PORT || 3333

console.log('process.env.SERVER_PORT', process.env.SERVER_PORT)

// Start resuming existing queries in background so server startup isn't blocked
startExistingQueries().catch((err) => console.error('Error resuming queries:', err))

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

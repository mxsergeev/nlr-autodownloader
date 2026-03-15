import express from 'express'
import PlayWrightController from './controllers/playwright.controller.js'

const app = express()

app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/playwright', PlayWrightController)

export default app

import express from 'express'
import PlayWrightController from './controllers/playwright.controller.js'

const app = express()

app.use('/playwright', PlayWrightController)

export default app

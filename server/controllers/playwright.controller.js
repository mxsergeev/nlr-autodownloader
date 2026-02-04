import express from 'express'
import { download, loadSearchResults } from '../services/playwright.service.js'

const router = express.Router()

router.get('/download', async (req, res) => {
  try {
    const { q, year } = req.query

    const result = await download({ q: decodeURIComponent(q), year })

    res.json({ result })
  } catch (error) {
    console.error('Download error:', error)
    res.status(500).json({
      error: 'Download failed',
      message: error.message,
      name: error.name,
    })
  }
})

router.get('/search', async (req, res) => {
  try {
    const { q, year } = req.query

    const result = await loadSearchResults({ q: decodeURIComponent(q), year })

    res.json({ result })
  } catch (error) {
    console.error('Search error:', error)
    res.status(500).json({
      error: 'Search failed',
      message: error.message,
      name: error.name,
    })
  }
})

export default router

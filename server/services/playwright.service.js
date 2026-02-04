import { firefox } from 'playwright'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import UserAgent from 'user-agents'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TMP_DIR = path.join(__dirname, '..', 'tmp')
await fs.mkdir(TMP_DIR, { recursive: true })

const QUERY_DIR = path.join(TMP_DIR, 'queries')
await fs.mkdir(QUERY_DIR, { recursive: true })

// const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(TMP_DIR, 'downloads')
const DOWNLOADS_DIR = path.join(TMP_DIR, 'downloads')
await fs.mkdir(DOWNLOADS_DIR, { recursive: true })

console.log('DOWNLOADS_DIR', DOWNLOADS_DIR)

const CONCURRENCY = 4

const userAgent = new UserAgent({ deviceCategory: 'desktop' })

let browser

async function startBrowser() {
  if (browser && browser.isConnected()) return

  if (browser) {
    await stopBrowser()
  }

  let headless

  if (process.env.PLAYWRIGHT_HEADLESS !== undefined) {
    headless = process.env.PLAYWRIGHT_HEADLESS === 'true'
  } else {
    headless = true
  }

  // Firefox is much more consistent in headless mode than Chromium
  browser = await firefox.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
}

async function stopBrowser() {
  if (!browser) return

  await browser.close().catch(() => {})

  browser = undefined
}

export async function runJob(fn) {
  if (!browser || !browser.isConnected()) await startBrowser()

  let context

  try {
    context = await browser.newContext(userAgent)
  } catch {
    // try restarting once
    await stopBrowser()
    await startBrowser()
    context = await browser.newContext(userAgent)
  }

  const page = await context.newPage()
  try {
    return await fn(page, context)
  } finally {
    await context.close().catch(() => {})
  }
}

export async function loadQueriesMetadata() {
  // find query subdirectories and look for metadata files inside each
  const entries = await fs.readdir(QUERY_DIR, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())

  const results = []

  for (const dir of dirs) {
    const dirPath = path.join(QUERY_DIR, dir.name)
    const files = await fs.readdir(dirPath, { withFileTypes: true })
    const metaFile = files.find((f) => f.isFile() && f.name.endsWith('.metadata.json'))

    if (!metaFile) continue

    const metaFilePath = path.join(dirPath, metaFile.name)
    try {
      const metadata = JSON.parse(await fs.readFile(metaFilePath, 'utf-8'))
      results.push({ dir: dir.name, metadata })
    } catch (err) {
      console.warn(`Failed to read metadata for ${dir.name}:`, err.message)
    }
  }

  return results
}

export async function startExistingQueries() {
  let metadataList = await loadQueriesMetadata()
  let queriesCount = metadataList.length

  while (queriesCount > 0) {
    await Promise.all(
      metadataList.splice(0, CONCURRENCY).map(async ({ dir, metadata }) => {
        console.log(`Resuming query in ${dir} with parameters:`, metadata.query)
        try {
          await download(metadata.query)
        } catch (err) {
          console.error(`Error resuming query in ${dir}:`, err)
        }
      }),
    )

    metadataList = await loadQueriesMetadata()
    queriesCount = metadataList.length
  }
}

async function scrapMetadata(params) {
  return runJob(async (page) => {
    await page.goto('https://primo.nlr.ru/')

    await page.getByRole('button', { name: 'Перейти к расширенному поиску' }).click()

    await page.getByRole('button', { name: 'Выберите точную операцию для сложного номера строки 1 содержит' }).click()
    await page.getByRole('option', { name: 'совпадает' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 1' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 1' }).fill(params.q)

    await page.getByRole('button', { name: 'Выберите поле поиска для сложного номера строки 2' }).click()
    await page.getByRole('option', { name: 'Год издания' }).click()
    await page.getByRole('button', { name: 'Выберите точную операцию для сложного номера строки 2 совпадает' }).click()
    await page.getByRole('option', { name: 'совпадает' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 2' }).click()
    await page.getByRole('textbox', { name: 'Введите поисковый запрос для сложного номера строки 2' }).fill(params.year)

    await page.getByRole('button', { name: 'Отправить поиск' }).click()

    await page.getByRole('button', { name: 'Сортировать по Релевантность' }).click()
    await page.getByRole('option', { name: 'Дата выхода периодики (по возр.)' }).click()

    await page.waitForSelector('.item-title', { timeout: 15000 }).catch(() => {
      throw new Error('No results found for the given search criteria.')
    })

    const resultCount = await page.locator('.results-count', { hasText: 'результат' }).textContent()

    // Extract the number using regex
    const match = resultCount.match(/(\d+)/)
    const resultNumber = match ? parseInt(match[1], 10) : null

    const resultsPerPart = await page.locator('.item-title').count()

    const parts = resultNumber ? Math.ceil(resultNumber / resultsPerPart) : 1

    const pageUrl = page.url()

    const metadata = {
      query: params,
      results: resultNumber,
      resultsPerPart,
      parts,
      pageUrl,
    }

    return metadata
  })
}

async function loadMetadata(params) {
  const existingMetadata = await fs
    .readFile(path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.metadata.json`), 'utf-8')
    .catch(() => null)

  if (existingMetadata) {
    return JSON.parse(existingMetadata)
  }

  const metadata = await scrapMetadata(params)

  const outputPath = path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.metadata.json`)
  await fs.writeFile(outputPath, JSON.stringify(metadata, null, 2))

  return metadata
}

async function scrapSearchResults(params, { doneParts = new Set(), scrapedUrls = new Set() } = {}) {
  const metadata = await loadMetadata(params)

  return runJob(async (page) => {
    const seenUrls = new Set(scrapedUrls)

    for (let curPart = 1; curPart <= metadata.parts; curPart++) {
      if (doneParts.has(curPart)) {
        console.log(`Skipping already done part ${curPart}`)
        continue
      }

      await page.goto(metadata.pageUrl.replace(/offset=\d+/, `offset=${(curPart - 1) * metadata.resultsPerPart}`))

      console.log(`Processing part ${curPart} of ${metadata.parts}`)

      const part = []

      await page.waitForSelector('.item-title', { timeout: 15000 })

      const headings = page.locator('.item-title')
      const headingData = await headings.evaluateAll((elements) => {
        return elements.map((element) => {
          const anchor = element.querySelector('a')
          // Clean up text: remove leading special chars, trim, and normalize whitespace
          const rawText = element.textContent.trim()
          const cleanText = rawText.replace(/^[=\s]+/, '').replace(/\s+/g, ' ')

          return {
            title: cleanText,
            href: anchor ? anchor.href : null,
          }
        })
      })

      // Generate fileName in Node context where sanitizeFileName is defined
      headingData.forEach((item) => {
        item.fileName = sanitizeFileName(item.title)
      })

      // Only add items we haven't seen before
      for (const item of headingData) {
        if (item.href && !seenUrls.has(item.href)) {
          seenUrls.add(item.href)

          part.push(item)
        }
      }

      const outputPath = path.join(QUERY_DIR, queryToString(params), `${queryToString(params)}.part${curPart}.json`)
      await fs.writeFile(outputPath, JSON.stringify(part, null, 2))

      // if (curPart < metadata.parts) {
      //   // Get the first item's href before clicking to detect when DOM updates
      //   const firstItemHref = await page.locator('.item-title a').first().getAttribute('href')

      //   console.log('firstItemHref', firstItemHref)

      //   await page.getByRole('link', { name: 'Загрузить больше результатов?' }, { timeout: 15000 }).click()

      //   // Wait for the DOM to update by checking if the first item changed
      //   await page.waitForFunction(
      //     (oldHref) => {
      //       // eslint-disable-next-line no-undef
      //       const firstAnchor = document.querySelector('.item-title a')
      //       console.log('firstAnchor href', firstAnchor ? firstAnchor.getAttribute('href') : null)
      //       return firstAnchor && firstAnchor.getAttribute('href') !== oldHref
      //     },
      //     firstItemHref,
      //     { timeout: 15000 },
      //   )
      // }
    }
  })
}

async function getPartFileNames(params) {
  await fs.mkdir(path.join(QUERY_DIR, queryToString(params)), { recursive: true })
  const dir = path.join(QUERY_DIR, queryToString(params))
  const partNames = (await fs.readdir(dir, { withFileTypes: true }))
    .filter(
      (f) =>
        f.isFile() &&
        // Only include files that follow the <query>.partN.json pattern
        f.name.startsWith(`${queryToString(params)}.part`) &&
        /\.part\d+\.json$/.test(f.name),
    )
    .map((f) => path.parse(f.name))
    // Sort by numeric part suffix (natural numeric order for .part1, .part2 ... .part10)
    .sort((a, b) => {
      const re = /\.part(\d+)$/
      const ma = a.name.match(re)
      const mb = b.name.match(re)

      if (ma && mb) {
        return parseInt(ma[1], 10) - parseInt(mb[1], 10)
      }

      // Fallback to name compare
      return a.name.localeCompare(b.name)
    })

  return partNames
}

function verifySearchResults(results, metadata) {
  if (results.length !== metadata.results) {
    console.warn(`Warning: Expected ${metadata.results} results, but got ${results.length}.`)
    return false
  }

  const seenUrls = new Set()
  const duplicates = []

  for (const item of results) {
    if (seenUrls.has(item.href)) {
      duplicates.push(item.href)
    } else {
      seenUrls.add(item.href)
    }
  }

  if (duplicates.length > 0) {
    console.warn(`Warning: Found ${duplicates.length} duplicate items in the results.`)
    return false
  }

  console.log('All search results have passed verification.')
  return true
}

async function removeQuery(params) {
  const dir = path.join(QUERY_DIR, queryToString(params))
  await fs.rm(dir, { recursive: true, force: true })
}

export async function loadSearchResults(params = {}, { override = false } = {}) {
  if (Object.keys(params).length === 0) {
    throw new Error('No search parameters provided.')
  }

  const dir = path.join(QUERY_DIR, queryToString(params))

  const searchResults = override
    ? null
    : JSON.parse(await fs.readFile(path.join(dir, `${queryToString(params)}.json`), 'utf-8').catch(() => 'null'))

  if (searchResults && searchResults.length > 0) {
    const metadata = await loadMetadata(params)
    console.log(`Search results for ${queryToString(params)} already exist. Skipping fetch.`)

    if (verifySearchResults(searchResults, metadata)) {
      return searchResults
    }
  }

  let partNames = await getPartFileNames(params)

  // Parse what parts are already done
  const doneParts = new Set()
  for (const part of partNames) {
    const match = part.name.match(/\.part(\d+)$/)
    if (match) {
      doneParts.add(parseInt(match[1], 10))
    }
  }

  await scrapSearchResults(params, { doneParts })

  partNames = await getPartFileNames(params)

  const resultParts = await Promise.all(
    partNames.map((p) => fs.readFile(path.join(dir, p.base), 'utf8').then(JSON.parse)),
  )

  const results = resultParts.flat()

  const metadata = await loadMetadata(params)

  if (!verifySearchResults(results, metadata)) {
    throw new Error('Search results verification failed.')
  }

  // Clean up query parts
  for (const part of partNames) {
    await fs.unlink(path.join(dir, part.base))
  }

  const outputPath = path.join(dir, `${queryToString(params)}.json`)
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2))

  return results
}

function sanitizeFileName(name = '') {
  name = name.replace(/[/\\?%*:|"<>]/g, '_')
  // Check if there a file extension
  const lastDotIndex = name.lastIndexOf('.')

  if (lastDotIndex > 0) {
    const base = name.substring(0, lastDotIndex).replace(/\./g, '')
    const ext = name.substring(lastDotIndex + 1)

    // Check if extension is valid (only letters) and not some garbage
    if (/^[a-zA-Z]+$/.test(ext)) {
      return base + '.' + ext
    } else {
      // If not a valid extension, treat as no extension
      return name.replace(/\./g, '')
    }
  } else {
    return name.replace(/\./g, '')
  }
}

function queryToString(params) {
  return Object.entries(params)
    .map(([, value]) => value.toString().trim().replace(/\s+/g, '_'))
    .join('_')
}

async function scrapDownload(item, storageDir) {
  return runJob(async (page) => {
    let page1 = null
    let page2 = null
    try {
      await page.goto(item.href)
      const page1Promise = page.waitForEvent('popup').catch(() => {})
      await page.getByLabel('Электронная копия').click()
      page1 = await page1Promise
      await page1.getByRole('link', { name: 'Карточка' }).click()
      await page1.locator('#btn-download').click()

      // Set up event listeners before clicking, but don't await yet
      const page2Promise = page1.waitForEvent('popup', { timeout: 15000 }).catch(() => {})
      const downloadPromise = page1.waitForEvent('download', { timeout: 15000 }).catch(() => {})

      await page1
        .getByLabel('Загрузка всего документа')
        .getByRole('link', { name: 'Скачать' })
        .click({ timeout: 15000 })

      page2 = await page2Promise
      const file = await downloadPromise

      const fileName = sanitizeFileName(item.fileName)
      const filePath = path.join(storageDir, `${fileName}.pdf`)
      await file.saveAs(filePath)
    } catch (err) {
      throw new Error(`Scraping failed for item: ${item.fileName}. Reason: ${err.message}`)
    } finally {
      // Clean up opened pages to prevent lingering promises
      if (page2) await page2.close()
      if (page1) await page1.close()
    }
  })
}

async function getDownloadedFileNames(params) {
  const storageDir = path.join(DOWNLOADS_DIR, queryToString(params))
  return new Set((await fs.readdir(storageDir)).map((file) => path.parse(file).name))
}

function verifyDownloads(downloads = new Set(), searchResults) {
  const missingFiles = searchResults.filter((item) => !downloads.has(item.fileName))

  return { missingFiles }
}

export async function download(params = {}) {
  const searchResults = await loadSearchResults(params)

  const storageDir = path.join(DOWNLOADS_DIR, queryToString(params))
  await fs.mkdir(storageDir, { recursive: true })

  let fails = 0

  while (fails < 10) {
    const downloads = await getDownloadedFileNames(params)
    const { missingFiles } = verifyDownloads(downloads, searchResults)

    console.log('----------------------------------------')
    console.log('Query:', queryToString(params))
    console.log(`Status: ${downloads.size} / ${searchResults.length}`)
    console.log(
      `Progress: ${(((searchResults.length - missingFiles.length) / searchResults.length) * 100).toFixed(2)}%`,
    )

    if (missingFiles.length === 0) {
      break
    }

    for (const item of missingFiles) {
      try {
        await scrapDownload(item, storageDir)

        console.log(`Downloaded: ${item.fileName}`)
      } catch (err) {
        fails += 1

        console.error(`Failed to download: ${item.fileName}. Reason: ${err.message}`)

        break
      }
    }
  }

  const { missingFiles } = verifyDownloads(await getDownloadedFileNames(params), searchResults)

  let msg = ''

  if (missingFiles.length > 0) {
    msg = `Failed to download ${missingFiles.length} items after multiple attempts. Missing files: ${missingFiles
      .map((f) => f.fileName)
      .join(', ')}`

    console.warn(msg)
  } else {
    msg = 'All items downloaded successfully.'

    await removeQuery(params)

    console.log(msg)
  }

  const result = {
    totalItems: searchResults.length,
    downloadedItems: searchResults.length - missingFiles.length,
    missingItems: missingFiles.length,
    message: msg,
  }

  return result
}

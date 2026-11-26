import { promises as fs } from 'fs'
import path from 'path'
import { PDFContext, PDFDocument, PDFHexString, PDFName, PDFObjectCopier } from 'pdf-lib'
import { readResults } from './files.js'
import { error, log } from './log.js'

const QUARTERS = ['янв–март', 'апр–июнь', 'июль–сент', 'окт–дек']
const MONTHS = {
  янв: 0,
  фев: 1,
  мар: 2,
  апр: 3,
  мая: 4,
  май: 4,
  июн: 5,
  июл: 6,
  авг: 7,
  сен: 8,
  окт: 9,
  ноя: 10,
  дек: 11,
}

/**
 * Bind the issues in inDir/<folder>_<year>/ (year in years) into one PDF per quarter, outDir/<folder>/<title> <year>, <quarter>.pdf,
 * with a bookmark per issue. The folder's .results.json says which issues exist; a quarter is bound only once all of its issues
 * (those with an electronic copy) are there. Tomes that already exist are skipped.
 *
 * @returns {Promise<{ bound: number, waiting: number, failed: number }>}
 */
export async function runBind({ inDir, outDir, years }) {
  const counts = { bound: 0, waiting: 0, failed: 0 }

  for (const dir of await fs.readdir(inDir, { withFileTypes: true })) {
    const year = Number(dir.name.match(/_(\d{4})$/)?.[1])
    if (!dir.isDirectory() || !years.includes(year)) continue

    const folderCounts = await bindFolder({ inDir, outDir, folder: dir.name })
    for (const key in counts) counts[key] += folderCounts[key]
  }

  log(`Binding done: ${counts.bound} tome(s)` + (counts.waiting ? `, ${counts.waiting} waiting for issues` : ''))
  return counts
}

/**
 * Bind the quarters of one folder, inDir/<folder>_<year>/ → outDir/<folder>/ (see runBind).
 *
 * @returns {Promise<{ bound: number, waiting: number, failed: number }>}
 */
export async function bindFolder({ inDir, outDir, folder }) {
  const counts = { bound: 0, waiting: 0, failed: 0 }
  const year = Number(folder.match(/_(\d{4})$/)[1])

  const results = await readResults(path.join(inDir, folder))
  if (!results) {
    error(`[${folder}] No .results.json, can't tell which issues belong to it. Skipped.`)
    counts.failed++
    return counts
  }

  const issues = results.items
    .filter((item) => item.vivaldiId)
    .map((item) => ({ ...item, date: issueDate(item.fileName) }))
  const undated = issues.filter((issue) => !issue.date)
  if (undated.length) {
    error(`[${folder}] No date in the name of: ${undated.map((issue) => issue.fileName).join('; ')}. Skipped.`)
    counts.failed++
    return counts
  }

  issues.sort((a, b) => byDate(a.date, b.date))

  for (const [quarter, name] of QUARTERS.entries()) {
    const tome = issues.filter((issue) => Math.floor(issue.date.month / 3) === quarter)
    if (!tome.length) continue

    const title = paperTitle(tome[0].fileName) ?? folder
    const out = path.join(outDir, folder, `${title} ${year}, ${name}.pdf`)
    if (await exists(out)) continue

    const files = tome.map((issue) => path.join(inDir, folder, `${issue.fileName}.pdf`))
    const missing = (await Promise.all(files.map(exists))).filter((found) => !found).length
    if (missing) {
      log(`[${folder}] ${name}: ${missing} of ${tome.length} issues not there yet`)
      counts.waiting++
      continue
    }

    try {
      const started = Date.now()
      const parts = tome.map((issue, i) => ({ file: files[i], title: bookmarkTitle(issue.fileName) }))
      const pages = await bindPdfs(parts, out)
      counts.bound++
      const minutes = ((Date.now() - started) / 60_000).toFixed(1)
      log(`[${folder}] ${tome.length} issues, ${pages} p. in ${minutes} min  ${path.basename(out)}`)
    } catch (err) {
      error(`[${folder}] Not bound: ${path.basename(out)}: ${err.message}. Re-run to try again.`)
      counts.failed++
    }
  }

  return counts
}

// "<title> Прил к 1918, № 64 (…)": a supplement to issue 64
const SUPPLEMENT = /\s*Прил\.? к\s*(?=\d{4},)/

/** The part of an issue's name after "<title> <year>,": "№ 1 (1 янв)", "экстр вып (5 (18) февр)", "Прил. к № 64 (…)". */
const bookmarkTitle = (fileName) =>
  (SUPPLEMENT.test(fileName) ? 'Прил. к ' : '') + fileName.replace(/^.*?\d{4},\s*/, '')

/** The newspaper's name: the part of an issue's name before the year (and a supplement's "Прил к"). */
const paperTitle = (fileName) => fileName.replace(SUPPLEMENT, ' ').match(/^(.*?)\s*\d{4},/)?.[1]

/**
 * Month (0-11), day, number (0 for special editions) and whether it's a supplement, from an issue's name. The date is the first
 * one in the brackets: "№ 1 (1 янв)", "№ 100 (8 (21) мая)" (old style, new style), "№ 110 (19 мая (1 июня))", "№ 127(3 июня)",
 * "№ 246 (19 окт", "экстр вып (5 (18) февр)".
 */
export function issueDate(fileName) {
  const issue = fileName.replace(/^.*?\d{4},\s*/, '')
  const match = issue.match(/\(\s*(\d{1,2})[\s()\d]*([а-яё]{3})/i)
  const month = MONTHS[match?.[2].toLowerCase()]
  if (month === undefined) return null
  const number = Number(issue.match(/^№\s*(\d+)/)?.[1] ?? 0)
  return { month, day: Number(match[1]), number, supplement: SUPPLEMENT.test(fileName) }
}

/** By date, then number; a supplement right after its issue. */
const byDate = (a, b) =>
  a.month - b.month || a.day - b.day || a.number - b.number || Number(a.supplement) - Number(b.supplement)

/**
 * Concatenate the PDFs into outFile, one bookmark per part (on its first page). Written as a stream: each part's objects go to
 * the file as soon as its pages are copied, so memory holds one part at a time however big the result gets. The objects are
 * copied as they are (only renumbered), so images and text stay byte for byte the same.
 *
 * @param {{ file: string, title: string }[]} parts
 * @returns {Promise<number>} pages written
 */
export async function bindPdfs(parts, outFile) {
  const out = PDFContext.create()
  const pagesRef = out.nextRef() // the page tree is written last, when all pages are known
  const kids = []
  const bookmarks = []
  const offsets = [] // byte offset of each object, by object number
  let position = 0

  const partial = path.join(path.dirname(outFile), `.${path.basename(outFile)}.tmp`)
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  const handle = await fs.open(partial, 'w')

  const write = async (buffer) => {
    await handle.write(buffer)
    position += buffer.length
  }

  /** Write every object now in `out` and drop it from memory. */
  const flush = async () => {
    const buffers = []
    let offset = position
    for (const [ref, object] of out.enumerateIndirectObjects()) {
      const head = `${ref.objectNumber} 0 obj\n`
      const size = object.sizeInBytes()
      const buffer = Buffer.alloc(head.length + size + 9)
      buffer.write(head, 'latin1')
      if (object.copyBytesInto(buffer, head.length) !== size)
        throw new Error(`Object ${ref.objectNumber} changed size while written`)
      buffer.write('\nendobj\n\n', head.length + size, 'latin1')

      offsets[ref.objectNumber] = offset
      offset += buffer.length
      buffers.push(buffer)
      out.delete(ref)
    }
    await write(Buffer.concat(buffers))
  }

  try {
    await write(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'))

    for (const part of parts) {
      const src = await PDFDocument.load(await fs.readFile(part.file), { updateMetadata: false })
      const pages = src.getPages()
      if (!pages.length) throw new Error(`${path.basename(part.file)} has no pages`)

      const copier = PDFObjectCopier.for(src.context, out)
      bookmarks.push({ title: part.title, page: kids.length })
      for (const page of pages) {
        const copy = copier.copy(page.node)
        copy.set(PDFName.of('Parent'), pagesRef)
        kids.push(out.register(copy))
      }
      await flush()
    }

    const outlinesRef = out.nextRef()
    const itemRefs = bookmarks.map(() => out.nextRef())
    bookmarks.forEach(({ title, page }, i) => {
      const item = { Title: PDFHexString.fromText(title), Parent: outlinesRef, Dest: [kids[page], 'Fit'] }
      if (i > 0) item.Prev = itemRefs[i - 1]
      if (i < itemRefs.length - 1) item.Next = itemRefs[i + 1]
      out.assign(itemRefs[i], out.obj(item))
    })
    out.assign(
      outlinesRef,
      out.obj({ Type: 'Outlines', First: itemRefs[0], Last: itemRefs.at(-1), Count: itemRefs.length }),
    )
    out.assign(pagesRef, out.obj({ Type: 'Pages', Kids: kids, Count: kids.length }))
    const rootRef = out.register(
      out.obj({ Type: 'Catalog', Pages: pagesRef, Outlines: outlinesRef, PageMode: 'UseOutlines' }),
    )
    await flush()

    const size = out.largestObjectNumber + 1
    const entries = Array.from({ length: size }, (_, n) =>
      offsets[n] === undefined ? '0000000000 65535 f \n' : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`,
    )
    const xref = position
    await write(
      Buffer.from(
        `xref\n0 ${size}\n${entries.join('')}trailer\n<< /Size ${size} /Root ${rootRef.objectNumber} 0 R >>\n` +
          `startxref\n${xref}\n%%EOF\n`,
        'latin1',
      ),
    )
  } catch (err) {
    await handle.close()
    await fs.rm(partial, { force: true })
    throw err
  }

  await handle.close()
  await fs.rename(partial, outFile)
  return kids.length
}

const exists = async (file) => !!(await fs.stat(file).catch(() => null))

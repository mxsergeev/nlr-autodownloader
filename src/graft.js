import jpeg from 'jpeg-js'
import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFName,
  PDFObjectCopier,
  PDFRawStream,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

// A sign is only trusted if the ink inside FineReader's text boxes differs by at least this much between the two directions
const MIN_SIGN_MARGIN = 0.03
const MIN_ANGLE = 0.0001 // radians (0.006°); below this the rotation is too small to matter
const MAX_ANGLE = (3 * Math.PI) / 180
const MAX_UNROTATED_OFFSET = 2 // points; a line of text is 8–10

/** Split a PDF into PDFs of pagesPerChunk pages. Pages are copied as they are: image streams keep their bytes. */
export async function splitPdf(bytes, pagesPerChunk) {
  const source = await PDFDocument.load(bytes, { updateMetadata: false })
  const indices = source.getPageIndices()
  const chunks = []

  for (let start = 0; start < indices.length; start += pagesPerChunk) {
    const chunk = await PDFDocument.create({ updateMetadata: false })
    const pages = await chunk.copyPages(source, indices.slice(start, start + pagesPerChunk))
    for (const page of pages) chunk.addPage(page)
    chunks.push(await chunk.save())
  }

  return chunks
}

/**
 * Put FineReader's invisible text onto the original pages; the original page content (scan images, NLR's own text) stays as is.
 *
 * ocrChunks are FineReader's output for splitPdf(original) in order. FineReader deskews before recognizing, so its text sits on
 * the straightened page: its page is the bounding box of the original rotated by the deskew angle. The angle comes from the two
 * page sizes, its direction from the original scan (see deskewSign), and the text is rotated back onto the original page.
 * If the direction can't be determined the text goes on unrotated, which leaves it a few points off (aligned: false) or, for a
 * tiny tilt, less than MAX_UNROTATED_OFFSET (aligned: true).
 * A page printed sideways is also turned upright by FineReader (CorrectOrientation); see turnedAngle.
 *
 * @returns {Promise<{ bytes: Uint8Array, pages: { angle: number, aligned: boolean }[] }>} angle in degrees
 */
export async function graftOcrText(originalBytes, ocrChunks) {
  const doc = await PDFDocument.load(originalBytes, { updateMetadata: false })
  const pages = doc.getPages()
  const result = []
  let index = 0

  for (const chunkBytes of ocrChunks) {
    const ocr = await PDFDocument.load(chunkBytes, { updateMetadata: false })
    const textBoxes = await readTextBoxes(chunkBytes)

    for (const [i, ocrPage] of ocr.getPages().entries()) {
      const page = pages[index++]
      if (!page) throw new Error(`FineReader returned more pages than the original has (${pages.length})`)
      if (page.getRotation().angle || ocrPage.getRotation().angle) throw new Error(`Page ${index} is rotated`)

      const box = page.getMediaBox()
      const ocrBox = ocrPage.getMediaBox()
      let angle
      let aligned = true

      if (isTurned(box, ocrBox)) ({ angle, aligned } = turnedAngle(page, ocrBox, textBoxes[i], index))
      else {
        angle = deskewAngle(box, ocrBox, index)
        if (angle >= MIN_ANGLE) {
          const sign = deskewSign(page, angle, ocrBox, textBoxes[i])
          // Too small a tilt to measure is also too small to matter: unrotated, the text's corners land this close
          // and without any (horizontal) text there's nothing to be off
          aligned =
            sign !== 0 ||
            (angle * Math.hypot(box.width, box.height)) / 2 < MAX_UNROTATED_OFFSET ||
            textBoxes[i].length === 0
          angle *= sign
        } else angle = 0
      }

      const form = textForm(doc, ocrPage)

      // original = R(angle) * (ocr - ocr centre) + original centre
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const [cx, cy] = centre(box)
      const [ox, oy] = centre(ocrBox)
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(cos, sin, -sin, cos, cx - (cos * ox - sin * oy), cy - (sin * ox + cos * oy)),
        drawObject(page.node.newXObject('OCR', form)),
        popGraphicsState(),
      )

      result.push({ angle: (angle * 180) / Math.PI, aligned })
    }
  }

  if (index !== pages.length) throw new Error(`FineReader returned ${index} pages, the original has ${pages.length}`)

  return { bytes: await doc.save(), pages: result }
}

const centre = (box) => [box.x + box.width / 2, box.y + box.height / 2]

/**
 * FineReader's page as a form XObject in doc, in its own page coordinates, with all its images blanked. Built here rather than
 * with doc.embedPage, which copies the whole page first and leaves that copy in the file (the text a second time).
 */
function textForm(doc, ocrPage) {
  const { context } = ocrPage.doc
  const resources = ocrPage.node.Resources()
  blankImages(resources)

  const contents = ocrPage.node.Contents()
  const streams =
    contents instanceof PDFArray ? contents.asArray().map((ref) => context.lookup(ref)) : contents ? [contents] : []
  const text = streams
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()))
    .flatMap((b) => [b, Buffer.from('\n')])

  const { x, y, width, height } = ocrPage.getMediaBox()
  const form = doc.context.flateStream(Buffer.concat(text), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [x, y, x + width, y + height],
    Resources: resources ? PDFObjectCopier.for(context, doc.context).copy(resources) : {},
  })
  return doc.context.register(form)
}

/**
 * Size of the deskew rotation (radians, ≥ 0) from the page sizes: rotating a W×H page by θ gives a bounding box of
 * (W cosθ + H sinθ) × (W sinθ + H cosθ). Throws if FineReader's page can't be the original page rotated.
 */
function deskewAngle(box, ocrBox, pageNumber) {
  const { width: W, height: H } = box
  const det = W * W - H * H
  const cos = (W * ocrBox.width - H * ocrBox.height) / det
  const sin = (W * ocrBox.height - H * ocrBox.width) / det
  const angle = Math.atan2(sin, cos)

  if (Math.abs(cos * cos + sin * sin - 1) > 0.002 || angle < -MIN_ANGLE || angle > MAX_ANGLE) {
    throw new Error(
      `Page ${pageNumber}: FineReader's page (${ocrBox.width.toFixed(1)}×${ocrBox.height.toFixed(1)}) ` +
        `doesn't match the original (${W.toFixed(1)}×${H.toFixed(1)})`,
    )
  }

  return Math.max(0, angle)
}

/**
 * Direction of the deskew rotation: 1, -1, or 0 if unclear. FineReader's text boxes are straight on the deskewed page; turned
 * back the right way they land on the ink of the original scan, the wrong way they slide off it. The unrotated boxes have to
 * score below the best, otherwise the measurement isn't about the tilt. They may score as low as the wrong way: once the boxes
 * are off the text lines, by θ or by 2θ, they only catch stray ink.
 */
function deskewSign(page, angle, ocrBox, boxes) {
  const scan = pageScan(page)
  if (!scan || boxes.length === 0) return 0

  const [plus, minus, none] = [angle, -angle, 0].map((a) => inkInBoxes(scan, page.getMediaBox(), ocrBox, boxes, a))
  const best = Math.max(plus, minus)
  const worst = Math.min(plus, minus)

  if (best < worst * (1 + MIN_SIGN_MARGIN) || none >= best) return 0
  return plus > minus ? 1 : -1
}

/** FineReader turned the page a quarter: one of the two pages is portrait, the other landscape. */
const isTurned = (box, ocrBox) => (box.width - box.height) * (ocrBox.width - ocrBox.height) < 0

/**
 * Rotation from FineReader's page back onto a page it turned upright: a quarter turn either way plus the deskew, either way.
 * The candidate whose text boxes land on the most ink wins; it is aligned if it clearly beats all the others.
 */
function turnedAngle(page, ocrBox, boxes, pageNumber) {
  // Turning the original a quarter swaps its sides, so with FineReader's page swapped back what's left is the deskew
  const deskew = deskewAngle(page.getMediaBox(), { width: ocrBox.height, height: ocrBox.width }, pageNumber)
  const scan = pageScan(page)
  if (!scan || boxes.length === 0) throw new Error(`Page ${pageNumber}: can't tell which way FineReader turned it`)

  const candidates = [Math.PI / 2, -Math.PI / 2]
    .flatMap((quarter) => (deskew >= MIN_ANGLE ? [quarter + deskew, quarter - deskew] : [quarter]))
    .map((angle) => ({ angle, ink: inkInBoxes(scan, page.getMediaBox(), ocrBox, boxes, angle) }))
    .sort((a, b) => b.ink - a.ink)

  return { angle: candidates[0].angle, aligned: candidates[0].ink >= candidates[1].ink * (1 + MIN_SIGN_MARGIN) }
}

/** Mean darkness (0–255) of the original scan inside the text boxes, mapped from FineReader's page rotated by angle. */
function inkInBoxes(scan, box, ocrBox, boxes, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const [cx, cy] = centre(box)
  const [ox, oy] = centre(ocrBox)
  const sx = scan.width / box.width
  const sy = scan.height / box.height
  const clampX = (v) => Math.min(scan.width, Math.max(0, Math.round(v)))
  const clampY = (v) => Math.min(scan.height, Math.max(0, Math.round(v)))
  const quarterTurn = Math.abs(sin) > Math.SQRT1_2 // a text box turned a quarter stands upright on the original
  let ink = 0
  let area = 0

  for (const b of boxes) {
    const dx = b.x + b.width / 2 - ox
    const dy = b.y + b.height / 2 - oy
    const x = cos * dx - sin * dy + cx - box.x
    const top = box.y + box.height - (sin * dx + cos * dy + cy) // distance from the top edge, as the image rows go
    const [width, height] = quarterTurn ? [b.height, b.width] : [b.width, b.height]

    const x0 = clampX((x - width / 2) * sx)
    const x1 = clampX((x + width / 2) * sx)
    const y0 = clampY((top - height / 2) * sy)
    const y1 = clampY((top + height / 2) * sy)

    for (let row = y0; row < y1; row++) {
      for (let col = x0, i = row * scan.width + x0; col < x1; col++, i++) ink += 255 - scan.pixels[i]
    }
    area += (x1 - x0) * (y1 - y0)
  }

  return area ? ink / area : 0
}

/**
 * The page's scan as grey pixels, halved in size: the largest JPEG image on the page, if it covers the page (NLR's scans do).
 * Returns null for anything else.
 */
function pageScan(page) {
  let largest = null

  const visit = (resources) => {
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const ref of xObjects?.values() ?? []) {
      const object = page.doc.context.lookup(ref)
      if (!(object instanceof PDFRawStream)) continue

      const subtype = object.dict.get(PDFName.of('Subtype'))
      if (subtype === PDFName.of('Form')) visit(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict))
      else if (subtype === PDFName.of('Image') && object.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
        if (!largest || object.contents.length > largest.contents.length) largest = object
      }
    }
  }
  visit(page.node.Resources())
  if (!largest) return null

  const image = jpeg.decode(largest.contents, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 2048 })
  const { width: W, height: H } = page.getMediaBox()
  if (Math.abs(image.width / image.height - W / H) > 0.01 * (W / H)) return null

  const channels = image.data.length / (image.width * image.height)
  const width = Math.floor(image.width / 2)
  const height = Math.floor(image.height / 2)
  const pixels = new Uint8Array(width * height)
  const at = (x, y) => image.data[(y * image.width + x) * channels] // first channel is enough for a grey scan

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] =
        (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) >> 2
    }
  }

  return { width, height, pixels }
}

/** Text runs of every page as boxes in page space ({ x, y } = bottom left); only horizontal ones. */
async function readTextBoxes(bytes) {
  const loading = getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false })
  const pdf = await loading.promise
  const pages = []

  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const { items } = await (await pdf.getPage(n)).getTextContent()
      pages.push(
        items
          .filter((item) => item.str.trim() && item.width > 0 && item.height > 0)
          .filter(({ transform: [a, b, c, d] }) => a > 0 && d > 0 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6)
          // x-height band of the run (the item box is the whole font height): this is where the ink is, so the sharpest signal
          .map(({ transform, width, height }) => ({
            x: transform[4],
            y: transform[5] + 0.1 * height,
            width,
            height: 0.4 * height,
          })),
      )
    }
  } finally {
    await loading.destroy()
  }

  return pages
}

/** Replace every image (also inside forms) with an empty form, so only the text of FineReader's page is left. */
function blankImages(resources) {
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xObjects) return

  const context = xObjects.context
  for (const [name, ref] of xObjects.entries()) {
    const object = context.lookup(ref)
    const subtype = object?.dict?.get(PDFName.of('Subtype'))

    if (subtype === PDFName.of('Image'))
      xObjects.set(name, context.register(context.formXObject([], { BBox: [0, 0, 0, 0] })))
    else if (subtype === PDFName.of('Form')) blankImages(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict))
  }
}

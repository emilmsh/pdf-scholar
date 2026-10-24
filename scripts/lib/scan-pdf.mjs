// A SCANNED copy of a PDF's pages: each page rendered to a grey raster and put
// back into a new PDF as nothing but an image — no text object anywhere, so
// pdf.js finds no words and the app's OCR is the only way to read it. Built
// the way scripts/test-ocr.mjs builds its fixtures (one page there; several
// here), for the README's search_scan frame: the house paper photographed as
// a scanner would hand it back, so the frame shows the OCR search on a page
// that looks like a scan rather than on a page that merely has no text layer.
//
// `skewDeg` leans every page a hair, the way a sheet fed by hand comes out:
// without it the raster is pixel-straight and reads as a rendered page.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
const STANDARD_FONTS = pathToFileURL(join(require.resolve('pdfjs-dist/package.json'), '../standard_fonts/')).href
const { createCanvas } = require('@napi-rs/canvas')

/** A PDF of the given objects (1-based, object 1 the catalog) */
function pdfOf(objs) {
  const chunks = [Buffer.from('%PDF-1.7\n', 'latin1')]
  const offsets = []
  let size = chunks[0].length
  for (let i = 0; i < objs.length; i++) {
    offsets.push(size)
    const o = objs[i]
    const part =
      typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
        : Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'),
            o.stream,
            Buffer.from('\nendstream\nendobj\n', 'latin1')
          ])
    chunks.push(part)
    size += part.length
  }
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`
  chunks.push(Buffer.from(tail, 'latin1'))
  return Buffer.concat(chunks)
}

/**
 * @param {Uint8Array} bytes      the source PDF
 * @param {number[]}   pages      1-based page numbers to scan, in order
 * @param {{dpi?: number, skewDeg?: number}} [opts]
 * @returns {Promise<Buffer>}     the image-only PDF
 */
export async function scanPdf(bytes, pages, { dpi = 220, skewDeg = 0.35 } = {}) {
  // pdf.js refuses a Node Buffer and transfers the array it gets — a fresh copy
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS, verbosity: 0 }).promise
  const images = []
  for (const n of pages) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: dpi / 72 })
    const w = Math.ceil(viewport.width)
    const h = Math.ceil(viewport.height)
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    // The lean: rotate about the centre, paper stays white around the edges
    ctx.translate(w / 2, h / 2)
    ctx.rotate((skewDeg * Math.PI) / 180)
    ctx.translate(-w / 2, -h / 2)
    await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise
    const { data } = ctx.getImageData(0, 0, w, h)
    const grey = Buffer.alloc(w * h)
    for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
    images.push({ w, h, wPt: page.view[2] - page.view[0], hPt: page.view[3] - page.view[1], grey: deflateSync(grey) })
  }
  await doc.loadingTask.destroy()

  // Objects: 1 catalog, 2 pages, then per page: page, content, image
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null]
  const kids = []
  for (const img of images) {
    const pageNum = objs.length + 1
    kids.push(`${pageNum} 0 R`)
    const content = `q ${img.wPt} 0 0 ${img.hPt} 0 0 cm /Im1 Do Q`
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.wPt} ${img.hPt}] /Contents ${pageNum + 1} 0 R /Resources << /XObject << /Im1 ${pageNum + 2} 0 R >> >> >>`,
      { dict: `<< /Length ${content.length} >>`, stream: Buffer.from(content, 'latin1') },
      {
        dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.grey.length} >>`,
        stream: img.grey
      }
    )
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  return pdfOf(objs)
}

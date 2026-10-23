// Proof for text on scanned pages (src/renderer/src/ocr-text.ts, the engine
// in ocr.ts / ocr.worker.ts): a page whose PDF carries no text is read by
// Tesseract on this machine, and its words come back in the shape pdf.js
// gives a page's own text — so the text layer, search, selection, highlights
// and the assistant read it with no OCR branch of their own.
//
//   1. The pure half against hand-written TSV: words below the confidence
//      floor and blank ones are dropped (and a line left empty with them),
//      each word is one item WITH its trailing space so the page text reads
//      «one two» and a phrase search crosses items, a word's item reaches to
//      the next word (one unbroken selection band), the last word of a line
//      ends it, a blank line between paragraphs, no trailing break; the
//      raster→PDF mapping is applied (scale, y flip, a rotated raster);
//      the OCR scale caps at an A4's pixels; the language choice per UI.
//   2. The REAL engine — the exact wasm and models the app ships, through the
//      same calls ocr.worker.ts makes — against true scanned pages built here:
//      a text page rendered by pdf.js and put back into a PDF as nothing but
//      an image. pdf.js finds no text on it (the case this is for), OCR finds
//      the words the original page had, at the places it had them; a two-
//      column page reads down the left column first; a page scanned sideways
//      and righted by /Rotate 90 maps its words back through the rotation.
//
// Run: node scripts/test-ocr.mjs
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { deflateSync, gunzipSync } from 'node:zlib'
import { pathToFileURL, fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SRC = fileURLToPath(new URL('../src/renderer/src/ocr-text.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ocr-'))
const out = join(dir, 'ocr-text.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, platform: 'neutral', logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
/** search.ts's buildPageText rule, for the page text a content yields */
const pageText = (content) => {
  let text = ''
  for (const item of content.items) {
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  return text
}
const tsvRow = (level, block, par, line, word, left, top, width, height, conf, text = '') =>
  [level, 1, block, par, line, word, left, top, width, height, conf, text].join('\t')

// ---------- 1. The pure half ----------

{
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    tsvRow(1, 0, 0, 0, 0, 0, 0, 1000, 1000, -1),
    tsvRow(2, 1, 0, 0, 0, 100, 100, 600, 200, -1),
    tsvRow(3, 1, 1, 0, 0, 100, 100, 600, 100, -1),
    tsvRow(4, 1, 1, 1, 0, 100, 100, 500, 40, -1),
    tsvRow(5, 1, 1, 1, 1, 100, 102, 120, 36, 96, 'The'),
    tsvRow(5, 1, 1, 1, 2, 240, 100, 160, 40, 91, 'tree'),
    tsvRow(5, 1, 1, 1, 3, 420, 104, 180, 36, 12, '|||'),
    tsvRow(4, 1, 1, 2, 0, 100, 150, 300, 40, -1),
    // A real word Tesseract scores 0 (it does, at the start of a line)
    tsvRow(5, 1, 1, 2, 1, 100, 150, 300, 40, 0, 'grows'),
    // A line of nothing but noise goes, and the paragraph with it
    tsvRow(3, 1, 2, 0, 0, 100, 300, 300, 40, -1),
    tsvRow(4, 1, 2, 1, 0, 100, 300, 300, 40, -1),
    tsvRow(5, 1, 2, 1, 1, 100, 300, 300, 40, 5, '~~'),
    tsvRow(5, 1, 2, 1, 2, 100, 300, 300, 40, 90, '   '),
    tsvRow(3, 2, 1, 0, 0, 100, 500, 300, 40, -1),
    tsvRow(4, 2, 1, 1, 0, 100, 500, 300, 40, -1),
    tsvRow(5, 2, 1, 1, 1, 100, 500, 140, 40, 77, 'Second'),
    tsvRow(5, 2, 1, 1, 2, 260, 500, 140, 40, 80, 'block'),
    ''
  ].join('\n')
  const pars = M.parseTsv(tsv)
  check('paragraphs by block and paragraph number; an all-noise one is gone', pars.length === 2, JSON.stringify(pars.map((p) => p.lines.length)))
  check('symbols alone at low confidence are dropped', pars[0].lines[0].words.map((w) => w.text).join() === 'The,tree')
  check('a word with letters is kept at any confidence, 0 too', pars[0].lines[1]?.words[0]?.text === 'grows')
  check('a blank word is dropped', !pars.flatMap((p) => p.lines).flatMap((l) => l.words).some((w) => w.text.trim() === ''))
  check('a line keeps its own box (words lie on it)', pars[0].lines[0].top === 100 && pars[0].lines[0].height === 40)

  // Raster px at 2× the page, y down → PDF points, y up, on a 500 pt page
  const toPdf = (x, y) => [x / 2, 500 - y / 2]
  const content = M.toTextContent(pars, toPdf)
  const text = pageText(content)
  check('the page text reads word, space, word; lines and paragraphs break', text === 'The tree\ngrows\n\nSecond block\n', JSON.stringify(text))
  const items = content.items
  check('one item per word, the trailing space inside it', items[0].str === 'The ' && items[1].str === 'tree')
  check('the last word on a line ends the line', items[1].hasEOL && !items[0].hasEOL && items[2].hasEOL)
  check('a paragraph ends with an empty item ending one more line', items[3].str === '' && items[3].hasEOL)
  check('no break after the last paragraph', items[items.length - 1].str === 'block' && items.length === 6)
  check('a word reaches to the next word (one selection band)', items[0].width === (240 - 100) / 2, String(items[0].width))
  // Two labels of a diagram on one line, a gutter apart: the first must not
  // stretch across the gutter (its highlight would mark empty paper)
  const far = M.toTextContent([{ lines: [{ left: 100, top: 0, width: 600, height: 40, words: [
    { text: 'Left', left: 100, top: 0, width: 60, height: 40, conf: 90 },
    { text: 'Right', left: 600, top: 0, width: 100, height: 40, conf: 90 }
  ] }] }], toPdf)
  check('…but never further than a word space', far.items[0].width === (60 + 0.6 * 40) / 2, String(far.items[0].width))
  check('the last word is its own width', items[1].width === 160 / 2, String(items[1].width))
  check('every word on a line shares its height', items[0].height === 20 && items[1].height === 20)
  const [a, b, c, d, e, f] = items[0].transform
  check('upright text: a plain scale matrix the size of the line', a === 20 && b === 0 && c === 0 && d === 20, JSON.stringify(items[0].transform))
  check('the baseline sits 0.8 of the line down, mapped into PDF space', e === 50 && Math.abs(f - (500 - (100 + 0.8 * 40) / 2)) < 1e-9, `${e},${f}`)
  check('a style for the font name the items carry', content.styles[M.OCR_FONT]?.fontFamily === 'sans-serif' && content.styles[M.OCR_FONT].vertical === false)
  check('hasVisibleText: OCR content has text', M.hasVisibleText(content))

  // The same raster, but the page is /Rotate 90: raster x runs along PDF +y
  const rotated = M.toTextContent(pars, (x, y) => [y / 2, x / 2])
  const [ra, rb, rc, rd] = rotated.items[0].transform
  check('a rotated raster gives text running along the page\'s y axis', Math.abs(ra) < 1e-9 && rb === 20 && rc === -20 && Math.abs(rd) < 1e-9, JSON.stringify(rotated.items[0].transform))
  check('…with the same width in PDF units', rotated.items[0].width === items[0].width)
}
{
  check('nothing at all: an empty content', M.toTextContent([], (x, y) => [x, y]).items.length === 0)
  check('whitespace and zero-width characters are not text', !M.hasVisibleText({ items: [{ str: ' \n' }, { str: '​­' }] }))
  check('…a real character is', M.hasVisibleText({ items: [{ str: ' ' }, { str: 'a' }] }))
  check('a marked-content item (no str) is not text', !M.hasVisibleText({ items: [{ type: 'beginMarkedContent' }] }))
  const a4 = M.ocrScale(595, 842)
  check('an A4 page is read at 300 dpi', Math.abs(a4 - 300 / 72) < 1e-9)
  check('a larger page is capped at OCR_MAX_SIDE', Math.abs(M.ocrScale(2384, 3370) * 3370 - M.OCR_MAX_SIDE) < 1e-6)
  check('a Norwegian interface reads with the Norwegian model first', M.ocrLanguages('nb').join() === 'nor,eng')
  check('English first otherwise, Norwegian beside it', M.ocrLanguages('en').join() === 'eng,nor')
  check('a Chinese interface reads simplified Chinese and English', M.ocrLanguages('zh').join() === 'chi_sim,eng')
  const pgm = M.toPgm(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)
  const header = 'P5\n2 1\n255\n'
  check('PGM: header, then one grey byte per pixel', new TextDecoder().decode(pgm.slice(0, header.length)) === header && pgm[header.length] === 255 && pgm[header.length + 1] === 0)
}

// ---------- 1b. What is kept between sessions (ocr-store.ts, pure half) ----------

{
  const storeOut = join(dir, 'ocr-store.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/ocr-store.ts', import.meta.url))],
    outfile: storeOut, format: 'esm', bundle: true, platform: 'neutral', logLevel: 'silent'
  })
  const St = await import(pathToFileURL(storeOut).href)
  check('a document is known by its fingerprint AND the models it was read with',
    St.ocrDocKey('abc', ['nor', 'eng']) === 'abc|nor+eng' && St.ocrDocKey('abc', ['nor', 'eng']) !== St.ocrDocKey('abc', ['chi_sim', 'eng']))
  const rec = { view: [0, 0, 432, 669], rotate: 0 }
  check('a stored page matches the same box and rotation', St.storedPageMatches(rec, [0, 0, 432.04, 669], 0))
  check('…not another size', !St.storedPageMatches(rec, [0, 0, 612, 792], 0))
  check('…not another rotation', !St.storedPageMatches(rec, [0, 0, 432, 669], 90))
  const docs = [
    { docKey: 'a', numPages: 3, used: 30 },
    { docKey: 'b', numPages: 3, used: 10 },
    { docKey: 'c', numPages: 3, used: 20 },
    { docKey: 'd', numPages: 3, used: 10 }
  ]
  check('nothing goes while under the cap', St.docsToEvict(docs, 4).length === 0)
  check('the least recently used go first, a tie broken by key', St.docsToEvict(docs, 2).join() === 'b,d', St.docsToEvict(docs, 2).join())
  check('the cap is a real number', St.OCR_STORE_MAX_DOCS >= 50)
}

// ---------- 2. The real engine on real scanned pages ----------

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
const STANDARD_FONTS = pathToFileURL(join(require.resolve('pdfjs-dist/package.json'), '../standard_fonts/')).href
const { createCanvas } = require('@napi-rs/canvas')
// pdf.js transfers the buffer to its worker — always hand it a copy
const open = (data) => pdfjs.getDocument({ data: data.slice(), standardFontDataUrl: STANDARD_FONTS, verbosity: 0 }).promise

/** A PDF of the given objects (1-based, object 1 the catalog) */
function pdfOf(objs) {
  let body = '%PDF-1.7\n'
  const chunks = []
  const offsets = []
  for (let i = 0; i < objs.length; i++) {
    offsets.push(body.length + chunks.reduce((n, c) => n + c.length, 0))
    const o = objs[i]
    const part = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1') : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    chunks.push(part)
  }
  const head = Buffer.from(body, 'latin1')
  const bodyBuf = Buffer.concat([head, ...chunks])
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${bodyBuf.length}\n%%EOF\n`
  return new Uint8Array(Buffer.concat([bodyBuf, Buffer.from(tail, 'latin1')]))
}

/** A text page: Helvetica lines at the given points */
function textPdf(lines, w = 595, h = 842) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c)
  const content = lines.map(([x, y, size, s]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n')
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    { dict: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, stream: Buffer.from(content, 'latin1') },
    // WinAnsi, or æ, ø and å are not in the font's encoding and draw as nothing
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ])
}

/** A page drawn at `scale` into an RGBA raster, white paper, no annotations */
async function raster(page, scale, rotation) {
  const viewport = page.getViewport(rotation === undefined ? { scale } : { scale, rotation })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { rgba: img.data, width: img.width, height: img.height, viewport }
}

/** The scan of a text page: the page rendered at 300 dpi and put into a new
 *  PDF as one grey image filling the page — no text object anywhere. With
 *  `sideways`, the image is laid on its side in a landscape MediaBox and the
 *  page carries /Rotate 90 to stand it up again, as a scanner that fed the
 *  sheet sideways leaves it. */
async function scanOf(textBytes, { sideways = false } = {}) {
  const doc = await open(textBytes)
  const page = await doc.getPage(1)
  const { rgba, width, height } = await raster(page, 300 / 72)
  const grey = Buffer.alloc(width * height)
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
  const [wPt, hPt] = [page.view[2], page.view[3]]
  await doc.loadingTask.destroy()
  const image = deflateSync(grey)
  // Upright: the image fills the page. Sideways: image x runs up the
  // landscape page's y axis, image y down its x axis — /Rotate 90 turns it
  // back on screen.
  const cm = sideways ? `0 ${wPt} ${-hPt} 0 ${hPt} 0 cm` : `${wPt} 0 0 ${hPt} 0 0 cm`
  const content = `q ${cm} /Im1 Do Q`
  const box = sideways ? `[0 0 ${hPt} ${wPt}] /Rotate 90` : `[0 0 ${wPt} ${hPt}]`
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
    { dict: `<< /Length ${content.length} >>`, stream: Buffer.from(content, 'latin1') },
    {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>`,
      stream: image
    }
  ])
}

// The engine, exactly as ocr.worker.ts starts it — the same wasm file and
// models ocr.ts hands the worker
const TesseractCore = require('tesseract.js-core/tesseract-core-relaxedsimd-lstm.js')
const wasmBinary = readFileSync(require.resolve('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm'))
const core = await TesseractCore({ wasmBinary })
for (const code of ['eng', 'nor']) {
  const gz = readFileSync(require.resolve(`@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`))
  core.FS.writeFile(`/${code}.traineddata`, gunzipSync(gz))
}
const api = new core.TessBaseAPI()
check('the engine starts with the shipped models', api.Init('/', M.ocrLanguages('nb').join('+'), M.OEM_LSTM_ONLY) === 0)
check('automatic page segmentation is accepted', api.SetVariable('tessedit_pageseg_mode', M.PSM_AUTO) === true)

/** ocr.ts's readPage: render at the OCR scale, recognise, map back */
async function ocrPage(page) {
  const base = page.getViewport({ scale: 1 })
  const scale = M.ocrScale(base.width, base.height)
  const { rgba, width, height, viewport } = await raster(page, scale)
  core.FS.writeFile('/input', M.toPgm(rgba, width, height))
  if (api.SetImageFile(1, 0) === 1) throw new Error('image not read')
  api.SetSourceResolution(Math.round(72 * scale))
  const t0 = performance.now()
  api.Recognize(null)
  const tsv = api.GetTSVText(0)
  // OCR_DEBUG=1 prints what Tesseract returned, confidences included
  if (process.env.OCR_DEBUG) console.log(tsv)
  const ms = performance.now() - t0
  api.Clear()
  core.FS.unlink('/input')
  return { content: M.toTextContent(M.parseTsv(tsv), (x, y) => viewport.convertToPdfPoint(x, y)), ms }
}

const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

const LINES = [
  [72, 760, 22, 'Bruk av offentlige tjenester'],
  [72, 720, 11, 'Rapporten ser på hvordan kommunene bruker tjenestene'],
  [72, 704, 11, 'og hva det koster. Analysen dekker perioden fra 2015 til 2024.'],
  [72, 688, 11, 'Søk i skannede dokumenter er nå mulig for leserne.'],
  [72, 640, 14, 'Innledning og metode'],
  [72, 616, 11, 'Vi bruker registerdata fra Statistisk sentralbyrå og egne intervjuer.']
]
const original = textPdf(LINES)
const scanned = await scanOf(original)
{
  const doc = await open(scanned)
  const page = await doc.getPage(1)
  check('the scan has no text of its own (the case OCR is for)', !M.hasVisibleText(await page.getTextContent()))
  const { content, ms } = await ocrPage(page)
  const text = pageText(content)
  const want = words(LINES.map((l) => l[3]).join(' '))
  const got = new Set(words(text))
  const found = want.filter((w) => got.has(w))
  // Tesseract glues a short word to the next now and then («iskannede») —
  // search misses that word, the rest of the page is there
  check('OCR finds the words the original page had (≥ 90 %)', found.length / want.length >= 0.9, `${found.length}/${want.length}, missing: ${want.filter((w) => !got.has(w)).join(' ')}`)
  const nordic = ['på', 'nå', 'sentralbyrå']
  check('æ, ø and å come through with the Norwegian model', nordic.every((w) => got.has(w)), `missing: ${nordic.filter((w) => !got.has(w)).join(' ')}`)
  check('a phrase reads across items, as search needs it', /Innledning og metode/.test(text))
  check('one line of the page is one line of text', text.split('\n').some((l) => /^Rapporten ser på hvordan kommunene bruker tjenestene$/.test(l.trim())), JSON.stringify(text))
  // Positions: the recognised title lies where the original drew it
  const title = content.items.find((i) => /Bruk/.test(i.str))
  check('a word lands where the page drew it (x within 3 pt)', !!title && Math.abs(title.transform[4] - 72) < 3, title ? String(title.transform[4]) : 'not found')
  check('…on its baseline (y within 6 pt)', !!title && Math.abs(title.transform[5] - 760) < 6, title ? String(title.transform[5]) : 'not found')
  const odoc = await open(original)
  const orig = (await (await odoc.getPage(1)).getTextContent()).items.find((i) => /Rapporten/.test(i.str))
  const line = content.items.filter((i) => Math.abs(i.transform[5] - orig.transform[5]) < 6)
  const span = line.reduce((n, i) => n + i.width, 0)
  check('a line\'s words together are as wide as the line the page drew (±5 %)', Math.abs(span - orig.width) / orig.width < 0.05, `${span.toFixed(1)} vs ${orig.width.toFixed(1)}`)
  console.log(`      (one A4 page recognised in ${Math.round(ms)} ms)`)
  await odoc.loadingTask.destroy()
  await doc.loadingTask.destroy()
}
{
  // Two columns: Tesseract's default for the C++ API reads ONE block straight
  // across — PSM_AUTO is what finds the columns
  // A paper's columns: 10 pt type, a 24 pt gutter, a column's worth of lines
  // (three short lines side by side read as one table-like block, which is
  // also what they are)
  const filler = ['analysen viser at kostnadene', 'har steget jevnt over tid', 'og at forskjellene mellom', 'kommunene er store i alle', 'deler av landet vi har sett']
  const left = ['Venstre spalte begynner her', ...Array.from({ length: 14 }, (_, i) => filler[i % filler.length]), 'og den slutter akkurat her.']
  const right = ['Høyre spalte kommer etterpå', ...Array.from({ length: 14 }, (_, i) => filler[(i + 2) % filler.length]), 'og er lest ferdig til slutt.']
  const lines = [
    ...left.map((s, i) => [72, 720 - i * 13, 10, s]),
    ...right.map((s, i) => [309, 720 - i * 13, 10, s])
  ]
  const doc = await open(await scanOf(textPdf(lines)))
  const { content } = await ocrPage(await doc.getPage(1))
  const text = pageText(content)
  const endLeft = text.indexOf('akkurat')
  const startRight = text.indexOf('Høyre')
  check('two columns read down the left one first', endLeft >= 0 && startRight > endLeft, JSON.stringify(text))
  await doc.loadingTask.destroy()
}
{
  // Scanned sideways, righted by /Rotate 90: the words must map back through
  // the rotation and land where the upright scan has them ON SCREEN
  const doc = await open(await scanOf(original, { sideways: true }))
  const page = await doc.getPage(1)
  check('the sideways fixture is a /Rotate 90 page', page.rotate === 90)
  const { content } = await ocrPage(page)
  const text = pageText(content)
  check('the rotated scan reads the same words', /Innledning og metode/.test(text) && /Rapporten/.test(text), JSON.stringify(text.slice(0, 120)))
  const title = content.items.find((i) => /Bruk/.test(i.str))
  // On screen (pdf.js applies /Rotate in the viewport) the title is at the
  // upright page's (72, 842 − 760) from the top left
  const [sx, sy] = title ? page.getViewport({ scale: 1 }).convertToViewportPoint(title.transform[4], title.transform[5]) : [NaN, NaN]
  check('…and its title sits where the upright page has it on screen', Math.abs(sx - 72) < 3 && Math.abs(sy - (842 - 760)) < 6, `${sx?.toFixed?.(1)},${sy?.toFixed?.(1)}`)
  check('…its text running along the page\'s y axis in PDF space', !!title && Math.abs(title.transform[0]) < 1e-6 && Math.abs(title.transform[1]) > 1)
  await doc.loadingTask.destroy()
}

// ---------- 3. Text in images on a page that has text of its own ----------
//
// ocr-image.ts: no OCR where the page already has the text, no duplicates,
// no rubbish — and the page's own text untouched as the prefix of what
// search and the assistant read.

const imgOut = join(dir, 'ocr-image.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/ocr-image.ts', import.meta.url))], outfile: imgOut, format: 'esm', bundle: true, platform: 'neutral', logLevel: 'silent' })
const IM = await import(pathToFileURL(imgOut).href)
const irOut = join(dir, 'image-regions.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/image-regions.ts', import.meta.url))], outfile: irOut, format: 'esm', bundle: true, platform: 'neutral', external: ['pdfjs-dist'], logLevel: 'silent' })
const IR = await import(pathToFileURL(irOut).href)
const pgmBody = (pgm) => {
  const header = new TextDecoder().decode(pgm.slice(0, 20)).match(/^P5\n(\d+) (\d+)\n255\n/)
  return { w: Number(header[1]), h: Number(header[2]), px: pgm.slice(header[0].length) }
}

{
  // Pixel formats as pdf.js decodes them
  const bw = pgmBody(IM.pixelsToPgm('bw1', new Uint8Array([0b10100000, 0b01000000, 0b00000000, 0b10000000]), 10, 2))
  check('1 bit: rows padded to a byte, 1 = white', bw.w === 10 && bw.px[0] === 255 && bw.px[1] === 0 && bw.px[2] === 255 && bw.px[9] === 255 && bw.px[10] === 0 && bw.px[18] === 255, Array.from(bw.px).join(','))
  const rgb = pgmBody(IM.pixelsToPgm('rgb', new Uint8Array([255, 255, 255, 0, 0, 0]), 2, 1))
  check('RGB: white and black', rgb.px[0] === 255 && rgb.px[1] === 0)
  const rgba = pgmBody(IM.pixelsToPgm('rgba', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]), 2, 1))
  check('RGBA: a transparent pixel lies on white paper', rgba.px[0] === 255 && rgba.px[1] === 0)
  const up = pgmBody(IM.pixelsToPgm('rgb', new Uint8Array([0, 0, 0, 255, 255, 255]), 2, 1, 2))
  check('enlarged twice: twice the size, black to white across', up.w === 4 && up.h === 2 && up.px[0] === 0 && up.px[3] === 255 && up.px[1] < up.px[2])

  // Which images are read
  const own = { items: [{ str: 'Some caption text here', transform: [10, 0, 0, 10, 100, 500], width: 120, height: 10, hasEOL: true }] }
  const rect = (x0, y0, x1, y1, extra = {}) => ({ x0, y0, x1, y1, px: { w: 800, h: 300 }, src: { objId: 'img_p0_1' }, upright: true, ...extra })
  const picked = IM.imageCandidates([
    rect(50, 100, 350, 220),
    rect(90, 480, 400, 600), // the caption's text lies on it
    rect(50, 300, 350, 420, { upright: false }),
    rect(50, 700, 80, 710), // a rule, not a picture
    rect(50, 50, 350, 90, { px: { w: 100, h: 20 } }), // too few pixels
    rect(400, 100, 550, 160, { src: undefined })
  ], own)
  check('a figure is read; one with the page\'s own text on it, a turned one, a tiny one, a coarse one and one without pixels are not', picked.length === 1 && picked[0].y0 === 100, JSON.stringify(picked.map((p) => [p.x0, p.y0])))
  const many = IM.imageCandidates(Array.from({ length: 30 }, (_, i) => rect(10, i * 20, 10 + 70 + i, i * 20 + 25)), { items: [] })
  check('at most IMAGES_PER_PAGE images per page, the largest first', many.length === IM.IMAGES_PER_PAGE && many[0].x1 - many[0].x0 >= many.at(-1).x1 - many.at(-1).x0)
  check('a coarse image is enlarged, a fine one is not', IM.imageUpscale({ x0: 0, x1: 72, px: { w: 100, h: 50 } }) === 3 && IM.imageUpscale({ x0: 0, x1: 72, px: { w: 300, h: 50 } }) === 1)

  // Which words are kept
  const line = (words) => ({ left: 0, top: 0, width: 400, height: 20, words: words.map(([text, conf, left]) => ({ text, conf, left, top: 0, width: 30, height: 20 })) })
  const map = IM.regionToPdf({ x0: 0, y0: 0, x1: 400, y1: 20, w: 400, h: 20 })
  const ownOver = { items: [{ str: 'Label', transform: [10, 0, 0, 10, 300, 5], width: 40, height: 10 }] }
  const kept = IM.imageWords([{ lines: [line([['Revenue', 92, 0], ['2024', 88, 60], ['|]', 95, 100], ['pf', 30, 140], ['Label', 90, 305]])] }], map, ownOver)
  const keptWords = kept.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => w.text)))
  check('kept: sure words with letters or digits — not symbols, not an unsure fragment, not a word on the page\'s own text', keptWords.join() === 'Revenue,2024', keptWords.join())
  const photo = IM.imageWords([{ lines: [line([['ee', 41, 0], ['Iii', 45, 60], ['mn', 52, 120]])] }], map, { items: [] })
  check('an image of unsure fragments (a photo) gives nothing at all', photo.length === 0)
  const one = IM.imageWords([{ lines: [line([['Logo', 95, 0]])] }], map, { items: [] })
  check('one lone word is not enough to call a picture text', one.length === 0)
  check('a read image maps its pixels onto its box, y up', JSON.stringify(map(0, 0)) === '[0,20]' && JSON.stringify(map(400, 20)) === '[400,0]')

  // The merge keeps the page's own text as the prefix
  const ownContent = { items: [{ str: 'Own text', transform: [10, 0, 0, 10, 0, 0], width: 40, height: 10, hasEOL: false, fontName: 'F1' }], styles: { F1: {} }, lang: null }
  const imgContent = IM.imageTextContent([{ x0: 0, y0: 0, x1: 400, y1: 20, w: 400, h: 20, paragraphs: kept }])
  const merged = IM.mergeImageText(ownContent, imgContent)
  const mergedText = pageText(merged)
  check('merged: the own text first and untouched, a blank line, then the image words', mergedText.startsWith('Own text\n\n') && mergedText.includes('Revenue 2024'), JSON.stringify(mergedText))
  check('nothing read: the own text comes back as it was', IM.mergeImageText(ownContent, { items: [], styles: {} }) === ownContent)
}

{
  // The real engine on a hand-built page: text of its own, a picture of a
  // table, the same picture with the page's own text over it, and noise
  const tableDoc = await open(textPdf([
    [16, 70, 13, 'Kostnader per innbygger'],
    [16, 46, 11, 'Oslo 2023 1250 kroner'],
    [16, 26, 11, 'Bergen 2023 980 kroner']
  ], 300, 100))
  const { rgba, width: tw, height: th } = await raster(await tableDoc.getPage(1), 200 / 72)
  await tableDoc.loadingTask.destroy()
  const grey = Buffer.alloc(tw * th)
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
  let seed = 7
  const noise = Buffer.alloc(tw * th, 0).map(() => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255)
  const img = (data) => ({ dict: `<< /Type /XObject /Subtype /Image /Width ${tw} /Height ${th} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${deflateSync(data).length} >>`, stream: deflateSync(data) })
  const content = [
    'BT /F1 12 Tf 72 780 Td (Rapporten viser kostnadene i tabellen under.) Tj ET',
    'q 300 0 0 100 72 600 cm /Table Do Q',
    // The same picture, with the page's own words written over it
    'q 300 0 0 100 72 400 cm /Table Do Q',
    'BT /F1 13 Tf 88 470 Td (Kostnader per innbygger) Tj ET',
    'BT /F1 11 Tf 88 446 Td (Oslo 2023 1250 kroner) Tj ET',
    'q 300 0 0 100 72 200 cm /Noise Do Q'
  ].join('\n')
  const pagePdf = pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Table 6 0 R /Noise 7 0 R >> >> >>',
    { dict: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, stream: Buffer.from(content, 'latin1') },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    img(grey),
    img(noise)
  ])
  const doc = await open(pagePdf)
  const page = await doc.getPage(1)
  const own = await page.getTextContent()
  const ops = await page.getOperatorList()
  const rects = IR.imageRectsFromOps(ops.fnArray, ops.argsArray, pdfjs.OPS)
  check('the image walk names each picture\'s pixels and finds it upright', rects.length === 3 && rects.every((r) => r.src?.objId && r.upright), JSON.stringify(rects.map((r) => [r.y0, r.src, r.upright])))
  const candidates = IM.imageCandidates(rects, own)
  check('read: the table and the noise — not the picture the page already has the words over', candidates.length === 2 && !candidates.some((c) => c.y0 === 400), JSON.stringify(candidates.map((c) => c.y0)))
  const regions = []
  for (const c of candidates) {
    const data = await new Promise((resolve) => page.objs.get(c.src.objId, resolve))
    const format = data.kind === 1 ? 'bw1' : data.kind === 2 ? 'rgb' : 'rgba'
    const upscale = IM.imageUpscale(c)
    core.FS.writeFile('/input', IM.pixelsToPgm(format, data.data, data.width, data.height, upscale))
    api.SetImageFile(1, 0)
    api.SetSourceResolution(Math.round((c.px.w / ((c.x1 - c.x0) / 72)) * upscale))
    api.Recognize(null)
    const tsv = api.GetTSVText(0)
    if (process.env.OCR_DEBUG) console.log(tsv.split('\n').filter((l) => l.startsWith('5\t')).map((l) => l.split('\t').slice(10).join(' ')).join(' | '))
    api.Clear()
    const region = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w: data.width * upscale, h: data.height * upscale }
    regions.push({ ...region, paragraphs: IM.imageWords(M.parseTsv(tsv), IM.regionToPdf(region), own) })
  }
  const table = regions.find((r) => r.y0 === 600)
  const noiseRegion = regions.find((r) => r.y0 === 200)
  const tableText = pageText(IM.imageTextContent([table]))
  check('the table\'s words are read', /Kostnader per innbygger/.test(tableText) && /1250/.test(tableText) && /Bergen/.test(tableText), JSON.stringify(tableText))
  check('noise gives no words at all', noiseRegion.paragraphs.length === 0, JSON.stringify(noiseRegion.paragraphs))
  const word = IM.imageTextContent([table]).items.find((i) => /Kostnader/.test(i.str))
  check('a table word lands on the picture where it is drawn (x within 6 pt, y within the row)', !!word && Math.abs(word.transform[4] - (72 + 16)) < 6 && word.transform[5] > 600 + 60 && word.transform[5] < 600 + 80, word ? `${word.transform[4]},${word.transform[5]}` : 'none')
  const merged = IM.mergeImageText(own, IM.imageTextContent(regions))
  const mergedText = pageText(merged)
  const ownText = pageText(own)
  check('what search and the assistant read: the page\'s own text unchanged, then the table', mergedText.startsWith(ownText) && /Kostnader per innbygger/.test(mergedText.slice(ownText.length)), JSON.stringify(mergedText))
  check('…and the picture with the page\'s own words on it is not read twice', (mergedText.match(/Kostnader per innbygger/g) ?? []).length === 2, JSON.stringify(mergedText))
  await doc.loadingTask.destroy()
}

console.log(failures === 0 ? '\nAll OCR checks passed.' : `\n${failures} OCR check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

// Round-trip test of the incremental appender THROUGH the production adapter
// (annotation-engine-embedpdf.ts routes to src/main/incremental-appender.ts
// for files >= PDFX_APPENDER_THRESHOLD — lowered to 1 KB here so the tiny
// corpora take the appender path).
//
//   (a) BOTH corpus flavors — classic xref (pdf-lib default save) and
//       xref-stream + object-streams (save({ useObjectStreams: true })):
//       create annotations, verify with mupdf (object numbers + /AP), the
//       EmbedPDF engine, and pdfjs-dist (the app's actual renderer); a second
//       batch of appends must chain onto the first.
//   (b) update color + translate + delete round-trip through the appender.
//   (c) HEADLINE: on the 413 MB bench corpus one applyAnnotation completes in
//       < 2 s with RSS growth < 200 MB, and mupdf lists the annotation.
//
// Self-bundling like test-engine-cache.mjs. Run: node scripts/test-appender.mjs
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as mupdf from 'mupdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'pdfx-appender-test')
const BENCH_TMP = path.join(os.tmpdir(), 'pdfx-engine-bench')
fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(BENCH_TMP, { recursive: true })

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

// --- bundle the production adapter, threshold lowered via env ---------------
process.env.PDFX_APPENDER_THRESHOLD = '1024'
const BUNDLE = path.join(__dirname, '.appender-test-bundle.mjs')
{
  const { build } = await import('esbuild')
  await build({
    entryPoints: [path.join(ROOT, 'src/main/annotation-engine-embedpdf.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: BUNDLE,
    logLevel: 'silent'
  })
}
const { applyAnnotation, updateAnnotation, deleteAnnotation } = await import(pathToFileURL(BUNDLE).href)

// --- independent verifiers ---------------------------------------------------
function mupdfAnnots(file, pageIndex) {
  const pdf = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf').asPDF()
  const annots = pdf.loadPage(pageIndex).getAnnotations()
  const out = annots.map((a) => {
    let hasAp = false
    try {
      const ap = a.getObject().get('AP')
      hasAp = !!ap && !ap.isNull()
    } catch {
      /* keep false */
    }
    return { id: a.getObject().asIndirect(), type: a.getType(), hasAp, annot: a }
  })
  return { pdf, out }
}

async function embedpdfCount(file, pageIndex) {
  const { init } = await import('@embedpdf/pdfium')
  const { PdfiumNative } = await import('@embedpdf/engines/pdfium')
  const require = createRequire(import.meta.url)
  const wasm = fs.readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  const engine = new PdfiumNative(await init({ wasmBinary: wasm }))
  const bytes = fs.readFileSync(file)
  const doc = await engine
    .openDocumentBuffer({ id: `verify-${Math.random()}`, content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    .toPromise()
  const n = (await engine.getPageAnnotations(doc, doc.pages[pageIndex]).toPromise()).length
  await engine.closeDocument(doc).toPromise()
  engine.destroy()
  return n
}

// NOTE: pdf.js may warn "Unable to load font data ... LiberationSans" while
// preparing the FreeText fallback font — pdfjs-dist v6 no longer ships that
// ttf. Cosmetic only; getAnnotations() is unaffected.
async function pdfjsAnnotIds(file, pageIndex) {
  const require = createRequire(import.meta.url)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  const data = new Uint8Array(fs.readFileSync(file))
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '..', '..', 'standard_fonts')
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: pathToFileURL(fontDir).href + '/'
  })
  const doc = await task.promise
  const page = await doc.getPage(pageIndex + 1)
  const annots = await page.getAnnotations()
  await task.destroy()
  return annots.map((a) => a.id)
}

// --- corpora -----------------------------------------------------------------
async function smallCorpus(objectStreams) {
  const file = path.join(TMP, `corpus-${objectStreams ? 'objstm' : 'classic'}.pdf`)
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([595, 842])
    page.setFont(font)
    page.setFontSize(11)
    for (let line = 0; line < 30; line++) {
      page.drawText(`Side ${i + 1}, linje ${line + 1}: tekst for appender-testen.`, { x: 60, y: 800 - line * 20 })
    }
  }
  fs.writeFileSync(file, await doc.save({ useObjectStreams: objectStreams }))
  return file
}

/** Same generator (and cached filename) as scripts/engine-bench.mjs `5800@400`. */
async function bigCorpus() {
  const file = path.join(BENCH_TMP, 'corpus-5800p-400mb.pdf')
  if (fs.existsSync(file)) return file
  console.log('generating 5800-page / 400 MB corpus (one-time, cached)...')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 5800; i++) {
    const page = doc.addPage([595, 842])
    page.setFont(font)
    page.setFontSize(11)
    for (let line = 0; line < 40; line++) {
      page.drawText(
        `Side ${i + 1}, linje ${line + 1}: kvantitativ analyse av konkurransevirkninger i dagligvaremarkedet.`,
        { x: 60, y: 800 - line * 18 }
      )
    }
  }
  const blob = new Uint8Array(400 * 1024 * 1024)
  for (let i = 0; i < blob.length; i += 65536) {
    blob.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, blob.length - i))), i)
  }
  await doc.attach(blob, 'figures.bin', { mimeType: 'application/octet-stream' })
  fs.writeFileSync(file, await doc.save())
  return file
}

const q = (x, y, w, h) => [{ x, y, w, h }]

// =============================================================================
// (a) + (b): both xref flavors through the production adapter
// =============================================================================
for (const objectStreams of [false, true]) {
  const flavor = objectStreams ? 'xref-stream/objstm' : 'classic xref'
  console.log(`\n===== ${flavor} corpus =====`)
  const FILE = path.join(TMP, `run-${objectStreams ? 'objstm' : 'classic'}.pdf`)
  fs.copyFileSync(await smallCorpus(objectStreams), FILE)
  const base = { path: FILE, pageIndex: 1, opacity: 1, color: [0.89, 0.29, 0.29], author: 'appender-test' }

  // -- create: first batch (each call is one incremental append) --
  const reqs = [
    { ...base, type: 'highlight', quads: q(70, 70, 200, 16), color: [1, 0.84, 0.29], opacity: 0.5 },
    { ...base, type: 'underline', quads: q(70, 95, 180, 14) },
    { ...base, type: 'squiggly', quads: q(70, 135, 140, 14) },
    { ...base, type: 'note', quads: q(300, 70, 20, 20), contents: 'Notat' },
    { ...base, type: 'ink', quads: q(70, 170, 120, 40), strokes: [[[72, 200], [100, 175], [130, 205]]], width: 2.2 },
    { ...base, type: 'square', quads: q(70, 230, 110, 60), width: 2 },
    { ...base, type: 'arrow', quads: q(70, 360, 160, 40), strokes: [[[72, 395], [225, 365]]], width: 2 },
    { ...base, type: 'freetext', quads: q(300, 310, 200, 48), contents: 'Fri tekst ÆØÅ', fontSize: 12, color: [0.11, 0.11, 0.13] }
  ]
  const ids = {}
  for (const req of reqs) {
    const res = await applyAnnotation(req)
    check(`create ${req.type}`, 'ok' in res && res.id > 0, 'ok' in res ? `obj#${res.id}` : res.error)
    if ('ok' in res) ids[req.type] = res.id
  }

  // -- a SECOND append batch must chain onto the first sections --
  const second = await applyAnnotation({ ...base, type: 'strikeout', quads: q(70, 115, 160, 14) })
  check('second batch chains (strikeout)', 'ok' in second && second.id > 0, 'ok' in second ? `obj#${second.id}` : second.error)
  if ('ok' in second) ids.strikeout = second.id
  const otherPage = await applyAnnotation({ ...base, pageIndex: 2, type: 'circle', quads: q(200, 230, 110, 60), width: 2 })
  check('append on another page', 'ok' in otherPage && otherPage.id > 0, 'ok' in otherPage ? `obj#${otherPage.id}` : otherPage.error)

  // -- mupdf verification --
  {
    const { pdf, out } = mupdfAnnots(FILE, 1)
    const byId = new Map(out.map((a) => [a.id, a]))
    check('mupdf reopens the file', true, `${out.length} annots on page 1`)
    check('all reported ids present (mupdf)', Object.values(ids).every((id) => byId.has(id)),
      `ids ${Object.values(ids).join(',')} vs file ${out.map((a) => a.id).join(',')}`)
    const apOk = Object.entries(ids).every(([type, id]) =>
      type === 'note' ? !byId.get(id)?.hasAp : byId.get(id)?.hasAp)
    check('/AP present on all except note', apOk,
      Object.entries(ids).map(([t, id]) => `${t}:${byId.get(id)?.hasAp ? 'AP' : '-'}`).join(' '))
    const ft = byId.get(ids.freetext)
    check('freetext contents round-trip (ÆØÅ)', ft?.annot.getContents() === 'Fri tekst ÆØÅ',
      JSON.stringify(ft?.annot.getContents()))
    const { pdf: pdf2, out: out2 } = mupdfAnnots(FILE, 2)
    check('circle landed on page 2 (mupdf)', out2.some((a) => 'ok' in otherPage && a.id === otherPage.id))
    pdf2.destroy()
    pdf.destroy()
  }

  // -- EmbedPDF engine sees them --
  {
    const n = await embedpdfCount(FILE, 1)
    check('EmbedPDF engine lists them', n === Object.keys(ids).length, `${n} vs ${Object.keys(ids).length}`)
  }

  // -- pdfjs-dist (the app's renderer) sees them under the right ids --
  {
    const pdfjsIds = await pdfjsAnnotIds(FILE, 1)
    const missing = Object.entries(ids).filter(([, id]) => !pdfjsIds.includes(`${id}R`))
    check('pdf.js getAnnotations returns all ids', missing.length === 0,
      missing.length ? `missing ${missing.map(([t, id]) => `${t}#${id}`).join(',')}` : `${pdfjsIds.length} annots`)
  }

  // -- (b) update color + translate + delete through the appender --
  {
    const rec = await updateAnnotation({ path: FILE, pageIndex: 1, id: ids.highlight, color: [0.44, 0.71, 1] })
    check('update color (highlight)', 'ok' in rec, 'error' in rec ? rec.error : '')
    const mv = await updateAnnotation({ path: FILE, pageIndex: 1, id: ids.arrow, translate: { dx: 15, dy: 10 } })
    check('translate arrow', 'ok' in mv, 'error' in mv ? mv.error : '')
    const del = await deleteAnnotation({ path: FILE, pageIndex: 1, id: ids.square })
    check('delete square', 'ok' in del, 'error' in del ? del.error : '')

    const { pdf, out } = mupdfAnnots(FILE, 1)
    const byId = new Map(out.map((a) => [a.id, a]))
    check('square is gone (mupdf)', !byId.has(ids.square))
    const hl = byId.get(ids.highlight)
    const rgb = hl ? Array.from(hl.annot.getColor(), (v) => Math.round(v * 255)).join(',') : 'missing'
    check('highlight recolored to 112,181,255', rgb === '112,181,255', rgb)
    // created at display (72,395)-(225,365), moved +15/+10 → (87,405)-(240,375).
    // mupdf getLine() reports top-left y-down page coords (same expectation as
    // scripts/test-engine-embedpdf.mjs for this exact scenario).
    const arrow = byId.get(ids.arrow)
    const line = arrow?.annot.getLine()
    const lineOk = line &&
      Math.round(line[0][0]) === 87 && Math.round(line[0][1]) === 405 &&
      Math.round(line[1][0]) === 240 && Math.round(line[1][1]) === 375
    check('arrow /L endpoints moved', !!lineOk, line ? JSON.stringify(line.map((p) => p.map(Math.round))) : 'missing')
    let le = 'none'
    try { const o = arrow?.annot.getObject().get('LE'); le = o && !o.isNull() ? String(o) : 'none' } catch { /* keep */ }
    check('arrowhead (/LE) intact after move', /ClosedArrow/.test(le), le)
    check('updated annots still have /AP', !!(hl?.hasAp && arrow?.hasAp))
    pdf.destroy()
  }
}

// =============================================================================
// (c) HEADLINE: 413 MB corpus — fast, flat-memory append; mupdf verifies
// =============================================================================
console.log('\n===== 413 MB corpus (5800 pages + 400 MB payload) =====')
{
  const src = await bigCorpus()
  const FILE = path.join(TMP, 'run-big.pdf')
  fs.copyFileSync(src, FILE)
  const size = fs.statSync(FILE).size
  check('corpus is over the real 150 MB threshold', size >= 150 * 1024 * 1024, mb(size))

  global.gc?.()
  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  const res = await applyAnnotation({
    path: FILE, pageIndex: 0, type: 'highlight', quads: q(60, 80, 400, 14),
    color: [1, 0.84, 0.29], opacity: 0.5, author: 'appender-test'
  })
  const dt = performance.now() - t0
  const rssGrowth = process.memoryUsage().rss - rss0
  check('applyAnnotation succeeds on 413 MB file', 'ok' in res && res.id > 0, 'ok' in res ? `obj#${res.id}` : res.error)
  check('completes in < 2 s', dt < 2000, `${dt.toFixed(0)} ms`)
  check('RSS growth < 200 MB', rssGrowth < 200 * 1024 * 1024, mb(rssGrowth))

  const { pdf, out } = mupdfAnnots(FILE, 0)
  check('mupdf lists the appended annotation', 'ok' in res && out.some((a) => a.id === res.id),
    `page 0 has [${out.map((a) => a.id).join(',')}]`)
  pdf.destroy()

  // a second append must chain onto the freshly appended xref section
  const res2 = await applyAnnotation({
    path: FILE, pageIndex: 5799, type: 'underline', quads: q(60, 120, 300, 14),
    color: [0.89, 0.29, 0.29], opacity: 1, author: 'appender-test'
  })
  check('second append chains (last page)', 'ok' in res2 && res2.id > 0, 'ok' in res2 ? `obj#${res2.id}` : res2.error)
}

fs.rmSync(BUNDLE, { force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

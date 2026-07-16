// Engine benchmark: mupdf (incremental save) vs EmbedPDF/PDFium (full rewrite)
// on the exact per-write cycle the app performs: open file -> add one highlight
// -> save -> close. Repeated N times per document so file-growth and latency
// trends are visible. Cross-parser validation at the end (each engine's output
// is reopened by BOTH parsers and annotation counts must match).
//
// Run: node scripts/engine-bench.mjs [pages[@payloadMB]...]
//   e.g. node scripts/engine-bench.mjs 5800@150   (5800 pages + 150 MB payload)
//   default: 10 100 500 1000 plus 200@20
// Test corpora are generated with pdf-lib into the OS temp dir and cached.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import * as mupdf from 'mupdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WASM = path.join(__dirname, '..', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')
const TMP = path.join(os.tmpdir(), 'pdfx-engine-bench')
fs.mkdirSync(TMP, { recursive: true })

const ARG_CASES = process.argv
  .slice(2)
  .map((a) => /^(\d+)(?:@(\d+))?$/.exec(a))
  .filter(Boolean)
  .map((m) => [Number(m[1]), Number(m[2] ?? 0)])
const WRITES = 5 // sequential annotation-writes per document

const kb = (n) => `${Math.round(n / 1024)} kB`
const ms = (n) => `${n.toFixed(1)} ms`

// ---------------------------------------------------------------------------
// Corpus: n-page text PDFs (cached across runs)
// ---------------------------------------------------------------------------
async function corpus(pages, heavyMb = 0) {
  const file = path.join(TMP, `corpus-${pages}p${heavyMb ? `-${heavyMb}mb` : ''}.pdf`)
  if (fs.existsSync(file)) return file
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
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
  // Simulate figure/scan byte-weight: incompressible random payload embedded as
  // an attachment — a full rewrite must re-serialize every one of these bytes.
  if (heavyMb > 0) {
    const blob = new Uint8Array(heavyMb * 1024 * 1024)
    for (let i = 0; i < blob.length; i += 65536) {
      blob.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, blob.length - i))), i)
    }
    await doc.attach(blob, 'figures.bin', { mimeType: 'application/octet-stream' })
  }
  fs.writeFileSync(file, await doc.save())
  return file
}

// ---------------------------------------------------------------------------
// One write cycle per engine (mirrors src/main/annotation-engine.ts withPdf)
// ---------------------------------------------------------------------------
function mupdfWrite(file, pageIndex, i) {
  const t0 = performance.now()
  const data = fs.readFileSync(file)
  const pdf = mupdf.Document.openDocument(data, 'application/pdf').asPDF()
  const page = pdf.loadPage(pageIndex)
  const annot = page.createAnnotation('Highlight')
  const y = 80 + i * 24
  annot.setQuadPoints([[60, y, 460, y, 60, y + 14, 460, y + 14]])
  annot.setColor([1, 0.84, 0.29])
  annot.setOpacity(0.5)
  annot.setAuthor('bench')
  annot.update()
  const buf = pdf.saveToBuffer(pdf.canBeSavedIncrementally() ? 'incremental' : 'garbage=2')
  fs.writeFileSync(file, buf.asUint8Array())
  buf.destroy()
  pdf.destroy()
  return performance.now() - t0
}

async function embedWrite(engine, file, pageIndex, i) {
  const t0 = performance.now()
  const data = fs.readFileSync(file)
  const doc = await engine
    .openDocumentBuffer({ id: randomUUID(), content: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
    .toPromise()
  const page = doc.pages[pageIndex]
  const y = 80 + i * 24
  await engine
    .createPageAnnotation(doc, page, {
      id: randomUUID(),
      pageIndex,
      type: PdfAnnotationSubtype.HIGHLIGHT,
      rect: { origin: { x: 60, y }, size: { width: 400, height: 14 } },
      segmentRects: [{ origin: { x: 60, y }, size: { width: 400, height: 14 } }],
      strokeColor: '#FFD64A',
      opacity: 0.5,
      author: 'bench'
    })
    .toPromise()
  const saved = await engine.saveAsCopy(doc).toPromise()
  fs.writeFileSync(file, Buffer.from(saved))
  await engine.closeDocument(doc).toPromise()
  return performance.now() - t0
}

// ---------------------------------------------------------------------------
// Cross-parser validation: both parsers must read the file + agree on counts
// ---------------------------------------------------------------------------
async function validate(engine, file, pageIndex, expected) {
  const bytes = fs.readFileSync(file)
  let mCount = -1
  let mAp = 0
  try {
    const pdf = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()
    const annots = pdf.loadPage(pageIndex).getAnnotations()
    mCount = annots.length
    for (const a of annots) {
      try {
        const ap = a.getObject().get('AP')
        if (ap && !ap.isNull()) mAp++
      } catch { /* count stays */ }
    }
    pdf.destroy()
  } catch (err) {
    return { ok: false, detail: `mupdf failed to open: ${err.message}` }
  }
  let eCount = -1
  try {
    const doc = await engine
      .openDocumentBuffer({ id: randomUUID(), content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
      .toPromise()
    eCount = (await engine.getPageAnnotations(doc, doc.pages[pageIndex]).toPromise()).length
    await engine.closeDocument(doc).toPromise()
  } catch (err) {
    return { ok: false, detail: `EmbedPDF failed to open: ${err.message}` }
  }
  const ok = mCount === expected && eCount === expected && mAp === expected
  return { ok, detail: `mupdf=${mCount} embed=${eCount} /AP=${mAp} expected=${expected}` }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const pdfium = await init({ wasmBinary: fs.readFileSync(WASM) })
const engine = new PdfiumNative(pdfium)

console.log(`per-write cycle: open -> +1 highlight -> save -> close   (${WRITES} writes/doc)`)
const CASES = ARG_CASES.length > 0 ? ARG_CASES : [[10, 0], [100, 0], [500, 0], [1000, 0], [200, 20]]
for (const [pages, heavyMb] of CASES) {
  const src = await corpus(pages, heavyMb)
  const srcSize = fs.statSync(src).size
  console.log(`\n===== ${pages} pages${heavyMb ? ` + ${heavyMb} MB payload` : ''} (${kb(srcSize)}) =====`)
  for (const engineName of ['mupdf', 'embedpdf']) {
    const file = path.join(TMP, `run-${pages}p-${engineName}.pdf`)
    fs.copyFileSync(src, file)
    const times = []
    let failure = null
    for (let i = 0; i < WRITES; i++) {
      try {
        times.push(engineName === 'mupdf' ? mupdfWrite(file, 0, i) : await embedWrite(engine, file, 0, i))
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        break
      }
    }
    const outSize = fs.statSync(file).size
    if (failure) {
      console.log(
        `${engineName.padEnd(9)} writes: ${times.map(ms).join(', ') || '(none)'}  | FAILED on write #${times.length + 1}: ${failure.slice(0, 90)}`
      )
      continue
    }
    const v = await validate(engine, file, 0, WRITES)
    console.log(
      `${engineName.padEnd(9)} writes: ${times.map(ms).join(', ')}  | final ${kb(outSize)} (+${kb(outSize - srcSize)})  | valid: ${v.ok ? 'OK' : 'FAIL'} (${v.detail})`
    )
  }
}
engine.destroy()
console.log('\nBENCH DONE')

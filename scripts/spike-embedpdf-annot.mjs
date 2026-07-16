// SPIKE: prove @embedpdf/pdfium + @embedpdf/engines (MIT / BSD-3 PDFium fork)
// can replace mupdf as the PDFX annotation WRITER. Mirrors spike-mupdf-annot.mjs.
//
// Run: node scripts/spike-embedpdf-annot.mjs
//
// Must answer the three unknowns from the engine research:
//   A. Coordinate system of the model Rect (top-left y-down like mupdf, or not?)
//   B. Appearance streams: does every annotation type get an /AP after create?
//      (cross-checked by REOPENING THE OUTPUT WITH MUPDF — an independent parser)
//   C. Identity across sessions: does the `id` survive save+reopen, and can we
//      map it to a PDF object number (what the renderer/pdf.js tracks)?
//   D. Save behavior: full rewrite vs incremental — sizes + timing.
//   E. Modify-after-reopen: find by id, change color, save, verify (undo/redo path).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import {
  PdfAnnotationSubtype,
  PdfAnnotationLineEnding,
  PdfStandardFont,
  PdfTextAlignment,
  PdfVerticalAlignment
} from '@embedpdf/models'
import * as mupdf from 'mupdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_PDF = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')
const OUTPUT_PDF = path.join(__dirname, 'spike-embedpdf-output.pdf')
const WASM = path.join(__dirname, '..', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')

const fmt = (n) => Math.round(n * 100) / 100
const rect = (x, y, w, h) => ({ origin: { x, y }, size: { width: w, height: h } })
const fmtRect = (r) => `[x=${fmt(r.origin.x)} y=${fmt(r.origin.y)} w=${fmt(r.size.width)} h=${fmt(r.size.height)}]`

// ---------------------------------------------------------------------------
// 0. Init PDFium WASM in Node (no fetch: pass the binary directly)
// ---------------------------------------------------------------------------
const wasmBinary = fs.readFileSync(WASM)
const pdfium = await init({ wasmBinary })
const engine = new PdfiumNative(pdfium)
console.log('== init ==')
console.log('engine ready (wasm', wasmBinary.length, 'bytes)')

const bytes = fs.readFileSync(SAMPLE_PDF)
const doc = await engine
  .openDocumentBuffer({ id: 'spike', content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  .toPromise()
console.log('pages:', doc.pageCount)
const page0 = doc.pages[0]
const page1 = doc.pages[1] ?? page0
console.log('page 1 size:', page0.size.width, 'x', page0.size.height)

// ---------------------------------------------------------------------------
// A. Coordinate facts: where does the page's top text sit?
// ---------------------------------------------------------------------------
console.log('\n== A. coordinates ==')
const textRects = await engine.getPageTextRects(doc, page1).toPromise()
if (textRects.length > 0) {
  const first = textRects[0]
  const topHalf = first.rect.origin.y < page1.size.height / 2
  console.log(`first text rect: ${fmtRect(first.rect)} content=${JSON.stringify((first.content ?? '').slice(0, 30))}`)
  console.log(topHalf
    ? '=> first text has SMALL y: origin TOP-LEFT, y grows DOWNWARD (same as mupdf/pdf.js)'
    : '=> first text has LARGE y: origin BOTTOM-LEFT, y grows UPWARD (flip needed!)')
} else {
  console.log('no text rects returned — coordinate check inconclusive from text')
}

// ---------------------------------------------------------------------------
// B. Create all 11 PDFX annotation types
// ---------------------------------------------------------------------------
console.log('\n== B. create 11 annotations ==')
const mk = (obj) => ({ id: randomUUID(), pageIndex: page1.index, author: 'PDFX Spike', ...obj })

const specs = [
  ['highlight', mk({ type: PdfAnnotationSubtype.HIGHLIGHT, rect: rect(70, 70, 200, 16), segmentRects: [rect(70, 70, 200, 16)], strokeColor: '#FFD54A', opacity: 0.5 })],
  ['underline', mk({ type: PdfAnnotationSubtype.UNDERLINE, rect: rect(70, 95, 180, 14), segmentRects: [rect(70, 95, 180, 14)], strokeColor: '#E2494A', opacity: 1 })],
  ['strikeout', mk({ type: PdfAnnotationSubtype.STRIKEOUT, rect: rect(70, 115, 160, 14), segmentRects: [rect(70, 115, 160, 14)], strokeColor: '#E2494A', opacity: 1 })],
  ['squiggly', mk({ type: PdfAnnotationSubtype.SQUIGGLY, rect: rect(70, 135, 140, 14), segmentRects: [rect(70, 135, 140, 14)], strokeColor: '#327CF6', opacity: 1 })],
  ['note', mk({ type: PdfAnnotationSubtype.TEXT, rect: rect(300, 70, 20, 20), contents: 'Sticky note from spike', strokeColor: '#FFD54A', opacity: 1 })],
  ['ink', mk({ type: PdfAnnotationSubtype.INK, rect: rect(70, 170, 120, 40), inkList: [{ points: [{ x: 72, y: 200 }, { x: 100, y: 175 }, { x: 130, y: 205 }, { x: 185, y: 180 }] }], strokeColor: '#2959BF', opacity: 1, strokeWidth: 2.2 })],
  ['square', mk({ type: PdfAnnotationSubtype.SQUARE, rect: rect(70, 230, 110, 60), strokeColor: '#E2494A', opacity: 1, strokeWidth: 2 })],
  ['circle', mk({ type: PdfAnnotationSubtype.CIRCLE, rect: rect(200, 230, 110, 60), strokeColor: '#2F9E58', opacity: 1, strokeWidth: 2 })],
  ['line', mk({ type: PdfAnnotationSubtype.LINE, rect: rect(70, 310, 160, 40), linePoints: { start: { x: 72, y: 345 }, end: { x: 225, y: 315 } }, strokeColor: '#8F52D6', color: '#8F52D6', opacity: 1, strokeWidth: 2, strokeStyle: 1 })],
  ['arrow', mk({ type: PdfAnnotationSubtype.LINE, rect: rect(70, 360, 160, 40), linePoints: { start: { x: 72, y: 395 }, end: { x: 225, y: 365 } }, lineEndings: { start: PdfAnnotationLineEnding.None, end: PdfAnnotationLineEnding.ClosedArrow }, strokeColor: '#E2494A', color: '#E2494A', opacity: 1, strokeWidth: 2, strokeStyle: 1 })],
  ['freetext', mk({ type: PdfAnnotationSubtype.FREETEXT, rect: rect(300, 310, 200, 48), contents: 'Fri tekst fra spike — ÆØÅ æøå', fontFamily: PdfStandardFont.Helvetica ?? 0, fontSize: 12, fontColor: '#1C1C21', textAlign: PdfTextAlignment.Left, verticalAlign: PdfVerticalAlignment.Top, opacity: 1 })]
]

const createdIds = {}
for (const [name, spec] of specs) {
  try {
    const id = await engine.createPageAnnotation(doc, page1, spec).toPromise()
    createdIds[name] = id
    console.log(`${name.padEnd(9)} -> id ${id}${id === spec.id ? ' (same as supplied)' : ' (ENGINE-ASSIGNED, supplied ' + spec.id.slice(0, 8) + '…)'}`)
  } catch (err) {
    console.log(`${name.padEnd(9)} -> FAILED: ${err?.message ?? JSON.stringify(err)}`)
  }
}

// ---------------------------------------------------------------------------
// D. Save: timing + size (saveAsCopy = full rewrite?)
// ---------------------------------------------------------------------------
console.log('\n== D. save ==')
let t0 = performance.now()
const saved = await engine.saveAsCopy(doc).toPromise()
const saveMs = performance.now() - t0
fs.writeFileSync(OUTPUT_PDF, Buffer.from(saved))
console.log(`saveAsCopy: ${fmt(saveMs)} ms; ${saved.byteLength} bytes (original ${bytes.length} bytes, delta ${saved.byteLength - bytes.length})`)
await engine.closeDocument(doc).toPromise()

// ---------------------------------------------------------------------------
// C1. Reopen with EmbedPDF: are ids stable? geometry intact?
// ---------------------------------------------------------------------------
console.log('\n== C1. reopen with EmbedPDF ==')
const saved2 = fs.readFileSync(OUTPUT_PDF)
const doc2 = await engine
  .openDocumentBuffer({ id: 'spike2', content: saved2.buffer.slice(saved2.byteOffset, saved2.byteOffset + saved2.byteLength) })
  .toPromise()
const reAnnots = await engine.getPageAnnotations(doc2, doc2.pages[page1.index]).toPromise()
console.log(`page ${page1.index + 1} annotations after round-trip: ${reAnnots.length}`)
const foundByName = {}
for (const a of reAnnots) {
  const match = Object.entries(createdIds).find(([, id]) => id === a.id)
  if (match) foundByName[match[0]] = a
  console.log(`  type=${a.type} id=${a.id} ${match ? '<= MATCHES created "' + match[0] + '"' : '(no id match)'} rect=${a.rect ? fmtRect(a.rect) : 'n/a'}`)
}
const idStable = Object.keys(createdIds).filter((k) => foundByName[k]).length
console.log(`ids stable across reopen: ${idStable}/${Object.keys(createdIds).length}`)

// ---------------------------------------------------------------------------
// C2. Raw bytes: /NM present? map uuid -> PDF object number
// ---------------------------------------------------------------------------
console.log('\n== C2. raw-file identity ==')
const raw = saved2.toString('latin1')
const nmCount = (raw.match(/\/NM/g) ?? []).length
console.log(`/NM occurrences in file: ${nmCount}`)
const anyId = createdIds.highlight ?? Object.values(createdIds)[0]
if (anyId && raw.includes(anyId)) {
  const at = raw.indexOf(anyId)
  const before = raw.slice(Math.max(0, at - 2000), at)
  const objMatch = [...before.matchAll(/(\d+)\s+0\s+obj/g)].pop()
  console.log(`highlight uuid found in raw bytes; enclosing object: ${objMatch ? objMatch[1] + ' 0 obj' : 'NOT FOUND (object streams?)'}`)
} else {
  console.log('created uuid NOT found in raw bytes — /NM not written, identity must use another route')
}

// ---------------------------------------------------------------------------
// B2. mupdf cross-check: independent parser sees the annots + /AP?
// ---------------------------------------------------------------------------
console.log('\n== B2. mupdf cross-check (appearance streams) ==')
const mdoc = mupdf.Document.openDocument(saved2, 'application/pdf').asPDF()
const mpage = mdoc.loadPage(page1.index)
let apCount = 0
let mTotal = 0
for (const a of mpage.getAnnotations()) {
  mTotal++
  let hasAp = false
  try {
    const ap = a.getObject().get('AP')
    hasAp = ap && !ap.isNull()
  } catch { /* leave false */ }
  if (hasAp) apCount++
  console.log(`  ${a.getType().padEnd(10)} obj#${a.getObject().asIndirect()} /AP=${hasAp} /NM=${(() => { try { const nm = a.getObject().get('NM'); return nm && !nm.isNull() ? JSON.stringify(nm.asString()).slice(0, 15) + '…' : 'none' } catch { return 'none' } })()}`)
}
console.log(`appearance streams: ${apCount}/${mTotal} annotations have /AP`)
mdoc.destroy()

// ---------------------------------------------------------------------------
// E. Modify after reopen (the undo/redo + cross-session edit path)
// ---------------------------------------------------------------------------
console.log('\n== E. modify after reopen ==')
const hl = foundByName.highlight
if (hl) {
  hl.strokeColor = '#6FB6FF'
  const ok = await engine.updatePageAnnotation(doc2, doc2.pages[page1.index], hl).toPromise()
  t0 = performance.now()
  const saved3 = await engine.saveAsCopy(doc2).toPromise()
  console.log(`update ok=${ok}; second save: ${fmt(performance.now() - t0)} ms, ${saved3.byteLength} bytes (delta vs first save: ${saved3.byteLength - saved2.length})`)
  // verify the color change round-trips
  const doc3 = await engine
    .openDocumentBuffer({ id: 'spike3', content: saved3 })
    .toPromise()
  const annots3 = await engine.getPageAnnotations(doc3, doc3.pages[page1.index]).toPromise()
  const hl3 = annots3.find((a) => a.id === hl.id)
  console.log(`reopened color: ${hl3?.strokeColor ?? hl3?.color} (expected #6FB6FF-ish) — id still stable: ${!!hl3}`)
  await engine.closeDocument(doc3).toPromise()
} else {
  console.log('highlight not found by id — modify test skipped')
}
await engine.closeDocument(doc2).toPromise()

// ---------------------------------------------------------------------------
// Delete test: remove one annotation, verify count drops
// ---------------------------------------------------------------------------
console.log('\n== F. delete ==')
const doc4 = await engine
  .openDocumentBuffer({ id: 'spike4', content: saved2.buffer.slice(saved2.byteOffset, saved2.byteOffset + saved2.byteLength) })
  .toPromise()
const annots4 = await engine.getPageAnnotations(doc4, doc4.pages[page1.index]).toPromise()
if (annots4.length > 0) {
  const before = annots4.length
  const ok = await engine.removePageAnnotation(doc4, doc4.pages[page1.index], annots4[0]).toPromise()
  const after = (await engine.getPageAnnotations(doc4, doc4.pages[page1.index]).toPromise()).length
  console.log(`delete ok=${ok}: ${before} -> ${after}`)
}
await engine.closeDocument(doc4).toPromise()

engine.destroy()
console.log('\nSPIKE DONE')

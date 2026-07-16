// SPIKE 2: prove the object-number bridge for the EmbedPDF adapter.
// The renderer identifies annotations by PDF object number (pdf.js exposes it
// as parseInt(annotation.id)); mupdf returned it natively. EmbedPDF's fork
// ships EPDFAnnot_GetObjectNumber / EPDFPage_GetAnnotByObjectNumber — this
// script proves we can (1) get the obj# of a just-created annotation, and
// (2) find + mutate an annotation BY obj# after reopen, matching the
// AnnotationEngine contract exactly. Also: does obj# survive a second save?
//
// Run: node scripts/spike-embedpdf-objnum.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import * as mupdf from 'mupdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_PDF = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')
const WASM = path.join(__dirname, '..', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')

const pdfium = await init({ wasmBinary: fs.readFileSync(WASM) })
const engine = new PdfiumNative(pdfium)
const rect = (x, y, w, h) => ({ origin: { x, y }, size: { width: w, height: h } })

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const open = (id, bytes) => engine.openDocumentBuffer({ id, content: toArrayBuffer(bytes) }).toPromise()

/** Map every annotation on a page: /Annots index -> { objNum, nm } via raw EPDF calls */
function listRaw(engine, docId, pageIdx) {
  const ctx = engine.cache.getContext(docId)
  return ctx.borrowPage(pageIdx, (pageCtx) => {
    const out = []
    const count = pdfium.FPDFPage_GetAnnotCount(pageCtx.pagePtr)
    for (let i = 0; i < count; i++) {
      const annotPtr = pdfium.FPDFPage_GetAnnot(pageCtx.pagePtr, i)
      out.push({ index: i, objNum: pdfium.EPDFAnnot_GetObjectNumber(annotPtr) })
      pdfium.FPDFPage_CloseAnnot(annotPtr)
    }
    return out
  })
}

// 1. create a highlight, find its obj# BEFORE saving
console.log('== create + obj# before save ==')
const bytes = fs.readFileSync(SAMPLE_PDF)
const doc = await open('a', bytes)
const page = doc.pages[1]
const uuid = randomUUID()
await engine
  .createPageAnnotation(doc, page, {
    id: uuid,
    pageIndex: page.index,
    type: PdfAnnotationSubtype.HIGHLIGHT,
    rect: rect(70, 70, 200, 16),
    segmentRects: [rect(70, 70, 200, 16)],
    strokeColor: '#FFD54A',
    opacity: 0.5
  })
  .toPromise()
const rawList = listRaw(engine, 'a', page.index)
console.log('annots (index -> objNum):', JSON.stringify(rawList))
const created = rawList[rawList.length - 1]
console.log('created annotation objNum:', created.objNum)

const saved1 = Buffer.from(await engine.saveAsCopy(doc).toPromise())
await engine.closeDocument(doc).toPromise()

// cross-check with mupdf: is that objNum the same in the SAVED file?
{
  const mdoc = mupdf.Document.openDocument(saved1, 'application/pdf').asPDF()
  const mp = mdoc.loadPage(page.index)
  const objs = mp.getAnnotations().map((a) => a.getObject().asIndirect())
  console.log('mupdf sees objNums in saved file:', JSON.stringify(objs))
  console.log(objs.includes(created.objNum)
    ? '=> obj# STABLE through saveAsCopy'
    : '=> obj# CHANGED during save (must re-derive after save!)')
  mdoc.destroy()
}

// 2. reopen, find BY objNum via EPDFPage_GetAnnotByObjectNumber, recolor, save
console.log('\n== find by obj# after reopen, modify ==')
const doc2 = await open('b', saved1)
const ctx2 = engine.cache.getContext('b')
const found = ctx2.borrowPage(page.index, (pageCtx) => {
  const annotPtr = pdfium.EPDFPage_GetAnnotByObjectNumber(pageCtx.pagePtr, created.objNum)
  if (!annotPtr) return null
  const subtype = pdfium.FPDFAnnot_GetSubtype(annotPtr)
  const index = pdfium.EPDFPage_GetAnnotIndex ? pdfium.EPDFPage_GetAnnotIndex(pageCtx.pagePtr, annotPtr) : -1
  pdfium.FPDFPage_CloseAnnot(annotPtr)
  return { subtype, index }
})
console.log('EPDFPage_GetAnnotByObjectNumber(', created.objNum, ') ->', JSON.stringify(found))

// bridge to the high-level API: obj# -> index -> model object (same /Annots order)
const models = await engine.getPageAnnotations(doc2, doc2.pages[page.index]).toPromise()
const raw2 = listRaw(engine, 'b', page.index)
const idx = raw2.find((r) => r.objNum === created.objNum)?.index
const model = idx !== undefined ? models[idx] : undefined
console.log('high-level model at same index:', model ? `type=${model.type} id=${model.id}` : 'NOT FOUND')
console.log('uuid preserved:', model?.id === uuid)

if (model) {
  model.strokeColor = '#6FB6FF'
  const ok = await engine.updatePageAnnotation(doc2, doc2.pages[page.index], model).toPromise()
  const saved2 = Buffer.from(await engine.saveAsCopy(doc2).toPromise())
  // verify color in an independent parser + obj# still intact
  const mdoc = mupdf.Document.openDocument(saved2, 'application/pdf').asPDF()
  const mp = mdoc.loadPage(page.index)
  const target = mp.getAnnotations().find((a) => a.getObject().asIndirect() === created.objNum)
  console.log(`update ok=${ok}; mupdf color after 2nd save:`, target ? JSON.stringify(Array.from(target.getColor(), (v) => Math.round(v * 255))) : 'annot NOT at same objNum!')
  mdoc.destroy()
}
await engine.closeDocument(doc2).toPromise()

// 3. delete by obj#
console.log('\n== delete by obj# ==')
const doc3 = await open('c', saved1)
const before = (await engine.getPageAnnotations(doc3, doc3.pages[page.index]).toPromise()).length
const removed = engine.cache.getContext('c').borrowPage(page.index, (pageCtx) =>
  pdfium.EPDFPage_RemoveAnnotByObjectNumber(pageCtx.pagePtr, created.objNum)
)
const after = (await engine.getPageAnnotations(doc3, doc3.pages[page.index]).toPromise()).length
console.log(`EPDFPage_RemoveAnnotByObjectNumber -> ${removed}; count ${before} -> ${after}`)
await engine.closeDocument(doc3).toPromise()

engine.destroy()
console.log('\nOBJ# BRIDGE SPIKE DONE')

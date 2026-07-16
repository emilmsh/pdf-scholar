// Spike: can a mupdf PDFDocument stay open across incremental saves?
// Sequence: open -> annot A -> saveToBuffer(incremental) -> write file ->
// (same doc, still open) annot B -> saveToBuffer(incremental) -> write ->
// reopen from disk after EACH save: is the file clean (no xref repair)?
//
// VERDICT (mupdf 1.28, 2026-07): saves from a kept-open doc corrupt the xref
// chain ("expected 'obj' keyword ... repairing PDF document" on reopen).
// Content survives via repair, but shipping files that need repair is
// unacceptable -> the doc-cache CLOSES and REOPENS the mupdf doc after every
// flush (flushes are debounced, so the cost still amortizes across writes).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as mupdf from 'mupdf'

const SAMPLE = path.join(process.cwd(), 'src', 'renderer', 'public', 'sample.pdf')
const FILE = path.join(os.tmpdir(), 'spike-mupdf-cached.pdf')
fs.copyFileSync(SAMPLE, FILE)

const data = fs.readFileSync(FILE)
const pdf = mupdf.Document.openDocument(data, 'application/pdf').asPDF()
console.log('canBeSavedIncrementally (fresh):', pdf.canBeSavedIncrementally())

function addHighlight(pdf, y, author) {
  const page = pdf.loadPage(0)
  const annot = page.createAnnotation('Highlight')
  annot.setQuadPoints([[60, y, 460, y, 60, y + 14, 460, y + 14]])
  annot.setColor([1, 0.84, 0.29])
  annot.setAuthor(author)
  annot.update()
  return annot.getObject().asIndirect()
}

function save(pdf, file) {
  const opts = pdf.canBeSavedIncrementally() ? 'incremental' : 'garbage=2'
  const buf = pdf.saveToBuffer(opts)
  fs.writeFileSync(file, buf.asUint8Array())
  buf.destroy()
  return opts
}

// mupdf prints "repairing PDF document" warnings to stderr synchronously on
// open when the xref chain is broken — reopen after each save to see exactly
// which save corrupts the file.
function reopenReport(label, expected) {
  const pdf2 = mupdf.Document.openDocument(fs.readFileSync(FILE), 'application/pdf').asPDF()
  const n = pdf2.loadPage(0).getAnnotations().length
  console.log(`${label}: reopened, ${n} annots (expected ${expected})`)
  pdf2.destroy()
}

const idA = addHighlight(pdf, 100, 'A')
console.log(`save#1 opts=${save(pdf, FILE)} size=${fs.statSync(FILE).size} idA=${idA}`)
reopenReport('after save#1', 1)

const idB = addHighlight(pdf, 130, 'B')
console.log(`save#2 opts=${save(pdf, FILE)} size=${fs.statSync(FILE).size} idB=${idB}`)
reopenReport('after save#2', 2)

const page = pdf.loadPage(0)
for (const a of page.getAnnotations()) {
  if (a.getObject().asIndirect() === idA) a.setColor([0.2, 0.5, 1])
}
console.log(`save#3 opts=${save(pdf, FILE)} size=${fs.statSync(FILE).size}`)
reopenReport('after save#3', 2)
pdf.destroy()

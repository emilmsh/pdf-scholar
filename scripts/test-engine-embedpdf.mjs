// Round-trip test of the PRODUCTION EmbedPDF adapter (annotation-engine-embedpdf.ts,
// bundled by esbuild to .engine-test-bundle.mjs — same code the app runs).
// Exercises the full AnnotationEngine contract: create all 11 types -> recolor
// -> translate -> delete -> independent verification with mupdf.
//
// Run: node scripts/test-engine-embedpdf.mjs   (after esbuild bundling)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { applyAnnotation, updateAnnotation, deleteAnnotation, flushAnnotations } from './.engine-test-bundle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')
const FILE = path.join(os.tmpdir(), 'pdfx-engine-test.pdf')
fs.copyFileSync(SAMPLE, FILE)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const q = (x, y, w, h) => [{ x, y, w, h }]
const base = { path: FILE, pageIndex: 1, opacity: 1, color: [0.89, 0.29, 0.29], author: 'test' }

// 1. create all 11 types through the production applyAnnotation
const reqs = [
  { ...base, type: 'highlight', quads: q(70, 70, 200, 16), color: [1, 0.84, 0.29], opacity: 0.5 },
  { ...base, type: 'underline', quads: q(70, 95, 180, 14) },
  { ...base, type: 'strikeout', quads: q(70, 115, 160, 14) },
  { ...base, type: 'squiggly', quads: q(70, 135, 140, 14) },
  { ...base, type: 'note', quads: q(300, 70, 20, 20), contents: 'Notat' },
  { ...base, type: 'ink', quads: q(70, 170, 120, 40), strokes: [[[72, 200], [100, 175], [130, 205]]], width: 2.2 },
  { ...base, type: 'square', quads: q(70, 230, 110, 60), width: 2 },
  { ...base, type: 'circle', quads: q(200, 230, 110, 60), width: 2 },
  { ...base, type: 'line', quads: q(70, 310, 160, 40), strokes: [[[72, 345], [225, 315]]], width: 2 },
  { ...base, type: 'arrow', quads: q(70, 360, 160, 40), strokes: [[[72, 395], [225, 365]]], width: 2 },
  { ...base, type: 'freetext', quads: q(300, 310, 200, 48), contents: 'Fri tekst ÆØÅ', fontSize: 12, color: [0.11, 0.11, 0.13] }
]
const ids = {}
for (const req of reqs) {
  const res = await applyAnnotation(req)
  check(`create ${req.type}`, 'ok' in res && res.id > 0, 'ok' in res ? `obj#${res.id}` : res.error)
  if ('ok' in res) ids[req.type] = res.id
}

// 2. recolor the highlight through the production updateAnnotation
{
  const res = await updateAnnotation({ path: FILE, pageIndex: 1, id: ids.highlight, color: [0.44, 0.71, 1] })
  check('update color (highlight)', 'ok' in res, 'error' in res ? res.error : '')
}

// 3. translate the arrow and the note
{
  const res = await updateAnnotation({ path: FILE, pageIndex: 1, id: ids.arrow, translate: { dx: 15, dy: 10 } })
  check('translate arrow', 'ok' in res, 'error' in res ? res.error : '')
  const res2 = await updateAnnotation({ path: FILE, pageIndex: 1, id: ids.note, translate: { dx: -5, dy: 30 } })
  check('translate note', 'ok' in res2, 'error' in res2 ? res2.error : '')
}

// 4. edit freetext contents + rect (the new resize path)
{
  const res = await updateAnnotation({
    path: FILE, pageIndex: 1, id: ids.freetext,
    contents: 'Endret tekst', rect: { x: 300, y: 310, w: 240, h: 80 }
  })
  check('freetext contents+rect', 'ok' in res, 'error' in res ? res.error : '')
}

// 5. delete the square
{
  const res = await deleteAnnotation({ path: FILE, pageIndex: 1, id: ids.square })
  check('delete square', 'ok' in res, 'error' in res ? res.error : '')
}

// 6. independent verification with mupdf. All writes above hit the engine's
// document cache (one open doc, debounced flush) — force the flush so the
// file on disk reflects every operation before reopening it.
{
  await flushAnnotations(FILE)
  const pdf = mupdf.Document.openDocument(fs.readFileSync(FILE), 'application/pdf').asPDF()
  const annots = pdf.loadPage(1).getAnnotations()
  const byId = new Map(annots.map((a) => [a.getObject().asIndirect(), a]))
  check('mupdf reopens the file', true, `${annots.length} annots`)
  check('square is gone', !byId.has(ids.square))
  const hl = byId.get(ids.highlight)
  check('highlight recolored', hl && Array.from(hl.getColor(), (v) => Math.round(v * 255)).join(',') === '112,181,255',
    hl ? Array.from(hl.getColor(), (v) => Math.round(v * 255)).join(',') : 'missing')
  // Created at start (72,395) end (225,365); translated by (15,10) — the /L
  // endpoints themselves must move, not just the rect (stale-AP guard).
  const arrow = byId.get(ids.arrow)
  const line = arrow?.getLine()
  const lineOk =
    line &&
    Math.round(line[0][0]) === 87 && Math.round(line[0][1]) === 405 &&
    Math.round(line[1][0]) === 240 && Math.round(line[1][1]) === 375
  check('arrow endpoints moved', !!lineOk, line ? JSON.stringify(line.map((p) => p.map(Math.round))) : 'missing')
  // /LE arrowhead must survive the update
  let le = 'none'
  try { const o = arrow?.getObject().get('LE'); le = o && !o.isNull() ? String(o) : 'none' } catch { /* keep */ }
  check('arrowhead (/LE) intact', /ClosedArrow/.test(le), le)
  const ft = byId.get(ids.freetext)
  check('freetext text updated', ft?.getContents() === 'Endret tekst', JSON.stringify(ft?.getContents()))
  check('freetext resized', ft && Math.round(ft.getRect()[2] - ft.getRect()[0]) === 240,
    ft ? `w=${Math.round(ft.getRect()[2] - ft.getRect()[0])}` : 'missing')
  let ap = 0
  for (const a of annots) {
    try { const o = a.getObject().get('AP'); if (o && !o.isNull()) ap++ } catch { /* skip */ }
  }
  check('all annots have /AP', ap === annots.length, `${ap}/${annots.length}`)
  pdf.destroy()
}

// 7. document-open cache: two writes in quick succession reuse ONE cached doc
// (the flush in step 6 evicted it, so the first write reopens from disk);
// an explicit flush + reopen must show both with their reported object numbers.
{
  const base7 = { ...base, type: 'highlight', opacity: 0.5, color: [0.44, 0.71, 1] }
  const r1 = await applyAnnotation({ ...base7, quads: q(70, 430, 150, 14) })
  const r2 = await applyAnnotation({ ...base7, quads: q(70, 450, 150, 14) })
  check('cache write #1', 'ok' in r1 && r1.id > 0, 'ok' in r1 ? `obj#${r1.id}` : r1.error)
  check('cache write #2', 'ok' in r2 && r2.id > 0, 'ok' in r2 ? `obj#${r2.id}` : r2.error)
  check('cache ids distinct', 'ok' in r1 && 'ok' in r2 && r1.id !== r2.id)
  await flushAnnotations(FILE)
  const pdf = mupdf.Document.openDocument(fs.readFileSync(FILE), 'application/pdf').asPDF()
  const objs = new Set(pdf.loadPage(1).getAnnotations().map((a) => a.getObject().asIndirect()))
  check('cached write #1 flushed with correct id', objs.has(r1.id))
  check('cached write #2 flushed with correct id', objs.has(r2.id))
  pdf.destroy()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

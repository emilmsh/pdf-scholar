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

// 8. link-AP guard: getPageAnnotations (run by updateAnnotation) makes PDFium
// synthesize /AP for border-only Link annots — hyperref's green citation
// boxes. The guard must strip exactly those after every op, while a link that
// legitimately shipped WITH an /AP keeps it. See src/shared/link-ap-guard.ts.
{
  // Minimal single-page PDF: link #1 is hyperref-style (/Border+/C, no /AP),
  // link #2 carries its own appearance stream. Offsets computed, not typed.
  const buildLinkFixture = () => {
    const objs = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Annots[4 0 R 5 0 R]/Contents 6 0 R>>',
      '<</Type/Annot/Subtype/Link/Rect[100 700 160 715]/Border[0 0 1]/C[0 1 0]/A<</S/URI/URI(https://example.org)>>>>',
      '<</Type/Annot/Subtype/Link/Rect[100 650 160 665]/Border[0 0 1]/C[0 1 0]/AP<</N 7 0 R>>/A<</S/URI/URI(https://example.org)>>>>',
      '<</Length 0>>\nstream\n\nendstream',
      '<</Type/XObject/Subtype/Form/BBox[100 650 160 665]/Length 31>>\nstream\n0 1 0 RG 1 w 100 650 60 15 re S\nendstream'
    ]
    let out = '%PDF-1.4\n'
    const offsets = []
    for (let i = 0; i < objs.length; i++) {
      offsets.push(out.length)
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
    }
    const xref = out.length
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(out, 'latin1')
  }
  const LINKFILE = path.join(os.tmpdir(), 'pdfx-linkguard-test.pdf')
  fs.writeFileSync(LINKFILE, buildLinkFixture())

  const lbase = { path: LINKFILE, pageIndex: 0, opacity: 0.5, color: [1, 0.84, 0.29], author: 'test' }
  const r1 = await applyAnnotation({ ...lbase, type: 'highlight', quads: q(100, 600, 200, 16) })
  check('linkguard: create highlight', 'ok' in r1, 'error' in r1 ? r1.error : '')
  // update runs getPageAnnotations — the call that synthesizes link /AP
  const r2 = await updateAnnotation({ path: LINKFILE, pageIndex: 0, id: r1.id, color: [0.44, 0.71, 1] })
  check('linkguard: update highlight', 'ok' in r2, 'error' in r2 ? r2.error : '')
  await flushAnnotations(LINKFILE)

  const pdf = mupdf.Document.openDocument(fs.readFileSync(LINKFILE), 'application/pdf').asPDF()
  const pageObj = pdf.findPage(0)
  const arr = pageObj.get('Annots')
  const links = []
  let hlAp = false
  for (let i = 0; i < arr.length; i++) {
    const a = arr.get(i)
    const st = a.get('Subtype').asName()
    if (st === 'Link') links.push(a)
    else if (st === 'Highlight') hlAp = !a.get('AP').isNull()
  }
  const bare = links.find((a) => a.get('AP').isNull())
  const owned = links.find((a) => !a.get('AP').isNull())
  check('linkguard: border-only link kept AP-less', links.length === 2 && !!bare,
    `${links.filter((a) => a.get('AP').isNull()).length} of ${links.length} AP-less`)
  check('linkguard: /Border + /C intact', !!bare && bare.get('Border').toString() === '[0 0 1]' && bare.get('C').toString() === '[0 1 0]',
    bare ? `${bare.get('Border')} ${bare.get('C')}` : 'missing')
  check('linkguard: shipped link AP survives', !!owned)
  check('linkguard: highlight has /AP', hlAp)
  pdf.destroy()
  fs.rmSync(LINKFILE, { force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

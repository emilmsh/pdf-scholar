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
import { signaturePng } from './lib/tiny-png.mjs'
import { applyAnnotation, updateAnnotation, deleteAnnotation, flushAnnotations, setFormField } from './.engine-test-bundle.mjs'

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
const SIGNATURE = new Uint8Array(signaturePng())
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
  { ...base, type: 'freetext', quads: q(300, 310, 200, 48), contents: 'Fri tekst ÆØÅ', fontSize: 12, color: [0.11, 0.11, 0.13] },
  // The signature stamp: real PNG bytes, embedded by PDFium into the appearance
  // stream as an image XObject. Unlike every other type here the pixels ride in
  // createPageAnnotation's CONTEXT argument, not the annotation model.
  { ...base, type: 'stamp', quads: q(320, 420, 180, 68), image: SIGNATURE }
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

// 4b. RESHAPE: the request carries the NEW geometry outright (quads / strokes),
// which is what makes a mark editable at all — before this, getting one line
// more of a highlight meant deleting it and drawing again.
{
  const hl = await updateAnnotation({
    path: FILE, pageIndex: 1, id: ids.highlight,
    quads: [{ x: 70, y: 70, w: 200, h: 16 }, { x: 70, y: 88, w: 120, h: 16 }]
  })
  check('reshape highlight (1 -> 2 quads)', 'ok' in hl, 'error' in hl ? hl.error : '')
  // Same shape, scaled ~2x horizontally and vertically about its top-left
  const ink = await updateAnnotation({
    path: FILE, pageIndex: 1, id: ids.ink,
    strokes: [[[72, 200], [128, 150], [188, 210]]]
  })
  check('reshape ink (scaled strokes)', 'ok' in ink, 'error' in ink ? ink.error : '')
  const ln = await updateAnnotation({
    path: FILE, pageIndex: 1, id: ids.line,
    strokes: [[[80, 340], [300, 300]]]
  })
  check('reshape line (new endpoints)', 'ok' in ln, 'error' in ln ? ln.error : '')
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
  // Reshaped in 4b. Read the raw dict values for the geometry keys (the
  // accessor methods differ per subtype) and mupdf's own rect for the
  // appearance: /Rect is derived from the regenerated /AP, so a rect that
  // followed proves the appearance did too — a stale AP would keep the old box.
  const rawNums = (annot, key) => {
    try {
      const o = annot?.getObject().get(key)
      if (!o || o.isNull()) return []
      return (String(o).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    } catch { return [] }
  }
  // mupdf refuses getRect() on subtypes whose box is derived (Highlight, Ink,
  // Line …), so read /Rect straight from the dict — same numbers, no guard.
  const rectOf = (annot) => {
    const r = rawNums(annot, 'Rect')
    return r.length === 4 ? { w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) } : null
  }
  const qp = rawNums(hl, 'QuadPoints')
  check('highlight reshaped to 2 quads', qp.length === 16, `${qp.length / 8} quads`)
  const hlBox = rectOf(hl)
  check('highlight box covers both lines', !!hlBox && Math.abs(hlBox.h - 34) <= 2,
    hlBox ? `h=${hlBox.h.toFixed(1)}` : 'no /Rect')
  const inkA = byId.get(ids.ink)
  const inkPts = rawNums(inkA, 'InkList')
  const inkMaxX = inkPts.length ? Math.round(Math.max(...inkPts.filter((_, i) => i % 2 === 0))) : 0
  check('ink strokes rewritten', inkPts.length === 6 && inkMaxX === 188, `${inkPts.length / 2} pts, maxX=${inkMaxX}`)
  const inkBox = rectOf(inkA)
  check('ink appearance follows the strokes', !!inkBox && Math.abs(inkBox.w - 120.4) <= 3,
    inkBox ? `w=${inkBox.w.toFixed(1)}` : 'no /Rect')
  const ln2 = byId.get(ids.line)?.getLine()
  const lnOk = ln2 &&
    Math.round(ln2[0][0]) === 80 && Math.round(ln2[0][1]) === 340 &&
    Math.round(ln2[1][0]) === 300 && Math.round(ln2[1][1]) === 300
  check('line endpoints rewritten', !!lnOk, ln2 ? JSON.stringify(ln2.map((p) => p.map(Math.round))) : 'missing')
  const ft = byId.get(ids.freetext)
  check('freetext text updated', ft?.getContents() === 'Endret tekst', JSON.stringify(ft?.getContents()))
  check('freetext resized', ft && Math.round(ft.getRect()[2] - ft.getRect()[0]) === 240,
    ft ? `w=${Math.round(ft.getRect()[2] - ft.getRect()[0])}` : 'missing')
  let ap = 0
  for (const a of annots) {
    try { const o = a.getObject().get('AP'); if (o && !o.isNull()) ap++ } catch { /* skip */ }
  }
  check('all annots have /AP', ap === annots.length, `${ap}/${annots.length}`)
  // The stamp is only worth anything if the PICTURE went in. Check the box it
  // landed in, and that the file really carries an image XObject — an /AP that
  // draws nothing would satisfy the check above while showing blank everywhere.
  const stamp = byId.get(ids.stamp)
  check('stamp is a /Stamp', stamp?.getType() === 'Stamp', stamp ? stamp.getType() : 'missing')
  const stampBox = rectOf(stamp)
  check('stamp keeps its box', !!stampBox && Math.abs(stampBox.w - 180) <= 1 && Math.abs(stampBox.h - 68) <= 1,
    stampBox ? `${stampBox.w.toFixed(1)}×${stampBox.h.toFixed(1)}` : 'no /Rect')
  const bytes = fs.readFileSync(FILE).toString('latin1')
  check('file carries an image XObject', /\/Subtype\s*\/Image/.test(bytes))
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

// 9. pressure ink: a pen stroke's varying width must survive INTO the file —
// custom /AP (filled variable-width outline via FPDFAnnot_SetAP), centerline
// /InkList intact, pressures stored (PDFX_Pressures) so moves re-bake, and
// translucency carried INSIDE the appearance (annot-dict /CA alone is not
// honoured over an /AP by e.g. mupdf). Pixels are the proof for all of it.
{
  const PFILE = path.join(os.tmpdir(), 'pdfx-pressure-test.pdf')
  fs.copyFileSync(SAMPLE, PFILE)
  const N = 40
  const stroke = Array.from({ length: N }, (_, i) => [80 + (240 * i) / (N - 1), 400])
  const pressures = Array.from({ length: N }, (_, i) => 0.15 + (0.85 * i) / (N - 1))
  const pbase = { path: PFILE, pageIndex: 1, quads: [], color: [0.89, 0.29, 0.29], width: 6, author: 'test' }

  const p1 = await applyAnnotation({ ...pbase, type: 'ink', opacity: 1, strokes: [stroke], pressures: [pressures] })
  check('pressure: create', 'ok' in p1, 'error' in p1 ? p1.error : `obj#${p1.id}`)
  const p2 = await applyAnnotation({
    ...pbase, type: 'ink', opacity: 0.45,
    strokes: [stroke.map(([x, y]) => [x, y + 60])], pressures: [pressures]
  })
  check('pressure: create @45%', 'ok' in p2, 'error' in p2 ? p2.error : '')
  // Moves re-bake the appearance from the stored pressures
  const m1 = await updateAnnotation({ path: PFILE, pageIndex: 1, id: p1.id, translate: { dx: 0, dy: -120 } })
  check('pressure: translate', 'ok' in m1, 'error' in m1 ? m1.error : '')
  const m2 = await updateAnnotation({ path: PFILE, pageIndex: 1, id: p2.id, translate: { dx: 0, dy: 40 } })
  check('pressure: translate @45%', 'ok' in m2, 'error' in m2 ? m2.error : '')
  await flushAnnotations(PFILE)

  const pdf = mupdf.Document.openDocument(fs.readFileSync(PFILE), 'application/pdf').asPDF()
  const page = pdf.loadPage(1)
  const a1 = page.getAnnotations().find((a) => a.getObject().asIndirect() === p1.id)
  check('pressure: annot present after flush', !!a1)
  if (a1) {
    const obj = a1.getObject()
    const ap = obj.get('AP')?.get('N')
    const content = ap && !ap.isNull() ? new TextDecoder('latin1').decode(ap.readStream().asUint8Array()) : ''
    check('pressure: AP is our filled outline', content.includes(' rg') && content.includes('f\n') && !/\bS\b/.test(content),
      `${content.length} bytes`)
    const inkList = obj.get('InkList')
    check('pressure: InkList centerline intact', !!inkList && !inkList.isNull() && inkList.get(0).length === 2 * N,
      inkList && !inkList.isNull() ? `${inkList.get(0).length / 2} points` : 'missing')
    const stored = obj.get('PDFX_Pressures')
    check('pressure: pressures survive translate', !!stored && !stored.isNull() && stored.asString().split(' ').length === N,
      stored && !stored.isNull() ? `${stored.asString().split(' ').length} values` : 'missing')
  }
  // Pixel proof: rendered thickness grows with pressure; 45% renders lighter.
  const SCALE = 4
  const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true)
  const W = pix.getWidth()
  const px = pix.getPixels()
  const isReddish = (i) => px[i] > 150 && px[i] - px[i + 1] > 40 && px[i] - px[i + 2] > 40
  const thickness = (xPt, y0, y1) => {
    const x = Math.round(xPt * SCALE)
    let n = 0
    for (let y = Math.round(y0 * SCALE); y < Math.round(y1 * SCALE); y++) if (isReddish((y * W + x) * 3)) n++
    return n
  }
  const thin = thickness(90, 240, 320)
  const thick = thickness(290, 240, 320)
  check('pressure: thick end ≥ 1.5× thin end', thin > 0 && thick / thin >= 1.5, `${thin}px vs ${thick}px`)
  const coreGreen = (xPt, y0, y1) => {
    const x = Math.round(xPt * SCALE)
    let sum = 0, n = 0
    for (let y = Math.round(y0 * SCALE); y < Math.round(y1 * SCALE); y++) {
      const i = (y * W + x) * 3
      if (px[i] > px[i + 1] && px[i] - px[i + 1] > 15) { sum += px[i + 1]; n++ }
    }
    return n ? sum / n : -1
  }
  const gOpaque = coreGreen(290, 240, 320)
  const gTrans = coreGreen(290, 460, 540)
  check('pressure: 45% stays translucent after move', gOpaque >= 0 && gTrans > gOpaque + 25,
    `green ${Math.round(gOpaque)} vs ${Math.round(gTrans)}`)
  pdf.destroy()
  fs.rmSync(PFILE, { force: true })
}

// 10. the text box's TYPEFACE: one of the PDF Standard 14, chosen in the tool
// menu and written into the annotation's /DA. Nothing is embedded — that is the
// whole point of the fourteen — so what this proves is that the face SURVIVES
// into the file and is the one that was asked for. (v0.35–v0.36 had a
// handwriting note here instead: a Stamp full of drawn glyphs in an embedded
// font. It was removed in v0.37 — see the note in shared/types.ts.)
{
  const FFILE = path.join(os.tmpdir(), 'pdfx-textfont-test.pdf')
  fs.copyFileSync(SAMPLE, FFILE)
  const fbase = { path: FFILE, pageIndex: 0, color: [0.1, 0.1, 0.12], opacity: 1 }
  // 10 = Times-BoldItalic in PdfStandardFont — a face nothing defaults to, so
  // finding it in the file cannot be a coincidence.
  const TIMES_BOLD_ITALIC = 10
  const f1 = await applyAnnotation({
    ...fbase, type: 'freetext', quads: q(40, 120, 220, 40),
    contents: 'Times, fet og kursiv', fontSize: 14, font: TIMES_BOLD_ITALIC
  })
  check('textfont: create with a chosen face', 'ok' in f1, 'error' in f1 ? f1.error : `obj#${f1.id}`)
  // A face nobody chose falls back to Helvetica rather than to nothing
  const f2 = await applyAnnotation({
    ...fbase, type: 'freetext', quads: q(40, 200, 220, 40),
    contents: 'Uten valgt skrift', fontSize: 14
  })
  check('textfont: create without one', 'ok' in f2, 'error' in f2 ? f2.error : `obj#${f2.id}`)
  // A box that ALREADY EXISTS can be re-set in another face (Emil, 2026-08-09).
  // Until then the toolbar's font choice only ever reached boxes that did not
  // exist yet, so a paragraph typed in the wrong face had to be retyped.
  //
  // 0 = Courier in PdfStandardFont — and note that it is ZERO, which is why
  // every hop in this path guards on `!== undefined` rather than truthiness.
  // A `req.font &&` anywhere between the popover and EPDFAnnot_SetDefaultAppearance
  // would silently drop Courier alone, and the box would keep its old face while
  // every layer reported success.
  const COURIER = 0
  const f3 = await applyAnnotation({
    ...fbase, type: 'freetext', quads: q(40, 280, 220, 40),
    contents: 'Skrevet i Helvetica', fontSize: 14
  })
  check('textfont: create the box to re-set', 'ok' in f3, 'error' in f3 ? f3.error : `obj#${f3.id}`)
  if ('ok' in f3) {
    const changed = await updateAnnotation({
      path: FFILE, pageIndex: 0, id: f3.id, font: COURIER
    })
    check('textfont: re-set an existing box', 'ok' in changed,
      'error' in changed ? changed.error : '')
  }
  await flushAnnotations(FFILE)

  const doc = mupdf.Document.openDocument(fs.readFileSync(FFILE), 'application/pdf')
  const page = doc.loadPage(0)
  const byId = (id) => {
    for (const a of page.getAnnotations()) {
      if (a.getObject().asIndirect() === id) return a.getObject()
    }
    return null
  }
  const o1 = 'ok' in f1 ? byId(f1.id) : null
  const o2 = 'ok' in f2 ? byId(f2.id) : null
  const o3 = 'ok' in f3 ? byId(f3.id) : null
  check('textfont: the box is a FreeText, not a Stamp',
    o1 && String(o1.get('Subtype')) === '/FreeText', o1 ? String(o1.get('Subtype')) : 'missing')
  const da1 = o1?.get('DA')
  const daText = da1 && !da1.isNull() ? da1.asString() : ''
  check('textfont: /DA names the chosen face', /Times/i.test(daText), daText || 'no /DA')
  const da2 = o2?.get('DA')
  const daText2 = da2 && !da2.isNull() ? da2.asString() : ''
  check('textfont: an unset face writes Helvetica', /Helv/i.test(daText2), daText2 || 'no /DA')
  // The words stay TEXT — the reason for stopping at the Standard 14 in the
  // first place. Two places have to carry them: /Contents (what the notes
  // panel, search and the exports read) and the appearance stream, as a real
  // show-text operator rather than as drawn outlines.
  const c1 = o1?.get('Contents')
  check('textfont: the words live in /Contents',
    !!c1 && !c1.isNull() && c1.asString() === 'Times, fet og kursiv',
    c1 && !c1.isNull() ? c1.asString() : 'missing')
  const ap1 = o1?.get('AP')?.get('N')
  const apText = ap1 && !ap1.isNull() ? ap1.readStream().asString() : ''
  check('textfont: the appearance SHOWS text, it does not draw glyphs',
    /BT/.test(apText) && /Tj|TJ/.test(apText), `${apText.length} bytes`)
  // The re-set box: the face in the file is the NEW one, the words survived the
  // rewrite, and the appearance is still a show-text operator — a font change
  // that silently turned the paragraph into drawn outlines would pass a "looks
  // like Courier" eyeball test and lose searchable text.
  const da3 = o3?.get('DA')
  const daText3 = da3 && !da3.isNull() ? da3.asString() : ''
  check('textfont: the re-set box names the NEW face', /Cour/i.test(daText3), daText3 || 'no /DA')
  check('textfont: and no longer the old one', !/Helv/i.test(daText3), daText3 || 'no /DA')
  const c3 = o3?.get('Contents')
  check('textfont: re-setting kept the words',
    !!c3 && !c3.isNull() && c3.asString() === 'Skrevet i Helvetica',
    c3 && !c3.isNull() ? c3.asString() : 'missing')
  const ap3 = o3?.get('AP')?.get('N')
  const apText3 = ap3 && !ap3.isNull() ? ap3.readStream().asString() : ''
  check('textfont: the re-set appearance still SHOWS text',
    /BT/.test(apText3) && /Tj|TJ/.test(apText3), `${apText3.length} bytes`)
  const raw = fs.readFileSync(FFILE)
  check('textfont: nothing was embedded (no /FontFile)', !raw.includes(Buffer.from('FontFile')))
  doc.destroy()
  fs.rmSync(FFILE, { force: true })
}

// 11. AcroForm field filling (engine slice — no UI yet). sample.pdf has no form
// fields, so the fixture is hand-built the way test-signatures.mjs builds its
// /Sig fixtures: one page carrying a text field, a read-only text field, a
// check box, a two-widget radio GROUP, a combo box, a list box — and a
// border-only hyperref Link, because merely OPENING a form-fill environment
// makes PDFium synthesize /AP for AP-less annotations on the page (measured),
// which is the same leak src/shared/link-ap-guard.ts exists for.
{
  // Object numbers are fixed up front rather than accumulated: the dictionaries
  // reference each other in both directions (a page lists its widgets, a radio
  // kid points back at its parent field).
  const N = {
    catalog: 1, pages: 2, page: 3, contents: 4, helv: 5,
    cbOn: 6, cbOff: 7, rbOn: 8, rbOff: 9,
    text: 10, wide: 11, readOnly: 12, checkbox: 13,
    radioParent: 14, radio1: 15, radio2: 16,
    combo: 17, list: 18, link: 19
  }
  const stream = (dict, content) =>
    `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`
  const widget = (body) => `<< /Type /Annot /Subtype /Widget /F 4 /P ${N.page} 0 R ${body} >>`
  const DA = '/DA (/Helv 12 Tf 0 g)'

  const objs = [
    `<< /Type /Catalog /Pages ${N.pages} 0 R /AcroForm << /Fields [${N.text} 0 R ${N.wide} 0 R ` +
      `${N.readOnly} 0 R ${N.checkbox} 0 R ${N.radioParent} 0 R ${N.combo} 0 R ${N.list} 0 R] ` +
      `/DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${N.helv} 0 R >> >> >> >>`,
    `<< /Type /Pages /Kids [${N.page} 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent ${N.pages} 0 R /MediaBox [0 0 612 792] /Contents ${N.contents} 0 R ` +
      `/Resources << /Font << /Helv ${N.helv} 0 R >> >> ` +
      `/Annots [${N.text} 0 R ${N.wide} 0 R ${N.readOnly} 0 R ${N.checkbox} 0 R ` +
      `${N.radio1} 0 R ${N.radio2} 0 R ${N.combo} 0 R ${N.list} 0 R ${N.link} 0 R] >>`,
    stream('', ''),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    // The two button states each need a real appearance: PDFium reads the /AP
    // /N dictionary's KEY to learn what this widget's "on" state is called.
    stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '0 0 0 RG 1 w 2 2 m 12 12 l S 2 12 m 12 2 l S'),
    stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '0 0 0 RG 1 w 0.5 0.5 13 13 re S'),
    stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '0 0 0 rg 4 4 6 6 re f'),
    stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '0 0 0 RG 1 w 0.5 0.5 13 13 re S'),
    widget(`/FT /Tx /T (navn) /Rect [72 700 300 720] ${DA} /V ()`),
    widget(`/FT /Tx /T (bred) /Rect [72 730 300 750] ${DA} /V ()`),
    widget(`/FT /Tx /Ff 1 /T (fast) /Rect [72 670 300 690] ${DA} /V (uroert)`),
    widget(
      `/FT /Btn /T (samtykke) /Rect [72 640 86 654] /V /Off /AS /Off ` +
        `/AP << /N << /Ja ${N.cbOn} 0 R /Off ${N.cbOff} 0 R >> >> /MK << /BC [0 0 0] >>`
    ),
    // /Ff 32768 = the Radio flag. The VALUE lives on this parent; the two kids
    // below are the widgets on the page — which is exactly why the object
    // number of a widget, not the field's /T name, is the address we fill by.
    `<< /FT /Btn /Ff 32768 /T (valg) /V /Off /Kids [${N.radio1} 0 R ${N.radio2} 0 R] >>`,
    widget(
      `/Parent ${N.radioParent} 0 R /Rect [72 610 86 624] /AS /Off ` +
        `/AP << /N << /A ${N.rbOn} 0 R /Off ${N.rbOff} 0 R >> >> /MK << /BC [0 0 0] >>`
    ),
    widget(
      `/Parent ${N.radioParent} 0 R /Rect [102 610 116 624] /AS /Off ` +
        `/AP << /N << /B ${N.rbOn} 0 R /Off ${N.rbOff} 0 R >> >> /MK << /BC [0 0 0] >>`
    ),
    // /Ff 131072 = Combo
    widget(`/FT /Ch /Ff 131072 /T (land) /Rect [72 570 300 590] ${DA} /Opt [(Norge) (Sverige) (Danmark)] /V ()`),
    widget(`/FT /Ch /T (farge) /Rect [72 500 300 560] ${DA} /Opt [(Rod) (Gronn) (Bla)] /V ()`),
    `<< /Type /Annot /Subtype /Link /Rect [72 460 200 476] /Border [0 0 1] /C [0 1 0] ` +
      `/A << /S /URI /URI (https://example.org) >> >>`
  ]
  let out = '%PDF-1.7\n'
  const offsets = []
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${N.catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  const FFILE = path.join(os.tmpdir(), 'pdfx-form-test.pdf')
  fs.writeFileSync(FFILE, Buffer.from(out, 'latin1'))

  const set = (id, value) => setFormField({ path: FFILE, pageIndex: 0, id, value })
  // Norwegian letters on purpose: a PDF text string is PDFDocEncoding (a
  // single byte per character) unless it opens with the UTF-16BE BOM, and
  // «æøå» is where a writer that guessed wrong falls over.
  const NAME = 'Åse Bjørk Ægir æøå'
  /** Beyond PDFDocEncoding entirely — this is the string that FORCES UTF-16. */
  const WIDE = 'Sun Tzu 孫子 → ✓'

  const rText = await set(N.text, { kind: 'text', text: NAME })
  check('form: fill text field', 'ok' in rText && rText.id === N.text,
    'error' in rText ? rText.code : `obj#${rText.id}`)
  const rWide = await set(N.wide, { kind: 'text', text: WIDE })
  check('form: fill text field beyond PDFDocEncoding', 'ok' in rWide,
    'error' in rWide ? rWide.code : '')
  const rCheck = await set(N.checkbox, { kind: 'checked', checked: true })
  check('form: tick check box', 'ok' in rCheck, 'error' in rCheck ? rCheck.code : '')
  // The SECOND kid of the radio group — per-widget addressing is the whole
  // point of using object numbers: both kids share the field name «valg».
  const rRadio = await set(N.radio2, { kind: 'checked', checked: true })
  check('form: select the 2nd radio kid', 'ok' in rRadio, 'error' in rRadio ? rRadio.code : '')
  const rCombo = await set(N.combo, { kind: 'choice-index', index: 1 })
  check('form: pick combo option', 'ok' in rCombo, 'error' in rCombo ? rCombo.code : '')
  const rList = await set(N.list, { kind: 'choice-index', index: 2 })
  check('form: pick list option', 'ok' in rList, 'error' in rList ? rList.code : '')

  // PDFium does NOT enforce /Ff ReadOnly — measured: it returns success and
  // writes the value. The refusal is ours, at this boundary.
  const rRo = await set(N.readOnly, { kind: 'text', text: 'skulle ikke gå inn' })
  check('form: read-only field is refused by CODE', 'error' in rRo && rRo.code === 'form-field-read-only',
    'error' in rRo ? rRo.code : 'accepted!')
  // Not a form field at all: the link's object number names a real annotation.
  const rLink = await set(N.link, { kind: 'text', text: 'nei' })
  check('form: a non-widget id is refused', 'error' in rLink && rLink.code === 'form-field-not-found',
    'error' in rLink ? rLink.code : 'accepted!')
  // PDFium reports SUCCESS for this and leaves /V alone (correct PDF semantics
  // — a radio group is only unset by picking a sibling — dishonest return
  // value). We read the field back instead of echoing the engine's ok.
  const rUncheck = await set(N.radio2, { kind: 'checked', checked: false })
  check('form: unchecking a radio is reported honestly, not as ok',
    'error' in rUncheck && rUncheck.code === 'form-field-not-written',
    'error' in rUncheck ? rUncheck.code : 'claimed ok!')

  await flushAnnotations(FFILE)

  // ---- independent verification with mupdf ----
  const raw = fs.readFileSync(FFILE)
  const pdf = mupdf.Document.openDocument(raw, 'application/pdf').asPDF()
  const page = pdf.findPage(0)
  const arr = page.get('Annots')
  const byNum = new Map()
  for (let i = 0; i < arr.length; i++) byNum.set(arr.get(i).asIndirect(), arr.get(i))
  const str = (num, key) => {
    const o = byNum.get(num)?.get(key)
    return o && !o.isNull() ? String(o) : ''
  }
  const text = (num, key) => {
    const o = byNum.get(num)?.get(key)
    return o && !o.isNull() ? o.asString() : ''
  }

  check('form: object numbers survived the fill + saveAsCopy',
    [N.text, N.wide, N.readOnly, N.checkbox, N.radio1, N.radio2, N.combo, N.list, N.link]
      .every((n) => byNum.has(n)),
    `${byNum.size} annots`)
  check('form: text /V round-trips byte-identical (æøå included)', text(N.text, 'V') === NAME,
    JSON.stringify(text(N.text, 'V')))
  check('form: a value beyond PDFDocEncoding round-trips too', text(N.wide, 'V') === WIDE,
    JSON.stringify(text(N.wide, 'V')))
  // Which ENCODING PDFium picks, read out of the file's own bytes rather than
  // through a parser that would hide the difference. Measured 2026-08-08: æøå
  // fits PDFDocEncoding and is written one byte per character; 孫 does not, and
  // that string gets the UTF-16BE BOM. Both are correct PDF text strings and
  // both survive — what this pins down is that neither is mangled into the
  // other, which is exactly how a value comes back as "Ã¦Ã¸Ã¥".
  check('form: æøå is written as a plain one-byte-per-char PDF string',
    raw.includes(Buffer.from(`/V(${NAME})`, 'latin1')))
  const utf16be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(WIDE, 'utf16le').swap16()
  ])
  check('form: a wider string is escalated to UTF-16BE with a BOM', raw.includes(utf16be))
  check('form: the filled text got an /AP (visible, not just parseable)',
    !byNum.get(N.text)?.get('AP').isNull())
  check('form: check box is on', str(N.checkbox, 'V') === '/Ja' && str(N.checkbox, 'AS') === '/Ja',
    `${str(N.checkbox, 'V')} / ${str(N.checkbox, 'AS')}`)
  // /V lives on the shared parent; /AS is what says WHICH kid.
  const parentV = String(byNum.get(N.radio2)?.get('Parent')?.get('V') ?? '')
  check('form: the 2nd radio kid is the one selected',
    parentV === '/B' && str(N.radio2, 'AS') === '/B' && str(N.radio1, 'AS') === '/Off',
    `V=${parentV} kid1=${str(N.radio1, 'AS')} kid2=${str(N.radio2, 'AS')}`)
  check('form: combo picked option 1', text(N.combo, 'V') === 'Sverige', JSON.stringify(text(N.combo, 'V')))
  check('form: list picked option 2', text(N.list, 'V') === 'Bla', JSON.stringify(text(N.list, 'V')))
  check('form: the read-only field kept its own value', text(N.readOnly, 'V') === 'uroert',
    JSON.stringify(text(N.readOnly, 'V')))
  // The guard's whole reason for existing, reached through the FORM door:
  // opening a form-fill environment synthesizes /AP for AP-less annots.
  check('form: the border-only link is still AP-less', byNum.get(N.link)?.get('AP').isNull() !== false)
  check('form: the link kept /Border + /C',
    str(N.link, 'Border') === '[0 0 1]' && str(N.link, 'C') === '[0 1 0]',
    `${str(N.link, 'Border')} ${str(N.link, 'C')}`)
  pdf.destroy()
  fs.rmSync(FFILE, { force: true })
}


// 12. OPTIONAL CONTENT GROUPS (layers) must survive a save. PDFium exposes no
// public OCG API at all — we neither read nor write layers — so the risk is not
// that we get them wrong, it is that a full-rewrite save silently FLATTENS a
// document that had them: a layered figure exported from Illustrator or a CAD
// drawing, annotated once, comes back with every layer fused and the hidden
// ones now visible. Nothing else in this suite would notice, because the marks
// we wrote would all be correct. pdf.js honours /OCProperties on display, so
// what we destroy here the reader WOULD see.
//
// The fixture carries the three places layer state lives: the catalog's
// /OCProperties (which groups exist, plus the /D default config saying which
// start off), the page's /Resources /Properties + /OC ... BDC marked content
// (which page content belongs to which group), and an annotation's own /OC
// (a mark that belongs to a layer).
{
  const N = { catalog: 1, pages: 2, page: 3, ocgOn: 4, ocgOff: 5, contents: 6, square: 7 }
  const content =
    '/OC /MC0 BDC\n1 0 0 RG 4 w 50 700 200 50 re S\nEMC\n' +
    '/OC /MC1 BDC\n0 0 1 rg 50 600 100 30 re f\nEMC\n'

  const objs = [
    `<< /Type /Catalog /Pages ${N.pages} 0 R /OCProperties << ` +
      `/OCGs [${N.ocgOn} 0 R ${N.ocgOff} 0 R] ` +
      `/D << /BaseState /ON /ON [${N.ocgOn} 0 R] /OFF [${N.ocgOff} 0 R] ` +
      `/Order [${N.ocgOn} 0 R ${N.ocgOff} 0 R] >> >> >>`,
    `<< /Type /Pages /Kids [${N.page} 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent ${N.pages} 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${N.contents} 0 R /Annots [${N.square} 0 R] ` +
      `/Resources << /Properties << /MC0 ${N.ocgOn} 0 R /MC1 ${N.ocgOff} 0 R >> >> >>`,
    `<< /Type /OCG /Name (Kartlag) >>`,
    `<< /Type /OCG /Name (Tekstlag) >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    // A mark that belongs to the layer which starts OFF: hiding «Tekstlag»
    // must keep hiding this square too.
    `<< /Type /Annot /Subtype /Square /Rect [300 700 400 760] /C [1 0 0] ` +
      `/OC ${N.ocgOff} 0 R /F 4 >>`
  ]
  let out = '%PDF-1.7\n'
  const offsets = []
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${N.catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  const OCFILE = path.join(os.tmpdir(), 'pdfx-ocg-test.pdf')
  fs.writeFileSync(OCFILE, Buffer.from(out, 'latin1'))

  // A normal annotation session: create, then edit. The edit is the one that
  // matters — updateAnnotation runs getPageAnnotations, the call that already
  // leaked once (see linkguard above) — and both go out through the
  // full-rewrite save.
  const obase = { path: OCFILE, pageIndex: 0, opacity: 0.5, color: [1, 0.84, 0.29], author: 'test' }
  const r1 = await applyAnnotation({ ...obase, type: 'highlight', quads: q(60, 400, 200, 16) })
  check('ocg: create highlight on a layered page', 'ok' in r1, 'error' in r1 ? r1.error : '')
  const r2 = await updateAnnotation({ path: OCFILE, pageIndex: 0, id: r1.id, color: [0.44, 0.71, 1] })
  check('ocg: update highlight on a layered page', 'ok' in r2, 'error' in r2 ? r2.error : '')
  await flushAnnotations(OCFILE)

  const pdf = mupdf.Document.openDocument(fs.readFileSync(OCFILE), 'application/pdf').asPDF()
  const name = (o) => (o && !o.isNull() && !o.get('Name').isNull() ? o.get('Name').asString() : '')
  const ocp = pdf.getTrailer().get('Root').get('OCProperties')
  check('ocg: /OCProperties survives the save', !ocp.isNull())

  const ocgs = ocp.isNull() ? null : ocp.get('OCGs')
  const ocgNames = []
  if (ocgs && !ocgs.isNull()) for (let i = 0; i < ocgs.length; i++) ocgNames.push(name(ocgs.get(i)))
  check('ocg: both groups still listed, names intact',
    ocgNames.length === 2 && ocgNames[0] === 'Kartlag' && ocgNames[1] === 'Tekstlag',
    JSON.stringify(ocgNames))

  // The default configuration is what decides what the reader SEES. Losing /D
  // (or just its /OFF list) turns every hidden layer visible.
  const d = ocp.isNull() ? null : ocp.get('D')
  const off = d && !d.isNull() ? d.get('OFF') : null
  check('ocg: the /D default config survives', !!d && !d.isNull())
  check('ocg: the layer that started hidden is still in /OFF',
    !!off && !off.isNull() && off.length === 1 && name(off.get(0)) === 'Tekstlag',
    off && !off.isNull() ? `${off.length} entries, first: ${name(off.get(0)) || 'unnamed'}` : 'missing')
  const order = d && !d.isNull() ? d.get('Order') : null
  check('ocg: the /Order tree (what a layer panel would list) survives',
    !!order && !order.isNull() && order.length === 2,
    order && !order.isNull() ? `${order.length} entries` : 'missing')

  // Page side: the marked-content operators plus the /Properties map that binds
  // /MC0 to a group. Either one missing and the content becomes unconditional.
  const page = pdf.findPage(0)
  const props = page.get('Resources').get('Properties')
  check('ocg: /Resources /Properties still maps MC0 + MC1 to the groups',
    !props.isNull() && name(props.get('MC0')) === 'Kartlag' && name(props.get('MC1')) === 'Tekstlag',
    props.isNull() ? 'missing' : `${name(props.get('MC0')) || '?'} / ${name(props.get('MC1')) || '?'}`)
  const cs = page.get('Contents')
  const csText = !cs.isNull() ? cs.readStream().asString() : ''
  check('ocg: the /OC ... BDC marked content is still in the page stream',
    csText.includes('/OC /MC0 BDC') && csText.includes('/OC /MC1 BDC') && csText.includes('EMC'),
    csText.includes('BDC') ? 'BDC present' : 'no BDC')

  // And the mark that belonged to a layer: an annotation whose /OC is dropped
  // becomes permanently visible, which is the version of this bug a reader
  // would actually notice.
  const annots = page.get('Annots')
  let layered = null
  let ours = false
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i)
    const st = a.get('Subtype').asName()
    if (st === 'Square') layered = a
    else if (st === 'Highlight') ours = true
  }
  check('ocg: our own highlight really landed', ours)
  check('ocg: the layered annotation kept its /OC',
    !!layered && name(layered.get('OC')) === 'Tekstlag',
    layered ? `OC -> ${name(layered.get('OC')) || 'gone'}` : 'square missing')
  pdf.destroy()
  fs.rmSync(OCFILE, { force: true })
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

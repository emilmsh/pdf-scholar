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

// 10. handwritten notes: a Stamp whose appearance holds text in an EMBEDDED
// handwriting font — the only subtype PDFium lets us append objects to
// (FPDFAnnot_IsObjectSupportedSubtype says no to FreeText). What matters is
// that the font travels inside the file (so the glyphs are identical
// everywhere), that the words stay in /Contents (so the notes panel, search
// and exports keep working), and that a move re-bakes rather than smearing.
{
  const HFILE = path.join(os.tmpdir(), 'pdfx-handnote-test.pdf')
  fs.copyFileSync(SAMPLE, HFILE)
  const lines = ['Can you connect this', 'to any contemporary', 'phenomenon?']
  const hbase = { path: HFILE, pageIndex: 1, opacity: 1, color: [0.82, 0.2, 0.18], author: 'test' }

  const h1 = await applyAnnotation({
    ...hbase, type: 'handnote', quads: q(40, 120, 150, 70), fontSize: 15,
    lines, contents: lines.join(' ')
  })
  check('handnote: create', 'ok' in h1, 'error' in h1 ? h1.error : `obj#${h1.id}`)
  const hMove = await updateAnnotation({
    path: HFILE, pageIndex: 1, id: h1.id, contents: lines.join(' '),
    hand: { lines, box: { x: 40, y: 300, w: 150, h: 70 }, fontSize: 15, color: [0.82, 0.2, 0.18] }
  })
  check('handnote: move re-bakes', 'ok' in hMove, 'error' in hMove ? hMove.error : '')
  // An empty one must be refused, not written as an invisible stamp
  const hEmpty = await applyAnnotation({
    ...hbase, type: 'handnote', quads: q(40, 500, 150, 40), fontSize: 15, lines: []
  })
  check('handnote: empty is refused', 'error' in hEmpty, 'error' in hEmpty ? hEmpty.code : 'accepted!')
  await flushAnnotations(HFILE)

  const raw = fs.readFileSync(HFILE)
  check('handnote: the font is EMBEDDED (/FontFile2)', raw.includes(Buffer.from('FontFile2')))
  check('handnote: it is the handwriting font', raw.includes(Buffer.from('PatrickHand')))

  const pdf = mupdf.Document.openDocument(raw, 'application/pdf').asPDF()
  const page = pdf.loadPage(1)
  const a = page.getAnnotations().find((x) => x.getObject().asIndirect() === h1.id)
  check('handnote: present after flush', !!a)
  if (a) {
    const obj = a.getObject()
    check('handnote: subtype is Stamp', String(obj.get('Subtype')) === '/Stamp', String(obj.get('Subtype')))
    const c = obj.get('Contents')
    check('handnote: words live in /Contents (panel, search, export)',
      !!c && !c.isNull() && /contemporary/.test(c.asString()),
      c && !c.isNull() ? JSON.stringify(c.asString()) : 'missing')
    const mark = obj.get('PDFX_Hand')
    check('handnote: marked as ours, not a foreign image stamp', !!mark && !mark.isNull())
    const ap = obj.get('AP')?.get('N')
    const content = ap && !ap.isNull()
      ? new TextDecoder('latin1').decode(ap.readStream().asUint8Array()) : ''
    check('handnote: the AP draws text', /BT/.test(content) && /Tj|TJ/.test(content), `${content.length} bytes`)
  }
  // Pixels: the glyphs are at the MOVED box and gone from the old one. This is
  // also what proves the appearance is drawn in FORM space — absolute page
  // coordinates get clipped by the /BBox and render nothing at all.
  const SC = 3
  const pix = page.toPixmap(mupdf.Matrix.scale(SC, SC), mupdf.ColorSpace.DeviceRGB, false, true)
  const W2 = pix.getWidth(), px2 = pix.getPixels()
  const redIn = (y0, y1) => {
    let n = 0
    for (let y = Math.round(y0 * SC); y < Math.round(y1 * SC); y++)
      for (let x = Math.round(35 * SC); x < Math.round(200 * SC); x++) {
        const i = (y * W2 + x) * 3
        if (px2[i] > 110 && px2[i] - px2[i + 1] > 45 && px2[i] - px2[i + 2] > 45) n++
      }
    return n
  }
  check('handnote: glyphs painted at the new box', redIn(295, 390) > 250, `${redIn(295, 390)} px`)
  check('handnote: nothing left at the old box', redIn(115, 195) < 40, `${redIn(115, 195)} px`)
  pdf.destroy()

  // DRAGGING one in the UI sends `translate`, not `hand` — and that used to go
  // through the generic model update, which rebuilds the appearance from a
  // model that knows nothing about our text objects: the /AP collapsed from
  // ~500 bytes to 42 and the note went blank. Every change to a handnote must
  // re-bake instead, from the state stored on the annotation.
  const h2 = await applyAnnotation({
    ...hbase, type: 'handnote', quads: q(300, 120, 150, 70), fontSize: 15,
    lines, contents: lines.join(' ')
  })
  const dragged = await updateAnnotation({
    path: HFILE, pageIndex: 1, id: h2.id, translate: { dx: 0, dy: 180 }
  })
  check('handnote: a plain translate (what a drag sends) works', 'ok' in dragged,
    'error' in dragged ? dragged.error : '')
  const recolored = await updateAnnotation({
    path: HFILE, pageIndex: 1, id: h2.id, color: [0.2, 0.3, 0.8]
  })
  check('handnote: a plain recolor works', 'ok' in recolored, 'error' in recolored ? recolored.error : '')
  await flushAnnotations(HFILE)
  {
    const p2 = mupdf.Document.openDocument(fs.readFileSync(HFILE), 'application/pdf').asPDF()
    const a2 = p2.loadPage(1).getAnnotations().find((x) => x.getObject().asIndirect() === h2.id)
    const ap2 = a2?.getObject().get('AP')?.get('N')
    const len = ap2 && !ap2.isNull() ? ap2.readStream().asUint8Array().length : 0
    // The blank-note bug showed up here and nowhere else: the annotation still
    // existed, still had an /AP, and the /AP was empty.
    check('handnote: the appearance survives a drag (not blanked)', len > 200, `${len} bytes`)
    const stored = a2?.getObject().get('PDFX_HandLines')
    check('handnote: the redraw state travels with it', !!stored && !stored.isNull(),
      stored && !stored.isNull() ? `${stored.asString().split('\n').length} lines` : 'missing')
    p2.destroy()
  }
  fs.rmSync(HFILE, { force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

// Round-trip test of the margin-export transform (src/shared/margin-export.ts,
// bundled by esbuild to .margin-test-bundle.mjs — same code the renderer runs).
// buildMarginCopy widens every page box by a gutter and bakes each margin card
// into it as a real Line + FreeText annotation; mupdf independently verifies:
//   1. every MediaBox is exactly MARGIN_EXPORT_GUTTER_PT wider on the edge that
//      faces right in the page's own display rotation (incl. /Rotate 90), and a
//      CropBox widens along with it
//   2. one FreeText + one Line per card, all with /AP appearance streams
//   3. the FreeText contents round-trip verbatim (incl. æøå)
//   4. the link-AP guard held: a border-only Link annot in the source is still
//      AP-less in the copy (same "linkguard" pattern as test:engine)
//
// Run: node scripts/test-margin-export.mjs   (after esbuild bundling)
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as mupdf from 'mupdf'
import { buildMarginCopy, MARGIN_EXPORT_GUTTER_PT } from './.margin-test-bundle.mjs'

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// Same engine init as the production desktop adapter (annotation-engine-embedpdf.ts):
// the wrapped module is both what PdfiumNative wraps and what pass 1 (the raw
// box widening) needs.
const [{ init }, { PdfiumNative }] = await Promise.all([
  import('@embedpdf/pdfium'),
  import('@embedpdf/engines/pdfium')
])
const wasmBinary = fs.readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'))
const wrapped = await init({ wasmBinary })
const engine = new PdfiumNative(wrapped)

// Three-page fixture, offsets computed like test-engine-embedpdf.mjs's linkguard
// fixture: page 0 is US Letter and carries a hyperref-style border-only Link
// (/Border+/C, no /AP), page 1 is Letter with an intrinsic /Rotate 90, page 2
// is a smaller page WITH a CropBox. One shared empty content stream.
const buildFixture = () => {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Annots[6 0 R]/Contents 7 0 R>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Rotate 90/Contents 7 0 R>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 500 700]/CropBox[0 0 500 700]/Contents 7 0 R>>',
    '<</Type/Annot/Subtype/Link/Rect[100 700 160 715]/Border[0 0 1]/C[0 1 0]/A<</S/URI/URI(https://example.org)>>>>',
    '<</Length 0>>\nstream\n\nendstream'
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

// Two cards on page 0 with near-equal anchors, so the second must be STACKED
// below the first (the margin view's rule, run through the real pipeline);
// one card on the rotated page.
const TEXT_A = 'Første kommentar med ÆØÅ og æøå.'
const TEXT_B =
  'Denne kommentaren er lang nok til å brytes over flere linjer i margen, slik at stablingen får noe å dytte på.'
const TEXT_C = 'Kommentar på rotert side.'
const cards = [
  { pageIndex: 0, anchorY: 120, text: TEXT_A, color: [0.89, 0.29, 0.29] },
  { pageIndex: 0, anchorY: 130, text: TEXT_B, color: [0.24, 0.53, 0.94] },
  { pageIndex: 1, anchorY: 80, text: TEXT_C, color: [0.18, 0.64, 0.35] }
]

const source = buildFixture()
const result = await buildMarginCopy(engine, wrapped, new Uint8Array(source), cards)
check('buildMarginCopy returns bytes', result instanceof Uint8Array, 'error' in (result ?? {}) ? result.error : `${result?.length} bytes`)
if (!(result instanceof Uint8Array)) {
  console.log('\nABORT — no output to verify')
  process.exit(1)
}

// Independent verification with mupdf
const pdf = mupdf.Document.openDocument(Buffer.from(result), 'application/pdf').asPDF()
check('page count preserved', pdf.countPages() === 3, `${pdf.countPages()} pages`)

const nums = (o) => (o && !o.isNull() ? (String(o).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number) : [])
const boxIs = (o, expected) => {
  const b = nums(o)
  return b.length === 4 && b.every((v, i) => Math.abs(v - expected[i]) < 0.01)
}
const G = MARGIN_EXPORT_GUTTER_PT

// 1. every page's MediaBox grew by exactly the gutter on the DISPLAY-right
// edge: +x for an unrotated page, +y (top) for /Rotate 90. The CropBox on
// page 2 follows; pages without one must not gain one.
{
  const p0 = pdf.findPage(0)
  const p1 = pdf.findPage(1)
  const p2 = pdf.findPage(2)
  check('p0 MediaBox widened right', boxIs(p0.get('MediaBox'), [0, 0, 612 + G, 792]), String(p0.get('MediaBox')))
  check('p1 (/Rotate 90) MediaBox widened on top edge', boxIs(p1.get('MediaBox'), [0, 0, 612, 792 + G]), String(p1.get('MediaBox')))
  check('p1 /Rotate intact', nums(p1.get('Rotate'))[0] === 90, String(p1.get('Rotate')))
  check('p2 MediaBox widened right', boxIs(p2.get('MediaBox'), [0, 0, 500 + G, 700]), String(p2.get('MediaBox')))
  check('p2 CropBox widened with it', boxIs(p2.get('CropBox'), [0, 0, 500 + G, 700]), String(p2.get('CropBox')))
  check('p0 gained no CropBox', p0.get('CropBox').isNull(), String(p0.get('CropBox')))
}

const annotsOf = (i) => {
  const arr = pdf.findPage(i).get('Annots')
  const out = []
  if (arr && !arr.isNull()) for (let k = 0; k < arr.length; k++) out.push(arr.get(k))
  return out
}
const bySubtype = (list, name) => list.filter((a) => a.get('Subtype').asName() === name)

// 2. one FreeText + one Line per card, every one with an /AP appearance stream
{
  const a0 = annotsOf(0)
  const a1 = annotsOf(1)
  check('p0: 2 FreeText + 2 Line + the Link', bySubtype(a0, 'FreeText').length === 2 && bySubtype(a0, 'Line').length === 2 && bySubtype(a0, 'Link').length === 1, `${a0.length} annots`)
  check('p1: 1 FreeText + 1 Line', bySubtype(a1, 'FreeText').length === 1 && bySubtype(a1, 'Line').length === 1, `${a1.length} annots`)
  check('p2 (no cards): no annots', annotsOf(2).length === 0, `${annotsOf(2).length} annots`)
  const marks = [...a0, ...a1].filter((a) => a.get('Subtype').asName() !== 'Link')
  const withAp = marks.filter((a) => !a.get('AP').isNull())
  check('all cards have /AP', withAp.length === marks.length, `${withAp.length}/${marks.length}`)
}

// 3. FreeText contents round-trip, read back through mupdf's own decoder
{
  const texts = (i) =>
    pdf
      .loadPage(i)
      .getAnnotations()
      .filter((a) => a.getObject().get('Subtype').asName() === 'FreeText')
      .map((a) => a.getContents())
  const t0 = texts(0)
  check('p0 contents round-trip', t0.includes(TEXT_A) && t0.includes(TEXT_B), JSON.stringify(t0))
  check('p1 contents round-trip', texts(1).includes(TEXT_C), JSON.stringify(texts(1)))

  // Placement on the unrotated page: both cards live inside the gutter (the
  // strip beyond the original 612 pt right edge), and the near-equal anchors
  // came out stacked — card B fully below card A, never overlapping.
  const ft = pdf
    .loadPage(0)
    .getAnnotations()
    .filter((a) => a.getObject().get('Subtype').asName() === 'FreeText')
    .map((a) => ({ text: a.getContents(), rect: nums(a.getObject().get('Rect')) }))
  const inGutter = (r) => r.length === 4 && Math.min(r[0], r[2]) >= 612 && Math.max(r[0], r[2]) <= 612 + G
  check('p0 cards placed inside the gutter', ft.every((f) => inGutter(f.rect)), JSON.stringify(ft.map((f) => f.rect)))
  const rectA = ft.find((f) => f.text === TEXT_A)?.rect
  const rectB = ft.find((f) => f.text === TEXT_B)?.rect
  // PDF user space is y-up: "A above B, disjoint" = A's bottom edge at or above B's top edge
  const stacked = rectA && rectB && Math.min(rectA[1], rectA[3]) >= Math.max(rectB[1], rectB[3]) - 0.5
  check('p0 cards stacked without overlap', !!stacked, `A=[${rectA}] B=[${rectB}]`)
}

// 4. link-AP guard: the border-only Link must still have NO /AP (a synthesized
// one would bake hyperref's green citation box visible in every viewer),
// with /Border and /C intact
{
  const link = bySubtype(annotsOf(0), 'Link')[0]
  check('linkguard: border-only link kept AP-less', !!link && link.get('AP').isNull())
  check('linkguard: /Border + /C intact', !!link && link.get('Border').toString() === '[0 0 1]' && link.get('C').toString() === '[0 1 0]', link ? `${link.get('Border')} ${link.get('C')}` : 'missing')
}

pdf.destroy()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

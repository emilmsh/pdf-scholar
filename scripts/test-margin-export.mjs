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
//   5. comments taller than their page: the margin runs on as one column —
//      cut cards continue on the next page under «forts. fra s. N», whole
//      cards that found no room are marked «fra s. N», pages are added at the
//      end for what is left (in columns), nothing overlaps, no text is lost
//
// Run: node scripts/test-margin-export.mjs   (after esbuild bundling)
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as mupdf from 'mupdf'
import { buildMarginCopy, layoutCards, MARGIN_EXPORT_GUTTER_PT } from './.margin-test-bundle.mjs'

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
  // The card carries its number as a prefix ("1. ", "2. ") — the chip at the
  // anchor and the card in the margin have to agree on paper, which is the
  // whole point of numbering them. So this is CONTAINS plus a number, not
  // equality: equality was written before the numbering existed and would
  // now fail on a feature working exactly as intended.
  const numbered = (list, text) => list.some((s) => /^\d+\.\s/.test(s) && s.includes(text))
  const t0 = texts(0)
  check('p0 contents round-trip, each card numbered',
    numbered(t0, TEXT_A) && numbered(t0, TEXT_B), JSON.stringify(t0))
  check('p1 contents round-trip, numbered',
    numbered(texts(1), TEXT_C), JSON.stringify(texts(1)))

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
  const rectA = ft.find((f) => f.text.includes(TEXT_A))?.rect
  const rectB = ft.find((f) => f.text.includes(TEXT_B))?.rect
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

// ---------------------------------------------------------------------------
// 5. Comments taller than their page (the report page with three long
// comments, 2026-10-27): before, every card on such a page was clamped to the
// top edge and printed through the others. Now the margin is ONE column
// running through the document — a card that finds no room is cut on an
// estimated line and continues at the top of the next page's margin under
// its own number and «forts. fra s. N», that page's own cards pushed down;
// what is left after the last page goes on added pages, in columns.
// First the pure layout, then the real pipeline verified by mupdf.
{
  const mark = (p, how) => (how === 'cut' ? `forts. fra s. ${p}` : `fra s. ${p}`)
  const A4 = { width: 595 + G, height: 842 }
  const tall = (n) => Array.from({ length: n }, (_, i) => `Avsnitt ${i + 1}: ${TEXT_B}`).join(' ')
  const rawOf = (text) => text.replace(/^\d+\. (\([^)]*\) )?/, '')
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const overlaps = (list) => {
    const byPage = new Map()
    // Per text column: an added page holds several side by side
    const key = (c) => `${c.pageIndex}:${c.textX}`
    for (const c of list) (byPage.get(key(c)) ?? byPage.set(key(c), []).get(key(c))).push(c)
    for (const [, cards] of byPage) {
      cards.sort((a, b) => a.top - b.top)
      for (let i = 1; i < cards.length; i++) if (cards[i].top < cards[i - 1].top + cards[i - 1].height - 0.01) return `p${cards[i].pageIndex}: «${cards[i].text.slice(0, 20)}» starts at ${cards[i].top.toFixed(1)} inside the card above (ends ${(cards[i - 1].top + cards[i - 1].height).toFixed(1)})`
    }
    return null
  }
  const inside = (list, pages) =>
    list.every((c) => c.top >= 0 && c.top + c.height <= (pages[c.pageIndex] ?? pages[pages.length - 1]).height)

  // Short cards: the layout the export always had — own page, own anchor, nothing added
  {
    const l = layoutCards(cards, [A4, A4, A4], G, 'right', mark)
    check('layout: short cards stay beside their anchors', l.placed.length === 3 && l.placed.every((c) => c.pageIndex === cards.find((k) => c.text.includes(k.text)).pageIndex) && l.extraPages === 0, JSON.stringify(l.placed.map((c) => [c.pageIndex, c.top])))
    check('layout: numbered per page, no mark', l.placed.every((c) => /^\d+\. [^(]/.test(c.text)), JSON.stringify(l.placed.map((c) => c.text.slice(0, 12))))
  }

  // Three page-tall comments on page 1 of a three-page document
  {
    const big = [
      { pageIndex: 0, anchorY: 600, anchor: { x: 72, y: 600, w: 200, h: 12 }, text: tall(8), color: [0.9, 0.3, 0.3] },
      { pageIndex: 0, anchorY: 650, anchor: { x: 72, y: 650, w: 200, h: 12 }, text: tall(10), color: [0.2, 0.5, 0.9] },
      { pageIndex: 0, anchorY: 700, anchor: { x: 72, y: 700, w: 200, h: 12 }, text: tall(10), color: [0.2, 0.6, 0.3] },
      { pageIndex: 1, anchorY: 100, anchor: { x: 72, y: 100, w: 200, h: 12 }, text: TEXT_A, color: [0.5, 0.5, 0.5] }
    ]
    const l = layoutCards(big, [A4, A4, A4], G, 'right', mark)
    check('layout: nothing overlaps', overlaps(l.placed) === null, overlaps(l.placed) ?? '')
    check('layout: every piece inside its page', inside(l.placed, [A4, A4, A4]))
    check('layout: no added page while the document has room', l.extraPages === 0, `${l.extraPages}`)
    const cont = l.placed.filter((c) => c.pageIndex > 0 && /^\d+\. \(forts\. fra s\. 1\)/.test(c.text))
    check('layout: the rest continues on later pages under «forts. fra s. 1»', cont.length >= 1, `${cont.length} pieces, first: «${cont[0]?.text.slice(0, 40)}»`)
    const moved = l.placed.filter((c) => /^\d+\. \(fra s\. 1\)/.test(c.text))
    check('layout: a whole card that found no room is marked «fra s. 1»', moved.length >= 1, `${moved.length}`)
    for (let n = 1; n <= 3; n++) {
      const pieces = l.placed.filter((c) => c.text.startsWith(`${n}. `) && (c.pageIndex === 0 || /\(.*s\. 1\)/.test(c.text)))
      const joined = norm(pieces.map((c) => rawOf(c.text)).join(' '))
      check(`layout: card ${n} loses no text across the cut`, joined === norm(big[n - 1].text), `${pieces.length} pieces, ${joined.length}/${norm(big[n - 1].text).length} chars`)
    }
    check('layout: chips stay on the anchor page', l.chips.length === 4 && l.chips.filter((c) => c.pageIndex === 0).length === 3 && l.chips.map((c) => c.label).join('') === '1231', JSON.stringify(l.chips.map((c) => [c.pageIndex, c.label])))
    // Page 2's own card comes AFTER what came on from page 1 — below it on
    // page 2, or (when that filled page 2) on a later page marked «fra s. 2»
    const p1own = l.placed.find((c) => c.text.includes(TEXT_A))
    const before = l.placed.filter((c) => c.text.includes('s. 1)') && (c.pageIndex < p1own.pageIndex || (c.pageIndex === p1own.pageIndex && c.top + c.height <= p1own.top)))
    const all1 = l.placed.filter((c) => c.text.includes('s. 1)'))
    check("layout: page 2's own card comes after everything from page 1", !!p1own && before.length === all1.length && (p1own.pageIndex === 1 || /^1\. \(fra s\. 2\)/.test(p1own.text)), `own on p${p1own?.pageIndex} at ${p1own?.top.toFixed(1)}: «${p1own?.text.slice(0, 16)}»`)
    const cutHead = l.placed.find((c) => c.pageIndex === 0 && c.text.startsWith('1. '))
    check('layout: the cut leaves at least three lines beside the anchor', !!cutHead && cutHead.height >= 4 * 9 * 1.35 - 0.01, `${cutHead?.height.toFixed(1)} pt`)
  }

  // A one-page document whose comments run to several pages: added pages, in columns
  {
    const huge = [
      { pageIndex: 0, anchorY: 100, anchor: { x: 72, y: 100, w: 200, h: 12 }, text: tall(40), color: [0.9, 0.3, 0.3] },
      { pageIndex: 0, anchorY: 200, anchor: { x: 72, y: 200, w: 200, h: 12 }, text: tall(40), color: [0.2, 0.5, 0.9] }
    ]
    const l = layoutCards(huge, [A4], G, 'right', mark)
    check('layout: added pages when the document runs out', l.extraPages >= 1, `${l.extraPages}`)
    check('layout: nothing overlaps on the added pages', overlaps(l.placed) === null, overlaps(l.placed) ?? '')
    check('layout: every piece inside the added page', inside(l.placed, [A4]))
    const onAdded = l.placed.filter((c) => c.pageIndex >= 1)
    const columnsUsed = new Set(onAdded.map((c) => c.textX)).size
    check('layout: the added page is used in columns across its width', columnsUsed >= 2 && columnsUsed <= Math.floor((A4.width - 8) / G), `${columnsUsed} columns`)
    const joined = norm(l.placed.filter((c) => c.text.startsWith('1. ')).map((c) => rawOf(c.text)).join(' '))
    check('layout: card 1 loses no text over the added pages', joined === norm(huge[0].text), `${joined.length}/${norm(huge[0].text).length} chars`)
    check('layout: the second card follows the first, never before it', l.placed.findIndex((c) => c.text.startsWith('2. ')) > l.placed.map((c) => c.text.startsWith('1. ')).lastIndexOf(true))
  }

  // The real pipeline: a one-page fixture with two page-tall comments
  {
    const one = Buffer.from(
      (() => {
        const objs = [
          '<</Type/Catalog/Pages 2 0 R>>',
          '<</Type/Pages/Kids[3 0 R]/Count 1>>',
          '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>',
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
        return out
      })(),
      'latin1'
    )
    const huge = [
      { pageIndex: 0, anchorY: 700, anchor: { x: 72, y: 700, w: 200, h: 12 }, text: tall(12), color: [0.9, 0.3, 0.3] },
      { pageIndex: 0, anchorY: 740, anchor: { x: 72, y: 740, w: 200, h: 12 }, text: tall(12), color: [0.2, 0.5, 0.9] }
    ]
    const expect = layoutCards(huge, [A4], G, 'right', mark)
    const out = await buildMarginCopy(engine, wrapped, new Uint8Array(one), huge, undefined, 'right', undefined, undefined, mark)
    check('overflow: buildMarginCopy returns bytes', out instanceof Uint8Array, 'error' in (out ?? {}) ? out.error : '')
    if (out instanceof Uint8Array) {
      const doc = mupdf.Document.openDocument(Buffer.from(out), 'application/pdf').asPDF()
      check('overflow: pages added for the margin that found no room', doc.countPages() === 1 + expect.extraPages && expect.extraPages >= 1, `${doc.countPages()} pages, layout wanted ${1 + expect.extraPages}`)
      const added = doc.findPage(doc.countPages() - 1)
      check('overflow: the added page has the widened size', boxIs(added.get('MediaBox'), [0, 0, 595 + G, 842]), String(added.get('MediaBox')))
      let allInside = true
      let anyOverlap = null
      const texts = []
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i)
        const box = nums(doc.findPage(i).get('MediaBox'))
        const fts = page
          .getAnnotations()
          .filter((a) => a.getObject().get('Subtype').asName() === 'FreeText')
          .map((a) => ({ text: a.getContents(), rect: nums(a.getObject().get('Rect')) }))
          .filter((f) => !/^\d+$/.test(f.text)) // the anchor chips
        for (const f of fts) {
          texts.push({ page: i, text: f.text })
          const [x0, y0, x1, y1] = f.rect
          if (Math.min(x0, x1) < box[0] - 0.5 || Math.max(x0, x1) > box[2] + 0.5 || Math.min(y0, y1) < box[1] - 0.5 || Math.max(y0, y1) > box[3] + 0.5) allInside = false
        }
        // Same text column (x) and overlapping y = printed through each other
        for (let a = 0; a < fts.length; a++)
          for (let b = a + 1; b < fts.length; b++) {
            const ra = fts[a].rect
            const rb = fts[b].rect
            const sameCol = Math.abs(Math.min(ra[0], ra[2]) - Math.min(rb[0], rb[2])) < 0.5
            const yOverlap = Math.min(ra[1], ra[3]) < Math.max(rb[1], rb[3]) - 0.5 && Math.min(rb[1], rb[3]) < Math.max(ra[1], ra[3]) - 0.5
            if (sameCol && yOverlap) anyOverlap = `p${i}: «${fts[a].text.slice(0, 15)}» and «${fts[b].text.slice(0, 15)}»`
          }
      }
      check('overflow: every card inside its page box', allInside)
      check('overflow: no two cards printed through each other', anyOverlap === null, anyOverlap ?? '')
      const joined1 = norm(texts.filter((t) => t.text.startsWith('1. ')).map((t) => rawOf(t.text)).join(' '))
      check('overflow: card 1 reads whole across the pages', joined1 === norm(huge[0].text), `${joined1.length}/${norm(huge[0].text).length} chars`)
      check('overflow: the continuation is marked', texts.some((t) => t.page >= 1 && /^\d+\. \((forts\. )?fra s\. 1\)/.test(t.text)), JSON.stringify(texts.filter((t) => t.page >= 1).map((t) => t.text.slice(0, 30))))
      const lines = doc.loadPage(doc.countPages() - 1).getAnnotations().filter((a) => a.getObject().get('Subtype').asName() === 'Line')
      check('overflow: the added page carries the colour bars too', lines.length >= 1, `${lines.length}`)
      doc.destroy()
    }
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

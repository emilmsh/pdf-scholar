// «Eksporter med kommentarer i margen»: build a COPY of the document where
// every page is physically widened by a gutter (MediaBox/CropBox) and each
// note/comment is baked into that new margin as a real FreeText annotation,
// with a thin line in the anchor's colour as its bar — so what the margin view
// shows on screen survives printing and every other PDF viewer. The original
// file is never touched; the caller writes the returned bytes wherever the
// user chose.
//
// Two passes over the bytes, in this order:
//   1. RAW pdfium (@embedpdf/pdfium cwraps): widen the page boxes and save via
//      the EPDF fork's in-memory file writer. Raw because the engines wrapper
//      exposes no box mutation.
//   2. Engine wrapper (PdfiumNative): create the FreeText + Line annotations
//      through the SAME shared builder every ordinary annotation uses
//      (buildAnnotation via applyOn — appearance streams, link-AP guard, the
//      lot), then saveAsCopy. Annotation second, box first: the cards then
//      land INSIDE the page box, and some viewers clip annotations outside it.
//
// Runs in the renderer on every platform (desktop included — an explicit
// export action is allowed to pay the wasm cost the annotate path avoids
// there). Callers must refuse documents above WASM_SAFE_LIMIT first.
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import type { FileError, PageRect } from './types'
import { ENGINE_ERRORS } from './engine-errors'
import type { OpenDoc } from './pdfium-annot-ops'
import { applyOn } from './pdfium-annot-ops'

export interface MarginExportCard {
  /** 0-based page index */
  pageIndex: number
  /** Anchor top edge, page points, top-left origin y-down — the same page
   *  space every annotation quad uses (unrotated) */
  anchorY: number
  /** Full anchor rect (same space). When present, a small numbered chip is
   *  stamped right after the anchor — the print stand-in for the screen's
   *  leader line, since colour + height alone are ambiguous on paper. */
  anchor?: PageRect
  text: string
  /** Anchor colour (rgb 0–1) — drawn as the card's bar in the margin */
  color: [number, number, number]
}

/** Which side of the page the margin is added to (in display orientation) */
export type MarginSide = 'left' | 'right'

/** Gutter width added to every page, in PDF points (≈ 6 cm). Wide enough for a
 *  readable 9 pt comment column, narrow enough that an A4 still prints. */
export const MARGIN_EXPORT_GUTTER_PT = 170
const BAR_INSET = 10 // gutter start → colour bar
const TEXT_INSET = 18 // gutter start → text column
const TEXT_RIGHT_PAD = 10
const FONT_SIZE = 9
const LINE_HEIGHT = FONT_SIZE * 1.35
const CARD_GAP = 10
const EDGE_PAD = 8
// The numbered anchor chip: a footnote-sized white plate with the anchor's
// colour as its border, stamped right AFTER the anchor and raised half a step
// so it mostly lives in the line gap. Small enough that the worst case is a
// few grazed pixels of a neighbouring word — never a line across the text
// (vetoed), and unambiguous where colour + height are not (two yellow
// highlights on one line).
const CHIP_FONT_SIZE = 6.5
const CHIP_H = 9
/** Text ink for the margin comments — the anchor colour lives in the bar, the
 *  text itself stays readable (a comment on a yellow highlight must not be
 *  yellow-on-white). Same near-black as the on-screen FreeText default. */
const INK: [number, number, number] = [0.11, 0.11, 0.13]

/** The emscripten heap view. Present at runtime (the engines wrapper indexes
 *  it the same way) but missing from the wrapper's TS surface, hence the cast.
 *  Re-read after every malloc — memory growth replaces the backing buffer. */
function heapU8(m: WrappedPdfiumModule['pdfium']): Uint8Array {
  return (m as unknown as { HEAPU8: Uint8Array }).HEAPU8
}

/** Rough Helvetica wrap estimate. 0.55 em per char UNDERestimates how much
 *  fits on a line, so the card is sized for at least as many lines as PDFium's
 *  real wrap will produce — the failure mode is a little extra whitespace,
 *  never clipped text. */
function estimateLines(text: string, widthPt: number): number {
  const charsPerLine = Math.max(8, Math.floor(widthPt / (FONT_SIZE * 0.55)))
  let lines = 0
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines += 1
      continue
    }
    let current = 0
    let paragraphLines = 1
    for (const word of words) {
      const next = current === 0 ? word.length : current + 1 + word.length
      if (next > charsPerLine && current > 0) {
        paragraphLines += 1
        current = word.length
      } else {
        current = next
      }
    }
    lines += paragraphLines
  }
  return lines
}

interface PlacedCard extends MarginExportCard {
  top: number
  height: number
}

/** The margin view's stacking rule, in PDF points: each card at its anchor's
 *  height unless the one above pushes it down; if the stack runs off the page
 *  bottom it is pushed back up as a block (annotations below the page box get
 *  clipped by viewers, unlike the screen where cards may overhang). */
export function stackCards(cards: MarginExportCard[], textW: number, pageH: number): PlacedCard[] {
  const sorted = [...cards].sort((a, b) => a.anchorY - b.anchorY)
  const placed: PlacedCard[] = []
  let prevBottom = -Infinity
  for (const card of sorted) {
    const height = (estimateLines(card.text, textW) + 1) * LINE_HEIGHT
    const top = Math.max(card.anchorY, prevBottom + CARD_GAP)
    placed.push({ ...card, top, height })
    prevBottom = top + height
  }
  const overflow = prevBottom - (pageH - EDGE_PAD)
  if (overflow > 0) {
    // Push the whole tail up, card by card from the bottom, without creating
    // new overlaps at the top (first card never goes above EDGE_PAD).
    let ceiling = pageH - EDGE_PAD
    for (let i = placed.length - 1; i >= 0; i--) {
      const c = placed[i]
      c.top = Math.max(EDGE_PAD, Math.min(c.top, ceiling - c.height))
      ceiling = c.top - CARD_GAP
    }
  }
  return placed
}

/** Pass 1: widen MediaBox (and CropBox when present) on every page, on the
 *  side that faces RIGHT in the page's own display rotation. Returns the
 *  re-saved bytes. */
function widenPageBoxes(
  wrapped: WrappedPdfiumModule,
  bytes: Uint8Array,
  gutterPt: number,
  side: MarginSide
): Uint8Array | FileError {
  const m = wrapped.pdfium
  const src = m.wasmExports.malloc(bytes.length)
  heapU8(m).set(bytes, src)
  const doc = wrapped.FPDF_LoadMemDocument(src, bytes.length, '')
  if (!doc) {
    m.wasmExports.free(src)
    return { error: `PDFium could not open the document (error ${wrapped.FPDF_GetLastError()})` }
  }
  // 4 out-floats, reused for both boxes on every page
  const box = m.wasmExports.malloc(16)
  const readBox = (
    get: (page: number, l: number, b: number, r: number, t: number) => boolean,
    page: number
  ): [number, number, number, number] | null => {
    if (!get(page, box, box + 4, box + 8, box + 12)) return null
    return [
      m.getValue(box, 'float'),
      m.getValue(box + 4, 'float'),
      m.getValue(box + 8, 'float'),
      m.getValue(box + 12, 'float')
    ]
  }
  /** Grow the edge that faces the chosen side when the page is displayed with
   *  its /Rotate. Display-right by rotation: 0→right, 90 (CW)→top, 180→left,
   *  270→bottom; display-left is the opposite edge each time. */
  const widen = (
    [l, b, r, t]: [number, number, number, number],
    rot: number
  ): [number, number, number, number] => {
    const edge = side === 'right' ? rot : (rot + 2) % 4
    return edge === 1 ? [l, b, r, t + gutterPt]
      : edge === 2 ? [l - gutterPt, b, r, t]
      : edge === 3 ? [l, b - gutterPt, r, t]
      : [l, b, r + gutterPt, t]
  }

  try {
    const pageCount = wrapped.FPDF_GetPageCount(doc)
    for (let i = 0; i < pageCount; i++) {
      const page = wrapped.FPDF_LoadPage(doc, i)
      if (!page) return { error: `PDFium could not load page ${i + 1}` }
      try {
        const rot = wrapped.FPDFPage_GetRotation(page)
        // A page without its own MediaBox inherits one; fall back to the
        // rendered size at origin (0,0) — right for all but exotic files.
        const media =
          readBox(wrapped.FPDFPage_GetMediaBox, page) ??
          ([0, 0, wrapped.FPDF_GetPageWidthF(page), wrapped.FPDF_GetPageHeightF(page)] as [
            number,
            number,
            number,
            number
          ])
        const [ml, mb, mr, mt] = widen(media, rot)
        wrapped.FPDFPage_SetMediaBox(page, ml, mb, mr, mt)
        const crop = readBox(wrapped.FPDFPage_GetCropBox, page)
        if (crop) {
          const [cl, cb, cr, ct] = widen(crop, rot)
          wrapped.FPDFPage_SetCropBox(page, cl, cb, cr, ct)
        }
      } finally {
        wrapped.FPDF_ClosePage(page)
      }
    }
    const writer = wrapped.PDFiumExt_OpenFileWriter()
    try {
      wrapped.PDFiumExt_SaveAsCopy(doc, writer)
      const size = wrapped.PDFiumExt_GetFileWriterSize(writer)
      if (size <= 0) return { error: 'PDFium produced an empty save buffer' }
      const out = m.wasmExports.malloc(size)
      try {
        wrapped.PDFiumExt_GetFileWriterData(writer, out, size)
        return new Uint8Array(heapU8(m).subarray(out, out + size))
      } finally {
        m.wasmExports.free(out)
      }
    } finally {
      wrapped.PDFiumExt_CloseFileWriter(writer)
    }
  } finally {
    m.wasmExports.free(box)
    wrapped.FPDF_CloseDocument(doc)
    m.wasmExports.free(src)
  }
}

/** The whole transform. `bytes` must be the CURRENT document (draft included —
 *  the caller owns getting them); returns the finished copy's bytes. */
export async function buildMarginCopy(
  engine: PdfiumNative,
  wrapped: WrappedPdfiumModule,
  bytes: Uint8Array,
  cards: MarginExportCard[],
  gutterPt: number = MARGIN_EXPORT_GUTTER_PT,
  side: MarginSide = 'right',
  /** Author (/T) for the baked margin annotations — the user's own name from
   *  settings, or nothing */
  author?: string
): Promise<Uint8Array | FileError> {
  const widened = widenPageBoxes(wrapped, bytes, gutterPt, side)
  if (!(widened instanceof Uint8Array)) return widened

  const docId = `margin-export-${Date.now().toString(36)}`
  const buf = widened
  const doc = await engine
    .openDocumentBuffer({
      id: docId,
      content: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    })
    .toPromise()
  const open: OpenDoc = { engine, doc, docId }
  try {
    const byPage = new Map<number, MarginExportCard[]>()
    for (const card of cards) {
      const list = byPage.get(card.pageIndex) ?? []
      list.push(card)
      byPage.set(card.pageIndex, list)
    }
    const textW = gutterPt - TEXT_INSET - TEXT_RIGHT_PAD
    for (const [pageIndex, pageCards] of byPage) {
      const size = doc.pages[pageIndex]?.size
      if (!size) continue
      // The page is already widened. Right margin: the gutter begins gutterPt
      // short of the new width. Left margin: the gutter IS x ∈ [0, gutterPt] —
      // the original content now starts at x = gutterPt. Marker, bar and text
      // mirror so the markers always hug the page edge.
      const gutterX = side === 'right' ? size.width - gutterPt : 0
      const barX = side === 'right' ? gutterX + BAR_INSET : gutterPt - BAR_INSET
      const textX = side === 'right' ? gutterX + TEXT_INSET : TEXT_RIGHT_PAD
      const placed = stackCards(pageCards, textW, size.height)
      // On paper nothing is hoverable, so the anchor↔card link is a NUMBER:
      // a footnote-style chip stamped at the anchor itself, repeated in front
      // of the card text. Numbers restart per page.
      for (let n = 0; n < placed.length; n++) {
        const card = placed[n]
        const label = String(n + 1)
        if (card.anchor) {
          const chipW = 4 + 3.8 * label.length
          const chip = await applyOn(open, {
            path: '',
            pageIndex,
            author,
            type: 'freetext',
            quads: [
              {
                x: Math.min(card.anchor.x + card.anchor.w + 1.5, size.width - chipW - 1),
                y: Math.max(1, card.anchor.y - 3),
                w: chipW,
                h: CHIP_H
              }
            ],
            color: INK,
            opacity: 1,
            contents: label,
            fontSize: CHIP_FONT_SIZE,
            // White plate only, NO border: the EPDF appearance generator lets
            // a strokeColor take over /DA — a yellow anchor would print a
            // yellow digit. The anchor right beside the chip already carries
            // the colour; the digit's job is to be legible.
            background: [1, 1, 1]
          })
          if ('error' in chip) return chip
        }
        const bar = await applyOn(open, {
          path: '',
          pageIndex,
          author,
          type: 'line',
          quads: [],
          color: card.color,
          opacity: 1,
          width: 2,
          strokes: [
            [
              [barX, card.top + 1],
              [barX, card.top + card.height - LINE_HEIGHT + 1]
            ]
          ]
        })
        if ('error' in bar) return bar
        const text = await applyOn(open, {
          path: '',
          pageIndex,
          author,
          type: 'freetext',
          quads: [{ x: textX, y: card.top, w: textW, h: card.height }],
          color: INK,
          opacity: 1,
          contents: `${label}. ${card.text}`,
          fontSize: FONT_SIZE
        })
        if ('error' in text) return text
      }
    }
    const saved = await engine.saveAsCopy(doc).toPromise()
    return new Uint8Array(saved)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return /password/i.test(msg) ? ENGINE_ERRORS.passwordProtected : { error: msg }
  } finally {
    await engine
      .closeDocument(doc)
      .toPromise()
      .catch(() => {})
  }
}

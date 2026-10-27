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
import { applyOn, isPasswordError } from './pdfium-annot-ops'

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

/** Fewest lines a card keeps on a page when it is cut there — a cut leaving
 *  one orphan line beside the anchor reads worse than moving the whole card
 *  on. */
const MIN_SPLIT_LINES = 3

interface WrapLine {
  text: string
  /** A paragraph break follows this line in the source text */
  paragraphEnd: boolean
}

/** Rough Helvetica wrap estimate. 0.55 em per char UNDERestimates how much
 *  fits on a line, so the card is sized for at least as many lines as PDFium's
 *  real wrap will produce — the failure mode is a little extra whitespace,
 *  never clipped text. The same slack is what lets a card be CUT on one of
 *  these lines: the head holds at most as many real lines as estimated, so
 *  it fits the room it was cut for. */
function wrapEstimate(text: string, widthPt: number): WrapLine[] {
  const charsPerLine = Math.max(8, Math.floor(widthPt / (FONT_SIZE * 0.55)))
  const lines: WrapLine[] = []
  const paragraphs = text.split('\n')
  paragraphs.forEach((paragraph, p) => {
    const last = p === paragraphs.length - 1
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push({ text: '', paragraphEnd: !last })
      return
    }
    let current: string[] = []
    let length = 0
    for (const word of words) {
      const next = length === 0 ? word.length : length + 1 + word.length
      if (next > charsPerLine && length > 0) {
        lines.push({ text: current.join(' '), paragraphEnd: false })
        current = [word]
        length = word.length
      } else {
        current.push(word)
        length = next
      }
    }
    lines.push({ text: current.join(' '), paragraphEnd: !last })
  })
  return lines
}

function estimateLines(text: string, widthPt: number): number {
  return wrapEstimate(text, widthPt).length
}

/** The text a run of estimated lines stands for — paragraph breaks kept,
 *  wrapped lines rejoined with the space the wrap consumed. */
function joinLines(lines: WrapLine[]): string {
  let out = ''
  lines.forEach((line, i) => {
    out += line.text
    if (i < lines.length - 1) out += line.paragraphEnd ? '\n' : ' '
  })
  return out
}

/** A page's box as shown (rotation applied), after the gutter was added */
export interface PageGeometry {
  width: number
  height: number
}

/** A card, or a piece of one, with its place on paper */
export interface PlacedCard {
  pageIndex: number
  /** The text as printed, its number (and continuation mark) included */
  text: string
  /** Page points, top-left origin y-down */
  top: number
  height: number
  color: [number, number, number]
  /** The card's digit(s) */
  label: string
  /** The colour bar's x and the text column's left edge on this page */
  barX: number
  textX: number
}

/** The numbered chip at a card's anchor — always on the anchor's own page,
 *  whether or not the card's text found room beside it */
export interface AnchorChip {
  pageIndex: number
  anchor: PageRect
  label: string
}

export interface MarginLayout {
  placed: PlacedCard[]
  chips: AnchorChip[]
  /** Blank pages to add after the last one for what found no room beside any
   *  page — the margin runs on there, in columns across the whole page. */
  extraPages: number
}

/** How a piece of text relates to the page it is printed on: beside its own
 *  anchor, the rest of a card cut on an earlier page, or a whole card that
 *  found no room on its own page */
export type Continuation = 'own' | 'cut' | 'moved'

/** One run of margin, on a page or on an added one */
interface Column {
  pageIndex: number
  barX: number
  textX: number
  top: number
  bottom: number
}

/** A card, or what is left of one, still looking for room */
interface Segment {
  label: string
  /** 1-based page the anchor is on — named in the continuation mark */
  anchorPage: number
  color: [number, number, number]
  /** Raw text, no number */
  text: string
  continued: Continuation
  /** Where it wants to start — its anchor's height, pushed as the stack
   *  decided; a continuation has none and sits at the column top */
  wantedTop?: number
}

/** Lay every card out, page by page, as one margin running through the
 *  document (the margin view's rule on paper, where nothing may overhang):
 *  each card at its anchor's height unless the one above pushes it down; a
 *  stack that runs off the page bottom is pushed back up as far as the page
 *  (and anything already standing above it) allows; what still finds no room
 *  is CUT on an estimated line and continues at the top of the next page's
 *  margin under its own number — «2. (forts. fra s. 3) …» — pushing that
 *  page's own cards down, and so on to the last page. Whatever is left then
 *  goes on added pages, in gutter-wide columns across the page. Before this
 *  (v0.73), a page whose comments were taller than itself clamped every card
 *  to the top edge and printed them through each other. */
export function layoutCards(
  cards: MarginExportCard[],
  pages: PageGeometry[],
  gutterPt: number,
  side: MarginSide,
  /** The mark on a piece printed away from its anchor's page («forts. fra
   *  s. 3» for the rest of a cut card, «fra s. 3» for a whole card moved
   *  on), given that page's 1-based number — localised by the caller */
  continuedMark: (anchorPage: number, how: 'cut' | 'moved') => string
): MarginLayout {
  const textW = gutterPt - TEXT_INSET - TEXT_RIGHT_PAD
  const placed: PlacedCard[] = []
  const chips: AnchorChip[] = []
  let carry: Segment[] = []

  const printedText = (seg: Segment): string =>
    seg.continued === 'own'
      ? `${seg.label}. ${seg.text}`
      : `${seg.label}. (${continuedMark(seg.anchorPage, seg.continued)}) ${seg.text}`
  const heightOf = (lines: number): number => (lines + 1) * LINE_HEIGHT
  /** A segment that leaves its page keeps the mark it has, or gets «moved» */
  const movedOn = (seg: Segment): Segment => {
    if (seg.continued !== 'own') return seg
    const { wantedTop: _top, ...rest } = seg
    return { ...rest, continued: 'moved' }
  }

  /** Place `segments` in order down the column from `from`; the first that
   *  does not fit is cut (keeping MIN_SPLIT_LINES here when the room allows)
   *  and it and everything after it carry on to the next column. Returns the
   *  bottom of what was placed. */
  const flow = (col: Column, segments: Segment[], from: number): number => {
    let prevBottom = from - CARD_GAP
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const lines = wrapEstimate(printedText(seg), textW)
      const top = Math.max(seg.wantedTop ?? col.top, prevBottom + CARD_GAP)
      const height = heightOf(lines.length)
      const put = (text: string, h: number): void => {
        placed.push({
          pageIndex: col.pageIndex,
          text,
          top,
          height: h,
          color: seg.color,
          label: seg.label,
          barX: col.barX,
          textX: col.textX
        })
        prevBottom = top + h
      }
      if (top + height <= col.bottom) {
        put(joinLines(lines), height)
        continue
      }
      const room = Math.floor((col.bottom - top) / LINE_HEIGHT) - 1
      if (room >= MIN_SPLIT_LINES && room < lines.length) {
        put(joinLines(lines.slice(0, room)), heightOf(room))
        // The tail is raw text again: it gets its own number and mark when it
        // lands, and is wrapped afresh for them.
        const { wantedTop: _top, ...rest } = seg
        carry.push({ ...rest, text: joinLines(lines.slice(room)), continued: 'cut' })
      } else {
        carry.push(movedOn(seg))
      }
      // Order is kept: nothing after a card that moved on may stay behind it.
      carry.push(...segments.slice(i + 1).map(movedOn))
      break
    }
    return prevBottom
  }

  const byPage = new Map<number, MarginExportCard[]>()
  for (const card of cards) {
    if (!pages[card.pageIndex]) continue
    const list = byPage.get(card.pageIndex) ?? []
    list.push(card)
    byPage.set(card.pageIndex, list)
  }

  pages.forEach((page, pageIndex) => {
    // The page is already widened. Right margin: the gutter begins gutterPt
    // short of the new width. Left margin: the gutter IS x ∈ [0, gutterPt] —
    // the original content now starts at x = gutterPt. Marker, bar and text
    // mirror so the markers always hug the page edge.
    const gutterX = side === 'right' ? page.width - gutterPt : 0
    const col: Column = {
      pageIndex,
      barX: side === 'right' ? gutterX + BAR_INSET : gutterPt - BAR_INSET,
      textX: side === 'right' ? gutterX + TEXT_INSET : TEXT_RIGHT_PAD,
      top: EDGE_PAD,
      bottom: page.height - EDGE_PAD
    }
    // The page's own cards, numbered in anchor order (numbers restart per
    // page). The chip at the anchor is stamped whatever becomes of the text.
    const own = [...(byPage.get(pageIndex) ?? [])].sort((a, b) => a.anchorY - b.anchorY)
    const segments: Segment[] = own.map((card, n) => {
      const label = String(n + 1)
      if (card.anchor) chips.push({ pageIndex, anchor: card.anchor, label })
      return {
        label,
        anchorPage: pageIndex + 1,
        color: card.color,
        text: card.text,
        continued: 'own',
        wantedTop: card.anchorY
      }
    })
    // What came on from the page before stands first, at the top.
    const continued = carry
    carry = []
    const contBottom = continued.length > 0 ? flow(col, continued, col.top) : col.top - CARD_GAP
    if (carry.length > 0) {
      // The continuation alone filled the page: this page's own cards go
      // after it, on the next page.
      carry.push(...segments.map(movedOn))
      return
    }
    // Stacked at their anchors, the stack pushed back up when it runs off
    // the page — never above what stands over it.
    const heights = segments.map((seg) => heightOf(estimateLines(printedText(seg), textW)))
    const tops: number[] = []
    let prevBottom = contBottom
    segments.forEach((seg, i) => {
      const top = Math.max(seg.wantedTop ?? col.top, prevBottom + CARD_GAP)
      tops.push(top)
      prevBottom = top + heights[i]
    })
    if (prevBottom > col.bottom) {
      const floor = contBottom + CARD_GAP
      let ceiling = col.bottom
      for (let i = segments.length - 1; i >= 0; i--) {
        tops[i] = Math.max(floor, Math.min(tops[i], ceiling - heights[i]))
        ceiling = tops[i] - CARD_GAP
      }
    }
    segments.forEach((seg, i) => (seg.wantedTop = tops[i]))
    flow(col, segments, contBottom + CARD_GAP)
  })

  // Added pages: the last page's size, the margin in columns across it.
  let extraPages = 0
  if (carry.length > 0 && pages.length > 0) {
    const last = pages[pages.length - 1]
    const columns = Math.max(1, Math.floor((last.width - EDGE_PAD) / gutterPt))
    while (carry.length > 0) {
      const pageIndex = pages.length + extraPages
      extraPages++
      for (let c = 0; c < columns && carry.length > 0; c++) {
        const gutterX = EDGE_PAD + c * gutterPt
        const col: Column = {
          pageIndex,
          barX: gutterX + BAR_INSET,
          textX: gutterX + TEXT_INSET,
          top: EDGE_PAD,
          bottom: last.height - EDGE_PAD
        }
        const segments = carry
        carry = []
        const before = placed.length
        flow(col, segments, col.top)
        if (placed.length === before) {
          // A column too short for even MIN_SPLIT_LINES (a page a few points
          // tall): print the piece clipped rather than loop for ever.
          const seg = carry.shift()!
          placed.push({
            pageIndex,
            text: printedText(seg),
            top: col.top,
            height: col.bottom - col.top,
            color: seg.color,
            label: seg.label,
            barX: col.barX,
            textX: col.textX
          })
        }
      }
    }
  }
  return { placed, chips, extraPages }
}

/** The bytes of a raw PDFium document, through the EPDF fork's in-memory
 *  file writer */
function saveRaw(wrapped: WrappedPdfiumModule, doc: number): Uint8Array | FileError {
  const m = wrapped.pdfium
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
}

/** Pass 1: widen MediaBox (and CropBox when present) on every page, on the
 *  side that faces RIGHT in the page's own display rotation. Returns the
 *  re-saved bytes and every page's box as shown — the room the layout has. */
function widenPageBoxes(
  wrapped: WrappedPdfiumModule,
  bytes: Uint8Array,
  gutterPt: number,
  side: MarginSide,
  password: string
): { bytes: Uint8Array; pages: PageGeometry[] } | FileError {
  const m = wrapped.pdfium
  const src = m.wasmExports.malloc(bytes.length)
  heapU8(m).set(bytes, src)
  const doc = wrapped.FPDF_LoadMemDocument(src, bytes.length, password)
  if (!doc) {
    m.wasmExports.free(src)
    return { error: `PDFium could not open the document (error ${wrapped.FPDF_GetLastError()})` }
  }
  const pages: PageGeometry[] = []
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
        let shown: [number, number, number, number] = [ml, mb, mr, mt]
        if (crop) {
          const [cl, cb, cr, ct] = widen(crop, rot)
          wrapped.FPDFPage_SetCropBox(page, cl, cb, cr, ct)
          shown = [cl, cb, cr, ct]
        }
        // As displayed: the CropBox when there is one, turned by /Rotate —
        // what the engine reports as the page size in pass 2.
        const w = shown[2] - shown[0]
        const h = shown[3] - shown[1]
        pages.push(rot % 2 === 1 ? { width: h, height: w } : { width: w, height: h })
      } finally {
        wrapped.FPDF_ClosePage(page)
      }
    }
    const saved = saveRaw(wrapped, doc)
    return saved instanceof Uint8Array ? { bytes: saved, pages } : saved
  } finally {
    m.wasmExports.free(box)
    wrapped.FPDF_CloseDocument(doc)
    m.wasmExports.free(src)
  }
}

/** Between the passes: `count` blank pages of `size` after the last one, for
 *  the margin that found no room beside any page. Raw, because the engine
 *  wrapper lists a document's pages once at open and would not see them. */
function appendBlankPages(
  wrapped: WrappedPdfiumModule,
  bytes: Uint8Array,
  count: number,
  size: PageGeometry,
  password: string
): Uint8Array | FileError {
  const m = wrapped.pdfium
  const src = m.wasmExports.malloc(bytes.length)
  heapU8(m).set(bytes, src)
  const doc = wrapped.FPDF_LoadMemDocument(src, bytes.length, password)
  if (!doc) {
    m.wasmExports.free(src)
    return { error: `PDFium could not open the document (error ${wrapped.FPDF_GetLastError()})` }
  }
  try {
    for (let i = 0; i < count; i++) {
      const page = wrapped.FPDFPage_New(doc, wrapped.FPDF_GetPageCount(doc), size.width, size.height)
      if (!page) return { error: 'PDFium could not add a page for the margin' }
      wrapped.FPDF_ClosePage(page)
    }
    return saveRaw(wrapped, doc)
  } finally {
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
  author?: string,
  /** The password the document was unlocked with, when it is encrypted. Both
   *  passes below re-open the bytes, and the widened intermediate keeps the
   *  encryption PDFium was given — so both need it. */
  password?: string,
  /** The mark on a card printed away from its anchor's page — see
   *  layoutCards. Norwegian when the caller gives none. */
  continuedMark: (anchorPage: number, how: 'cut' | 'moved') => string = (p, how) =>
    how === 'cut' ? `forts. fra s. ${p}` : `fra s. ${p}`
): Promise<Uint8Array | FileError> {
  const widened = widenPageBoxes(wrapped, bytes, gutterPt, side, password ?? '')
  if ('error' in widened) return widened

  const layout = layoutCards(cards, widened.pages, gutterPt, side, continuedMark)
  let buf = widened.bytes
  if (layout.extraPages > 0) {
    const grown = appendBlankPages(
      wrapped,
      buf,
      layout.extraPages,
      widened.pages[widened.pages.length - 1],
      password ?? ''
    )
    if (!(grown instanceof Uint8Array)) return grown
    buf = grown
  }

  const docId = `margin-export-${Date.now().toString(36)}`
  const doc = await engine
    .openDocumentBuffer(
      {
        id: docId,
        content: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      },
      password === undefined ? undefined : { password }
    )
    .toPromise()
  const open: OpenDoc = { engine, doc, docId }
  try {
    const textW = gutterPt - TEXT_INSET - TEXT_RIGHT_PAD
    // On paper nothing is hoverable, so the anchor↔card link is a NUMBER: a
    // footnote-style chip stamped at the anchor itself, repeated in front of
    // the card text. Numbers restart per page; a card printed on another
    // page says which page its number belongs to.
    for (const chip of layout.chips) {
      const pageW = widened.pages[chip.pageIndex].width
      const chipW = 4 + 3.8 * chip.label.length
      const res = await applyOn(open, {
        path: '',
        pageIndex: chip.pageIndex,
        author,
        type: 'freetext',
        quads: [
          {
            x: Math.min(chip.anchor.x + chip.anchor.w + 1.5, pageW - chipW - 1),
            y: Math.max(1, chip.anchor.y - 3),
            w: chipW,
            h: CHIP_H
          }
        ],
        color: INK,
        opacity: 1,
        contents: chip.label,
        fontSize: CHIP_FONT_SIZE,
        // White plate only, NO border: the EPDF appearance generator lets
        // a strokeColor take over /DA — a yellow anchor would print a
        // yellow digit. The anchor right beside the chip already carries
        // the colour; the digit's job is to be legible.
        background: [1, 1, 1]
      })
      if ('error' in res) return res
    }
    for (const card of layout.placed) {
      const bar = await applyOn(open, {
        path: '',
        pageIndex: card.pageIndex,
        author,
        type: 'line',
        quads: [],
        color: card.color,
        opacity: 1,
        width: 2,
        strokes: [
          [
            [card.barX, card.top + 1],
            [card.barX, card.top + card.height - LINE_HEIGHT + 1]
          ]
        ]
      })
      if ('error' in bar) return bar
      const text = await applyOn(open, {
        path: '',
        pageIndex: card.pageIndex,
        author,
        type: 'freetext',
        quads: [{ x: card.textX, y: card.top, w: textW, h: card.height }],
        color: INK,
        opacity: 1,
        contents: card.text,
        fontSize: FONT_SIZE
      })
      if ('error' in text) return text
    }
    const saved = await engine.saveAsCopy(doc).toPromise()
    return new Uint8Array(saved)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!isPasswordError(err)) return { error: msg }
    return password === undefined ? ENGINE_ERRORS.passwordProtected : ENGINE_ERRORS.passwordWrong
  } finally {
    await engine
      .closeDocument(doc)
      .toPromise()
      .catch(() => {})
  }
}

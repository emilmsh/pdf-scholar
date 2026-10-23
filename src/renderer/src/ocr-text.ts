// A scanned page's recognised words, in the shape pdf.js gives a page's own
// text (getTextContent). Everything downstream — the text layer, search,
// selection, text markup, the assistant — then reads a scanned page exactly
// as it reads a born-digital one, with no OCR branch of its own. The words
// live in memory only and are never written into the file (Emil, 2026-10-23:
// Chrome's way, not Acrobat's — the save path stays untouched).
//
// Pure: Tesseract's TSV comes in as a string and the page geometry as a
// function, so scripts/test-ocr.mjs runs this in plain Node. The engine and
// the page rendering are ocr.ts.
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'

/** Resolution a page is rendered at for recognition. Tesseract reads best
 *  with an x-height of 20 px or more; 10 pt body text reaches that at 300 dpi. */
export const OCR_DPI = 300

/** Longest side of the rendered page, in px: a little over an A4 page at
 *  OCR_DPI (3508). A poster or an A0 drawing is read at less than 300 dpi
 *  rather than at 100 MB of pixels. */
export const OCR_MAX_SIDE = 3600

/** A "word" with no letter or digit in it — «|||», «~~», a rule read as «—» —
 *  is kept only when Tesseract is at least this sure of it (0–100): that is
 *  what a table rule or a figure's hatching comes back as.
 *
 *  Words WITH letters are never filtered on confidence. Tesseract's LSTM
 *  scores are not a quality measure at the start of a line: «Vi bruker»,
 *  read correctly on a clean 300 dpi scan, came back at 0.0 and the line
 *  above it at 4.5 (test:ocr) — a floor of 35 silently cut real words out of
 *  search. A misread word costs nothing a reader would notice; a missing one
 *  is a search that finds nothing. */
export const OCR_SYMBOL_MIN_CONFIDENCE = 50

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u

/** The font name every recognised word carries. The family is only what the
 *  invisible text layer measures its spans with — nothing is drawn in it. */
export const OCR_FONT = 'pdfx-ocr'

/** pdf.js's TextLayer puts a span's top `ascent × fontHeight` above its
 *  baseline, with the ascent it measures for the family (≈ 0.8 for the
 *  platform sans-serif, and its own fallback when it cannot measure). A line's
 *  baseline is placed this far down its box so the span covers the box. */
const ASCENT = 0.8

/** Tesseract's LSTM engine only — the legacy one is not in this build */
export const OEM_LSTM_ONLY = 1
/** Fully automatic page segmentation: finds the columns, so a two-column
 *  paper reads down the left column before the right one. The C++ API's
 *  default is ONE uniform block, which reads straight across both. */
export const PSM_AUTO = '3'

/** RGBA → 8-bit grey as a binary PGM, which Leptonica reads without a codec:
 *  a quarter of the bytes, and no PNG encode on either side. */
export function toPgm(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`)
  const out = new Uint8Array(header.length + width * height)
  out.set(header)
  for (let i = 0, j = header.length; i < rgba.length; i += 4, j++) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
  }
  return out
}

/** The page scale the OCR raster is rendered at: OCR_DPI, unless that would
 *  take the longer side past OCR_MAX_SIDE. Sizes are in PDF points. */
export function ocrScale(widthPt: number, heightPt: number): number {
  const scale = OCR_DPI / 72
  const longest = Math.max(widthPt, heightPt) * scale
  return longest > OCR_MAX_SIDE ? OCR_MAX_SIDE / Math.max(widthPt, heightPt) : scale
}

/** Tesseract's language codes for the reader's interface language, most
 *  likely first. English rides along everywhere — the academic default — and
 *  a Norwegian interface reads æ, ø and å with the Norwegian model. */
export function ocrLanguages(ui: 'nb' | 'en' | 'zh'): string[] {
  if (ui === 'nb') return ['nor', 'eng']
  if (ui === 'zh') return ['chi_sim', 'eng']
  return ['eng', 'nor']
}

/** Whether a string shows anything. Whitespace and the zero-width characters
 *  HTML-to-PDF writers emit (U+200B, soft hyphens, BOM…) do not count — the
 *  rule PdfPage marks a span ws-only by. */
export const isVisibleText = (s: string): boolean => s.replace(/[\s­​-‏⁠﻿]/gu, '') !== ''

/** Whether a page's own text has anything a reader could search or select */
export function hasVisibleText(content: Pick<TextContent, 'items'>): boolean {
  return content.items.some((item) => 'str' in item && isVisibleText(item.str))
}

export interface OcrWord {
  text: string
  /** Box in raster px, y down */
  left: number
  top: number
  width: number
  height: number
  conf: number
}

export interface OcrLine {
  /** The line's box in raster px — words are laid on its baseline */
  left: number
  top: number
  width: number
  height: number
  words: OcrWord[]
}

export interface OcrParagraph {
  lines: OcrLine[]
}

/** Tesseract's TSV (GetTSVText) as paragraphs of lines of words, in its
 *  reading order — which already runs down one column before the next.
 *
 *  Columns: level page block par line word left top width height conf text.
 *  Level 4 is a line, 5 a word. A blank word is dropped, and so is one of
 *  symbols alone below OCR_SYMBOL_MIN_CONFIDENCE; a line left without words
 *  goes with them, and so does a paragraph. */
export function parseTsv(tsv: string): OcrParagraph[] {
  const paragraphs: OcrParagraph[] = []
  let parKey = ''
  let par: OcrParagraph | null = null
  let line: OcrLine | null = null
  for (const row of tsv.split('\n')) {
    const cols = row.split('\t')
    if (cols.length < 12) continue
    const level = Number(cols[0])
    if (level !== 4 && level !== 5) continue
    const [left, top, width, height] = cols.slice(6, 10).map(Number)
    if (![left, top, width, height].every(Number.isFinite)) continue
    if (level === 4) {
      // Block and paragraph numbers together name the paragraph
      const key = `${cols[2]}/${cols[3]}`
      if (key !== parKey || !par) {
        parKey = key
        par = { lines: [] }
        paragraphs.push(par)
      }
      line = { left, top, width, height, words: [] }
      par.lines.push(line)
      continue
    }
    const text = cols.slice(11).join('\t').trim()
    const conf = Number(cols[10])
    if (!line || text === '') continue
    if (!HAS_WORD_CHAR.test(text) && !(conf >= OCR_SYMBOL_MIN_CONFIDENCE)) continue
    line.words.push({ text, left, top, width, height, conf })
  }
  for (const p of paragraphs) p.lines = p.lines.filter((l) => l.words.length > 0)
  return paragraphs.filter((p) => p.lines.length > 0)
}

/** Raster px → PDF user space. ocr.ts passes the OCR viewport's own
 *  convertToPdfPoint, so a /Rotate page maps back through its rotation. */
export type ToPdfPoint = (x: number, y: number) => number[]

/**
 * The recognised paragraphs as pdf.js text content.
 *
 * One item per word, its trailing space included («word »), so the page text
 * reads «one two three» and a phrase search finds words across items — and
 * each word keeps its own place on the line: pdf.js stretches a span to the
 * item's width, and a whole line in one item would drift off the words of a
 * justified line by the time it reached the far end. A word's item reaches to
 * the next word, so a selection across a line is one unbroken band, as on a
 * born-digital page.
 *
 * Every word on a line shares the line's box: its height is the font height
 * and its baseline sits ASCENT of the way down, so the spans line up in a row
 * whatever each word's own ascenders and descenders were. The last word of a
 * line ends it (hasEOL → '\n' in the page text, a <br> in the layer); a
 * paragraph ends with an empty item that ends one more line, so the page text
 * carries a blank line between paragraphs.
 */
export function toTextContent(paragraphs: OcrParagraph[], toPdf: ToPdfPoint): TextContent {
  const items: TextItem[] = []
  const at = (x: number, y: number): [number, number] => {
    const [px, py] = toPdf(x, y)
    return [px, py]
  }
  for (const par of paragraphs) {
    for (const line of par.lines) {
      const baseline = line.top + ASCENT * line.height
      const [ox, oy] = at(line.left, baseline)
      const [ex, ey] = at(line.left + line.width, baseline)
      const [ux, uy] = at(line.left, baseline - line.height)
      // The line's direction and its height vector, in PDF units — the OCR
      // raster may be turned against the page (/Rotate) and is scaled to
      // OCR_DPI. The text matrix is the unit run along the line, scaled to
      // the font size, and the height vector itself.
      const run = Math.hypot(ex - ox, ey - oy)
      const len = run / Math.max(1, line.width)
      const size = Math.hypot(ux - ox, uy - oy)
      const dx = (size * (ex - ox)) / Math.max(1e-9, run)
      const dy = (size * (ey - oy)) / Math.max(1e-9, run)
      line.words.forEach((word, i) => {
        const last = i === line.words.length - 1
        const right = last ? word.left + word.width : line.words[i + 1].left
        const [x, y] = at(word.left, baseline)
        items.push({
          str: last ? word.text : `${word.text} `,
          dir: 'ltr',
          transform: [dx, dy, ux - ox, uy - oy, x, y],
          width: Math.max(0, right - word.left) * len,
          height: size,
          fontName: OCR_FONT,
          hasEOL: last
        })
      })
    }
    items.push({ str: '', dir: 'ltr', transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0, fontName: OCR_FONT, hasEOL: true })
  }
  // The trailing paragraph break says nothing — the page ends there anyway
  if (items.length > 0) items.pop()
  return {
    items,
    styles: { [OCR_FONT]: { fontFamily: 'sans-serif', ascent: ASCENT, descent: ASCENT - 1, vertical: false } },
    lang: null
  }
}

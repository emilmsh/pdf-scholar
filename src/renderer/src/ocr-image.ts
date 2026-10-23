// Text in images on pages that HAVE text of their own: a figure, a screenshot,
// a table pasted in as a picture. Its words join the page's text, so a search
// for a label finds the figure and the assistant reads it.
//
// Never where the page already has the text (Emil, 2026-10-23: no OCR of
// finished text, no duplicates, no rubbish in what search and the assistant
// read): an image with the page's own text over it is left alone, a word
// lying on the page's own text is dropped, and an image whose words Tesseract
// is unsure of goes whole. The pixels are the ones pdf.js already decoded for
// drawing the page (ocr.ts) — nothing is drawn again for this.
//
// Pure, like ocr-text.ts: scripts/test-ocr.mjs runs it in plain Node.
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { OCR_FONT, OCR_MAX_SIDE, isVisibleText, toTextContent } from './ocr-text'
import type { OcrLine, OcrParagraph, ToPdfPoint } from './ocr-text'

/** pdf.js's decoded image formats (ImageKind): RGBA, RGB, and 1 bit per pixel
 *  with rows padded to a byte (1 = white) */
export type PixelFormat = 'rgba' | 'rgb' | 'bw1'

/** Decoded pixels → 8-bit grey PGM, `upscale` times the size (bilinear). RGBA
 *  is laid on white paper by its alpha. */
export function pixelsToPgm(
  format: PixelFormat,
  data: ArrayLike<number>,
  width: number,
  height: number,
  upscale = 1
): Uint8Array {
  const src = new Uint8Array(width * height)
  if (format === 'bw1') {
    const stride = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        src[y * width + x] = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
      }
    }
  } else {
    const step = format === 'rgba' ? 4 : 3
    for (let i = 0, j = 0; j < src.length; i += step, j++) {
      const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      src[j] = step === 4 ? (lum * data[i + 3] + 255 * (255 - data[i + 3])) / 255 : lum
    }
  }
  const k = Math.max(1, Math.round(upscale))
  const w = width * k
  const h = height * k
  const header = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`)
  const out = new Uint8Array(header.length + w * h)
  out.set(header)
  if (k === 1) {
    out.set(src, header.length)
    return out
  }
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / k - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(height - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / k - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(width - 1, x0 + 1)
      const fx = sx - x0
      const top = src[y0 * width + x0] * (1 - fx) + src[y0 * width + x1] * fx
      const bottom = src[y1 * width + x0] * (1 - fx) + src[y1 * width + x1] * fx
      out[header.length + y * w + x] = top * (1 - fy) + bottom * fy
    }
  }
  return out
}

/** A box in PDF user space (y up) */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The box each visible item of the page's own text covers, in user space,
 *  in item order. Turned text gets the box around its turned rectangle;
 *  descenders reach a quarter of the font size under the baseline. */
export function ownTextBoxes(content: Pick<TextContent, 'items'>): { box: Box; chars: number }[] {
  const out: { box: Box; chars: number }[] = []
  for (const item of content.items) {
    if (!('str' in item) || !isVisibleText(item.str)) continue
    const [a, b, c, d, e, f] = item.transform as number[]
    const run = Math.hypot(a, b) || 1
    const up = Math.hypot(c, d) || 1
    const size = item.height || up
    const [ux, uy, dx, dy] = [c / up, d / up, a / run, b / run]
    const pts = [
      [e - 0.25 * size * ux, f - 0.25 * size * uy],
      [e + size * ux, f + size * uy],
      [e + item.width * dx - 0.25 * size * ux, f + item.width * dy - 0.25 * size * uy],
      [e + item.width * dx + size * ux, f + item.width * dy + size * uy]
    ]
    out.push({
      box: {
        x0: Math.min(...pts.map((p) => p[0])),
        y0: Math.min(...pts.map((p) => p[1])),
        x1: Math.max(...pts.map((p) => p[0])),
        y1: Math.max(...pts.map((p) => p[1]))
      },
      chars: item.str.trim().length
    })
  }
  return out
}

const inside = (b: Box, x: number, y: number): boolean => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1

/** Smallest image read, in points and in its own pixels — logos, icons and
 *  rules below this hold no text worth a search */
export const IMAGE_MIN_PT = { w: 60, h: 20 }
export const IMAGE_MIN_PX = { w: 120, h: 30 }
/** An image the page already has this much of its own text over is left
 *  alone: its text is there (a labelled plot, a scan with a text layer) */
export const IMAGE_OWN_TEXT_CHARS = 15
/** At most this many images per page, the largest first — a page tiled with
 *  hundreds of small pictures is not a page of figures */
export const IMAGES_PER_PAGE = 12

/** Where the decoded pixels of an image are (image-regions.ts records it) */
export interface ImageSource {
  /** pdf.js object id of an image XObject — page.objs, or commonObjs for g_… */
  objId?: string
  /** An inline image's decoded data, carried in the operator list itself */
  inline?: unknown
}

export interface ImageCandidate extends Box {
  px: { w: number; h: number }
  src: ImageSource
}

/** The images on a page worth reading: drawn upright (pixel rows run along
 *  the page's lines), big enough to hold words, with pixels pdf.js decoded,
 *  and NOT already covered by the page's own text. */
export function imageCandidates(
  rects: (Box & { px?: { w: number; h: number }; src?: ImageSource; upright?: boolean })[],
  own: Pick<TextContent, 'items'>
): ImageCandidate[] {
  const ownBoxes = ownTextBoxes(own)
  const out: ImageCandidate[] = []
  for (const r of rects) {
    if (!r.px || !r.src || !r.upright) continue
    if (r.x1 - r.x0 < IMAGE_MIN_PT.w || r.y1 - r.y0 < IMAGE_MIN_PT.h) continue
    if (r.px.w < IMAGE_MIN_PX.w || r.px.h < IMAGE_MIN_PX.h) continue
    // A photograph the size of a building is not a figure, and reading it
    // would not be over in a moment
    if (Math.max(r.px.w, r.px.h) > 2 * OCR_MAX_SIDE) continue
    let chars = 0
    for (const { box, chars: n } of ownBoxes) {
      if (inside(r, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)) chars += n
    }
    if (chars >= IMAGE_OWN_TEXT_CHARS) continue
    out.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, px: r.px, src: r.src })
  }
  const area = (b: Box): number => (b.x1 - b.x0) * (b.y1 - b.y0)
  return out.sort((a, b) => area(b) - area(a)).slice(0, IMAGES_PER_PAGE)
}

/** How much an image is enlarged before reading: text in a coarse picture is
 *  too small for Tesseract at its own pixels (it wants an x-height near 20 px) */
export function imageUpscale(c: Pick<ImageCandidate, 'x0' | 'x1' | 'px'>): number {
  const dpi = c.px.w / ((c.x1 - c.x0) / 72)
  let k = dpi < 110 ? 3 : dpi < 200 ? 2 : 1
  while (k > 1 && Math.max(c.px.w, c.px.h) * k > OCR_MAX_SIDE) k--
  return k
}

/** One read image: its box on the page, the raster it was read at, its words
 *  (already through imageWords) */
export interface ImageRegionText extends Box {
  w: number
  h: number
  paragraphs: OcrParagraph[]
}

/** Raster px of a read image → user space: an upright image fills its box */
export const regionToPdf =
  (r: Box & { w: number; h: number }): ToPdfPoint =>
  (x, y) => [r.x0 + (x / r.w) * (r.x1 - r.x0), r.y1 - (y / r.h) * (r.y1 - r.y0)]

/** An image is text when the words read in it are, on average, at least
 *  this sure (0–100): a table or a labelled diagram reads in the 70s–90s, a
 *  photo or a texture as a scatter of guesses in the 30s–40s */
export const IMAGE_MEAN_CONFIDENCE = 55
/** A word of one or two characters (a «pf», a «J», a «1» off a stroke of a
 *  diagram) is kept only this sure; longer words are kept as read */
export const IMAGE_SHORT_WORD_CONFIDENCE = 85

/** The symbols that stand as words in a figure's labels («Add & Norm», «+»,
 *  «%») — kept when read surely. Brackets and bars are what a box's edges
 *  read as, and go. */
const LABEL_SYMBOLS = /^[&+%=/–-]+$/u

/** An image's words fit to join the page's text — or none.
 *
 *  The verdict is the IMAGE's, not each word's: Tesseract's per-word scores
 *  are not a measure of the word — in a table read right, «per innbygger»
 *  came back at 19.9 beside «Kostnader» at 78.8 (test:ocr), the same quirk
 *  that scored «Vi bruker» on a clean scan at 0.0. So an image counts as
 *  text when its words average IMAGE_MEAN_CONFIDENCE and at least two have
 *  three characters or more; then every word with a letter or a digit is
 *  kept, except a short fragment Tesseract is unsure of. A word that lies on
 *  the page's own text is never kept — that text is there already. */
export function imageWords(paragraphs: OcrParagraph[], toPdf: ToPdfPoint, own: Pick<TextContent, 'items'>): OcrParagraph[] {
  const ownBoxes = ownTextBoxes(own).map((o) => o.box)
  const wordChars = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length
  let long = 0
  let count = 0
  let confSum = 0
  const out: OcrParagraph[] = []
  for (const par of paragraphs) {
    const lines: OcrLine[] = []
    for (const line of par.lines) {
      const words = line.words.filter((w) => {
        const n = wordChars(w.text)
        if (n === 0 && !(LABEL_SYMBOLS.test(w.text) && w.conf >= IMAGE_SHORT_WORD_CONFIDENCE)) return false
        if (n < 3 && !(w.conf >= IMAGE_SHORT_WORD_CONFIDENCE)) return false
        const [x, y] = toPdf(w.left + w.width / 2, w.top + w.height / 2)
        return !ownBoxes.some((b) => inside(b, x, y))
      })
      if (words.length === 0) continue
      for (const w of words) {
        count++
        confSum += w.conf
        if (wordChars(w.text) >= 3) long++
      }
      lines.push({ ...line, words })
    }
    if (lines.length > 0) out.push({ lines })
  }
  return long >= 2 && confSum / count >= IMAGE_MEAN_CONFIDENCE ? out : []
}

const paragraphBreak = (): TextItem => ({
  str: '',
  dir: 'ltr',
  transform: [1, 0, 0, 1, 0, 0],
  width: 0,
  height: 0,
  fontName: OCR_FONT,
  hasEOL: true
})

/** The read images of a page as text content, one block after another */
export function imageTextContent(regions: ImageRegionText[]): TextContent {
  const items: TextContent['items'] = []
  let styles: TextContent['styles'] = {}
  for (const r of regions) {
    if (r.paragraphs.length === 0) continue
    const content = toTextContent(r.paragraphs, regionToPdf(r))
    if (items.length > 0) items.push(paragraphBreak())
    items.push(...content.items)
    styles = { ...styles, ...content.styles }
  }
  return { items, styles, lang: null }
}

/** The page's own text, then — after a blank line — the words in its images.
 *  Own text first and untouched, so every offset into it is the same with or
 *  without the images' words (search.ts relies on that prefix). */
export function mergeImageText(own: TextContent, images: TextContent): TextContent {
  if (images.items.length === 0) return own
  return {
    items: [...own.items, paragraphBreak(), paragraphBreak(), ...images.items],
    styles: { ...own.styles, ...images.styles },
    lang: own.lang
  }
}

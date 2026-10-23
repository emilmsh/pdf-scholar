// Full-document text search. Page text is extracted once per document and
// cached; matches are located back on screen by mapping character offsets to
// the pdf.js text-layer spans (spans correspond 1:1 to non-empty text items).
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import type { PageRect } from '../../shared/types'
import { clientRectsToPageRects } from './annotations'
import { OCR_FONT, hasVisibleText } from './ocr-text'

export interface PageText {
  /** Concatenated item strings; '\n' appended after items with hasEOL */
  text: string
  /** Non-empty items only: char offset, length, in span order */
  runs: { start: number; length: number }[]
  /** The first run OCR read, when the page has any: all of a scanned page's,
   *  or the words in its images after its own text (ocr-image.ts). What lets
   *  a text layer built with or without the images' words still be measured
   *  against this text — the page's own runs are a prefix of both. */
  ocrRunsFrom?: number
}

export interface SearchMatch {
  pageNumber: number
  start: number
  end: number
  snippet: string
  /** offset of the query within the snippet (for highlighting in the list) */
  snippetOffset: number
}

export interface SearchOptions {
  matchCase: boolean
  wholeWords: boolean
}

const MAX_MATCHES = 500

/** Whether the words OCR reads in a page's IMAGES are waited for. Only search
 *  waits ('wait', and it shows what it has meanwhile); everything else takes
 *  what is already read ('available') — a figure is never a reason for the
 *  assistant or the export to stand still (Emil, 2026-10-23). A scanned page
 *  has no text without OCR and is waited for either way. */
export type ImageText = 'wait' | 'available'

/** Where text the PDF lacks comes from: ocr.ts (installOcr) — a scanned
 *  page's words in place of its empty `own` text, or `own` with its images'
 *  words appended; null keeps `own`. Injected rather than imported so this
 *  module — and its tests — stay free of the engine. */
export type TextFallback = (
  pdf: PDFDocumentProxy,
  pageNumber: number,
  own: TextContent,
  opts: { priority?: number; signal?: AbortSignal; images?: ImageText }
) => Promise<TextContent | null>

let textFallback: TextFallback | null = null

export function setTextFallback(fallback: TextFallback | null): void {
  textFallback = fallback
}

/** A page's text content: its own, or — a scanned page with none — the words
 *  OCR found on it, or its own with the words in its images after it. The
 *  ONE place both the text layer's source and every extracted PageText come
 *  from, so the spans and the runs correspond (see resolveMatchRects). An XFA
 *  form's text is never read. */
export async function pageTextContent(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  opts: { priority?: number; signal?: AbortSignal; images?: ImageText } = {}
): Promise<TextContent> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  if (!textFallback || pdf.isPureXfa) return content
  return (await textFallback(pdf, pageNumber, content, opts)) ?? content
}

/** Text content → page text, with a run per non-empty item */
function toPageText(content: TextContent, xfa: boolean): PageText {
  let text = ''
  const runs: { start: number; length: number }[] = []
  let ocrRunsFrom: number | undefined
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (item.str !== '') {
      if (ocrRunsFrom === undefined && item.fontName === OCR_FONT) ocrRunsFrom = runs.length
      runs.push({ start: text.length, length: item.str.length })
      text += item.str
    }
    // An XFA form's items are the laid-out form's text nodes (a caption, a
    // paragraph, a label) with no positions and no hasEOL — glued together
    // they would read «Page of Support for…». Each one ends its own line.
    if (item.hasEOL || xfa) text += '\n'
  }
  return ocrRunsFrom === undefined ? { text, runs } : { text, runs, ocrRunsFrom }
}

/**
 * One page's text and runs.
 *
 * Split out of buildPageTexts because a whole-document pass is the wrong unit
 * for anything interactive: on a 15-page paper it takes over a second, and the
 * markup-end drag needs exactly one page's text before the hand has finished
 * moving. Extracting that page alone is a few tens of milliseconds — a scanned
 * page the first time it is read takes the OCR's second or two instead.
 */
export async function buildPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageText> {
  return toPageText(await pageTextContent(pdf, pageNumber), pdf.isPureXfa)
}

/**
 * Every page's text and runs.
 *
 * In two passes: first every page's own text (fast), then what OCR adds — a
 * scanned page's words, a second or two each, and with `images: 'wait'` the
 * words in the images of pages that have text. `onProgress` hears the pages
 * as they change — the array in page order, the own text in place from the
 * first pass on — so a search shows what it has found at once instead of
 * waiting minutes on a long book. With a `signal` the pass can be given up:
 * pages not yet read leave the OCR queue and the promise rejects.
 */
export async function buildPageTexts(
  pdf: PDFDocumentProxy,
  opts: { onProgress?(pages: PageText[]): void; signal?: AbortSignal; images?: ImageText } = {}
): Promise<PageText[]> {
  const pages: PageText[] = []
  const owns: TextContent[] = []
  let scanned = false
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    opts.signal?.throwIfAborted()
    if (!hasVisibleText(content)) scanned = true
    owns.push(content)
    pages.push(toPageText(content, pdf.isPureXfa))
  }
  if (!textFallback || pdf.isPureXfa) return pages
  const fallback = textFallback
  // The own text is searchable now; what OCR adds follows page by page
  if (scanned || opts.images === 'wait') opts.onProgress?.(pages.slice())
  const rest = { images: opts.images ?? 'available', ...(opts.signal ? { signal: opts.signal } : {}) }
  // All at once, so the queue holds the whole pass (and the pages on screen
  // can still jump it); each lands in its slot as it is read
  await Promise.all(
    owns.map(async (own, i) => {
      const content = await fallback(pdf, i + 1, own, rest)
      if (!content) return
      pages[i] = toPageText(content, false)
      opts.onProgress?.(pages.slice())
    })
  )
  return pages
}

/** Whether the document has a text layer worth reading at all.
 *
 *  A scanned PDF is pictures of words: getTextContent returns nothing, and
 *  where OCR could not help either (the engine would not start, the pages are
 *  photographs) every page comes back as `{ text: '', runs: [] }` with no
 *  error anywhere. Callers
 *  that would otherwise send an empty document to a model — or search text that
 *  does not exist — have to ask first, because the failure is silent and looks
 *  like the document simply saying nothing.
 *
 *  A page or two of scanned plates inside a normal paper is not this case, hence
 *  "any page", not "every page". */
export const hasExtractableText = (pages: PageText[]): boolean =>
  pages.some((p) => p.text.trim() !== '')

const WORD_CHAR = /[\p{L}\p{N}_]/u

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The query as a pattern over a page's text. Every whitespace run in the
 *  query matches ANY whitespace run on the page, so a phrase the page breaks
 *  across a line — «originated» + '\n' + «in», the '\n' buildPageText writes
 *  after an item with hasEOL — is still one match (issue #38: «The tree
 *  originated in» found nothing while «The tree originated» did). Leading and
 *  trailing blanks are dropped: a reader who has typed «originated » is on the
 *  way to the next word, not asking for a space. Null for a blank query. */
export function queryPattern(query: string, matchCase: boolean): RegExp | null {
  const words = query.trim().split(/\s+/)
  if (words.length === 0 || words[0] === '') return null
  return new RegExp(words.map(escapeRe).join('\\s+'), matchCase ? 'g' : 'gi')
}

export function findMatches(
  pages: PageText[],
  query: string,
  opts: SearchOptions
): SearchMatch[] {
  const matches: SearchMatch[] = []
  const re = queryPattern(query, opts.matchCase)
  if (!re) return matches
  for (let p = 0; p < pages.length; p++) {
    const haystack = pages[p].text
    let from = 0
    while (matches.length < MAX_MATCHES) {
      re.lastIndex = from
      const m = re.exec(haystack)
      if (!m) break
      const at = m.index
      from = at + 1
      const end = at + m[0].length
      if (opts.wholeWords && !isWholeWord(pages[p].text, at, end)) continue
      const snippetStart = Math.max(0, at - 32)
      const snippetEnd = Math.min(pages[p].text.length, end + 42)
      matches.push({
        pageNumber: p + 1,
        start: at,
        end,
        snippet:
          (snippetStart > 0 ? '…' : '') +
          pages[p].text.slice(snippetStart, snippetEnd).replaceAll('\n', ' ') +
          (snippetEnd < pages[p].text.length ? '…' : ''),
        snippetOffset: at - snippetStart + (snippetStart > 0 ? 1 : 0)
      })
    }
    if (matches.length >= MAX_MATCHES) break
  }
  return matches
}

/** Whether a character range lies among the words OCR read in the page's
 *  images (after its own text) — a range a text layer can only measure once
 *  those words have joined it, which happens after the layer's first build */
export function inImageWords(pageText: PageText | undefined, range: { start: number }): boolean {
  const from = pageText?.ocrRunsFrom
  if (!pageText || from === undefined || from === 0) return false
  const first = pageText.runs[from]
  return !!first && range.start >= first.start
}

/** «The words in this page's images are in the DOM» */
export const IMAGE_SPANS_READY_SELECTOR = '.text-host .textLayer > span[data-ocr="image"]'

/** An XFA page's text spans — the laid-out form's text nodes, wrapped in the
 *  order getTextContent() lists them (xfa.ts). */
const XFA_TEXT_SPANS = '.xfa-host .xfaLayer span.xfa-text'

/** «This page's text is in the DOM»: what a search jump waits for before it
 *  measures a match — the pdf.js text layer, or an XFA page's spans. */
export const TEXT_SPANS_READY_SELECTOR = `.text-host .textLayer > span, ${XFA_TEXT_SPANS}`

/** The spans a page's matches are measured against, or null when the text layer
 *  is not in the DOM yet or does not correspond 1:1 to the extracted runs (see
 *  the invariant in CLAUDE.md — includeMarkedContent would break it). An XFA
 *  page has no text layer; its wrapped text nodes carry the same invariant. */
function matchSpans(pageEl: HTMLElement, pageText: PageText): NodeListOf<HTMLElement> | null {
  const textLayer = pageEl.querySelectorAll<HTMLElement>('.text-host .textLayer > span')
  const spans = textLayer.length > 0 ? textLayer : pageEl.querySelectorAll<HTMLElement>(XFA_TEXT_SPANS)
  if (spans.length === 0) return null
  if (spans.length === pageText.runs.length) return spans
  // The words OCR read in the page's images come after its own text, in the
  // layer (spans marked data-ocr="image", PdfPage) and in the text alike —
  // one of them may have them already and the other not yet. The page's own
  // words are then still a prefix of both, and measure true; a match among
  // the images' words finds no span and comes back null (rectsFromSpans).
  let layerOwn = spans.length
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].dataset.ocr === 'image') {
      layerOwn = i
      break
    }
  }
  const textOwn = pageText.ocrRunsFrom ?? pageText.runs.length
  return layerOwn === textOwn ? spans : null
}

/** One character range's rects, measured against spans the caller already
 *  queried. Takes a bare {start,end} rather than a SearchMatch: the extent of a
 *  text markup is the same question asked by a different feature (dragging the
 *  ends of a highlight, text-range.ts), and the measurement has no opinion about
 *  which one is asking. */
function rectsFromSpans(
  pageEl: HTMLElement,
  pageText: PageText,
  spans: NodeListOf<HTMLElement>,
  match: { start: number; end: number },
  scale: number
): PageRect[] | null {
  const { runs } = pageText
  let first = -1
  let last = -1
  for (let i = 0; i < runs.length; i++) {
    const runEnd = runs[i].start + runs[i].length
    if (first === -1 && match.start < runEnd) first = i
    if (match.end > runs[i].start) last = i
  }
  if (first === -1 || last < first || last >= spans.length) return null
  const startNode = spans[first].firstChild
  const endNode = spans[last].firstChild
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, Math.max(0, match.start - runs[first].start))
  range.setEnd(endNode, Math.min(runs[last].length, match.end - runs[last].start))
  return clientRectsToPageRects(range.getClientRects(), pageEl, scale)
}

/**
 * Locate a match's rectangles (page space) via the rendered text layer.
 * Returns null if the page's text layer is not in the DOM yet.
 */
export function resolveMatchRects(
  pageEl: HTMLElement,
  pageText: PageText,
  match: { start: number; end: number },
  scale: number
): PageRect[] | null {
  const spans = matchSpans(pageEl, pageText)
  return spans ? rectsFromSpans(pageEl, pageText, spans, match, scale) : null
}

/**
 * Every match on one page, in one pass. Highlight-all needs the whole page's
 * rects, and calling resolveMatchRects per match would re-query the span list
 * and force a separate layout flush each time — on a dense page that is a few
 * hundred spans re-walked per match. Here the spans are queried once and the
 * ranges measured together, so the browser can batch the reads.
 *
 * Rects come back FLATTENED: the caller paints them, and which match a rect
 * belongs to does not change how it is drawn.
 */
export function resolveAllMatchRects(
  pageEl: HTMLElement,
  pageText: PageText,
  matches: SearchMatch[],
  scale: number
): PageRect[] | null {
  const spans = matchSpans(pageEl, pageText)
  if (!spans) return null
  const out: PageRect[] = []
  for (const match of matches) {
    const rects = rectsFromSpans(pageEl, pageText, spans, match, scale)
    if (rects) out.push(...rects)
  }
  return out
}

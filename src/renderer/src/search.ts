// Full-document text search. Page text is extracted once per document and
// cached; matches are located back on screen by mapping character offsets to
// the pdf.js text-layer spans (spans correspond 1:1 to non-empty text items).
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect } from '../../shared/types'
import { clientRectsToPageRects } from './annotations'

export interface PageText {
  /** Concatenated item strings; '\n' appended after items with hasEOL */
  text: string
  /** Non-empty items only: char offset, length, in span order */
  runs: { start: number; length: number }[]
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

export async function buildPageTexts(pdf: PDFDocumentProxy): Promise<PageText[]> {
  const pages: PageText[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    const runs: { start: number; length: number }[] = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      if (item.str !== '') {
        runs.push({ start: text.length, length: item.str.length })
        text += item.str
      }
      if (item.hasEOL) text += '\n'
    }
    pages.push({ text, runs })
  }
  return pages
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))
}

export function findMatches(
  pages: PageText[],
  query: string,
  opts: SearchOptions
): SearchMatch[] {
  const matches: SearchMatch[] = []
  const needle = opts.matchCase ? query : query.toLowerCase()
  if (!needle) return matches
  for (let p = 0; p < pages.length; p++) {
    const haystack = opts.matchCase ? pages[p].text : pages[p].text.toLowerCase()
    let from = 0
    while (matches.length < MAX_MATCHES) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      from = at + 1
      const end = at + needle.length
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

/** The spans a page's matches are measured against, or null when the text layer
 *  is not in the DOM yet or does not correspond 1:1 to the extracted runs (see
 *  the invariant in CLAUDE.md — includeMarkedContent would break it). */
function matchSpans(pageEl: HTMLElement, pageText: PageText): NodeListOf<HTMLElement> | null {
  const spans = pageEl.querySelectorAll<HTMLElement>('.text-host .textLayer > span')
  return spans.length === 0 || spans.length !== pageText.runs.length ? null : spans
}

/** One match's rects, measured against spans the caller already queried. */
function rectsFromSpans(
  pageEl: HTMLElement,
  pageText: PageText,
  spans: NodeListOf<HTMLElement>,
  match: SearchMatch,
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
  if (first === -1 || last < first) return null
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
  match: SearchMatch,
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

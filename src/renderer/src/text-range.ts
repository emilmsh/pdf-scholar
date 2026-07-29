// Points on screen -> character offsets in a page's extracted text.
//
// search.ts goes the other way (offsets -> rects, measured through the pdf.js
// text layer). Editing a highlight's ends needs the inverse: what character is
// under the cursor right now. Both directions rest on the same invariant — the
// text-layer spans correspond 1:1, in order, to the non-empty getTextContent()
// items recorded in PageText.runs (see CLAUDE.md).
import type { PageText } from './search'

export interface CharRange {
  start: number
  end: number
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * Grow a range outward to whole words.
 *
 * Dragging a highlight's end snaps to word boundaries rather than characters —
 * the same thing Preview and PDF Expert do, and for the same reason: a
 * character-precise edge is fiddly to hit with a mouse, and half a word is
 * almost never what anyone meant to mark.
 */
export function snapToWords(text: string, range: CharRange): CharRange {
  let { start, end } = range
  while (start > 0 && WORD_CHAR.test(text[start - 1] ?? '') && WORD_CHAR.test(text[start] ?? '')) {
    start--
  }
  while (end < text.length && WORD_CHAR.test(text[end] ?? '') && WORD_CHAR.test(text[end - 1] ?? '')) {
    end++
  }
  return { start, end }
}

/** The text-layer spans for a page, or null when the layer is absent or has
 *  drifted out of step with the extracted runs. Same guard as search.ts: a
 *  mismatch means every offset would be wrong, so refuse rather than guess. */
function textSpans(pageEl: HTMLElement, pageText: PageText): HTMLElement[] | null {
  const spans = pageEl.querySelectorAll<HTMLElement>('.text-host .textLayer > span')
  if (spans.length === 0 || spans.length !== pageText.runs.length) return null
  return Array.from(spans)
}

/** Caret position under a client point, across the standard API and the older
 *  WebKit-era one Chromium still ships. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?(x: number, y: number): Range | null
  }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * The character offset under a client point.
 *
 * The caret API answers directly when the point is over a glyph. When it is not
 * — past the end of a line, in the gutter, inside the leading between lines,
 * all of which happen constantly while dragging an end — fall back to the
 * nearest span and pick the edge the cursor is closer to. Without that fallback
 * the drag would simply stop responding whenever it left the text, which reads
 * as the feature being broken rather than as the cursor being 3 px too low.
 */
export function offsetAtPoint(
  pageEl: HTMLElement,
  pageText: PageText,
  clientX: number,
  clientY: number
): number | null {
  const spans = textSpans(pageEl, pageText)
  if (!spans) return null

  const caret = caretAt(clientX, clientY)
  const host = caret?.node.parentElement?.closest<HTMLElement>('.textLayer > span')
  if (host && pageEl.contains(host)) {
    const index = spans.indexOf(host)
    const run = pageText.runs[index]
    if (run) return run.start + Math.min(caret?.offset ?? 0, run.length)
  }

  // Nearest span, then its nearer edge.
  let best = -1
  let bestDist = Infinity
  let atEnd = false
  for (let i = 0; i < spans.length; i++) {
    const r = spans[i].getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0
    // Vertical distance weighs more: the line you are on matters more than how
    // far along it you are, or a drag one line down would grab the line above.
    const dist = dx + dy * 3
    if (dist < bestDist) {
      bestDist = dist
      best = i
      atEnd = clientX > (r.left + r.right) / 2
    }
  }
  const run = best === -1 ? undefined : pageText.runs[best]
  if (!run) return null
  return atEnd ? run.start + run.length : run.start
}

/**
 * The character range a text markup covers, read back from its quads.
 *
 * Nothing in the file records it: a Highlight is a list of rectangles, and the
 * text under them is only knowable through the rendered text layer. Probing the
 * caret just inside the first quad's left edge and the last quad's right edge
 * gives character precision for free, and reuses the one primitive above
 * instead of a second span-walking path.
 *
 * Page space equals view space here — the caller only offers this unrotated.
 */
export function rangeOfQuads(
  pageEl: HTMLElement,
  pageText: PageText,
  quads: { x: number; y: number; w: number; h: number }[],
  scale: number
): CharRange | null {
  const first = quads[0]
  const last = quads[quads.length - 1]
  if (!first || !last) return null
  const box = pageEl.getBoundingClientRect()
  const probe = (x: number, q: { y: number; h: number }): number | null =>
    offsetAtPoint(pageEl, pageText, box.left + x * scale, box.top + (q.y + q.h / 2) * scale)
  const start = probe(first.x + 1, first)
  const end = probe(last.x + last.w - 1, last)
  if (start === null || end === null || end <= start) return null
  return snapToWords(pageText.text, { start, end })
}

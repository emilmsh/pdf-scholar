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

/**
 * The character offset under a client point.
 *
 * Deliberately does NOT use caretPositionFromPoint. That API hit-tests the page,
 * so it answers about whatever is ON TOP — and the selection layer that carries
 * the drag handles has to sit above the text layer to be grabbable at all. With
 * it there, the caret API stopped returning text nodes and the drag quietly
 * resolved to "no change" (caught by test:annot-edit, after the z-index fix that
 * made the handles reachable). Measuring the geometry ourselves is immune to
 * whatever is layered over the page, which is the property this needs.
 *
 * Two steps: pick the line (nearest span, weighting vertical distance — which
 * line you are on matters more than how far along it), then binary-search that
 * line for the character whose trailing edge the pointer has passed. Both work
 * past the end of a line, in the gutter and in the leading between lines, all of
 * which happen constantly while dragging.
 */
export function offsetAtPoint(
  pageEl: HTMLElement,
  pageText: PageText,
  clientX: number,
  clientY: number
): number | null {
  const spans = textSpans(pageEl, pageText)
  if (!spans) return null

  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < spans.length; i++) {
    const r = spans[i].getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0
    const dist = dx + dy * 3
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  const run = best === -1 ? undefined : pageText.runs[best]
  const node = best === -1 ? null : spans[best].firstChild
  if (!run) return null
  if (!node) return run.start

  // The character whose right edge the pointer has passed, found by halving.
  // ~5 range measurements for a 40-character line, all reads, no layout writes.
  const range = document.createRange()
  let lo = 0
  let hi = run.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    range.setStart(node, 0)
    range.setEnd(node, mid + 1)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1]
    if (!last) break
    if (last.right <= clientX) lo = mid + 1
    else hi = mid
  }
  return run.start + lo
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

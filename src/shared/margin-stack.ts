// The margin view's stacking rule ON SCREEN (MarginNotes.tsx), kept pure so
// it can be tested without a DOM. Every card sits at its anchor's height
// unless the one above pushes it down (Word's comment-column rule). A stack
// that runs off the page bottom is pushed back up as a block — but only as
// far as the page allows: when the cards together are taller than the page
// the push-up used to clamp each card to the top edge, so several landed on
// EDGE_PAD and drew through each other (2026-10-27, three paragraph-long
// comments on one page). Now the stack keeps every card at least `gap` below
// the one above and overhangs the page bottom instead; the margin column is
// a scrolling column, so there is room below — MarginNotes extends the strip
// and the next page's stack starts under the overhang. The export has its
// own, document-wide answer (layoutCards in margin-export.ts): paper cannot
// overhang.
//
// Units are the caller's (CSS px on screen); nothing here is page points.

export interface MarginStackItem {
  /** The anchor's top edge, measured from the page's top; the items come in
   *  anchor order and are placed in that order */
  anchor: number
  /** The card's measured height */
  height: number
}

export interface MarginStackOptions {
  /** Vertical gap between stacked cards */
  gap: number
  /** Cards keep this clear of the page's top and bottom edges */
  edgePad: number
  /** The first card goes no higher than this — the page above's column may
   *  run on into this page. `edgePad` when absent or smaller. */
  floor?: number
}

export interface MarginStack {
  /** Each card's top edge, from the page's top, in the items' order */
  tops: number[]
  /** The last card's bottom edge from the page's top — past the page's
   *  height when the stack overhangs; `floor`/`edgePad` with no cards */
  bottom: number
  /** How far the stack runs past the page's bottom edge, 0 when it fits
   *  (the bottom edge pad counts as the page) */
  overhang: number
}

export function stackMarginCards(
  items: readonly MarginStackItem[],
  pageHeight: number,
  { gap, edgePad, floor }: MarginStackOptions
): MarginStack {
  const first = Math.max(edgePad, floor ?? edgePad)
  const tops: number[] = []
  // 1. Down from the anchors: each card at its anchor unless the one above
  //    pushes it down.
  let prevBottom = first - gap
  for (const it of items) {
    const top = Math.max(it.anchor, prevBottom + gap)
    tops.push(top)
    prevBottom = top + it.height
  }
  const limit = pageHeight - edgePad
  if (prevBottom > limit) {
    // 2. Off the paper: push the tail back up, card by card from the bottom,
    //    each under the one below it. (A card may now sit above the top edge
    //    or on top of the card above it — step 3 settles that.)
    let ceiling = limit
    for (let i = items.length - 1; i >= 0; i--) {
      tops[i] = Math.min(tops[i], ceiling - items[i].height)
      ceiling = tops[i] - gap
    }
    // 3. Down again from the top edge: the first card no higher than the
    //    page (or the column above) allows, every other at least `gap`
    //    below its predecessor. Whatever does not fit now overhangs the
    //    page bottom, in order, readable.
    prevBottom = first - gap
    for (let i = 0; i < items.length; i++) {
      tops[i] = Math.max(tops[i], prevBottom + gap)
      prevBottom = tops[i] + items[i].height
    }
  }
  const bottom = items.length === 0 ? first : prevBottom
  return { tops, bottom, overhang: Math.max(0, bottom - limit) }
}

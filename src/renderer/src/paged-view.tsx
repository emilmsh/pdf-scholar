// «Bla side for side» (issue #29) — the pieces both page columns share.
//
// The paged view is the continuous layout with every row in a viewport-tall
// slot (buildRows' `pagedHeight`) and the scroller snapping slot to slot: CSS
// `scroll-snap-type: y mandatory` on `.pages.paged`, one snap anchor per slot
// with `scroll-snap-stop: always`. That keeps every page where the continuous
// view has it — search, links, the page handle and the annotation overlay all
// work unchanged — while the wheel, a swipe, PageDown and the arrow keys land
// on whole slots. A slot taller than the viewport (zoomed in) can be scrolled
// within: a snap area larger than the snapport is valid at any position that
// covers it, so the page reads top to bottom and only its edge turns it.
import { memo } from 'react'
import type { RowLayout } from './rotation'

/** The anchors the scroller snaps to, one per row. Empty, absolutely
 *  positioned and click-through — they only give scroll-snap something to
 *  align, at the slot's top and over the slot's full height. Memoised on the
 *  layout: the viewer re-renders on every page change, and a long document's
 *  thousand anchors need not be compared each time when nothing moved. */
export const PageSlots = memo(function PageSlots({ layout }: { layout: RowLayout }): React.JSX.Element {
  return (
    <>
      {layout.rows.map((row, i) => (
        <div key={i} className="page-slot" style={{ top: row.top, height: row.height }} />
      ))}
    </>
  )
})

/** A pinch or Ctrl+wheel previews by scaling the pages host with a CSS
 *  transform, which moves the snap anchors with it — a mandatory snap would
 *  pull the scroller about under the fingers. Held off for the gesture… */
export function holdSnap(el: HTMLElement): void {
  el.style.scrollSnapType = 'none'
}

/** …and given back once the zoom has committed and the scroll is anchored:
 *  the browser re-snaps from there, which inside a zoomed-in slot changes
 *  nothing and at a fitted page centres it in its slot again. */
export function releaseSnap(el: HTMLElement): void {
  el.style.scrollSnapType = ''
}

/** Where a page turn in direction `dir` lands from `scrollTop`: the next
 *  slot's top, or — going back — the previous slot's top, or its FOOT when
 *  that page is zoomed in (reading backwards ends where the page ends).
 *  undefined while inside a zoomed-in page short of its edge, where the wheel
 *  should simply scroll; null at the document's either end. */
export function pageTurnTarget(
  layout: RowLayout,
  scrollTop: number,
  viewport: number,
  dir: 1 | -1
): number | null | undefined {
  const rows = layout.rows
  const i = rows.findIndex((r) => scrollTop >= r.top - 1 && scrollTop < r.top + r.height - 1)
  if (i === -1) return undefined
  const row = rows[i]
  const tall = (r: { height: number }): boolean => r.height > viewport + 1
  if (tall(row)) {
    if (dir > 0 && scrollTop + viewport < row.top + row.height - 1) return undefined
    if (dir < 0 && scrollTop > row.top + 1) return undefined
  }
  if (dir > 0) return rows[i + 1]?.top ?? null
  const prev = rows[i - 1]
  if (!prev) return null
  return tall(prev) ? prev.top + prev.height - viewport : prev.top
}

/** The paged view's wheel. Chromium snaps a wheel scroll to the slot NEAREST
 *  where it would have ended, so a notch of 100 px in a slot of 800 falls back
 *  to the page it left — the wheel could not turn a page at all. It is turned
 *  here instead, instantly, the way a page turns:
 *    - a mouse wheel's notch (a big delta, or one counted in lines or pages)
 *      turns one page per notch, so spinning the wheel still flips quickly;
 *    - a trackpad's stream of small deltas is summed, and one swipe turns one
 *      page: after the turn the rest of the gesture — fingers and inertia —
 *      is swallowed until the deltas fall quiet;
 *    - inside a zoomed-in page the browser scrolls as usual, and only at the
 *      page's edge does the next notch turn it.
 *  One per column: the state is the gesture in progress. */
export function createPagedWheel(): (e: WheelEvent, el: HTMLElement, layout: RowLayout) => void {
  let sum = 0
  let spent = false
  let lastEvent = -Infinity
  let lastTurn = -Infinity
  return (e, el, layout) => {
    if (e.deltaY === 0) return
    const now = e.timeStamp
    if (now - lastEvent > 200) {
      // A new gesture
      sum = 0
      spent = false
    }
    lastEvent = now
    const dir = e.deltaY > 0 ? 1 : -1
    const target = pageTurnTarget(layout, el.scrollTop, el.clientHeight, dir)
    if (target === undefined) return
    e.preventDefault()
    if (target === null) return
    const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50
    if (notch) {
      // One notch can arrive as two events on some wheels
      if (now - lastTurn < 60) return
    } else {
      if (spent) return
      sum += e.deltaY
      if (Math.abs(sum) < 60) return
      spent = true
    }
    lastTurn = now
    el.scrollTop = target
  }
}

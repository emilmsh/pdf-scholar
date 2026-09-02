// One address for "scroll THIS column somewhere".
//
// Split view means every go-to action — a search hit, an outline entry, a note
// in the sidebar, an AI citation chip, a hyperlink — has to answer a question it
// never had to before: *which column goes there?* Rather than teach each of
// those functions about panes, they take a PaneHandle and stop caring.
//
// Both columns build one of these from their own refs via makePaneHandle, so the
// two are interchangeable by construction: whatever the main column can be told
// to do, the second one can too.
import type { PageRect, ViewRotation } from '../../shared/types'
import { pageRectToView } from './rotation'
import type { RowLayout } from './rotation'
import { clamp } from './clamp'

/** Air left above a page landed on by scrollToPage, so it is not flush with the
 *  viewport's top edge. position() adds it back, which makes the two exact
 *  inverses — without that, every save/restore round trip (reading position,
 *  reopening the split on the spot you left) creeps 8 px up the document. */
const LAND_NUDGE = 8

export interface PaneHandle {
  /** Scroll so `page` sits at the top of the viewport; `offset` (0–1) nudges
   *  that far into the page, which is how a reading position is restored. */
  scrollToPage(page: number, offset?: number): void
  /** Scroll so a PAGE-SPACE y on `page` lands `fromTop` px below the viewport's
   *  top edge. Used by search (a third of the way down, so the hit has context
   *  above it) and by XYZ link destinations (which name an exact y). */
  scrollToPageY(page: number, pageY: number, fromTop: number): void
  /** Book-style page turn (←/→): land the previous/next layout row's top at
   *  the viewport top — a whole spread at a time in two-page view. In a fit
   *  mode the column re-fits against the landing row first, so "fit page +
   *  turn" always shows the whole page it turned to. No-op at either end. */
  flipPage(dir: -1 | 1): void
  /** Where the reader is in this column: page + fractional offset into it */
  position(): { page: number; offset: number } | null
  /** The scroll container — for finding this column's page/text elements */
  el(): HTMLElement | null
  /** This column's own zoom and orientation */
  scale(): number
  rotation(): ViewRotation
  /** True once the layout exists (a column mid-mount can't be scrolled yet) */
  ready(): boolean
}

interface Deps {
  el(): HTMLElement | null
  layout(): RowLayout | null
  scale(): number
  rotation(): ViewRotation
  sizes(): { w: number; h: number }[]
  /** Re-evaluate which pages should be mounted after a programmatic scroll —
   *  a scroll event does not fire for an assignment to scrollTop in every path,
   *  and the target page has to render before anything can refine against it. */
  afterScroll(): void
  /** The column's own page-turn logic — it lives with the column because a
   *  turn in a fit mode re-fits, and only the column knows its fit machinery. */
  flipPage(dir: -1 | 1): void
}

export function makePaneHandle(deps: Deps): PaneHandle {
  const handle: PaneHandle = {
    ready: () => !!deps.el() && !!deps.layout(),
    el: deps.el,
    scale: deps.scale,
    rotation: deps.rotation,
    flipPage: deps.flipPage,
    position() {
      const el = deps.el()
      const lay = deps.layout()
      if (!el || !lay) return null
      // The topmost page that starts above the 35 % line — the same anchor both
      // columns use for "current page", so a position taken from one column can
      // be handed to the other and mean the same thing.
      const probe = el.scrollTop + el.clientHeight * 0.35
      let row = lay.rows[0]
      for (const r of lay.rows) {
        if (r.top <= probe) row = r
        else break
      }
      const index = row?.pages[0]?.index ?? 0
      const offset = clamp(
        (el.scrollTop + LAND_NUDGE - lay.tops[index]) / lay.heights[index],
        0,
        1
      )
      return { page: index + 1, offset }
    },
    scrollToPage(page, offset = 0) {
      const el = deps.el()
      const lay = deps.layout()
      if (!el || !lay) return
      const i = clamp(Math.round(page), 1, lay.tops.length) - 1
      el.scrollTop = Math.max(0, lay.tops[i] + offset * lay.heights[i] - LAND_NUDGE)
      deps.afterScroll()
    },
    scrollToPageY(page, pageY, fromTop) {
      const el = deps.el()
      const lay = deps.layout()
      const sizes = deps.sizes()
      if (!el || !lay) return
      const i = clamp(Math.round(page), 1, lay.tops.length) - 1
      const size = sizes[i]
      // Page space → view space: under rotation the y a caller means is not the
      // y on screen, and the columns can be rotated differently.
      const rect: PageRect = { x: 0, y: pageY, w: 0, h: 0 }
      const vy = size ? pageRectToView(rect, size.w, size.h, deps.rotation()).y : pageY
      el.scrollTop = Math.max(0, lay.tops[i] + vy * deps.scale() - fromTop)
      deps.afterScroll()
    }
  }
  return handle
}

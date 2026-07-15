// The single home for every rotation/spread coordinate transform. A missed
// view↔page conversion at a pointer or selection boundary would write
// corrupted coordinates into the PDF via mupdf (permanent file damage), so
// ALL of it lives here as pure functions and every boundary routes through
// this module. Proven to round-trip for all four rotations by
// scripts/spike-rotation.mjs (run before any UI was wired).
//
// Spaces:
//  - PAGE space: PDF points, origin top-left, y down (the page's default
//    viewport, intrinsic /Rotate already applied). Annotations are stored and
//    hit-tested here; this is what mupdf reads.
//  - VIEW space: the page after the user's clockwise rotation is applied.
//    Same units and handedness (origin top-left, y down) but the axes/size
//    swap for 90°/270°. This is what is laid out and rendered on screen.
//
// `rotation` is always clockwise degrees ∈ {0, 90, 180, 270}.
import type { ViewRotation } from '../../shared/types'

export interface Size {
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** View-space size of a page of page-space size (pw, ph) under `rotation`. */
export function viewSize(pw: number, ph: number, rotation: ViewRotation): Size {
  return rotation === 90 || rotation === 270 ? { w: ph, h: pw } : { w: pw, h: ph }
}

/** PAGE point → VIEW point. */
export function pagePointToView(
  px: number,
  py: number,
  pw: number,
  ph: number,
  rotation: ViewRotation
): [number, number] {
  switch (rotation) {
    case 90:
      return [ph - py, px]
    case 180:
      return [pw - px, ph - py]
    case 270:
      return [py, pw - px]
    default:
      return [px, py]
  }
}

/** VIEW point → PAGE point (exact inverse of pagePointToView). */
export function viewPointToPage(
  vx: number,
  vy: number,
  pw: number,
  ph: number,
  rotation: ViewRotation
): [number, number] {
  switch (rotation) {
    case 90:
      return [vy, ph - vx]
    case 180:
      return [pw - vx, ph - vy]
    case 270:
      return [pw - vy, vx]
    default:
      return [vx, vy]
  }
}

/** PAGE rect → axis-aligned VIEW rect. */
export function pageRectToView(r: Rect, pw: number, ph: number, rotation: ViewRotation): Rect {
  const [ax, ay] = pagePointToView(r.x, r.y, pw, ph, rotation)
  const [bx, by] = pagePointToView(r.x + r.w, r.y + r.h, pw, ph, rotation)
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) }
}

/** VIEW rect → axis-aligned PAGE rect (exact inverse of pageRectToView). */
export function viewRectToPage(r: Rect, pw: number, ph: number, rotation: ViewRotation): Rect {
  const [ax, ay] = viewPointToPage(r.x, r.y, pw, ph, rotation)
  const [bx, by] = viewPointToPage(r.x + r.w, r.y + r.h, pw, ph, rotation)
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) }
}

/** A VIEW-space delta (e.g. a drag vector) → PAGE-space delta. Translation
 *  cancels, so only the rotation's linear part remains. */
export function viewDeltaToPage(
  dx: number,
  dy: number,
  rotation: ViewRotation
): { dx: number; dy: number } {
  switch (rotation) {
    case 90:
      return { dx: dy, dy: -dx }
    case 180:
      return { dx: -dx, dy: -dy }
    case 270:
      return { dx: -dy, dy: dx }
    default:
      return { dx, dy }
  }
}

/** An SVG transform that maps PAGE coordinates into a VIEW-space viewBox, so a
 *  group of page-space geometry (ink strokes, shapes) paints rotated without
 *  transforming every point. Pairs with a viewBox of `0 0 viewW viewH`. */
export function svgRotationTransform(pw: number, ph: number, rotation: ViewRotation): string {
  // matrix(a b c d e f): (x,y) → (a·x + c·y + e, b·x + d·y + f), matching
  // pagePointToView above.
  switch (rotation) {
    case 90:
      return `matrix(0 1 -1 0 ${ph} 0)`
    case 180:
      return `matrix(-1 0 0 -1 ${pw} ${ph})`
    case 270:
      return `matrix(0 -1 1 0 0 ${pw})`
    default:
      return ''
  }
}

// ---------- Layout (rows for single-page and two-page spread) ----------

export interface PageBox {
  /** 0-based page index */
  index: number
  /** view-space top-left in px (scale already applied) */
  top: number
  left: number
  /** view-space size in px (scale already applied) */
  width: number
  height: number
}

export interface LayoutRow {
  top: number
  height: number
  pages: PageBox[]
}

export interface RowLayout {
  rows: LayoutRow[]
  /** per-page arrays, indexed by 0-based page index, in px */
  tops: number[]
  lefts: number[]
  widths: number[]
  heights: number[]
  total: number
  contentWidth: number
}

export interface LayoutOpts {
  containerWidth: number
  pageGap: number
  padTop: number
  padBottom: number
  sidePad: number
  spreadGap: number
}

/**
 * Vertical stack of rows. In single mode each row is one page; in spread mode
 * pages pair up strictly (1-2, 3-4, …). Each page's view size accounts for the
 * rotation; a row is as tall as its tallest page and its pages are centred
 * within it, and every row is centred horizontally in the content column.
 */
export function buildRows(
  sizes: Size[],
  scale: number,
  rotation: ViewRotation,
  spread: boolean,
  opts: LayoutOpts
): RowLayout {
  const { containerWidth, pageGap, padTop, padBottom, sidePad, spreadGap } = opts
  const n = sizes.length
  const widths: number[] = new Array(n)
  const heights: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const v = viewSize(sizes[i].w, sizes[i].h, rotation)
    widths[i] = v.w * scale
    heights[i] = v.h * scale
  }

  // Group page indices into rows
  const groups: number[][] = []
  if (spread) {
    for (let i = 0; i < n; i += 2) groups.push(i + 1 < n ? [i, i + 1] : [i])
  } else {
    for (let i = 0; i < n; i++) groups.push([i])
  }

  // Widest row drives the content column (so rows stay centred, not shoved)
  let maxRowWidth = 0
  for (const g of groups) {
    let rw = 0
    for (const i of g) rw += widths[i]
    if (g.length > 1) rw += spreadGap
    maxRowWidth = Math.max(maxRowWidth, rw)
  }
  const contentWidth = Math.max(containerWidth, maxRowWidth + sidePad)

  const tops: number[] = new Array(n)
  const lefts: number[] = new Array(n)
  const rows: LayoutRow[] = []
  let y = padTop
  for (const g of groups) {
    let rowWidth = 0
    for (const i of g) rowWidth += widths[i]
    if (g.length > 1) rowWidth += spreadGap
    const rowHeight = Math.max(...g.map((i) => heights[i]))
    let x = (contentWidth - rowWidth) / 2
    const boxes: PageBox[] = []
    for (const i of g) {
      const top = y + (rowHeight - heights[i]) / 2
      tops[i] = top
      lefts[i] = x
      boxes.push({ index: i, top, left: x, width: widths[i], height: heights[i] })
      x += widths[i] + spreadGap
    }
    rows.push({ top: y, height: rowHeight, pages: boxes })
    y += rowHeight + pageGap
  }

  return { rows, tops, lefts, widths, heights, total: y - pageGap + padBottom, contentWidth }
}

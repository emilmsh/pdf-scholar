// Zoom limits, shared by the main pages view and the reference pane so the two
// can never drift apart.
import { clamp } from './clamp'

export const ZOOM_MIN = 0.25

// 800%. render-quality.ts caps device pixels per raster within the frame
// budget, but it can never go below native 1× — and a page CANVAS is allocated
// at full zoomed size, not just the visible slice. At the old 1600% ceiling an
// A4 page needed a ~9500 × 13500 px canvas (~128 MP, half a gigabyte), which is
// where the owner felt the app "lagge på det nivået". 800% quarters that while
// still resolving anything a scanned figure or a footnote glyph can carry.
// Going meaningfully higher needs TILED rendering (raster only the visible
// slice) — a bigger change than raising this number.
export const ZOOM_MAX = 8

export function clampZoom(v: number): number {
  return clamp(v, ZOOM_MIN, ZOOM_MAX)
}

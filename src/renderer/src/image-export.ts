// Getting a PICTURE out of the document — the arithmetic behind «Kopier bilde»
// and «Lagre bilde …». The gesture is a marquee over the page (or a click on a
// figure the overlay has outlined); this module answers the two questions that
// decide whether the result is worth pasting into a manuscript:
//
//   1) At what resolution do we re-render the crop? Acrobat's Snapshot copies
//      what is on screen, which is why its output is famously unusable at
//      100 %. We render offscreen instead, and a crop that IS one of the
//      document's raster images comes out on that image's own pixel grid —
//      the resolution the FILE holds, not the one the window happens to show
//      (image-regions.ts carries each region's pixel size). Everything else —
//      a vector figure, a table, an equation, which is most of an academic
//      paper — has no native resolution at all and gets print dpi.
//      exportScale() below is where the two meet.
//   2) What is it called on disk?
//
// Pure arithmetic, no DOM and no pdf.js value import, so scripts/test-image-
// regions.mjs can build it with bundle:false and drive it in plain Node.
import type { UserRect } from './image-regions'

/** Neither side of an exported crop may exceed this. Canvas limits differ per
 *  platform (Chromium refuses beyond ~16 384 px a side and much earlier by
 *  total area); 4000 keeps a full page at ~350 dpi and never approaches them. */
export const MAX_EXPORT_SIDE = 4000

/** A crop with no raster image under it is rendered at this many dots per inch.
 *  PDF user space is 1/72", so the scale is EXPORT_DPI / 72 — 300 dpi is the
 *  figure every journal asks for, and a vector figure re-rendered at it is
 *  indistinguishable from the original at any print size. */
export const EXPORT_DPI = 300

/** Axis-aligned box in whatever space the caller is working in. The overlay's
 *  hit-testing uses client px; nothing here cares which. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Overlapping area of two user-space rects (0 when they merely touch). */
export function overlapArea(a: UserRect, b: UserRect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

export interface ExportScale {
  /** Render scale for page.getViewport — px per user-space unit */
  scale: number
  /** True when the crop IS a picture the file holds, taken at that picture's
   *  own pixel grid. False means the crop was re-rendered off the page
   *  description instead — which is the right answer for a vector figure, a
   *  table or an equation, and the popover says which one happened. */
  native: boolean
}

/** A crop at least this covered by raster images IS one of those images
 *  rather than a piece of page containing one, and renders at exactly that
 *  image's own pixel grid — a 72-dpi scan upsampled to print dpi gains no
 *  detail and quadruples the file, and someone who clicked the outlined
 *  figure asked for THAT picture, not a rendering of it.
 *
 *  Deliberately near 1: in practice this is the click-an-outlined-image path
 *  (exactly 1) and nothing else. A drag that also took the caption in sits
 *  around 0.87, and at a threshold of 0.8 that caption came out rendered at
 *  the figure's 72 dpi — soft text, for a file that was no smaller in any way
 *  that mattered. Whenever a crop is partly page, the page wins. */
export const IMAGE_CROP_COVER = 0.95

/** The scale to re-render `box` (user space) at.
 *
 *  Every raster region overlapping the box votes with its own density — px per
 *  user unit, the larger of the two axes so a rotated placement still asks for
 *  enough pixels — and the densest one wins: a crop containing both a 72-dpi
 *  logo and a 600-dpi plot must serve the plot. Regions the operator list gave
 *  no pixel size (the repeat op) do not vote.
 *
 *  A crop those regions nearly fill is the picture itself and takes that
 *  density verbatim. Anything else is page content being re-rendered, so it
 *  gets whichever is larger of print dpi, the screen it was drawn on (a figure
 *  read at 400 % must not come back softer than it looked), and any image
 *  density it does contain. Either way it is clamped to MAX_EXPORT_SIDE. */
export function exportScale(
  box: UserRect,
  regions: readonly UserRect[],
  onScreen: number,
  opts: { maxSide?: number; dpi?: number } = {}
): ExportScale {
  const maxSide = opts.maxSide ?? MAX_EXPORT_SIDE
  const dpi = opts.dpi ?? EXPORT_DPI
  const bw = Math.max(1e-6, box.x1 - box.x0)
  const bh = Math.max(1e-6, box.y1 - box.y0)
  let density = 0
  let covered = 0
  for (const r of regions) {
    const over = overlapArea(r, box)
    if (over <= 0) continue
    covered += over
    const w = r.x1 - r.x0
    const h = r.y1 - r.y0
    if (!r.px || w <= 0 || h <= 0) continue
    density = Math.max(density, r.px.w / w, r.px.h / h)
  }
  // Summed, not unioned: two regions overlapping each other can push this past
  // 1, which only ever means "even more covered". min() keeps it a share.
  const cover = Math.min(1, covered / (bw * bh))
  const isPicture = density > 0 && cover >= IMAGE_CROP_COVER
  const wanted = isPicture ? density : Math.max(density, dpi / 72, onScreen)
  const scale = Math.min(Math.max(0.05, wanted), maxSide / bw, maxSide / bh)
  return { scale, native: isPicture && scale >= wanted - 1e-9 }
}

/** Index of the SMALLEST listed box containing (x, y), or -1. Smallest wins so
 *  a figure sitting on a full-width background panel is what the click takes —
 *  the enclosing panel is never the thing someone is pointing at. */
export function smallestBoxAt(boxes: readonly Box[], x: number, y: number): number {
  let best = -1
  let bestArea = Infinity
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue
    const a = b.w * b.h
    if (a < bestArea) {
      best = i
      bestArea = a
    }
  }
  return best
}

/** Regions too small to be worth outlining as click targets — bullet glyphs,
 *  hairline rules and single-pixel spacers are raster images too. */
export const MIN_PICKABLE_PX = 24

/** Drop boxes nobody could aim at, and boxes that merely repeat one already in
 *  the list (the same figure placed twice within a pixel). */
export function pickableBoxes(boxes: readonly Box[], minSide = MIN_PICKABLE_PX): Box[] {
  const out: Box[] = []
  for (const b of boxes) {
    if (b.w < minSide || b.h < minSide) continue
    if (out.some((o) => Math.abs(o.x - b.x) < 1 && Math.abs(o.y - b.y) < 1 && Math.abs(o.w - b.w) < 1 && Math.abs(o.h - b.h) < 1)) continue
    out.push(b)
  }
  return out
}

/** Characters no Windows path may hold, plus the control range. Replaced
 *  rather than dropped so two documents cannot collapse onto one name. */
const UNSAFE = /[\\\/:*?"<>|\u0000-\u001f]/g

/** `Attention Is All You Need.pdf` + page 6 → `Attention Is All You Need - bilde s. 6.png`
 *  (the suffix is the caller's, already translated). Trailing dots and spaces
 *  go too: Windows silently strips them and the saved file then has a name the
 *  app cannot find again. */
export function imageExportName(docName: string, suffix: string, ext = 'png'): string {
  const base = docName.replace(/\.pdf$/i, '').replace(UNSAFE, '-').replace(/[. ]+$/, '').trim()
  const clean = suffix.replace(UNSAFE, '-').trim()
  const stem = base ? `${base} - ${clean}` : clean
  // Long names are the other way to get an unwritable path (260 chars on a
  // default Windows install, and the user still has to pick a folder).
  return `${stem.slice(0, 120).replace(/[. ]+$/, '')}.${ext}`
}

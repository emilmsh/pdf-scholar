// Where the pictures are: raster-image regions of a page, from pdf.js's own
// operator list. Night mode inverts the WHOLE page canvas, which turns photos
// and figure images negative — the «Behold bildefarger» toggle draws exactly
// these regions again, unfiltered, from the same rendered bitmap (a CSS filter
// never changes the canvas pixels, so the original colours are already there).
//
// Two layers on purpose:
//   - imageRectsFromOps: a pure walk over (fnArray, argsArray) with a CTM
//     stack — unit-testable in plain Node with a fake ops table
//     (scripts/test-image-regions.mjs), no worker, no DOM.
//   - pageImageRects: the pdf.js wrapper — getOperatorList(), the
//     scanned-page guard, and a per-proxy cache.
//
// Image MASKS (stencils) are deliberately not collected: a mask takes the
// current fill colour, so inverting it with the page is the correct look.
// Vector figures are not images at all and stay inverted too — that is the
// documented boundary of the feature, not an oversight.
//
// No value import from pdfjs-dist here — the caller passes its OPS table.
// That keeps the whole module importable in plain Node (the modern pdf.js
// build needs DOMMatrix), where the test drives it with the legacy build.
import type { PDFPageProxy } from 'pdfjs-dist'

/** Transform matrix [a, b, c, d, e, f] — the PDF/canvas 2×3 convention. */
export type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** Combined transform: apply `m2` first, then `m1` (the `cm` concatenation). */
export function mulMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

const applyMatrix = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
]

/** Axis-aligned box in PDF user space (y up, unrotated page coordinates —
 *  exactly what viewport.convertToViewportPoint consumes). */
export interface UserRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The operator ids the walk needs — injected so the pure function can be
 *  tested with a hand-made table and the wrapper passes pdf.js's OPS. */
export interface OpsTable {
  save: number
  restore: number
  transform: number
  paintImageXObject: number
  paintInlineImageXObject: number
  paintImageXObjectRepeat: number
  paintFormXObjectBegin: number
  paintFormXObjectEnd: number
}

/** Walk an operator list and return the user-space AABB of every raster image.
 *  An image XObject paints the unit square through the current CTM (PDF 32000
 *  §8.9.5.4), so the box is the transformed square's AABB — exact for the
 *  axis-aligned placements real documents use, conservative for a rotated one. */
export function imageRectsFromOps(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: OpsTable
): UserRect[] {
  const rects: UserRect[] = []
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []

  const pushUnitSquare = (m: Matrix): void => {
    const pts = [applyMatrix(m, 0, 0), applyMatrix(m, 1, 0), applyMatrix(m, 0, 1), applyMatrix(m, 1, 1)]
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    rects.push({
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys)
    })
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[] | null
    switch (fn) {
      case ops.save:
        stack.push(ctm)
        break
      case ops.restore:
        // A restore with an empty stack is malformed content — fall back to
        // identity rather than throwing mid-walk
        ctm = stack.pop() ?? IDENTITY
        break
      case ops.transform:
        ctm = mulMatrix(ctm, args as Matrix)
        break
      // pdf.js inlines form XObjects into the page's list, bracketed by these
      // two ops carrying the form's own matrix — an implicit save/restore pair
      case ops.paintFormXObjectBegin: {
        stack.push(ctm)
        const m = args?.[0] as Matrix | null | undefined
        if (m) ctm = mulMatrix(ctm, m)
        break
      }
      case ops.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY
        break
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
        pushUnitSquare(ctm)
        break
      case ops.paintImageXObjectRepeat: {
        // (objId, scaleX, scaleY, positions[x0,y0, x1,y1, …]) — one placement
        // per position, each a scaled unit square
        const scaleX = args?.[1] as number
        const scaleY = args?.[2] as number
        const positions = args?.[3] as ArrayLike<number> | undefined
        if (!positions) break
        for (let p = 0; p + 1 < positions.length; p += 2) {
          pushUnitSquare(mulMatrix(ctm, [scaleX, 0, 0, scaleY, positions[p], positions[p + 1]]))
        }
        break
      }
      default:
        break
    }
  }
  return rects
}

/** An image covering at least this share of the page is treated as the page
 *  itself (a scan) and stays inverted — "keep image colours" on a scanned
 *  document would otherwise just switch night mode off page by page. */
const SCAN_COVER_SHARE = 0.9

const cache = new WeakMap<PDFPageProxy, Promise<UserRect[]>>()

/** The page's raster-image regions in user space, cached per page proxy (the
 *  operator list does not change under a proxy, and building it costs real
 *  worker time). `ops` is the caller's pdf.js OPS table. Failure degrades to
 *  «no regions» — the page simply stays fully inverted, never an error surface. */
export function pageImageRects(page: PDFPageProxy, ops: OpsTable): Promise<UserRect[]> {
  let promise = cache.get(page)
  if (!promise) {
    promise = (async () => {
      const list = await page.getOperatorList()
      const raw = imageRectsFromOps(list.fnArray, list.argsArray, ops)
      const [vx0, vy0, vx1, vy1] = page.view
      const pageArea = Math.abs((vx1 - vx0) * (vy1 - vy0))
      return raw.filter(
        (r) => (r.x1 - r.x0) * (r.y1 - r.y0) <= SCAN_COVER_SHARE * pageArea
      )
    })().catch(() => [] as UserRect[])
    cache.set(page, promise)
  }
  return promise
}

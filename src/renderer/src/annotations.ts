// Geometry + styling for annotations created in this session. Coordinates are
// stored in "page space": PDF points with origin at the page's TOP-LEFT and y
// growing downward — which is also MuPDF's convention, so the engine uses
// these rects as-is (verified in scripts/spike-mupdf-annot.mjs).
import type { CSSProperties } from 'react'
import type { AnnotationType, PageRect } from '../../shared/types'

export interface PageAnnotation {
  /** Local key for React state */
  id: string
  /** PDF object number — identifies the annotation in the file across
   *  sessions; null for session annotations the engine has not confirmed */
  fileId: number | null
  /** 'file' annots are painted by pdf.js from the appearance stream (we only
   *  hit-test them); 'session' annots are painted by our overlay */
  source: 'session' | 'file'
  type: AnnotationType
  quads: PageRect[]
  /** rgb 0–1 */
  color: [number, number, number]
  opacity: number
  contents?: string
  author?: string
}

export interface HighlightColor {
  name: string
  hex: string
  rgb: [number, number, number]
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: 'Gul', hex: '#ffd54a', rgb: [1, 0.835, 0.29] },
  { name: 'Grønn', hex: '#7ed37e', rgb: [0.494, 0.827, 0.494] },
  { name: 'Blå', hex: '#6fb6ff', rgb: [0.435, 0.714, 1] },
  { name: 'Rosa', hex: '#ff8db0', rgb: [1, 0.553, 0.69] },
  { name: 'Lilla', hex: '#c39dff', rgb: [0.765, 0.616, 1] }
]

export const UNDERLINE_COLOR: [number, number, number] = [0.886, 0.29, 0.29]
export const STRIKEOUT_COLOR: [number, number, number] = [0.886, 0.29, 0.29]
export const NOTE_COLOR: [number, number, number] = [1, 0.835, 0.29]

function rgbCss(rgb: [number, number, number], alpha: number): string {
  const [r, g, b] = rgb.map((v) => Math.round(v * 255))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Inline style for one quad of an annotation, in the page's CSS space. */
export function annotationCss(
  a: PageAnnotation,
  q: PageRect,
  scale: number,
  _pageHeight: number
): CSSProperties {
  const x = q.x * scale
  const y = q.y * scale
  const w = q.w * scale
  const h = q.h * scale
  switch (a.type) {
    case 'highlight':
      return {
        left: x,
        top: y,
        width: w,
        height: h,
        background: rgbCss(a.color, 0.42),
        mixBlendMode: 'multiply'
      }
    case 'underline':
      return {
        left: x,
        top: y + h - Math.max(1.5, 0.045 * h),
        width: w,
        height: Math.max(1.5, scale * 1.2),
        background: rgbCss(a.color, 0.9)
      }
    case 'strikeout':
      return {
        left: x,
        top: y + h * 0.52,
        width: w,
        height: Math.max(1.5, scale * 1.2),
        background: rgbCss(a.color, 0.9)
      }
    case 'squiggly':
      return {
        left: x,
        top: y + h - Math.max(2, 0.06 * h),
        width: w,
        height: Math.max(2, scale * 1.6),
        background: `repeating-linear-gradient(90deg, ${rgbCss(a.color, 0.9)} 0 ${Math.max(3, 2 * scale)}px, transparent ${Math.max(3, 2 * scale)}px ${Math.max(6, 4 * scale)}px)`
      }
    case 'note':
      return {
        left: x,
        top: y,
        width: 18,
        height: 18
      }
  }
}

/**
 * Convert client rects (from a Range or Selection) into merged rects in page
 * space, clipped to the given page element. Returns null when nothing lands
 * on the page.
 */
export function clientRectsToPageRects(
  rectList: Iterable<DOMRect>,
  pageEl: HTMLElement,
  scale: number
): PageRect[] | null {
  const pageRect = pageEl.getBoundingClientRect()
  const rects: PageRect[] = []
  for (const r of rectList) {
    if (r.width < 1 || r.height < 2) continue
    const left = Math.max(r.left, pageRect.left)
    const right = Math.min(r.right, pageRect.right)
    const top = Math.max(r.top, pageRect.top)
    const bottom = Math.min(r.bottom, pageRect.bottom)
    if (right - left < 1 || bottom - top < 2) continue
    rects.push({
      x: (left - pageRect.left) / scale,
      y: (top - pageRect.top) / scale,
      w: (right - left) / scale,
      h: (bottom - top) / scale
    })
  }
  if (rects.length === 0) return null
  return mergeLineRects(rects)
}

/**
 * Convert the current DOM selection into merged rects in page space for the
 * given page element. Returns null when the selection does not intersect it.
 */
export function selectionRectsForPage(
  selection: Selection,
  pageEl: HTMLElement,
  scale: number
): PageRect[] | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null
  const all: DOMRect[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    all.push(...selection.getRangeAt(i).getClientRects())
  }
  return clientRectsToPageRects(all, pageEl, scale)
}

/** Merge overlapping fragments on the same text line into single rects. */
function mergeLineRects(rects: PageRect[]): PageRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const merged: PageRect[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    const sameLine =
      last && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.5 && r.x <= last.x + last.w + 2
    if (sameLine) {
      const right = Math.max(last.x + last.w, r.x + r.w)
      const bottom = Math.max(last.y + last.h, r.y + r.h)
      last.y = Math.min(last.y, r.y)
      last.w = right - last.x
      last.h = bottom - last.y
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

let idCounter = 0
export function nextAnnotationId(): string {
  return `session-${++idCounter}`
}

const SUBTYPE_MAP: Record<string, AnnotationType> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  Text: 'note'
}

/** Raw pdf.js annotation data (the fields we consume) */
export interface PdfJsAnnotationData {
  id: string
  subtype: string
  rect: number[]
  quadPoints?: Float32Array | null
  color?: Uint8ClampedArray | number[] | null
  opacity?: number
  contentsObj?: { str: string }
  titleObj?: { str: string }
}

/**
 * Convert a pdf.js annotation (PDF user space, y-up) into a PageAnnotation
 * (page space, y-down). Returns null for unsupported subtypes.
 */
export function fromPdfJsAnnotation(
  a: PdfJsAnnotationData,
  pageHeight: number
): PageAnnotation | null {
  const type = SUBTYPE_MAP[a.subtype]
  if (!type) return null
  const fileId = parseInt(a.id, 10)
  if (Number.isNaN(fileId)) return null

  const toPageRect = (xs: number[], ys: number[]): PageRect => {
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const yMin = Math.min(...ys)
    const yMax = Math.max(...ys)
    return { x: xMin, y: pageHeight - yMax, w: xMax - xMin, h: yMax - yMin }
  }

  const quads: PageRect[] = []
  if (type !== 'note' && a.quadPoints && a.quadPoints.length >= 8) {
    for (let i = 0; i + 7 < a.quadPoints.length; i += 8) {
      const q = a.quadPoints
      quads.push(
        toPageRect([q[i], q[i + 2], q[i + 4], q[i + 6]], [q[i + 1], q[i + 3], q[i + 5], q[i + 7]])
      )
    }
  } else {
    quads.push(toPageRect([a.rect[0], a.rect[2]], [a.rect[1], a.rect[3]]))
  }

  const color: [number, number, number] = a.color
    ? [a.color[0] / 255, a.color[1] / 255, a.color[2] / 255]
    : [1, 0.835, 0.29]

  return {
    id: `file-${fileId}`,
    fileId,
    source: 'file',
    type,
    quads,
    color,
    opacity: a.opacity ?? 1,
    contents: a.contentsObj?.str || undefined,
    author: a.titleObj?.str || undefined
  }
}

/** Topmost annotation whose quads contain the given page-space point */
export function annotationAtPoint(
  annots: PageAnnotation[],
  x: number,
  y: number
): PageAnnotation | null {
  const PAD = 2
  for (let i = annots.length - 1; i >= 0; i--) {
    for (const q of annots[i].quads) {
      if (x >= q.x - PAD && x <= q.x + q.w + PAD && y >= q.y - PAD && y <= q.y + q.h + PAD) {
        return annots[i]
      }
    }
  }
  return null
}

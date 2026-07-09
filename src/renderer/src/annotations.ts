// Geometry + styling for annotations created in this session. Coordinates are
// stored in "page space": PDF points with origin at the page's TOP-LEFT and y
// growing downward — which is also MuPDF's convention, so the engine uses
// these rects as-is (verified in scripts/spike-mupdf-annot.mjs).
import type { CSSProperties } from 'react'
import type { AnnotationType, PageRect } from '../../shared/types'

export interface PageAnnotation {
  id: string
  type: AnnotationType
  quads: PageRect[]
  /** rgb 0–1 */
  color: [number, number, number]
  opacity: number
  contents?: string
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
 * Convert the current DOM selection into merged rects in page space for the
 * given page element. Returns null when the selection does not intersect it.
 */
export function selectionRectsForPage(
  selection: Selection,
  pageEl: HTMLElement,
  scale: number
): PageRect[] | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null
  const pageRect = pageEl.getBoundingClientRect()
  const rects: PageRect[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const r of selection.getRangeAt(i).getClientRects()) {
      if (r.width < 1 || r.height < 2) continue
      // Clip to this page
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
  }
  if (rects.length === 0) return null
  return mergeLineRects(rects)
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

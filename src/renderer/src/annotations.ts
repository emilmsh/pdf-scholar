// Geometry + styling for annotations created in this session. Coordinates are
// stored in "page space": PDF points with origin at the page's TOP-LEFT and y
// growing downward — which is also MuPDF's convention, so the engine uses
// these rects as-is (verified in scripts/spike-mupdf-annot.mjs).
import type { CSSProperties } from 'react'
import type { AnnotationType, PageRect, ViewRotation } from '../../shared/types'
import { pagePointToView, pageRectToView } from './rotation'
import { t } from './i18n'

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
  /** ink: strokes; line/arrow: [[start, end]] — page space */
  strokes?: [number, number][][]
  /** ink/shapes: stroke width in points */
  width?: number
  /** freetext only */
  fontSize?: number
}

export type ColorKey = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'red' | 'orange' | 'custom'

export interface HighlightColor {
  key: ColorKey
  hex: string
  rgb: [number, number, number]
}

/** Localized display name for a palette color; custom picks show their hex */
export function colorLabel(c: HighlightColor): string {
  return c.key === 'custom' ? c.hex.toUpperCase() : t(`color.${c.key}`)
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// ---------- Last-used custom colors (color-wheel picks) ----------

const CUSTOM_COLORS_KEY = 'pdfx-custom-colors'
const CUSTOM_COLORS_MAX = 3

export function loadCustomColors(): HighlightColor[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((h): h is string => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h))
      .slice(0, CUSTOM_COLORS_MAX)
      .map((hex) => ({ key: 'custom' as const, hex, rgb: hexToRgb(hex) }))
  } catch {
    return []
  }
}

/** Remember a color-wheel pick (most recent first, deduped, capped) */
export function addCustomColor(hex: string): void {
  const list = [hex, ...loadCustomColors().map((c) => c.hex).filter((h) => h !== hex)]
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(list.slice(0, CUSTOM_COLORS_MAX)))
  } catch {
    /* remembering colors is cosmetic */
  }
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { key: 'yellow', hex: '#ffd54a', rgb: [1, 0.835, 0.29] },
  { key: 'green', hex: '#7ed37e', rgb: [0.494, 0.827, 0.494] },
  { key: 'blue', hex: '#6fb6ff', rgb: [0.435, 0.714, 1] },
  { key: 'pink', hex: '#ff8db0', rgb: [1, 0.553, 0.69] },
  { key: 'purple', hex: '#c39dff', rgb: [0.765, 0.616, 1] }
]

/** Saturated palette for line markup (underline) — pastels vanish as thin lines */
export const UNDERLINE_COLORS: HighlightColor[] = [
  { key: 'red', hex: '#e2494a', rgb: [0.886, 0.286, 0.29] },
  { key: 'orange', hex: '#f5920b', rgb: [0.96, 0.573, 0.043] },
  { key: 'green', hex: '#2f9e58', rgb: [0.184, 0.62, 0.345] },
  { key: 'blue', hex: '#327cf6', rgb: [0.196, 0.486, 0.965] },
  { key: 'purple', hex: '#8f52d6', rgb: [0.561, 0.322, 0.839] }
]

export const UNDERLINE_COLOR: [number, number, number] = [0.886, 0.29, 0.29]
export const STRIKEOUT_COLOR: [number, number, number] = [0.886, 0.29, 0.29]
export const NOTE_COLOR: [number, number, number] = [1, 0.835, 0.29]

/** Localized display name for an annotation type */
export function annotTypeLabel(type: AnnotationType): string {
  return t(`annot.${type}`)
}

export const SHAPE_DEFAULT: { color: [number, number, number]; width: number } = {
  color: [0.886, 0.29, 0.29],
  width: 2
}
export const FREETEXT_COLOR: [number, number, number] = [0.11, 0.11, 0.13]
export const FREETEXT_SIZE = 12

export const PEN_DEFAULT: { color: [number, number, number]; width: number } = {
  color: [0.16, 0.35, 0.75],
  width: 2.2
}
export const MARKER_DEFAULT: { color: [number, number, number]; width: number } = {
  color: [1, 0.835, 0.29],
  width: 10
}
export const MARKER_OPACITY = 0.45

export type DrawToolType =
  | 'pen'
  | 'marker'
  | 'eraser'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'text'

export interface DrawTool {
  type: DrawToolType
  color: [number, number, number]
  width: number
  opacity: number
}

export const SHAPE_TOOL_TYPES = ['square', 'circle', 'line', 'arrow'] as const
export type ShapeToolType = (typeof SHAPE_TOOL_TYPES)[number]

/** Text-anchored markup tools: unlike pen/marker these have no freehand form —
 *  they attach to the current text selection (like the context-menu markup). */
export const MARKUP_TOOL_TYPES = ['highlight', 'underline', 'strikeout', 'squiggly'] as const
export type MarkupToolType = (typeof MARKUP_TOOL_TYPES)[number]

/** Default colour for each markup tool (pastel fill for highlight, saturated
 *  line colour for the others so a thin stroke stays visible). */
export function markupDefaultColor(type: MarkupToolType): [number, number, number] {
  if (type === 'highlight') return HIGHLIGHT_COLORS[0].rgb
  return UNDERLINE_COLOR
}

export function rgbCss(rgb: [number, number, number], alpha: number): string {
  const [r, g, b] = rgb.map((v) => Math.round(v * 255))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** SVG path data for one freehand stroke (page-space points) */
export function strokePathData(points: [number, number][]): string {
  if (points.length === 0) return ''
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)}`
  }
  return d
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** True when a page-space point touches an ink annotation's strokes (or its
 *  bounds for file inks whose strokes we don't hold) */
export function inkHitTest(record: PageAnnotation, x: number, y: number, tolerance: number): boolean {
  if (record.strokes && record.strokes.length > 0) {
    const tol = Math.max(tolerance, (record.width ?? 2) / 2 + 2)
    for (const stroke of record.strokes) {
      if (stroke.length === 1) {
        if (Math.hypot(x - stroke[0][0], y - stroke[0][1]) <= tol) return true
        continue
      }
      for (let i = 1; i < stroke.length; i++) {
        if (
          pointToSegmentDistance(x, y, stroke[i - 1][0], stroke[i - 1][1], stroke[i][0], stroke[i][1]) <= tol
        ) {
          return true
        }
      }
    }
    return false
  }
  return record.quads.some(
    (q) => x >= q.x - 2 && x <= q.x + q.w + 2 && y >= q.y - 2 && y <= q.y + q.h + 2
  )
}

/**
 * Inline style for one quad of an annotation, positioned in VIEW space (after
 * the user's rotation). The painted region is computed as a PAGE-space rect per
 * type — with thicknesses/offsets in page units so the ×scale result is
 * numerically identical to the un-rotated code at rotation 0 (verified by
 * diffing a highlighted page) — then rotated via pageRectToView and scaled.
 */
export function annotationCss(
  a: PageAnnotation,
  q: PageRect,
  scale: number,
  pageSize: { w: number; h: number },
  rotation: ViewRotation
): CSSProperties {
  const { w: pw, h: ph } = pageSize
  const toCss = (pr: PageRect): CSSProperties => {
    const vr = pageRectToView(pr, pw, ph, rotation)
    return { left: vr.x * scale, top: vr.y * scale, width: vr.w * scale, height: vr.h * scale }
  }
  switch (a.type) {
    case 'highlight':
      return { ...toCss(q), background: rgbCss(a.color, 0.42), mixBlendMode: 'multiply' }
    case 'underline': {
      const thick = Math.max(1.5 / scale, 1.2)
      const off = Math.max(1.5 / scale, 0.045 * q.h)
      return {
        ...toCss({ x: q.x, y: q.y + q.h - off, w: q.w, h: thick }),
        background: rgbCss(a.color, 0.9)
      }
    }
    case 'strikeout': {
      const thick = Math.max(1.5 / scale, 1.2)
      return {
        ...toCss({ x: q.x, y: q.y + q.h * 0.52, w: q.w, h: thick }),
        background: rgbCss(a.color, 0.9)
      }
    }
    case 'squiggly': {
      const thick = Math.max(2 / scale, 1.6)
      const off = Math.max(2 / scale, 0.06 * q.h)
      const period = Math.max(3, 2 * scale)
      // The stripe direction follows the rotated baseline
      return {
        ...toCss({ x: q.x, y: q.y + q.h - off, w: q.w, h: thick }),
        background: `repeating-linear-gradient(${(90 + rotation) % 360}deg, ${rgbCss(a.color, 0.9)} 0 ${period}px, transparent ${period}px ${Math.max(6, 4 * scale)}px)`
      }
    }
    case 'note': {
      // Fixed-size, upright marker — only its anchor point rotates
      const [vx, vy] = pagePointToView(q.x, q.y, pw, ph, rotation)
      return { left: vx * scale, top: vy * scale, width: 18, height: 18 }
    }
    case 'freetext':
      return { ...toCss(q), color: rgbCss(a.color, 1) }
    case 'ink':
    case 'square':
    case 'circle':
    case 'line':
    case 'arrow':
      // Rendered as SVG in AnnotationMarks, not css boxes
      return toCss(q)
  }
}

/** SVG polygon points for an arrowhead at `to`, pointing from `from` */
export function arrowHeadPoints(
  from: [number, number],
  to: [number, number],
  size: number
): string {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
  const spread = 0.46
  const p1 = [to[0] - size * Math.cos(angle - spread), to[1] - size * Math.sin(angle - spread)]
  const p2 = [to[0] - size * Math.cos(angle + spread), to[1] - size * Math.sin(angle + spread)]
  return `${to[0]},${to[1]} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`
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
  // Text-layer spans in tables/figures (LaTeX column rules, stretched
  // glyphs) can be many times taller than a text line; selecting across
  // them turns the markup into giant vertical bars. Drop rects far taller
  // than the median line height — headings (~2× body) still survive.
  if (rects.length >= 3) {
    const heights = rects.map((r) => r.h).sort((a, b) => a - b)
    const median = heights[Math.floor(heights.length / 2)]
    const filtered = rects.filter((r) => r.h <= median * 2.5)
    if (filtered.length > 0) return mergeLineRects(filtered)
  }
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
  Text: 'note',
  Ink: 'ink',
  Square: 'square',
  Circle: 'circle',
  Line: 'line',
  FreeText: 'freetext'
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

/** Annotation types that support drag-to-move (translate) */
export const MOVABLE_TYPES = new Set<AnnotationType>([
  'note',
  'freetext',
  'square',
  'circle',
  'line',
  'arrow',
  'ink'
])

export function isMovableAnnotation(a: PageAnnotation): boolean {
  return MOVABLE_TYPES.has(a.type) && a.quads.length > 0
}

function hitsQuads(a: PageAnnotation, x: number, y: number, pad = 2): boolean {
  return a.quads.some(
    (q) => x >= q.x - pad && x <= q.x + q.w + pad && y >= q.y - pad && y <= q.y + q.h + pad
  )
}

/** Text boxes are grabbed to be dragged, so they answer well outside their
 *  visual bounds (8 pt ≈ 11 px at 100 %) — PAD=2 made them finicky to catch. */
const FREETEXT_PAD = 8

/**
 * Topmost annotation whose GEOMETRY (not bbox) contains the given page-space
 * point. Square/circle only respond near their outline so clicks inside a
 * hollow shape still select text; tolerance grows with stroke width.
 */
export function annotationHitTest(
  annots: PageAnnotation[],
  x: number,
  y: number
): PageAnnotation | null {
  for (let i = annots.length - 1; i >= 0; i--) {
    const a = annots[i]
    const tol = Math.max(3, (a.width ?? 2) / 2 + 3)
    if (a.type === 'square') {
      const q = a.quads[0]
      const inOuter = x >= q.x - tol && x <= q.x + q.w + tol && y >= q.y - tol && y <= q.y + q.h + tol
      const inInner = x >= q.x + tol && x <= q.x + q.w - tol && y >= q.y + tol && y <= q.y + q.h - tol
      if (inOuter && !inInner) return a
    } else if (a.type === 'circle') {
      const q = a.quads[0]
      const rx = q.w / 2
      const ry = q.h / 2
      if (rx >= 1 && ry >= 1) {
        const nx = (x - (q.x + rx)) / rx
        const ny = (y - (q.y + ry)) / ry
        // distance from the ellipse boundary, approximated via the normalized
        // radial offset scaled by the smaller semi-axis
        if (Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= tol) return a
      }
    } else if (a.type === 'line' || a.type === 'arrow') {
      const [p, q2] = a.strokes?.[0] ?? []
      if (p && q2) {
        if (pointToSegmentDistance(x, y, p[0], p[1], q2[0], q2[1]) <= tol) return a
      } else if (hitsQuads(a, x, y)) {
        return a // file-loaded lines carry no endpoints in the record — bbox fallback
      }
    } else if (a.type === 'ink') {
      if (inkHitTest(a, x, y, 4)) return a
    } else if (hitsQuads(a, x, y, a.type === 'freetext' ? FREETEXT_PAD : 2)) {
      return a // markup, note, freetext: padded bbox (same PAD=2 as annotationAtPoint)
    }
  }
  return null
}

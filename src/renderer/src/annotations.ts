// Geometry + styling for annotations created in this session. Coordinates are
// stored in "page space": PDF points with origin at the page's TOP-LEFT and y
// growing downward — which is also PDFium's and MuPDF's convention, so the
// engine writes these rects as-is. Held true by scripts/test-engine-embedpdf.mjs
// (`npm run test:engine`), which creates every type through the production
// engine and reads the geometry back with an independent library.
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
  // `| undefined` on top of `?` is deliberate under exactOptionalPropertyTypes.
  // These records are built as fresh object literals where the field is PRESENT
  // and undefined (`contents: maybeString`), which the flag distinguishes from
  // absent — and for a newly built snapshot the two are the same thing to every
  // consumer. AnnotPatch deliberately does NOT do this: a patch is spread onto an
  // existing record, where an explicit undefined would clobber a set value, and
  // that is the case the flag is actually here to catch.
  contents?: string | undefined
  author?: string | undefined
  /** ink: strokes; line/arrow: [[start, end]] — page space */
  strokes?: [number, number][][] | undefined
  /** ink (pen): per-point pen pressures (0–1), parallel to `strokes` — the
   *  mark renders as a variable-width filled outline (shared/ink-outline)
   *  instead of a constant-width stroked path */
  pressures?: number[][] | undefined
  /** ink/shapes: stroke width in points */
  width?: number | undefined
  /** freetext only */
  fontSize?: number | undefined
  /** ink (marker): drawn AND baked with multiply so text stays legible */
  blend?: 'multiply' | undefined
}

export type ColorKey = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'red' | 'orange' | 'black' | 'custom'

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

/** Forget every remembered color-wheel pick (app-wide reset to defaults) */
export function clearCustomColors(): void {
  try {
    localStorage.removeItem(CUSTOM_COLORS_KEY)
  } catch {
    /* nothing to forget */
  }
}

/** Fill opacity for text highlights — the SINGLE source for both the live
 *  overlay and the value persisted into the PDF (see applyMarkup), so a
 *  highlight looks identical before and after a save+reload. 0.5 is the tone
 *  the owner approved on saved annotations ("riktig", prettier than Edge);
 *  an earlier attempt to unify at 0.4 made every new highlight visibly paler
 *  than the existing ones. Changing this value changes NEW highlights only —
 *  saved ones keep the opacity they were written with, so any change here
 *  reintroduces a visible old-vs-new mismatch. Don't. */
export const HIGHLIGHT_FILL_ALPHA = 0.5

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

/* Underline/strikeout defaults match the palette's red exactly so the
   "selected" swatch ring recognizes them (compared componentwise in the
   toolbar menu). NOTE_COLOR is deliberately a softer, warmer amber than the
   palette's neon `yellow` — note markers are opaque (highlights are 50%), so
   the neon read too aggressively on the page. It therefore won't ring-match a
   swatch on a fresh note; that's fine. */
export const UNDERLINE_COLOR: [number, number, number] = [0.886, 0.286, 0.29]
export const STRIKEOUT_COLOR: [number, number, number] = [0.886, 0.286, 0.29]
export const NOTE_COLOR: [number, number, number] = [0.933, 0.796, 0.4]

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

/** Text colours for the FreeText tool: ink first (the default), then the
 *  saturated markup palette — red up front because a teacher's correction pen
 *  is the tool's signature use (Fredrik's Notability reference). */
export const FREETEXT_COLORS: HighlightColor[] = [
  { key: 'black', hex: '#1c1c21', rgb: FREETEXT_COLOR },
  { key: 'red', hex: '#e2494a', rgb: [0.886, 0.286, 0.29] },
  { key: 'blue', hex: '#327cf6', rgb: [0.196, 0.486, 0.965] },
  { key: 'green', hex: '#2f9e58', rgb: [0.184, 0.62, 0.345] },
  { key: 'orange', hex: '#f5920b', rgb: [0.96, 0.573, 0.043] }
]

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

const MARKUP_TYPE_SET: ReadonlySet<string> = new Set(MARKUP_TOOL_TYPES)

/** A mark ON TEXT (highlight, underline, strikeout, squiggly): its shape belongs
 *  to the words under it, which is why it is edited by dragging its ends rather
 *  than by resizing a box. */
export const isTextMarkup = (a: PageAnnotation): boolean => MARKUP_TYPE_SET.has(a.type)

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

/** The squiggly wave's LOW points, as a page-space y inside the quad. Kept
 *  right at the quad's bottom edge (a hair above, so the stroke's round cap
 *  stays inside the annotation /Rect) — the wave's peaks then land roughly
 *  where a plain underline's band sits, i.e. clear of the glyphs instead of
 *  running through them. Was max(2, 6% of h), which floated the whole wave
 *  ~1.6 pt too high and crossed the text.
 *
 *  This ALSO closes a live-vs-saved gap. Only huge files get their squiggly AP
 *  from us (incremental-appender.ts, case 'squiggly' — keep the two in
 *  lockstep); for normal saves PDFium synthesises it, and measured on a 14 pt
 *  quad at y 135 its wave occupies page-space y 147→149 — flush against the
 *  quad bottom. The old overlay drew 145.8→147.0, i.e. entirely ABOVE what the
 *  file would show after a reload; the current formula gives 147.3→148.5, which
 *  sits inside PDFium's band. Verify with a probe over an /AP content stream if
 *  this ever needs re-tuning — the overlay must show what the file will. */
export const squigglyBaseline = (q: PageRect): number =>
  q.y + q.h - Math.max(0.5, q.h * 0.015)

/**
 * Page-space `d` for a squiggly (zig-zag) underline over one quad. The geometry
 * is IDENTICAL to the saved appearance stream (incremental-appender.ts, case
 * 'squiggly') so the live overlay is a pixel-parity preview of the file: a
 * triangular wave whose troughs sit on squigglyBaseline(q), amplitude
 * max(1.2, 8%) of line height, one half-period every 2 page units.
 *
 * (Previously the overlay used a repeating-linear-gradient, which paints a
 * DASHED line, not a wave — the "bølgestrek blir dottet strek" bug.)
 */
export function squigglyPathData(q: PageRect): string {
  const base = squigglyBaseline(q)
  const amp = Math.max(1.2, q.h * 0.08)
  const half = 2 // page units per half-period
  let d = `M ${q.x.toFixed(2)} ${base.toFixed(2)}`
  let i = 1
  for (let x = q.x + half; x < q.x + q.w + half; x += half, i++) {
    const px = Math.min(x, q.x + q.w)
    const py = i % 2 ? base - amp : base
    d += ` L ${px.toFixed(2)} ${py.toFixed(2)}`
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
      // `multiply` — parity with the saved form: the appearance stream the
      // engine bakes renders through pdf.js as exactly this formula (verified
      // numerically: text (64,64,71) → (64,60,51) = (1-α)·C + α·C·S/255), so a
      // live highlight is pixel-identical to the same highlight after
      // save+reload. NOTE: the blend only works because .annot-highlights
      // carries `z-index: auto` (app.css) — any stacking-context trigger on an
      // ancestor between this div and the page canvas (z-index, filter,
      // opacity, transform) forms an isolated group and silently degrades the
      // blend to a plain alpha wash that greys the text. That exact bug
      // shipped for a while and produced every "markeringen gjør teksten dus"
      // complaint. Keep opacity coming from the RECORD (a.opacity), and keep
      // blend + color in lockstep with the engine.
      // The RECORD's opacity, never the global constant: the constant only
      // seeds NEW highlights (applyMarkup). Drawing with the constant made an
      // annotation saved under an older value render differently live vs after
      // reload — the overlay must always show exactly what the file will.
      return { ...toCss(q), background: rgbCss(a.color, a.opacity), mixBlendMode: 'multiply' }
    case 'underline': {
      const thick = Math.max(1.5 / scale, 1.2)
      const off = Math.max(1.5 / scale, 0.045 * q.h)
      return {
        ...toCss({ x: q.x, y: q.y + q.h - off, w: q.w, h: thick }),
        // 0.9 is the line markups' inherent softening (a hairline at full
        // opacity reads harsher than the same colour as a fill); the RECORD's
        // opacity rides on top of it so a user-dialled opacity shows live
        // exactly as the engine bakes it. opacity 1 (every pre-existing line
        // markup) is unchanged.
        background: rgbCss(a.color, 0.9 * a.opacity)
      }
    }
    case 'strikeout': {
      const thick = Math.max(1.5 / scale, 1.2)
      return {
        ...toCss({ x: q.x, y: q.y + q.h * 0.52, w: q.w, h: thick }),
        background: rgbCss(a.color, 0.9 * a.opacity)
      }
    }
    case 'squiggly':
      // Squiggly is drawn as an SVG zig-zag path in AnnotationMarks
      // (squigglyPathData) — a CSS gradient can only make a dashed line, not a
      // wave. This box is just its positioned bounds (unused for painting).
      return toCss(q)
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

/** Where the arrow SHAFT should end: pulled back from the tip so the stroke
 *  (including its round cap) stays hidden under the head polygon instead of
 *  poking out past its base edge */
export function arrowShaftEnd(
  from: [number, number],
  to: [number, number],
  size: number
): [number, number] {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (len < 1e-6) return to
  const k = Math.max(0, len - size * 0.75) / len
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]
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

// ---------- Resize (drag a handle instead of deleting and drawing again) -----

/** How an annotation answers a resize handle. A box is dragged by its corners;
 *  a line has no meaningful corners, only two endpoints. Everything else — text
 *  markup (its shape belongs to the text; see the end-drag path), notes (a fixed
 *  icon) — has no handles at all. */
export type ResizeKind = 'box' | 'endpoints'

export function resizeKindOf(a: PageAnnotation): ResizeKind | null {
  if (a.type === 'line' || a.type === 'arrow') return a.strokes?.[0]?.length === 2 ? 'endpoints' : null
  if (a.type === 'square' || a.type === 'circle' || a.type === 'freetext' || a.type === 'ink') {
    return a.quads.length > 0 ? 'box' : null
  }
  return null
}

/** Smallest box a resize may produce, in PDF points — below this a shape is
 *  invisible and impossible to grab again. */
export const MIN_SHAPE_SIZE = 8

// ---------- FreeText minimum size (no letter may ever be clipped) ----------

let freetextMeasureCtx: CanvasRenderingContext2D | null = null

/** The smallest box that shows EVERY letter of a FreeText at (or near) the
 *  candidate width: the width floor is the widest unbreakable word, the
 *  height is the greedy-wrapped line count at the effective width. Mirrors
 *  .annot-freetext exactly — Helvetica stack, line-height 1.35, pre-wrap, no
 *  padding — so what the clamp allows is what the overlay shows. A resize (or
 *  an editor commit) below this clips letters, which reads as data loss. */
export function freetextMinSize(
  text: string,
  fontSize: number,
  candidateW: number
): { w: number; h: number } {
  const content = text.length > 0 ? text : ' '
  const ctx = (freetextMeasureCtx ??= document.createElement('canvas').getContext('2d'))
  if (!ctx) return { w: MIN_SHAPE_SIZE, h: MIN_SHAPE_SIZE }
  ctx.font = `${fontSize}px Helvetica, Arial, sans-serif`
  const measure = (s: string): number => ctx.measureText(s).width
  // pre-wrap keeps words whole: the widest word is the honest width floor
  let maxWord = 0
  for (const word of content.split(/\s+/)) maxWord = Math.max(maxWord, measure(word))
  const w = Math.max(MIN_SHAPE_SIZE, maxWord + 1)
  const effW = Math.max(candidateW, w)
  let lines = 0
  for (const paragraph of content.split('\n')) {
    const words = paragraph.split(' ').filter((s) => s.length > 0)
    if (words.length === 0) {
      lines += 1
      continue
    }
    let current = ''
    let paragraphLines = 1
    for (const word of words) {
      const next = current === '' ? word : `${current} ${word}`
      if (measure(next) > effW && current !== '') {
        paragraphLines += 1
        current = word
      } else {
        current = next
      }
    }
    lines += paragraphLines
  }
  return { w, h: Math.max(MIN_SHAPE_SIZE, lines * fontSize * 1.35 + 1) }
}

/** The four corners, named as in the selection frame's CSS classes */
export const BOX_HANDLES = ['tl', 'tr', 'bl', 'br'] as const
export type BoxHandle = (typeof BOX_HANDLES)[number]
/** Which end of a line a handle grabs */
export type EndHandle = 'p0' | 'p1'
export type ResizeHandle = BoxHandle | EndHandle

/** Union box of an annotation's quads — what the selection frame hugs and what
 *  a box resize starts from. */
export function quadsUnion(quads: PageRect[]): PageRect {
  const first = quads[0] ?? { x: 0, y: 0, w: 0, h: 0 }
  let x0 = first.x
  let y0 = first.y
  let x1 = first.x + first.w
  let y1 = first.y + first.h
  for (const q of quads) {
    x0 = Math.min(x0, q.x)
    y0 = Math.min(y0, q.y)
    x1 = Math.max(x1, q.x + q.w)
    y1 = Math.max(y1, q.y + q.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Room the stroke width takes around an ink path */
export const inkPad = (width: number): number => width / 2 + 1

/** Bounding box of the ink itself, without the stroke-width padding — what a
 *  resize scales, so the corner opposite the grabbed one stays exactly put. */
export function strokesBox(strokes: [number, number][][]): PageRect {
  return quadsUnion(strokes.flat().map(([x, y]) => ({ x, y, w: 0, h: 0 })))
}

/** The record-level box for an ink annotation: its strokes plus the room the
 *  stroke width takes. Shared by the draw tool and the resize path so a scaled
 *  stroke keeps the box a freshly drawn one would have. */
export function inkQuad(strokes: [number, number][][], width: number): PageRect {
  const pad = inkPad(width)
  const u = strokesBox(strokes)
  return { x: u.x - pad, y: u.y - pad, w: u.w + 2 * pad, h: u.h + 2 * pad }
}

/** Same for a line/arrow: enough room around the endpoints for the stroke and
 *  the arrowhead. */
export function lineQuad(a: [number, number], b: [number, number], width: number): PageRect {
  const pad = Math.max(6, width * 3.2)
  return {
    x: Math.min(a[0], b[0]) - pad,
    y: Math.min(a[1], b[1]) - pad,
    w: Math.abs(b[0] - a[0]) + 2 * pad,
    h: Math.abs(b[1] - a[1]) + 2 * pad
  }
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

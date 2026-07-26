// Annotation-tool preferences: colour, stroke width and opacity per drawing
// tool, colour + opacity per text-markup type, and the eraser's scope.
//
// Persisted in localStorage so a chosen tusj tone survives a restart on every
// platform (desktop, extension, plain-web preview) — the same hand-rolled
// pattern as the panel widths and the toolbar pin in PdfViewer. Deliberately
// NOT in the main-process settings store: these are renderer-only view
// preferences with no IPC consumer, and the browser targets have no main
// process to talk to.
//
// DEFAULTS ARE LOAD-BEARING. Every default here reproduces the tone the owner
// approved (MARKER_OPACITY, HIGHLIGHT_FILL_ALPHA, PEN_DEFAULT …) — changing one
// changes how NEW annotations look, and saved ones keep whatever they were
// written with, so a change reintroduces an old-vs-new mismatch on the page.
// The user-facing sliders exist precisely so nobody has to touch these.
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_FILL_ALPHA,
  MARKER_DEFAULT,
  MARKER_OPACITY,
  MARKUP_TOOL_TYPES,
  PEN_DEFAULT,
  SHAPE_DEFAULT,
  UNDERLINE_COLOR
} from './annotations'
import type { MarkupToolType } from './annotations'
import { clamp } from './clamp'

/** The three freehand tools that carry colour + width + opacity */
export const DRAW_PREF_KEYS = ['pen', 'marker', 'shape'] as const
export type DrawPrefKey = (typeof DRAW_PREF_KEYS)[number]

export interface ToolPref {
  color: [number, number, number]
  width: number
  opacity: number
}

export interface MarkupPref {
  color: [number, number, number]
  opacity: number
}

/** What the eraser is allowed to remove. 'draw' (default) keeps it to marks
 *  you drew by hand — the historical behaviour the tooltip promised; 'all'
 *  extends it to highlights, notes and text boxes. */
export type EraserScope = 'draw' | 'all'

export interface ToolPrefs {
  tools: Record<DrawPrefKey, ToolPref>
  markup: Record<MarkupToolType, MarkupPref>
  eraserScope: EraserScope
}

/** Upper bound of each tool's width slider. The owner asked for headroom above
 *  the old flat 16 pt without moving any default: a tusj wide enough to band a
 *  whole paragraph (40 pt ≈ three text lines at 100 %), a pen wide enough for
 *  margin scrawl, and shapes left alone — a 40 pt rectangle outline is just a
 *  blob. */
export const TOOL_WIDTH_MAX: Record<DrawPrefKey, number> = {
  pen: 24,
  marker: 40,
  shape: 16
}
export const TOOL_WIDTH_MIN = 1
export const TOOL_WIDTH_STEP = 0.5

/** Opacity slider bounds. The floor is above 0 on purpose — an invisible tool
 *  reads as a broken tool, and 10 % is already a whisper. */
export const OPACITY_MIN = 0.1
export const OPACITY_MAX = 1
export const OPACITY_STEP = 0.05

export const DEFAULT_TOOL_PREFS: ToolPrefs = {
  tools: {
    pen: { ...PEN_DEFAULT, opacity: 1 },
    marker: { ...MARKER_DEFAULT, opacity: MARKER_OPACITY },
    shape: { ...SHAPE_DEFAULT, opacity: 1 }
  },
  markup: {
    highlight: { color: HIGHLIGHT_COLORS[0].rgb, opacity: HIGHLIGHT_FILL_ALPHA },
    underline: { color: UNDERLINE_COLOR, opacity: 1 },
    strikeout: { color: UNDERLINE_COLOR, opacity: 1 },
    squiggly: { color: UNDERLINE_COLOR, opacity: 1 }
  },
  eraserScope: 'draw'
}

const LS_KEY = 'pdfx-tool-prefs'

const isRgb = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1)

/** Merge one stored tool entry over its default, dropping anything malformed —
 *  a hand-edited or version-skewed localStorage entry must never be able to
 *  produce an invisible or zero-width tool. */
function mergeTool(key: DrawPrefKey, raw: unknown): ToolPref {
  const base = DEFAULT_TOOL_PREFS.tools[key]
  if (!raw || typeof raw !== 'object') return { ...base }
  const r = raw as Partial<ToolPref>
  return {
    color: isRgb(r.color) ? r.color : base.color,
    width:
      typeof r.width === 'number' && Number.isFinite(r.width)
        ? clamp(r.width, TOOL_WIDTH_MIN, TOOL_WIDTH_MAX[key])
        : base.width,
    opacity:
      typeof r.opacity === 'number' && Number.isFinite(r.opacity)
        ? clamp(r.opacity, OPACITY_MIN, OPACITY_MAX)
        : base.opacity
  }
}

function mergeMarkup(type: MarkupToolType, raw: unknown): MarkupPref {
  const base = DEFAULT_TOOL_PREFS.markup[type]
  if (!raw || typeof raw !== 'object') return { ...base }
  const r = raw as Partial<MarkupPref>
  return {
    color: isRgb(r.color) ? r.color : base.color,
    opacity:
      typeof r.opacity === 'number' && Number.isFinite(r.opacity)
        ? clamp(r.opacity, OPACITY_MIN, OPACITY_MAX)
        : base.opacity
  }
}

export function loadToolPrefs(): ToolPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    return {
      tools: {
        pen: mergeTool('pen', parsed?.tools?.pen),
        marker: mergeTool('marker', parsed?.tools?.marker),
        shape: mergeTool('shape', parsed?.tools?.shape)
      },
      markup: {
        highlight: mergeMarkup('highlight', parsed?.markup?.highlight),
        underline: mergeMarkup('underline', parsed?.markup?.underline),
        strikeout: mergeMarkup('strikeout', parsed?.markup?.strikeout),
        squiggly: mergeMarkup('squiggly', parsed?.markup?.squiggly)
      },
      eraserScope: parsed?.eraserScope === 'all' ? 'all' : 'draw'
    }
  } catch {
    return structuredClone(DEFAULT_TOOL_PREFS)
  }
}

export function saveToolPrefs(prefs: ToolPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs))
  } catch {
    /* remembering tool settings is a convenience, never a hard requirement */
  }
}

/** Forget every stored tool preference (app-wide reset to defaults) */
export function clearToolPrefs(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* nothing to forget */
  }
}

const sameRgb = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

/** True when a tool sits exactly on its shipped default — drives whether the
 *  popover's «Nullstill» link is offered at all (it stays hidden when there is
 *  nothing to undo, so the option never becomes visual noise). */
export function toolPrefIsDefault(key: DrawPrefKey, pref: ToolPref): boolean {
  const d = DEFAULT_TOOL_PREFS.tools[key]
  return sameRgb(pref.color, d.color) && pref.width === d.width && pref.opacity === d.opacity
}

export function markupPrefIsDefault(type: MarkupToolType, pref: MarkupPref): boolean {
  const d = DEFAULT_TOOL_PREFS.markup[type]
  return sameRgb(pref.color, d.color) && pref.opacity === d.opacity
}


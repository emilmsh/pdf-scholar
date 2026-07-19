// Turns an AnnotateRequest into an EmbedPDF annotation model object. Shared by
// the desktop engine (src/main/annotation-engine-embedpdf.ts) and the browser
// engine (src/renderer/src/annotation-engine-browser.ts) so both bake identical
// annotations — the appearance a reader sees is decided in exactly one place.
import type { AnnotateRequest, PageRect } from './types'
import type { PdfAnnotationObject } from '@embedpdf/models'
import {
  PdfAnnotationLineEnding,
  PdfAnnotationSubtype,
  PdfStandardFont,
  PdfTextAlignment,
  PdfVerticalAlignment
} from '@embedpdf/models'

export const rgbToHex = (c: [number, number, number]): string =>
  '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')

export const toRect = (
  r: PageRect
): { origin: { x: number; y: number }; size: { width: number; height: number } } => ({
  origin: { x: r.x, y: r.y },
  size: { width: r.w, height: r.h }
})

export function strokesBBox(strokes: [number, number][][], pad: number): PageRect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes) {
    for (const [x, y] of s) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
}

export const MARKUP = new Set<AnnotateRequest['type']>([
  'highlight',
  'underline',
  'strikeout',
  'squiggly'
])

export function buildAnnotation(req: AnnotateRequest): PdfAnnotationObject | { error: string } {
  const base = {
    id: crypto.randomUUID(),
    pageIndex: req.pageIndex,
    author: req.author ?? 'PDFX',
    contents: req.contents,
    created: new Date()
  }
  const color = rgbToHex(req.color)
  if (MARKUP.has(req.type)) {
    const subtype = {
      highlight: PdfAnnotationSubtype.HIGHLIGHT,
      underline: PdfAnnotationSubtype.UNDERLINE,
      strikeout: PdfAnnotationSubtype.STRIKEOUT,
      squiggly: PdfAnnotationSubtype.SQUIGGLY
    }[req.type as 'highlight' | 'underline' | 'strikeout' | 'squiggly']
    const bbox = req.quads.reduce(
      (a, q) => ({
        x: Math.min(a.x, q.x),
        y: Math.min(a.y, q.y),
        w: Math.max(a.x + a.w, q.x + q.w) - Math.min(a.x, q.x),
        h: Math.max(a.y + a.h, q.y + q.h) - Math.min(a.y, q.y)
      }),
      { ...req.quads[0] }
    )
    return {
      ...base,
      type: subtype,
      rect: toRect(bbox),
      segmentRects: req.quads.map(toRect),
      strokeColor: color,
      opacity: req.opacity
    } as PdfAnnotationObject
  }
  switch (req.type) {
    case 'note': {
      const q = req.quads[0]
      return {
        ...base,
        type: PdfAnnotationSubtype.TEXT,
        contents: req.contents ?? '',
        rect: toRect({ x: q.x, y: q.y, w: Math.max(q.w, 20), h: Math.max(q.h, 20) }),
        strokeColor: color,
        opacity: req.opacity
      } as PdfAnnotationObject
    }
    case 'ink': {
      if (!req.strokes || req.strokes.length === 0) return { error: 'Streken er tom' }
      const width = req.width ?? 2
      return {
        ...base,
        type: PdfAnnotationSubtype.INK,
        rect: toRect(strokesBBox(req.strokes, width)),
        inkList: req.strokes.map((s) => ({ points: s.map(([x, y]) => ({ x, y })) })),
        strokeColor: color,
        strokeWidth: width,
        opacity: req.opacity
      } as PdfAnnotationObject
    }
    case 'square':
    case 'circle': {
      const q = req.quads[0]
      return {
        ...base,
        type: req.type === 'square' ? PdfAnnotationSubtype.SQUARE : PdfAnnotationSubtype.CIRCLE,
        rect: toRect(q),
        strokeColor: color,
        strokeWidth: req.width ?? 2,
        opacity: req.opacity
      } as PdfAnnotationObject
    }
    case 'line':
    case 'arrow': {
      const [a, b] = req.strokes?.[0] ?? []
      if (!a || !b) return { error: 'Linjen mangler endepunkter' }
      const width = req.width ?? 2
      const pad = Math.max(6, width * 4.5)
      return {
        ...base,
        type: PdfAnnotationSubtype.LINE,
        rect: toRect(strokesBBox([[a, b]], pad)),
        linePoints: { start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } },
        ...(req.type === 'arrow'
          ? { lineEndings: { start: PdfAnnotationLineEnding.None, end: PdfAnnotationLineEnding.ClosedArrow } }
          : {}),
        strokeColor: color,
        color,
        strokeWidth: width,
        strokeStyle: 1,
        opacity: req.opacity
      } as unknown as PdfAnnotationObject
    }
    case 'freetext': {
      const q = req.quads[0]
      return {
        ...base,
        type: PdfAnnotationSubtype.FREETEXT,
        contents: req.contents ?? '',
        rect: toRect(q),
        fontFamily: PdfStandardFont.Helvetica,
        fontSize: req.fontSize ?? 12,
        fontColor: color,
        textAlign: PdfTextAlignment.Left,
        verticalAlign: PdfVerticalAlignment.Top,
        opacity: req.opacity
      } as PdfAnnotationObject
    }
    default:
      return { error: `Ukjent annotasjonstype: ${req.type}` }
  }
}

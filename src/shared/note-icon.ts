// The sticky note's icon: ONE drawing, rendered twice — as the overlay's SVG
// while the note is fresh (PdfPage.tsx), and as the appearance stream baked
// into the file (pdfium-annot-ops.ts, incremental-appender.ts), which pdf.js
// paints once the note has been saved and the document re-read.
//
// Until issue #30 only the first half existed. The file got PDFium's own Text
// icon, so a note changed face the moment it was saved and reopened: our
// rounded bubble before, a square with a tail after. Every shape below is
// described once, in the 24-unit box the overlay's viewBox uses (y down), and
// both renderings are derived from it.

export const NOTE_ICON_BOX = 24

type Pt = [number, number]
type Seg = { op: 'M' | 'L'; p: Pt } | { op: 'C'; c1: Pt; c2: Pt; p: Pt } | { op: 'Z' }

/** Cubic-Bézier handle length for a quarter circle of radius 1. */
const K = 0.5522847498

/** Rounded body 3.5..20.5 × 4..17 (corner radius 3), with the tail leaving
 *  the bottom edge between x 6.5 and 10.5 and pointing down-left to
 *  (6.5, 20.5). Corners are cubics rather than SVG arcs so the PDF side —
 *  which has no arc operator — draws exactly the same curve. */
function bubble(): Seg[] {
  const [x0, y0, x1, y1, r] = [3.5, 4, 20.5, 17, 3]
  const k = r * K
  return [
    { op: 'M', p: [x0, y0 + r] },
    { op: 'C', c1: [x0, y0 + r - k], c2: [x0 + r - k, y0], p: [x0 + r, y0] },
    { op: 'L', p: [x1 - r, y0] },
    { op: 'C', c1: [x1 - r + k, y0], c2: [x1, y0 + r - k], p: [x1, y0 + r] },
    { op: 'L', p: [x1, y1 - r] },
    { op: 'C', c1: [x1, y1 - r + k], c2: [x1 - r + k, y1], p: [x1 - r, y1] },
    { op: 'L', p: [10.5, y1] },
    { op: 'L', p: [6.5, 20.5] },
    { op: 'L', p: [x0 + r, y1] },
    { op: 'C', c1: [x0 + r - k, y1], c2: [x0, y1 - r + k], p: [x0, y1 - r] },
    { op: 'Z' }
  ]
}

/** The two text lines inside the bubble */
const LINES: [Pt, Pt][] = [
  [[7.5, 8.7], [16.5, 8.7]],
  [[7.5, 12.2], [13.5, 12.2]]
]

/** Ink of the outline and of the text lines: black at these alphas, so the
 *  icon darkens toward its own colour rather than going grey. */
const OUTLINE = { alpha: 0.22, width: 1 }
const TEXT_LINES = { alpha: 0.38, width: 1.5 }

const num = (v: number): string => String(Math.round(v * 1000) / 1000)

function svgPath(segs: Seg[]): string {
  return segs
    .map((s) =>
      s.op === 'Z'
        ? 'Z'
        : s.op === 'C'
          ? `C${[...s.c1, ...s.c2, ...s.p].map(num).join(' ')}`
          : `${s.op}${s.p.map(num).join(' ')}`
    )
    .join('')
}

/** What the overlay's <svg viewBox="0 0 24 24"> draws */
export const NOTE_ICON_SVG = {
  bubble: svgPath(bubble()),
  lines: LINES.map(([a, b]) => `M${a.map(num).join(' ')}L${b.map(num).join(' ')}`).join(''),
  outline: OUTLINE,
  textLines: TEXT_LINES
}

/** The appearance-stream content for a note in `color`, filling the box
 *  left..right × bottom..top in PDF user space (y up) — the annotation's
 *  /Rect, which is also the stream's /BBox, so no /Matrix is involved.
 *
 *  A stream written through FPDFAnnot_SetAP cannot bring an ExtGState of its
 *  own, so the overlay's translucent black inks are pre-composited instead:
 *  over the fill, black at alpha a is exactly fill × (1 − a). That is the
 *  whole of the text lines and the inner half of the outline (stroked under a
 *  clip to the bubble). The outer half lies over the paper and is composited
 *  against white — on the white pages notes are written on, pixel-identical
 *  to the overlay.
 *
 *  `gs` names an ExtGState in the stream's Resources that carries the note's
 *  opacity (PDFium's generator leaves one called GS; the appender writes its
 *  own). Only for a see-through note — an opaque one must not depend on that
 *  resource being there. */
export function noteIconApContent(
  color: [number, number, number],
  box: { left: number; bottom: number; right: number; top: number },
  gs?: string
): string {
  const sx = (box.right - box.left) / NOTE_ICON_BOX
  const sy = (box.top - box.bottom) / NOTE_ICON_BOX
  const s = Math.min(sx, sy)
  const pt = ([x, y]: Pt): string => `${num(box.left + x * sx)} ${num(box.top - y * sy)}`
  const path = bubble()
    .map((g) =>
      g.op === 'Z' ? 'h' : g.op === 'C' ? `${pt(g.c1)} ${pt(g.c2)} ${pt(g.p)} c` : `${pt(g.p)} ${g.op === 'M' ? 'm' : 'l'}`
    )
    .join('\n')
  const rgb = (c: number[]): string => c.map(num).join(' ')
  const over = (a: number): string => rgb(color.map((v) => v * (1 - a)))
  return [
    'q',
    ...(gs ? [`/${gs} gs`] : []),
    '1 j',
    `${num(OUTLINE.width * s)} w`,
    // Outer half of the outline, over the paper
    `${rgb([1, 1, 1].map((v) => v * (1 - OUTLINE.alpha)))} RG`,
    path,
    'S',
    `${rgb(color)} rg`,
    path,
    'f',
    // Inner half of the outline, over the fill
    'q',
    path,
    'W n',
    `${over(OUTLINE.alpha)} RG`,
    path,
    'S',
    'Q',
    '1 J',
    `${num(TEXT_LINES.width * s)} w`,
    `${over(TEXT_LINES.alpha)} RG`,
    ...LINES.map(([a, b]) => `${pt(a)} m ${pt(b)} l`),
    'S',
    'Q',
    ''
  ].join('\n')
}

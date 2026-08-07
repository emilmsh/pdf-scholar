// Variable-width ink geometry — the shape a pressure-sensitive pen stroke
// actually has. Shared by the renderer (live draw layer + annotation overlay,
// as an SVG path) and by both write engines (as PDF appearance-stream
// operators), so what the pen draws, what the overlay shows and what other
// readers render is the SAME polygon, computed in exactly one place.
//
// A standard Ink annotation carries one border width for the whole stroke, so
// pressure has to be baked as a custom appearance stream: a closed polygon
// around the centerline (round caps included), filled with nonzero winding.
// The InkList keeps the centerline so other editors still see a normal Ink.

/** What a mouse or finger reports for `PointerEvent.pressure` while pressed —
 *  and the pressure at which the width factor is exactly 1, so a non-pen
 *  stroke through the pressure path would come out identical to a plain one. */
export const PRESSURE_NEUTRAL = 0.5

/** Pen pressure (0–1) → width multiplier. Deliberately gentle (0.6×–1.4×):
 *  visible calligraphy without the theatrical swell of a paint app. Part of
 *  the stored format in the sense that saved pressures are re-baked through
 *  this curve when a stroke is edited — change it and edited old strokes
 *  change weight with it. */
export function pressureWidthFactor(p: number): number {
  const clamped = Math.min(1, Math.max(0, p))
  return 0.6 + 0.8 * clamped
}

/** The EMA weight both the batch smoother below and the renderer's
 *  incremental capture use — one constant so they agree. */
export const PRESSURE_EMA_ALPHA = 0.35

/** Exponential smoothing over a raw pressure sequence. Pen hardware reports
 *  pressure noisily sample-to-sample; without this the outline edge ripples. */
export function smoothPressures(raw: number[], alpha = PRESSURE_EMA_ALPHA): number[] {
  const out = new Array<number>(raw.length)
  let acc = raw[0] ?? PRESSURE_NEUTRAL
  for (let i = 0; i < raw.length; i++) {
    acc = acc + alpha * (raw[i] - acc)
    out[i] = Math.round(acc * 100) / 100
  }
  return out
}

const K_CAP = 6 // interior samples per semicircular cap

/** Closed outline polygon around a centerline with a half-width per point.
 *  Round caps at both ends. Sharp corners may self-overlap; nonzero-winding
 *  fill renders those correctly in both SVG and PDF. A single point (a dot)
 *  becomes a circle. Returns [] for empty input. */
export function strokeOutline(
  points: [number, number][],
  halfWidths: number[]
): [number, number][] {
  // Collapse consecutive duplicates so normals never divide by zero
  const pts: [number, number][] = []
  const hws: number[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = pts[pts.length - 1]
    if (prev && Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]) < 1e-6) continue
    pts.push(points[i])
    hws.push(halfWidths[i] ?? halfWidths[halfWidths.length - 1] ?? 1)
  }
  if (pts.length === 0) return []
  if (pts.length === 1) {
    const [cx, cy] = pts[0]
    const r = hws[0]
    const circle: [number, number][] = []
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 2 * Math.PI
      circle.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
    return circle
  }

  // Per-point unit direction: endpoint uses its single segment, interior
  // points average the two adjacent segment directions.
  const dirs: [number, number][] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    dirs.push([dx / len, dy / len])
  }

  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let i = 0; i < pts.length; i++) {
    const [dx, dy] = dirs[i]
    const nx = -dy
    const ny = dx
    const h = hws[i]
    left.push([pts[i][0] + nx * h, pts[i][1] + ny * h])
    right.push([pts[i][0] - nx * h, pts[i][1] - ny * h])
  }

  /** Interior points of a semicircle at `p`, sweeping from +n to -n through
   *  +d (t ∈ (0,1) exclusive — the ends are already in left/right). */
  const cap = (
    p: [number, number],
    d: [number, number],
    n: [number, number],
    h: number
  ): [number, number][] => {
    const out: [number, number][] = []
    for (let k = 1; k <= K_CAP; k++) {
      const t = (k / (K_CAP + 1)) * Math.PI
      const vx = n[0] * Math.cos(t) + d[0] * Math.sin(t)
      const vy = n[1] * Math.cos(t) + d[1] * Math.sin(t)
      out.push([p[0] + vx * h, p[1] + vy * h])
    }
    return out
  }

  const last = pts.length - 1
  const dEnd = dirs[last]
  const nEnd: [number, number] = [-dEnd[1], dEnd[0]]
  const dStart = dirs[0]
  const nStart: [number, number] = [-dStart[1], dStart[0]]
  return [
    ...left,
    ...cap(pts[last], dEnd, nEnd, hws[last]),
    ...right.reverse(),
    // Start cap sweeps from -n back to +n through -d (the stroke's rear)
    ...cap(pts[0], [-dStart[0], -dStart[1]], [-nStart[0], -nStart[1]], hws[0])
  ]
}

/** Half-widths for a stroke: base width × pressure curve, halved. */
export function pressureHalfWidths(pressures: number[], baseWidth: number): number[] {
  return pressures.map((p) => (baseWidth * pressureWidthFactor(p)) / 2)
}

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

/** The outline as an SVG path `d` (closed; fill-rule nonzero is SVG's default). */
export function outlineSvgPath(poly: [number, number][]): string {
  if (poly.length === 0) return ''
  let d = `M ${fmt(poly[0][0])} ${fmt(poly[0][1])}`
  for (let i = 1; i < poly.length; i++) d += ` L ${fmt(poly[i][0])} ${fmt(poly[i][1])}`
  return d + ' Z'
}

/** The outline as PDF path operators (m/l/h), through a model→PDF coordinate
 *  map. The caller wraps with colour and a nonzero-winding fill (`f`). */
export function outlinePdfOps(
  poly: [number, number][],
  map: (x: number, y: number) => [number, number]
): string {
  if (poly.length === 0) return ''
  const [x0, y0] = map(poly[0][0], poly[0][1])
  let ops = `${fmt(x0)} ${fmt(y0)} m\n`
  for (let i = 1; i < poly.length; i++) {
    const [x, y] = map(poly[i][0], poly[i][1])
    ops += `${fmt(x)} ${fmt(y)} l\n`
  }
  return ops + 'h\n'
}

/** Compact wire/dict format for per-stroke pressures: strokes joined with ';',
 *  points with ' ', two decimals. */
export function encodePressures(pressures: number[][]): string {
  return pressures.map((s) => s.map((p) => fmt(p)).join(' ')).join(';')
}

export function decodePressures(text: string): number[][] | null {
  if (!text) return null
  const strokes = text.split(';').map((s) =>
    s
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n))
  )
  if (strokes.some((s) => s.length === 0)) return null
  return strokes
}

/** Full appearance-stream content for a pressure ink annotation: every stroke
 *  as a filled outline polygon in the annotation's own colour.
 *
 *  Translucency: the annot-dict /CA alone is NOT honoured over an /AP by e.g.
 *  mupdf, so a see-through stroke must carry its alpha inside the appearance.
 *  `/GS gs` references the ExtGState EmbedPDF's own generator put in the
 *  stream's Resources (alpha = the annotation's opacity, blend Normal) —
 *  FPDFAnnot_SetAP replaces a stream's content but keeps its dictionary, so
 *  the resource is still there when this content lands (verified in
 *  test:engine). Emitted only when opacity < 1: a fully opaque stroke must not
 *  depend on the resource being present (regenerated APs don't always carry
 *  it), and needs no alpha anyway. The marker (uniform width, /BM Multiply)
 *  never comes here. */
export function inkPressureApContent(
  strokes: [number, number][][],
  pressures: number[][],
  baseWidth: number,
  color: [number, number, number],
  opacity: number,
  map: (x: number, y: number) => [number, number]
): string {
  const [r, g, b] = color.map((v) => Math.round(v * 1000) / 1000)
  let content = `q\n${opacity < 1 ? '/GS gs\n' : ''}${r} ${g} ${b} rg\n`
  for (let i = 0; i < strokes.length; i++) {
    const hw = pressureHalfWidths(pressures[i] ?? [], baseWidth)
    const poly = strokeOutline(strokes[i], hw)
    if (poly.length === 0) continue
    content += outlinePdfOps(poly, map) + 'f\n'
  }
  return content + 'Q\n'
}

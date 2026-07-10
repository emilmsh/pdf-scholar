import { memo, useEffect, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect } from '../../../shared/types'
import type { DrawTool, PageAnnotation, ShapeToolType } from '../annotations'
import { annotationCss, arrowHeadPoints, rgbCss, strokePathData } from '../annotations'

const SHAPE_TYPES = new Set(['square', 'circle', 'line', 'arrow'])
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Props {
  pdf: PDFDocumentProxy
  pageNumber: number
  top: number
  left: number
  cssWidth: number
  cssHeight: number
  scale: number
  /** Only pages near the viewport actually render their canvas */
  active: boolean
  /** Annotations created this session, drawn by the overlay (PDF page space) */
  annotations: PageAnnotation[]
  /** Rects of the active search match on this page (page space) */
  searchRects: PageRect[]
  /** Active freehand tool (pen/marker/eraser), or null when not drawing */
  drawTool: DrawTool | null
  /** Stable callbacks (identity must not change with viewer state) */
  onInternalLink(dest: unknown): void
  onExternalLink(url: string): void
  onStrokeComplete(pageNumber: number, points: [number, number][]): void
  onErase(pageNumber: number, x: number, y: number): void
  onShapeComplete(
    pageNumber: number,
    type: ShapeToolType,
    a: [number, number],
    b: [number, number]
  ): void
  onPlaceText(pageNumber: number, x: number, y: number, clientX: number, clientY: number): void
}

interface Cancellable {
  cancel(): void
}

function PdfPage({
  pdf,
  pageNumber,
  top,
  left,
  cssWidth,
  cssHeight,
  scale,
  active,
  annotations,
  searchRects,
  drawTool,
  onInternalLink,
  onExternalLink,
  onStrokeComplete,
  onErase,
  onShapeComplete,
  onPlaceText
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const linkRef = useRef<HTMLDivElement>(null)
  const drawSvgRef = useRef<SVGSVGElement>(null)
  const strokeRef = useRef<{
    pointerId: number
    points: [number, number][]
    path: SVGPathElement
  } | null>(null)
  const shapeRef = useRef<{
    pointerId: number
    type: ShapeToolType
    start: [number, number]
    end: [number, number]
    group: SVGGElement
  } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    const textHost = textRef.current
    const linkHost = linkRef.current
    if (!host || !textHost || !linkHost) return
    if (!active) {
      // Free bitmap + text nodes when far outside the viewport
      host.replaceChildren()
      textHost.replaceChildren()
      linkHost.replaceChildren()
      return
    }

    let cancelled = false
    let renderTask: Cancellable | null = null
    let textLayer: Cancellable | null = null

    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale })

      // Render into a detached canvas and swap it in when finished, so the
      // previous (CSS-stretched) bitmap stays visible during zoom — no flash.
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const task = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      })
      renderTask = task
      await task.promise
      if (cancelled) return
      host.replaceChildren(canvas)

      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      const tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport
      })
      textLayer = tl
      await tl.render()
      if (cancelled) return
      const endOfContent = document.createElement('div')
      endOfContent.className = 'endOfContent'
      textDiv.append(endOfContent)
      textHost.replaceChildren(textDiv)

      // Clickable link annotations (internal destinations + external URLs)
      const annots = (await page.getAnnotations()) as {
        subtype: string
        rect: number[]
        url?: string
        dest?: unknown
      }[]
      if (cancelled) return
      const links = annots.filter((a) => a.subtype === 'Link' && (a.url || a.dest))
      const frag = document.createDocumentFragment()
      for (const link of links) {
        const [px1, py1] = viewport.convertToViewportPoint(link.rect[0], link.rect[1])
        const [px2, py2] = viewport.convertToViewportPoint(link.rect[2], link.rect[3])
        const anchor = document.createElement('a')
        anchor.className = 'pdf-link'
        anchor.href = '#'
        anchor.style.left = `${Math.min(px1, px2)}px`
        anchor.style.top = `${Math.min(py1, py2)}px`
        anchor.style.width = `${Math.abs(px2 - px1)}px`
        anchor.style.height = `${Math.abs(py2 - py1)}px`
        if (link.url) anchor.title = link.url
        anchor.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (link.url) onExternalLink(link.url)
          else if (link.dest) onInternalLink(link.dest)
        })
        frag.append(anchor)
      }
      linkHost.replaceChildren(frag)
    })().catch((err: unknown) => {
      const name = err instanceof Error ? err.name : ''
      if (!cancelled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
        console.error(`pdfx: klarte ikke å tegne side ${pageNumber}`, err)
      }
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [pdf, pageNumber, scale, active, onInternalLink, onExternalLink])

  // ---------- Freehand drawing (pen/marker/eraser) ----------

  const pagePointOf = (clientX: number, clientY: number, el: HTMLElement): [number, number] => {
    const rect = el.getBoundingClientRect()
    return [(clientX - rect.left) / scale, (clientY - rect.top) / scale]
  }

  const renderShapePreview = (
    group: SVGGElement,
    type: ShapeToolType,
    a: [number, number],
    b: [number, number],
    color: string,
    width: number
  ): void => {
    group.replaceChildren()
    const x = Math.min(a[0], b[0])
    const y = Math.min(a[1], b[1])
    const w = Math.abs(b[0] - a[0])
    const h = Math.abs(b[1] - a[1])
    if (type === 'square') {
      const el = document.createElementNS(SVG_NS, 'rect')
      el.setAttribute('x', String(x))
      el.setAttribute('y', String(y))
      el.setAttribute('width', String(w))
      el.setAttribute('height', String(h))
      group.append(el)
    } else if (type === 'circle') {
      const el = document.createElementNS(SVG_NS, 'ellipse')
      el.setAttribute('cx', String(x + w / 2))
      el.setAttribute('cy', String(y + h / 2))
      el.setAttribute('rx', String(w / 2))
      el.setAttribute('ry', String(h / 2))
      group.append(el)
    } else {
      const el = document.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', String(a[0]))
      el.setAttribute('y1', String(a[1]))
      el.setAttribute('x2', String(b[0]))
      el.setAttribute('y2', String(b[1]))
      group.append(el)
      if (type === 'arrow') {
        const head = document.createElementNS(SVG_NS, 'polygon')
        head.setAttribute('points', arrowHeadPoints(a, b, Math.max(6, width * 3.2)))
        head.setAttribute('fill', color)
        head.setAttribute('stroke', 'none')
        group.append(head)
      }
    }
    for (const child of group.children) {
      if (child.tagName !== 'polygon') {
        child.setAttribute('fill', 'none')
        child.setAttribute('stroke', color)
        child.setAttribute('stroke-width', String(width))
      }
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawTool || e.button !== 0) return
    e.preventDefault()
    const [x, y] = pagePointOf(e.clientX, e.clientY, e.currentTarget)
    if (drawTool.type === 'eraser') {
      onErase(pageNumber, x, y)
      return
    }
    if (drawTool.type === 'text') {
      onPlaceText(pageNumber, x, y, e.clientX, e.clientY)
      return
    }
    const svg = drawSvgRef.current
    if (!svg) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic or already-released pointers can't be captured — drawing still works */
    }
    if (SHAPE_TYPES.has(drawTool.type)) {
      const group = document.createElementNS(SVG_NS, 'g')
      group.setAttribute('opacity', String(drawTool.opacity))
      svg.append(group)
      shapeRef.current = {
        pointerId: e.pointerId,
        type: drawTool.type as ShapeToolType,
        start: [x, y],
        end: [x, y],
        group
      }
      return
    }
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', rgbCss(drawTool.color, 1))
    path.setAttribute('stroke-width', String(drawTool.width))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('opacity', String(drawTool.opacity))
    path.setAttribute('d', strokePathData([[x, y]]))
    svg.append(path)
    strokeRef.current = { pointerId: e.pointerId, points: [[x, y]], path }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawTool) return
    if (drawTool.type === 'eraser') {
      if (e.buttons === 1) {
        const [x, y] = pagePointOf(e.clientX, e.clientY, e.currentTarget)
        onErase(pageNumber, x, y)
      }
      return
    }
    const shape = shapeRef.current
    if (shape && shape.pointerId === e.pointerId) {
      shape.end = pagePointOf(e.clientX, e.clientY, e.currentTarget)
      renderShapePreview(
        shape.group,
        shape.type,
        shape.start,
        shape.end,
        rgbCss(drawTool.color, 1),
        drawTool.width
      )
      return
    }
    const stroke = strokeRef.current
    if (!stroke || stroke.pointerId !== e.pointerId) return
    const native = e.nativeEvent
    const events =
      'getCoalescedEvents' in native && native.getCoalescedEvents().length > 0
        ? native.getCoalescedEvents()
        : [native]
    const el = e.currentTarget
    for (const ev of events) {
      const [x, y] = pagePointOf(ev.clientX, ev.clientY, el)
      const last = stroke.points[stroke.points.length - 1]
      if (Math.hypot(x - last[0], y - last[1]) < 0.4) continue
      stroke.points.push([x, y])
    }
    stroke.path.setAttribute('d', strokePathData(stroke.points))
  }

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    const shape = shapeRef.current
    if (shape && shape.pointerId === e.pointerId) {
      shapeRef.current = null
      shape.group.remove()
      const dx = Math.abs(shape.end[0] - shape.start[0])
      const dy = Math.abs(shape.end[1] - shape.start[1])
      if (dx > 2 || dy > 2) onShapeComplete(pageNumber, shape.type, shape.start, shape.end)
      return
    }
    const stroke = strokeRef.current
    if (!stroke || stroke.pointerId !== e.pointerId) return
    strokeRef.current = null
    stroke.path.remove()
    if (stroke.points.length > 1) onStrokeComplete(pageNumber, stroke.points)
  }

  const style = {
    top,
    left,
    width: cssWidth,
    height: cssHeight,
    '--scale-factor': String(scale)
  } as React.CSSProperties

  return (
    <div className="pdf-page" data-page={pageNumber} style={style}>
      <div className="canvas-host" ref={hostRef} />
      {annotations.some((a) => a.source === 'session') && (
        <div className="annot-overlay">
          {annotations
            .filter((a) => a.source === 'session')
            .map((a) => (
              <AnnotationMarks
                key={a.id}
                annotation={a}
                scale={scale}
                pageWidth={cssWidth / scale}
                pageHeight={cssHeight / scale}
              />
            ))}
        </div>
      )}
      {searchRects.length > 0 && (
        <div className="annot-overlay">
          {searchRects.map((r, i) => (
            <div
              key={i}
              className="search-hit"
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
            />
          ))}
        </div>
      )}
      <div className="text-host" ref={textRef} />
      <div className="link-host" ref={linkRef} />
      {drawTool && (
        <div
          className={`draw-layer${drawTool.type === 'eraser' ? ' erasing' : ''}${drawTool.type === 'text' ? ' text-mode' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <svg
            ref={drawSvgRef}
            viewBox={`0 0 ${cssWidth / scale} ${cssHeight / scale}`}
            preserveAspectRatio="none"
          />
        </div>
      )}
    </div>
  )
}

function AnnotationMarks({
  annotation,
  scale,
  pageWidth,
  pageHeight
}: {
  annotation: PageAnnotation
  scale: number
  pageWidth: number
  pageHeight: number
}): React.JSX.Element {
  if (annotation.type === 'ink' && annotation.strokes) {
    return (
      <svg
        className="annot-ink-svg"
        viewBox={`0 0 ${pageWidth} ${pageHeight}`}
        preserveAspectRatio="none"
      >
        {annotation.strokes.map((stroke, i) => (
          <path
            key={i}
            d={strokePathData(stroke)}
            fill="none"
            stroke={rgbCss(annotation.color, 1)}
            strokeWidth={annotation.width ?? 2}
            opacity={annotation.opacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    )
  }
  if (SHAPE_TYPES.has(annotation.type)) {
    const q = annotation.quads[0]
    const color = rgbCss(annotation.color, 1)
    const width = annotation.width ?? 2
    const [a, b] = annotation.strokes?.[0] ?? []
    return (
      <svg
        className="annot-ink-svg"
        viewBox={`0 0 ${pageWidth} ${pageHeight}`}
        preserveAspectRatio="none"
        opacity={annotation.opacity}
      >
        {annotation.type === 'square' && (
          <rect x={q.x} y={q.y} width={q.w} height={q.h} fill="none" stroke={color} strokeWidth={width} />
        )}
        {annotation.type === 'circle' && (
          <ellipse
            cx={q.x + q.w / 2}
            cy={q.y + q.h / 2}
            rx={q.w / 2}
            ry={q.h / 2}
            fill="none"
            stroke={color}
            strokeWidth={width}
          />
        )}
        {(annotation.type === 'line' || annotation.type === 'arrow') && a && b && (
          <>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={width} />
            {annotation.type === 'arrow' && (
              <polygon points={arrowHeadPoints(a, b, Math.max(6, width * 3.2))} fill={color} />
            )}
          </>
        )}
      </svg>
    )
  }
  if (annotation.type === 'freetext') {
    const css = annotationCss(annotation, annotation.quads[0], scale, pageHeight)
    return (
      <div
        className="annot annot-freetext"
        style={{ ...css, fontSize: (annotation.fontSize ?? 12) * scale }}
      >
        {annotation.contents}
      </div>
    )
  }
  return (
    <>
      {annotation.quads.map((q, i) => {
        const css = annotationCss(annotation, q, scale, pageHeight)
        return <div key={i} className={`annot annot-${annotation.type}`} style={css} />
      })}
    </>
  )
}

export default memo(PdfPage)

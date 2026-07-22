import { memo, useEffect, useRef } from 'react'
import { AnnotationMode, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PageRect, ViewRotation } from '../../../shared/types'
import type { DrawTool, PageAnnotation, ShapeToolType } from '../annotations'
import { annotationCss, arrowHeadPoints, arrowShaftEnd, rgbCss, squigglyPathData, strokePathData } from '../annotations'
import { pagePointToView, pageRectToView, svgRotationTransform, viewSize } from '../rotation'
import { beginRender, chooseRenderDpr, endRender } from '../render-quality'
import { PDFIUM_RENDER, renderPdfiumPage } from '../pdfium-renderer'

const SHAPE_TYPES = new Set(['square', 'circle', 'line', 'arrow'])
const SVG_NS = 'http://www.w3.org/2000/svg'

// Canvas bitmaps render at full device-pixel density for crispness on high-DPI
// screens. These ceilings keep a bitmap under Chromium's limits so a large page
// at high zoom never silently produces a blank canvas: ~16k px on any side and
// ~2^28 px total area (both GPU-safe across Chromium/Edge).
const MAX_CANVAS_DIM = 16384
const MAX_CANVAS_AREA = 16384 * 16384

// Zoom-OUT reuses the displayed bitmap while it's ≤ this factor denser than
// the target (CSS downscale is sharp, so the step costs zero rasters). Beyond
// it, re-raster immediately — zoomed far out, holding full-zoom bitmaps on
// every mounted page would waste real memory. Zoom-IN always re-rasters at
// exactly the new scale right away: speculative/headroom bitmaps were tried
// (2026-07-20) and reverted — pinch commits arbitrary ratios that miss any
// pre-rendered band, and the extra raster rounds made the gesture janky.
const MAX_OVERSAMPLE = 2
// Once a zoom-out pause lasts this long, re-raster at exactly the current
// scale. Text sharpness is king: the downscaled bitmap is a mid-gesture
// convenience, never the resting state.
const SETTLE_MS = 300

interface Props {
  pdf: PDFDocumentProxy
  /** Document path — key into the PDFium raster registry (spike flag only) */
  docKey: string
  pageNumber: number
  top: number
  left: number
  cssWidth: number
  cssHeight: number
  scale: number
  /** User view rotation (clockwise degrees), added on top of intrinsic /Rotate */
  rotation: ViewRotation
  /** Page-space dimensions (points), before the view rotation is applied */
  pageW: number
  pageH: number
  /** Only pages near the viewport actually render their canvas */
  active: boolean
  /** Annotations created this session, drawn by the overlay (PDF page space) */
  annotations: PageAnnotation[]
  /** Hide all annotations: skips the overlay and re-renders the canvas
   *  without the file's annotation appearances */
  hideAnnots: boolean
  /** Local id of the selected annotation on THIS page, or null — passed per
   *  page (not the whole `selected` object) so unrelated pages don't re-render */
  selectedId: string | null
  /** Rects of the active search match on this page (page space) */
  searchRects: PageRect[]
  /** True when searchRects are a citation-jump flash (holds, then fades out)
   *  rather than a persistent search hit */
  searchFlash?: boolean
  /** Nonce that changes each citation jump; folded into the flash rects' key so
   *  they remount and replay the fade animation on repeat / same-page clicks */
  searchFlashId?: number
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
  docKey,
  pageNumber,
  top,
  left,
  cssWidth,
  cssHeight,
  scale,
  rotation,
  pageW,
  pageH,
  active,
  annotations,
  hideAnnots,
  selectedId,
  searchRects,
  searchFlash,
  searchFlashId,
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
  // The built text layer + its page, kept so a zoom can call the cheap
  // TextLayer.update() instead of rebuilding. scaleRef/rotationRef let the
  // text-layer effect read the live scale/rotation without taking `scale` as a
  // dependency (which would defeat the whole point — a full rebuild per zoom).
  const textLayerRef = useRef<InstanceType<typeof TextLayer> | null>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const rotationRef = useRef(rotation)
  rotationRef.current = rotation
  // What the displayed bitmap was rastered as. Lets a zoom step reuse a
  // still-dense-enough bitmap (CSS downscale is sharp) instead of re-rastering,
  // and marks zoom re-rasters (same rotation/annots context) for headroom.
  const rasterInfoRef = useRef<{
    scale: number
    dpr: number
    rotation: ViewRotation
    hideAnnots: boolean
  } | null>(null)
  // Guards rasterInfo against a swapped document object (same component
  // instance, new pdf) — density bookkeeping must never outlive its document.
  const pdfIdentityRef = useRef<PDFDocumentProxy | null>(null)
  const strokeRef = useRef<{
    pointerId: number
    points: [number, number][]
    path: SVGPathElement
    /** Snapped to a straight line (hold still while drawing, or Shift) */
    straight: boolean
    holdTimer: number
  } | null>(null)

  /** Redraw the active stroke as a straight start→current line */
  const snapStrokeStraight = (stroke: NonNullable<typeof strokeRef.current>): void => {
    stroke.straight = true
    const first = stroke.points[0]
    const last = stroke.points[stroke.points.length - 1]
    stroke.path.setAttribute('d', strokePathData([first, last]))
  }

  /** Holding the pen still mid-stroke straightens it (Apple Pencil-style) */
  const armStrokeHold = (stroke: NonNullable<typeof strokeRef.current>): void => {
    window.clearTimeout(stroke.holdTimer)
    stroke.holdTimer = window.setTimeout(() => {
      const active = strokeRef.current
      if (active !== stroke || active.straight) return
      const first = active.points[0]
      const last = active.points[active.points.length - 1]
      if (Math.hypot(last[0] - first[0], last[1] - first[1]) > 12) snapStrokeStraight(active)
    }, 600)
  }
  const shapeRef = useRef<{
    pointerId: number
    type: ShapeToolType
    start: [number, number]
    end: [number, number]
    group: SVGGElement
  } | null>(null)

  // ---- Canvas raster ----
  // Re-runs on zoom because a crisp bitmap must be rasterised at the new scale.
  // Deliberately separate from the text/link layers below: a zoom re-rasters
  // only this canvas and must NOT rebuild the text layer (streamTextContent +
  // a DOM node per span) or re-fetch link annotations — those are scale-free.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (pdfIdentityRef.current !== pdf) {
      pdfIdentityRef.current = pdf
      rasterInfoRef.current = null
    }
    if (!active) {
      host.replaceChildren() // free the bitmap when far outside the viewport
      rasterInfoRef.current = null
      return
    }

    let cancelled = false
    let renderTask: Cancellable | null = null
    let settleTimer = 0

    const onRasterError = (err: unknown): void => {
      const name = err instanceof Error ? err.name : ''
      if (!cancelled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
        console.error(`pdfx: klarte ikke å tegne side ${pageNumber}`, err)
      }
    }

    /** Rasterise this page into a DETACHED canvas at the given device-pixel
     *  scale. Returns null when cancelled or the engine produced nothing. */
    const renderBitmap = async (
      page: PDFPageProxy,
      viewport: ReturnType<PDFPageProxy['getViewport']>,
      dpr: number
    ): Promise<HTMLCanvasElement | null> => {
      // Render off-DOM so the previous bitmap stays visible until the caller
      // blits (show) or parks (speculative) the finished one — no flash.
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      // Time the raster so the controller learns this machine's throughput.
      // Only feed back clean, completed samples (pixels = 0 skips the sample).
      beginRender()
      const startedAt = performance.now()
      let rasterOk = false
      try {
        if (PDFIUM_RENDER) {
          // Spike path: PDFium (EmbedPDF worker) supplies the bitmap; pdf.js
          // keeps every other job (text layer, links, search, metadata).
          const handle = renderPdfiumPage(docKey, pageNumber - 1, {
            scale,
            dpr,
            rotation,
            withAnnotations: !hideAnnots
          })
          renderTask = handle
          const img = await handle.promise
          if (img) {
            // Adopt PDFium's own rounding — the CSS box stretches the bitmap,
            // so a ±1px difference from the pdf.js-derived size is invisible.
            canvas.width = img.width
            canvas.height = img.height
            canvas.getContext('2d')?.putImageData(img, 0, 0)
            rasterOk = true
          }
        } else {
          const task = page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
            annotationMode: hideAnnots ? AnnotationMode.DISABLE : AnnotationMode.ENABLE
          })
          renderTask = task
          await task.promise
          rasterOk = true
        }
      } finally {
        endRender(
          rasterOk && !cancelled ? canvas.width * canvas.height : 0,
          performance.now() - startedAt
        )
      }
      if (cancelled || !rasterOk) return null
      if (import.meta.env.DEV) {
        // Spike telemetry: per-raster samples for the engine comparison,
        // readable from the console as window.__rasterLog.
        const w = window as unknown as { __rasterLog?: unknown[] }
        ;(w.__rasterLog ??= []).push({
          engine: PDFIUM_RENDER ? 'pdfium' : 'pdfjs',
          page: pageNumber,
          ms: Math.round(performance.now() - startedAt),
          px: canvas.width * canvas.height
        })
      }
      return canvas
    }

    /** Blit a finished bitmap into the displayed canvas and book its density.
     *  Keep the DISPLAYED canvas element stable across re-rasters (zoom,
     *  hide-annots): swapping the node tears down and rebuilds the composited
     *  layer (.page-raster is an isolated blend/filter group), which can
     *  flash for a frame. Resize + drawImage run in one synchronous task, so
     *  the compositor never sees an intermediate state. First render (or
     *  reactivation after scroll-out) has no canvas yet — append then. */
    const show = (canvas: HTMLCanvasElement, dpr: number): void => {
      const shown = host.firstElementChild
      if (shown instanceof HTMLCanvasElement) {
        shown.width = canvas.width
        shown.height = canvas.height
        shown.getContext('2d')?.drawImage(canvas, 0, 0)
      } else {
        host.replaceChildren(canvas)
      }
      rasterInfoRef.current = { scale, dpr, rotation, hideAnnots }
    }

    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      // Add the user rotation to the page's intrinsic /Rotate (don't replace
      // it) — pdf.js swaps the viewport's width/height for 90°/270° so the
      // canvas, text layer and link layer all come out rotated together.
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })

      // Target the screen's full pixel density for maximum sharpness, but let
      // the adaptive controller trade it back toward native when the machine is
      // struggling to keep raster times within budget. Then clamp so a large
      // page at high zoom can't exceed Chromium's per-side / total-area canvas
      // limits (which would render blank).
      const cssPixels = viewport.width * viewport.height
      const clampDpr = (d: number): number =>
        Math.max(
          0.1,
          Math.min(
            d,
            MAX_CANVAS_DIM / viewport.width,
            MAX_CANVAS_DIM / viewport.height,
            Math.sqrt(MAX_CANVAS_AREA / cssPixels)
          )
        )
      const baseDpr = clampDpr(chooseRenderDpr(cssPixels, window.devicePixelRatio || 1))

      // Text sharpness is king: a downscaled bitmap is never quite
      // native-crisp, so the zoom-out reuse below is a TRANSIENT state for
      // mid-gesture smoothness only. The settle timer guarantees that once the
      // user pauses, the page re-rasters at exactly the current scale — the
      // resting state is always a grid-aligned native raster.
      const settleToExact = (): void => {
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => {
          void (async () => {
            const bitmap = await renderBitmap(page, viewport, baseDpr)
            if (bitmap && !cancelled) show(bitmap, baseDpr)
          })().catch(onRasterError)
        }, SETTLE_MS)
      }

      // Zoom-out fast path: if the displayed bitmap (same rotation/annots
      // context) is at least as dense as this scale needs, show it downscaled
      // NOW (sharp, instant, zero rasters mid-gesture) and settle to exact
      // after the pause. Past MAX_OVERSAMPLE we re-raster immediately instead —
      // dragging a huge bitmap through more zoom-outs wastes memory and GPU.
      // Zoom-in falls through to an immediate exact raster: the fresh bitmap
      // blits in as soon as it's ready (the old one stays visible meanwhile).
      const prev = rasterInfoRef.current
      const isZoomStep =
        prev !== null &&
        host.firstElementChild instanceof HTMLCanvasElement &&
        prev.rotation === rotation &&
        prev.hideAnnots === hideAnnots
      if (isZoomStep) {
        const have = prev.scale * prev.dpr
        const need = scale * baseDpr
        if (have >= need && have <= need * MAX_OVERSAMPLE) {
          if (have > need * (1 + 1e-6)) settleToExact()
          return
        }
      }
      const bitmap = await renderBitmap(page, viewport, baseDpr)
      if (bitmap && !cancelled) show(bitmap, baseDpr)
    })().catch(onRasterError)

    return () => {
      cancelled = true
      window.clearTimeout(settleTimer)
      renderTask?.cancel()
    }
  }, [pdf, docKey, pageNumber, scale, rotation, active, hideAnnots])

  // ---- Text layer + clickable links ----
  // Built ONCE per page/rotation, NOT per zoom. pdf.js v6 lays spans out in
  // page-relative units (% offsets + the --scale-factor CSS var for font size),
  // and links are positioned as % of the page box, so a zoom reflows both via
  // CSS. The scale effect below only calls the cheap TextLayer.update() to
  // refine per-glyph fitting — never this rebuild. `scale` is intentionally NOT
  // a dependency (read via scaleRef for the initial build only).
  useEffect(() => {
    const textHost = textRef.current
    const linkHost = linkRef.current
    if (!textHost || !linkHost) return
    if (!active) {
      textHost.replaceChildren()
      linkHost.replaceChildren()
      textLayerRef.current = null
      pageRef.current = null
      return
    }

    let cancelled = false
    let textLayer: Cancellable | null = null

    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      pageRef.current = page
      // Build at the live scale so first paint's glyph fit is already correct;
      // subsequent zooms refine via TextLayer.update() (the scale effect below).
      const viewport = page.getViewport({
        scale: scaleRef.current,
        rotation: (page.rotate + rotation) % 360
      })

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
      textLayerRef.current = tl
      // Whitespace-only items (LaTeX PDFs often park them in the margins,
      // one per line) must not paint their own selection box — they stay
      // in the DOM so copied text keeps its spaces, but render no highlight.
      // trim() misses zero-width/invisible characters (U+200B, soft
      // hyphens, BOM…) that HTML-to-PDF generators love to emit
      for (const span of textDiv.querySelectorAll('span')) {
        const visible = (span.textContent ?? '').replace(/[\s\u00AD\u200B-\u200F\u2060\uFEFF]/gu, '')
        if (!visible) span.classList.add('ws-only')
      }
      const endOfContent = document.createElement('div')
      endOfContent.className = 'endOfContent'
      textDiv.append(endOfContent)
      // pdf.js's selection trick: while the mouse is down, .endOfContent
      // expands to cover the page (CSS .selecting) so a drag that starts
      // in the empty space between lines anchors there instead of
      // selecting the entire page
      textDiv.addEventListener('mousedown', () => {
        textDiv.classList.add('selecting')
        window.addEventListener('mouseup', () => textDiv.classList.remove('selecting'), {
          once: true
        })
      })
      textHost.replaceChildren(textDiv)

      // Clickable link annotations (internal destinations + external URLs).
      // Positioned as % of the page box so they reflow on zoom (no baked scale).
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
        anchor.style.left = `${(100 * Math.min(px1, px2)) / viewport.width}%`
        anchor.style.top = `${(100 * Math.min(py1, py2)) / viewport.height}%`
        anchor.style.width = `${(100 * Math.abs(px2 - px1)) / viewport.width}%`
        anchor.style.height = `${(100 * Math.abs(py2 - py1)) / viewport.height}%`
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
        console.error(`pdfx: klarte ikke å bygge tekstlaget for side ${pageNumber}`, err)
      }
    })

    return () => {
      cancelled = true
      textLayer?.cancel()
    }
  }, [pdf, pageNumber, rotation, active, onInternalLink, onExternalLink])

  // ---- Zoom refinement for the text layer ----
  // The spans' horizontal glyph fit (--scale-x) is measured at build scale; on
  // zoom pdf.js re-lays-out the EXISTING spans in place (no DOM rebuild, no text
  // re-stream), keeping text crisp. rotation is read via ref because a rotation
  // change already triggers a full rebuild in the effect above.
  useEffect(() => {
    const tl = textLayerRef.current
    const page = pageRef.current
    if (!tl || !page) return
    const viewport = page.getViewport({ scale, rotation: (page.rotate + rotationRef.current) % 360 })
    tl.update({ viewport })
  }, [scale])

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
      const headSize = Math.max(11, width * 4.5)
      const shaftEnd = type === 'arrow' ? arrowShaftEnd(a, b, headSize) : b
      const el = document.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', String(a[0]))
      el.setAttribute('y1', String(a[1]))
      el.setAttribute('x2', String(shaftEnd[0]))
      el.setAttribute('y2', String(shaftEnd[1]))
      group.append(el)
      if (type === 'arrow') {
        const head = document.createElementNS(SVG_NS, 'polygon')
        head.setAttribute('points', arrowHeadPoints(a, b, headSize))
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
    strokeRef.current = { pointerId: e.pointerId, points: [[x, y]], path, straight: false, holdTimer: 0 }
    armStrokeHold(strokeRef.current)
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
    let moved = false
    for (const ev of events) {
      const [x, y] = pagePointOf(ev.clientX, ev.clientY, el)
      const last = stroke.points[stroke.points.length - 1]
      if (Math.hypot(x - last[0], y - last[1]) < 0.4) continue
      stroke.points.push([x, y])
      moved = true
    }
    if (e.shiftKey && !stroke.straight) snapStrokeStraight(stroke)
    if (stroke.straight) {
      const first = stroke.points[0]
      const last = stroke.points[stroke.points.length - 1]
      stroke.path.setAttribute('d', strokePathData([first, last]))
      return
    }
    if (moved) armStrokeHold(stroke)
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
    window.clearTimeout(stroke.holdTimer)
    stroke.path.remove()
    if (stroke.points.length > 1) {
      const points = stroke.straight
        ? [stroke.points[0], stroke.points[stroke.points.length - 1]]
        : stroke.points
      onStrokeComplete(pageNumber, points)
    }
  }

  const style = {
    top,
    left,
    width: cssWidth,
    height: cssHeight,
    '--scale-factor': String(scale)
  } as React.CSSProperties

  const selectedAnnot = selectedId ? annotations.find((a) => a.id === selectedId) ?? null : null

  // Text highlights AND marker strokes blend (multiply — pixel-parity with the
  // saved appearance stream, see annotationCss/buildAnnotation) against the
  // raw page inside .page-raster, BEFORE the theme recolouring, so the tint
  // stays contained and text under them stays black. Pen/shape/note marks keep
  // their own recoloured layer on top so they also work as opaque strokes.
  const sessionAnnots = !hideAnnots ? annotations.filter((a) => a.source === 'session') : []
  const highlightMarks = sessionAnnots.filter(
    (a) => a.type === 'highlight' || a.blend === 'multiply'
  )
  const otherMarks = sessionAnnots.filter(
    (a) => a.type !== 'highlight' && a.blend !== 'multiply'
  )

  return (
    <div className="pdf-page" data-page={pageNumber} style={style}>
      <div className="page-raster">
        <div className="canvas-host" ref={hostRef} />
        {highlightMarks.length > 0 && (
          <div className="annot-overlay annot-highlights">
            {highlightMarks.map((a) => (
              <AnnotationMarks
                key={a.id}
                annotation={a}
                scale={scale}
                pageW={pageW}
                pageH={pageH}
                rotation={rotation}
              />
            ))}
          </div>
        )}
      </div>
      {otherMarks.length > 0 && (
        <div className="annot-overlay annot-marks">
          {otherMarks.map((a) => (
            <AnnotationMarks
              key={a.id}
              annotation={a}
              scale={scale}
              pageW={pageW}
              pageH={pageH}
              rotation={rotation}
            />
          ))}
        </div>
      )}
      {/* Search hits arrive already in VIEW space (resolved from the rotated
          text layer's client rects), so they paint directly — no rotation */}
      {searchRects.length > 0 && (
        <div className="annot-overlay">
          {searchRects.map((r, i) => (
            <div
              key={searchFlash ? `${searchFlashId}-${i}` : i}
              className={`search-hit${searchFlash ? ' cite-flash' : ''}`}
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
            />
          ))}
        </div>
      )}
      {!hideAnnots && selectedAnnot && (
        <div className="annot-overlay">
          <SelectionFrame record={selectedAnnot} scale={scale} pageW={pageW} pageH={pageH} rotation={rotation} />
        </div>
      )}
      <div className="text-host" ref={textRef} />
      <div className="link-host" ref={linkRef} />
      {/* Draw tools are disabled under rotation (their pointer/preview machinery
          assumes an un-rotated page); PdfViewer also blocks selecting one */}
      {drawTool && rotation === 0 && (
        <div
          className={`draw-layer${drawTool.type === 'eraser' ? ' erasing' : ''}${drawTool.type === 'text' ? ' text-mode' : ''}${drawTool.type === 'pen' ? ' pen-mode' : ''}${drawTool.type === 'marker' ? ' marker-mode' : ''}`}
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

/** Accent selection frame over the union bbox of all quads. PAD is in page-space
 *  points so the frame hugs the annotation at any zoom. Lives inside a
 *  pointer-events:none .annot-overlay host — never make this interactive. */
function SelectionFrame({
  record,
  scale,
  pageW,
  pageH,
  rotation
}: {
  record: PageAnnotation
  scale: number
  pageW: number
  pageH: number
  rotation: ViewRotation
}): React.JSX.Element {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of record.quads) {
    minX = Math.min(minX, q.x)
    minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x + q.w)
    maxY = Math.max(maxY, q.y + q.h)
  }
  const PAD = 4
  const v = pageRectToView(
    { x: minX - PAD, y: minY - PAD, w: maxX - minX + 2 * PAD, h: maxY - minY + 2 * PAD },
    pageW,
    pageH,
    rotation
  )
  return (
    <div
      className="annot-selection"
      style={{
        left: v.x * scale,
        top: v.y * scale,
        width: v.w * scale,
        height: v.h * scale
      }}
    >
      <i className="tl" />
      <i className="tr" />
      <i className="bl" />
      <i className="br" />
    </div>
  )
}

function AnnotationMarks({
  annotation,
  scale,
  pageW,
  pageH,
  rotation
}: {
  annotation: PageAnnotation
  scale: number
  pageW: number
  pageH: number
  rotation: ViewRotation
}): React.JSX.Element {
  // Ink/shape SVGs keep their page-space geometry and rotate it with a single
  // group transform into a view-sized viewBox (no per-point maths).
  const view = viewSize(pageW, pageH, rotation)
  const gTransform = svgRotationTransform(pageW, pageH, rotation)
  if (annotation.type === 'ink' && annotation.strokes) {
    return (
      <svg
        className="annot-ink-svg"
        viewBox={`0 0 ${view.w} ${view.h}`}
        preserveAspectRatio="none"
        // Marker strokes multiply against the page (inside .page-raster's
        // isolated group — see .annot-highlights) so text stays legible; the
        // blend must sit on the svg ELEMENT: an svg's children only ever blend
        // against the svg's own canvas, never the HTML behind it.
        style={annotation.blend === 'multiply' ? { mixBlendMode: 'multiply' } : undefined}
      >
        <g transform={gTransform}>
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
        </g>
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
        viewBox={`0 0 ${view.w} ${view.h}`}
        preserveAspectRatio="none"
        opacity={annotation.opacity}
      >
        <g transform={gTransform}>
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
          {(annotation.type === 'line' || annotation.type === 'arrow') &&
            a &&
            b &&
            (() => {
              const headSize = Math.max(11, width * 4.5)
              const end = annotation.type === 'arrow' ? arrowShaftEnd(a, b, headSize) : b
              return (
                <>
                  <line x1={a[0]} y1={a[1]} x2={end[0]} y2={end[1]} stroke={color} strokeWidth={width} />
                  {annotation.type === 'arrow' && (
                    <polygon points={arrowHeadPoints(a, b, headSize)} fill={color} />
                  )}
                </>
              )
            })()}
        </g>
      </svg>
    )
  }
  if (annotation.type === 'freetext') {
    const css = annotationCss(annotation, annotation.quads[0], scale, { w: pageW, h: pageH }, rotation)
    return (
      <div
        className="annot annot-freetext"
        style={{ ...css, fontSize: (annotation.fontSize ?? 12) * scale }}
      >
        {annotation.contents}
      </div>
    )
  }
  if (annotation.type === 'note') {
    // Modern comment marker (speech bubble); stays upright, only its anchor
    // point rotates
    const q = annotation.quads[0]
    const [vx, vy] = pagePointToView(q.x, q.y, pageW, pageH, rotation)
    return (
      <svg
        className="annot annot-note-mark"
        style={{ left: vx * scale, top: vy * scale }}
        width={q.w * scale}
        height={q.h * scale}
        viewBox="0 0 24 24"
      >
        <path
          d="M3.5 7a3 3 0 0 1 3 -3h11a3 3 0 0 1 3 3v7a3 3 0 0 1 -3 3H10.5l-4 3.5V17H6.5a3 3 0 0 1 -3 -3z"
          fill={rgbCss(annotation.color, 1)}
          stroke="rgba(0,0,0,0.22)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <g stroke="rgba(0,0,0,0.38)" strokeWidth="1.5" strokeLinecap="round">
          <path d="M7.5 8.7h9" />
          <path d="M7.5 12.2h6" />
        </g>
      </svg>
    )
  }
  if (annotation.type === 'squiggly') {
    // A real zig-zag wave (parity with the saved appearance stream), rotated
    // with the same group transform as ink — NOT a CSS repeating-gradient,
    // which degrades to a dashed line.
    return (
      <svg className="annot-ink-svg" viewBox={`0 0 ${view.w} ${view.h}`} preserveAspectRatio="none">
        <g transform={gTransform}>
          {annotation.quads.map((q, i) => (
            <path
              key={i}
              d={squigglyPathData(q)}
              fill="none"
              stroke={rgbCss(annotation.color, 0.9)}
              strokeWidth={1.1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      </svg>
    )
  }
  return (
    <>
      {annotation.quads.map((q, i) => {
        const css = annotationCss(annotation, q, scale, { w: pageW, h: pageH }, rotation)
        return <div key={i} className={`annot annot-${annotation.type}`} style={css} />
      })}
    </>
  )
}

export default memo(PdfPage)

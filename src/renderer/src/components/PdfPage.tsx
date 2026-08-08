import { memo, useEffect, useRef } from 'react'
import { AnnotationMode, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PageRect, ViewRotation } from '../../../shared/types'
import type { DrawTool, PageAnnotation, ResizeHandle, ShapeToolType } from '../annotations'
import { annotationCss, arrowHeadPoints, arrowShaftEnd, isTextMarkup, quadsUnion, resizeKindOf, rgbCss, squigglyPathData, strokePathData } from '../annotations'
import { pagePointToView, pageRectToView, svgRotationTransform, viewSize } from '../rotation'
import { beginRender, chooseRenderDpr, endRender } from '../render-quality'
import { PDFIUM_RENDER, renderPdfiumPage } from '../pdfium-renderer'
import { t } from '../i18n'
import { penNear } from '../pen-input'
import {
  outlineSvgPath,
  PRESSURE_EMA_ALPHA,
  PRESSURE_NEUTRAL,
  pressureHalfWidths,
  strokeOutline
} from '../../../shared/ink-outline'
import MarginNotes from './MarginNotes'
import type { MarginViewConfig } from './MarginNotes'

/** Tooltip for an in-document link — names the Ctrl/Cmd shortcut, which is the
 *  only place that gesture is advertised. */
const linkTitle = (): string => t('viewer.linkTip')

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
  /** Rects of EVERY match on this page while the find bar is open (page space).
   *  Separate from searchRects because the two are drawn differently and have
   *  different owners: the active hit is also how read-aloud and citation jumps
   *  paint, and highlight-all must not disturb that channel. */
  searchAllRects: PageRect[]
  /** True when searchRects are a citation-jump flash (holds, then fades out)
   *  rather than a persistent search hit */
  searchFlash?: boolean | undefined
  /** Nonce that changes each citation jump; folded into the flash rects' key so
   *  they remount and replay the fade animation on repeat / same-page clicks.
   *
   *  `| undefined` because both callers pass it unconditionally from state that
   *  is undefined when no citation jump is active — a JSX attribute is always
   *  present, so under exactOptionalPropertyTypes optional props that are
   *  forwarded rather than conditionally spread have to say so. */
  searchFlashId?: number | undefined
  /** Active freehand tool (pen/marker/eraser), or null when not drawing */
  drawTool: DrawTool | null
  /** Whether a finger may draw when a tool is armed. Off, a touch is left to
   *  the layer's touch-action (native pan/zoom) — only the pen draws. */
  fingerDraws: boolean
  /** Pen tool + real pen: stylus pressure varies the stroke width */
  penPressure: boolean
  /** Stable callbacks (identity must not change with viewer state) */
  /** In-document destination. `toOtherPane` is true when the reader held
   *  Ctrl/Cmd, i.e. "show this over there" — the viewer decides what that means
   *  (and opens the split if it is not open yet). */
  onInternalLink(dest: unknown, toOtherPane: boolean): void
  onExternalLink(url: string): void
  /** pressures: EMA-smoothed pen pressures parallel to points — present only
   *  for a pressure-sensitive pen stroke */
  onStrokeComplete(pageNumber: number, points: [number, number][], pressures?: number[]): void
  onErase(pageNumber: number, x: number, y: number): void
  onShapeComplete(
    pageNumber: number,
    type: ShapeToolType,
    a: [number, number],
    b: [number, number]
  ): void
  onPlaceText(pageNumber: number, x: number, y: number, clientX: number, clientY: number): void
  /** A resize handle on the selected annotation was grabbed. The viewer owns the
   *  drag from here (pointermove/up on the window), exactly as it owns a move. */
  onResizeStart(pageNumber: number, record: PageAnnotation, handle: ResizeHandle, e: React.PointerEvent): void
  /** An end of a text markup was grabbed — the mark is about to cover more or
   *  less text. Also viewer-owned. */
  onMarkupEndStart(
    pageNumber: number,
    record: PageAnnotation,
    end: 'start' | 'end',
    e: React.PointerEvent
  ): void
  /** While an end is being dragged, the rects the release would commit (page
   *  space) — painted in the mark's own colour instead of the mark itself. */
  markupPreview: PageRect[]
  /** Margin view: notes + annotation comments as visible cards beside the
   *  page; null when the view is off. Memoised by the viewer — this component
   *  is memo()d on shallow prop equality. */
  marginView: MarginViewConfig | null
  onMarginCommit(pageNumber: number, localId: string, text: string): void
  onMarginSelect(pageNumber: number, localId: string): void
  onMarginDelete(pageNumber: number, localId: string): void
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
  searchAllRects,
  searchFlash,
  searchFlashId,
  drawTool,
  fingerDraws,
  penPressure,
  onInternalLink,
  onExternalLink,
  onStrokeComplete,
  onErase,
  onShapeComplete,
  onPlaceText,
  onResizeStart,
  onMarkupEndStart,
  markupPreview,
  marginView,
  onMarginCommit,
  onMarginSelect,
  onMarginDelete
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
    /** Pen pressures parallel to points (EMA-smoothed), or null when the
     *  stroke is uniform (mouse/touch/marker, or pressure turned off) */
    pressures: number[] | null
    /** The smoothing accumulator behind `pressures` */
    ema: number
  } | null>(null)

  /** Redraw the active stroke as a straight start→current line */
  const snapStrokeStraight = (stroke: NonNullable<typeof strokeRef.current>): void => {
    stroke.straight = true
    // A straightened line is uniform by definition: drop the pressure trace
    // and give the path its stroked look back (the live outline was a fill)
    if (stroke.pressures && drawTool) {
      stroke.pressures = null
      stroke.path.setAttribute('fill', 'none')
      stroke.path.setAttribute('stroke', rgbCss(drawTool.color, 1))
      stroke.path.setAttribute('stroke-width', String(drawTool.width))
      stroke.path.setAttribute('stroke-linecap', 'round')
      stroke.path.setAttribute('stroke-linejoin', 'round')
    }
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
        else anchor.title = linkTitle()
        anchor.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          // An EXTERNAL link always hands off to the system browser, modifier or
          // not: there is nothing in this document for a second column to show,
          // and the browser applies its own new-tab conventions from there.
          if (link.url) onExternalLink(link.url)
          // An IN-DOCUMENT destination can go either way, so Ctrl/Cmd means
          // "over there" (see followLinkFrom in PdfViewer).
          else if (link.dest) onInternalLink(link.dest, e.ctrlKey || e.metaKey)
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
    if (!drawTool) return
    // The pen's eraser end erases whatever tool is armed — that is what the
    // physical end means. buttons bit 32; its `button` is 5, so this runs
    // before the primary-button check.
    if (e.pointerType === 'pen' && (e.buttons & 32) !== 0) {
      e.preventDefault()
      const [ex, ey] = pagePointOf(e.clientX, e.clientY, e.currentTarget)
      onErase(pageNumber, ex, ey)
      return
    }
    // Touch routing: with finger drawing off a finger is for navigation (the
    // layer's touch-action lets it pan and pinch natively), and while the pen
    // is in hover range a touch is a resting palm whatever that preference
    // says — the OS suppresses most palm contacts, this catches the rest.
    if (e.pointerType === 'touch' && (!fingerDraws || penNear())) return
    if (e.button !== 0) return
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
    // Pressure is captured only where it exists AND matters: a real pen, the
    // pen tool, and the preference on. The marker keeps its uniform band and
    // mouse/touch report no real pressure.
    const withPressure = drawTool.type === 'pen' && e.pointerType === 'pen' && penPressure
    const path = document.createElementNS(SVG_NS, 'path')
    if (withPressure) {
      path.setAttribute('fill', rgbCss(drawTool.color, 1))
    } else {
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', rgbCss(drawTool.color, 1))
      path.setAttribute('stroke-width', String(drawTool.width))
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
    }
    path.setAttribute('opacity', String(drawTool.opacity))
    svg.append(path)
    const p0 = withPressure && e.pressure > 0 ? e.pressure : PRESSURE_NEUTRAL
    strokeRef.current = {
      pointerId: e.pointerId,
      points: [[x, y]],
      path,
      straight: false,
      holdTimer: 0,
      pressures: withPressure ? [Math.round(p0 * 100) / 100] : null,
      ema: p0
    }
    redrawStroke(strokeRef.current)
    armStrokeHold(strokeRef.current)
  }

  /** Live preview of the in-progress stroke: a filled variable-width outline
   *  for a pressure stroke, the plain stroked centerline otherwise. `predicted`
   *  is the browser's extrapolated tail — drawn, never stored. */
  const redrawStroke = (
    stroke: NonNullable<typeof strokeRef.current>,
    predicted: [number, number][] = []
  ): void => {
    const points = predicted.length > 0 ? [...stroke.points, ...predicted] : stroke.points
    if (stroke.pressures && drawTool) {
      // The predicted tail keeps the current pressure — strokeOutline reuses
      // the last half-width for points beyond the pressure array
      stroke.path.setAttribute(
        'd',
        outlineSvgPath(strokeOutline(points, pressureHalfWidths(stroke.pressures, drawTool.width)))
      )
    } else {
      stroke.path.setAttribute('d', strokePathData(points))
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawTool) return
    // Dragging the pen's eraser end keeps erasing, whatever tool is armed
    if (e.pointerType === 'pen' && (e.buttons & 32) !== 0) {
      const [x, y] = pagePointOf(e.clientX, e.clientY, e.currentTarget)
      onErase(pageNumber, x, y)
      return
    }
    if (drawTool.type === 'eraser') {
      if (e.buttons === 1) {
        if (e.pointerType === 'touch' && (!fingerDraws || penNear())) return
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
      if (stroke.pressures) {
        // EMA over the raw samples: pen pressure is noisy point-to-point and
        // an unsmoothed trace ripples the outline's edge
        const p = ev.pressure > 0 ? ev.pressure : stroke.ema
        stroke.ema += PRESSURE_EMA_ALPHA * (p - stroke.ema)
        stroke.pressures.push(Math.round(stroke.ema * 100) / 100)
      }
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
    // Predicted events (pen only, Chromium extrapolates) shave the perceived
    // lag off the wet end of the stroke: drawn this frame, REPLACED by real
    // points the next — they are never stored.
    const predicted =
      'getPredictedEvents' in native
        ? native.getPredictedEvents().map((ev): [number, number] => pagePointOf(ev.clientX, ev.clientY, el))
        : []
    redrawStroke(stroke, predicted)
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
      // straight ⇒ pressures were dropped in snapStrokeStraight
      onStrokeComplete(pageNumber, points, stroke.pressures ?? undefined)
    }
  }

  /** pointercancel means the browser took the pointer for something else —
   *  usually a pan/pinch it decided to run (touch-action allows finger panning
   *  while a tool is armed). Committing the half-stroke would leave a stub
   *  annotation UNDER the scroll the user actually asked for — discard it. */
  const onPointerCancelDiscard = (e: React.PointerEvent<HTMLDivElement>): void => {
    const shape = shapeRef.current
    if (shape && shape.pointerId === e.pointerId) {
      shapeRef.current = null
      shape.group.remove()
      return
    }
    const stroke = strokeRef.current
    if (!stroke || stroke.pointerId !== e.pointerId) return
    strokeRef.current = null
    window.clearTimeout(stroke.holdTimer)
    stroke.path.remove()
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
      {/* Every OTHER match on this page, dim and quiet, drawn first so the
          current hit paints over its own box. Same view-space contract. */}
      {searchAllRects.length > 0 && (
        <div className="annot-overlay">
          {searchAllRects.map((r, i) => (
            <div
              key={i}
              className="search-hit-all"
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
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
        <div className="annot-overlay annot-select">
          {/* A marked passage gets knobs on its two ends instead of a box — the
              box would say "resize this rectangle", which is not what a
              highlight is. Rotated, neither is offered, so it keeps the frame as
              its "selected" cue. */}
          {isTextMarkup(selectedAnnot) && rotation === 0 ? (
            <MarkupEndHandles
              record={selectedAnnot}
              scale={scale}
              onGrab={(end, e) => onMarkupEndStart(pageNumber, selectedAnnot, end, e)}
            />
          ) : (
            <SelectionFrame
              record={selectedAnnot}
              scale={scale}
              pageW={pageW}
              pageH={pageH}
              rotation={rotation}
              onResizeStart={(handle, e) => onResizeStart(pageNumber, selectedAnnot, handle, e)}
            />
          )}
        </div>
      )}
      {/* What releasing the end would mark. Drawn in the mark's own colour so the
          decision is about the text, not about a dashed rectangle. */}
      {markupPreview.length > 0 && (
        <div className="annot-overlay">
          {markupPreview.map((r, i) => {
            const v = pageRectToView(r, pageW, pageH, rotation)
            return (
              <div
                key={i}
                className="markup-edit-preview"
                style={{
                  left: v.x * scale,
                  top: v.y * scale,
                  width: v.w * scale,
                  height: v.h * scale,
                  background: rgbCss(selectedAnnot?.color ?? [0.2, 0.5, 0.9], 0.42)
                }}
              />
            )
          })}
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
          onPointerCancel={onPointerCancelDiscard}
        >
          <svg
            ref={drawSvgRef}
            viewBox={`0 0 ${cssWidth / scale} ${cssHeight / scale}`}
            preserveAspectRatio="none"
          />
        </div>
      )}
      {/* File AND session annotations get cards — a student's own comments and
          the teacher's fresh ones belong in the same column */}
      {marginView && !hideAnnots && (
        <MarginNotes
          pageNumber={pageNumber}
          annotations={annotations}
          scale={scale}
          rotation={rotation}
          pageW={pageW}
          pageH={pageH}
          view={marginView}
          selectedId={selectedId}
          onCommit={onMarginCommit}
          onSelect={onMarginSelect}
          onDelete={onMarginDelete}
        />
      )}
    </div>
  )
}

/** Accent selection frame over the union bbox of all quads. PAD is in page-space
 *  points so the frame hugs the annotation at any zoom.
 *
 *  The host .annot-overlay is pointer-events:none and MUST stay that way (an
 *  interactive full-page overlay silently kills text selection — see CLAUDE.md);
 *  the resize handles are the exception the rule allows, opting themselves back
 *  in one element at a time.
 *
 *  Handles only appear unrotated, the same limit the draw tools have: their
 *  pointer maths assumes an un-rotated page, and a corner labelled "top-left"
 *  stops meaning that at 90°. */
function SelectionFrame({
  record,
  scale,
  pageW,
  pageH,
  rotation,
  onResizeStart
}: {
  record: PageAnnotation
  scale: number
  pageW: number
  pageH: number
  rotation: ViewRotation
  onResizeStart(handle: ResizeHandle, e: React.PointerEvent): void
}): React.JSX.Element {
  const box = quadsUnion(record.quads)
  const PAD = 4
  const v = pageRectToView(
    { x: box.x - PAD, y: box.y - PAD, w: box.w + 2 * PAD, h: box.h + 2 * PAD },
    pageW,
    pageH,
    rotation
  )
  const kind = rotation === 0 ? resizeKindOf(record) : null
  const grab = (handle: ResizeHandle) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onResizeStart(handle, e)
  }
  // A line's handles sit ON its endpoints, not on the corners of a box that
  // means nothing for a line: dragging the visible end is the whole gesture.
  const ends = kind === 'endpoints' ? record.strokes?.[0] : undefined
  return (
    <div
      // A line or arrow shows its two endpoint dots and nothing else: a box
      // around a diagonal frames mostly empty paper and reads as clutter. The
      // dots are the affordance, and they mark the geometry that actually exists.
      className={`annot-selection${kind ? ' resizable' : ''}${kind === 'endpoints' ? ' ends-only' : ''}`}
      style={{
        left: v.x * scale,
        top: v.y * scale,
        width: v.w * scale,
        height: v.h * scale
      }}
    >
      {kind === 'box' ? (
        (['tl', 'tr', 'bl', 'br'] as const).map((h) => (
          <i key={h} className={`${h} grip`} onPointerDown={grab(h)} />
        ))
      ) : ends && ends[0] && ends[1] ? (
        ([['p0', ends[0]], ['p1', ends[1]]] as const).map(([h, p]) => (
          <i
            key={h}
            className="grip end"
            style={{
              // Endpoints are page coords; place them relative to the padded box
              left: (p[0] - (box.x - PAD)) * scale,
              top: (p[1] - (box.y - PAD)) * scale
            }}
            onPointerDown={grab(h)}
          />
        ))
      ) : null}
      {/* Nothing else. A note has a fixed icon size and a rotated page offers no
          handles, so those cases get the frame alone — dots that cannot be
          dragged are the decoration v0.31.0 replaced with real handles, and
          putting them back would re-tell the same lie. */}
    </div>
  )
}

/** The two knobs at the ends of a marked passage: drag one and the mark covers
 *  more or less text, instead of having to erase it and mark again. Shaped like a
 *  text-selection handle (a bar the height of the line, with a dot below/above)
 *  because that is the gesture it borrows.
 *
 *  Unrotated only — its caller decides that; here page space IS view space. */
function MarkupEndHandles({
  record,
  scale,
  onGrab
}: {
  record: PageAnnotation
  scale: number
  onGrab(end: 'start' | 'end', e: React.PointerEvent): void
}): React.JSX.Element | null {
  const first = record.quads[0]
  const last = record.quads[record.quads.length - 1]
  if (!first || !last) return null
  const grab = (end: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onGrab(end, e)
  }
  const knob = (end: 'start' | 'end', q: PageRect, x: number): React.JSX.Element => (
    <span
      key={end}
      className={`markup-end markup-end-${end}`}
      style={{ left: x * scale, top: q.y * scale, height: q.h * scale }}
      onPointerDown={grab(end)}
    />
  )
  return (
    <>
      {knob('start', first, first.x)}
      {knob('end', last, last.x + last.w)}
    </>
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
  // Nullable since the stamp branch: a stamp whose image is not in hand has
  // nothing to paint here (pdf.js draws the saved one from its /AP).
}): React.JSX.Element | null {
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
          {annotation.strokes.map((stroke, i) =>
            annotation.pressures?.[i] ? (
              // Pressure stroke: the same filled variable-width outline the
              // engines bake into the file (shared/ink-outline)
              <path
                key={i}
                d={outlineSvgPath(
                  strokeOutline(
                    stroke,
                    pressureHalfWidths(annotation.pressures[i], annotation.width ?? 2)
                  )
                )}
                fill={rgbCss(annotation.color, 1)}
                opacity={annotation.opacity}
              />
            ) : (
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
            )
          )}
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
  if (annotation.type === 'stamp') {
    // Only session stamps get here with an image: once the write lands and the
    // document reloads, the stamp is a 'file' annotation and pdf.js paints it
    // from the appearance stream (drawing it here too would double it up).
    if (!annotation.imageUrl) return null
    const css = annotationCss(annotation, annotation.quads[0], scale, { w: pageW, h: pageH }, rotation)
    return (
      <img
        className="annot annot-stamp"
        style={css}
        src={annotation.imageUrl}
        alt=""
        draggable={false}
      />
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
              stroke={rgbCss(annotation.color, 0.9 * annotation.opacity)}
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

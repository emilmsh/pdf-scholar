// The second pages column of the split view.
//
// Why it is not a second PdfViewer:
//   - It shares the one `PDFDocumentProxy` (and its worker). A second viewer
//     would parse and hold the whole document twice.
//   - It shares the `annots` map, so a mark made in either column appears in the
//     other in the same React commit — there is no sync step that can be wrong.
//   - There is exactly ONE save model, one draft and one reading position per
//     path in the main process. Two viewers on the same path would fight over
//     all three.
//
// It is a full participant, not a preview: the same draw tools, the same
// selection markup, the same hit-testing and popovers. What is per-pane is
// exactly what sits in the toolbar's centre — the page number and the zoom —
// which this component owns the geometry for and the toolbar drives through
// controlled props. Everything else (tools, undo, save, search, assistant) is
// document-wide and lives in PdfViewer, so it cannot matter which column you
// work in.
//
// Page, zoom, rotation and two-page spread are all per column: the concrete case
// is holding a landscape-printed table upright on one side while the prose that
// discusses it stays readable on the other. The first column's are the ones
// persisted with the reading position; this one's live for the session.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect, ViewRotation } from '../../../shared/types'
import type { DrawTool, PageAnnotation, ResizeHandle, ShapeToolType } from '../annotations'
import type { RowLayout } from '../rotation'
import {
  buildRows,
  GESTURE_SETTLE,
  MARGIN_NOTES_W,
  PAD_BOTTOM,
  PAD_TOP,
  PAGE_GAP,
  RENDER_MARGIN,
  shiftLayoutX,
  SIDE_PAD,
  SPREAD_GAP,
  flipTarget,
  spreadRow,
  viewSize
} from '../rotation'
import { MarginJumpArrows } from './MarginNotes'
import type { MarginViewConfig } from './MarginNotes'
import { makePaneHandle } from '../pane-handle'
import type { PaneHandle } from '../pane-handle'
import { clampZoom } from '../zoom'
import PdfPage from './PdfPage'
import { OverlayScrollbars } from './OverlayScrollbars'


const EMPTY_ANNOTS: PageAnnotation[] = []
const EMPTY_RECTS: PageRect[] = []

export type FitMode = 'width' | 'page' | 'custom'

interface Props {
  pdf: PDFDocumentProxy
  /** Document path — PdfPage's key into the PDFium raster registry */
  docKey: string
  sizes: { w: number; h: number }[]
  /** Live annotation map, shared with the main column — never copied */
  annots: ReadonlyMap<number, PageAnnotation[]>
  annotsHidden: boolean
  rotation: ViewRotation
  spread: boolean
  /** Spread sub-option: page 1 alone, pairs 2-3, 4-5 … */
  coverPage: boolean
  /** Controlled zoom: the toolbar's centre owns it, this component reports the
   *  scale it arrives at (fit modes, pinch) back up. */
  scale: number
  fitMode: FitMode
  onZoom(scale: number, fitMode: FitMode): void
  onPageChange(page: number): void
  /** Pulse this column briefly (focus moved here, or a link landed here). The
   *  persistent active-column signal is the toolbar's column switcher. */
  flash: boolean
  drawTool: DrawTool | null
  /** Whether a finger may draw when a tool is armed — see tool-prefs InputPrefs */
  fingerDraws: boolean
  /** Pen tool + real pen: stylus pressure varies the stroke width */
  penPressure: boolean
  selected: { pageNumber: number; localId: string } | null
  searchHits: { pageNumber: number; rects: PageRect[]; flash?: boolean; flashId?: number } | null
  /** Highlight-all rects per page, already scoped to THIS column by the viewer
   *  (they are measured in one column's rotation and valid only there). */
  searchAllHits: ReadonlyMap<number, PageRect[]> | null
  /** The main column's pointer handlers, reused verbatim — they resolve the
   *  pane and its scale from the DOM (see scaleOfPageEl in PdfViewer), so the
   *  same functions work in either column. */
  onContextMenu(e: React.MouseEvent): void
  onMouseUp(e: React.MouseEvent): void
  onMouseDown(e: React.MouseEvent): void
  onDoubleClick(e: React.MouseEvent): void
  onMouseMove(e: React.MouseEvent): void
  onMouseLeave(): void
  onScroll(): void
  onStrokeComplete(pageNumber: number, points: [number, number][], pressures?: number[]): void
  onErase(pageNumber: number, x: number, y: number): void
  onShapeComplete(
    pageNumber: number,
    type: ShapeToolType,
    a: [number, number],
    b: [number, number]
  ): void
  onPlaceText(pageNumber: number, x: number, y: number, clientX: number, clientY: number): void
  onResizeStart(
    pageNumber: number,
    record: PageAnnotation,
    handle: ResizeHandle,
    e: React.PointerEvent
  ): void
  onMarkupEndStart(
    pageNumber: number,
    record: PageAnnotation,
    end: 'start' | 'end',
    e: React.PointerEvent
  ): void
  /** Page -> rects a markup-end drag would commit, for THIS column */
  markupPreview: ReadonlyMap<number, PageRect[]> | null
  /** Margin view (comments beside the page) — same setting as the main column */
  marginView: MarginViewConfig | null
  onMarginCommit(pageNumber: number, localId: string, text: string): void
  onMarginSelect(pageNumber: number, localId: string): void
  onMarginDelete(pageNumber: number, localId: string): void
  /** Right-click on the margin strip: offer to hide the view (viewport coords) */
  onMarginMenu(x: number, y: number): void
  /** Margin jump arrow clicked in THIS column: select + scroll it here */
  onMarginJump(pageNumber: number, record: PageAnnotation): void
  onExternalLink(url: string): void
  /** Internal link followed inside THIS column. The viewer decides where it
   *  lands — by default the other column, so following a cross-reference never
   *  costs you your place here. */
  onInternalLink(dest: unknown, toOtherPane: boolean): void
  /** Publishes this column's scroll API so the viewer can send any go-to action
   *  (search, outline, notes, citations, links) to it. */
  onHandle(handle: PaneHandle | null): void
  /** Pane-local chrome (text-box editor, drag ghost) rendered inside this
   *  column's page layout — it has to be positioned at THIS pane's zoom. */
  overlay?(ctx: { layout: RowLayout; scale: number }): React.ReactNode
}

export default function PagesPane({
  pdf,
  docKey,
  sizes,
  annots,
  annotsHidden,
  rotation,
  spread,
  coverPage,
  scale,
  fitMode,
  onZoom,
  onPageChange,
  flash,
  drawTool,
  fingerDraws,
  penPressure,
  selected,
  searchHits,
  searchAllHits,
  onContextMenu,
  onMouseUp,
  onMouseDown,
  onDoubleClick,
  onMouseMove,
  onMouseLeave,
  onScroll,
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
  onMarginDelete,
  onMarginMenu,
  onMarginJump,
  onExternalLink,
  onInternalLink,
  onHandle,
  overlay
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const fitModeRef = useRef(fitMode)
  fitModeRef.current = fitMode
  const rotationRef = useRef(rotation)
  rotationRef.current = rotation
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  const [range, setRange] = useState<[number, number]>([1, 1])
  /** Zoom anchor: an exact page point put back under the same viewport spot.
   *  Multiplying scrollTop by the scale ratio drifts — gaps do not scale. */
  const anchorRef = useRef<{
    pageIndex: number
    pageX: number
    pageY: number
    fx: number
    fy: number
  } | null>(null)
  const pendingPageRef = useRef<number | null>(null)
  const gestureRef = useRef<{
    factor: number
    originX: number
    originY: number
    fx: number
    fy: number
    timer: number
  } | null>(null)

  // Two width sources, for the same reason the toolbar's overflow logic needs
  // two: the drag-resizer changes an ancestor's width and re-renders this
  // component (caught by the layout effect, no frame-loop dependency), while a
  // window resize or a side panel opening changes it WITHOUT re-rendering
  // (caught by the observer). Either alone leaves a case where a fit mode
  // silently stops fitting.
  const measureWidth = (): void => {
    const el = containerRef.current
    if (el) setContainerWidth((w) => (w === el.clientWidth ? w : el.clientWidth))
  }
  const measureRef = useRef(measureWidth)
  measureRef.current = measureWidth
  useLayoutEffect(() => {
    measureRef.current()
  })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureRef.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Same rule as the main column: the margin-view card column is reserved from
  // every width the layout and the fit modes see, and a left-hand margin
  // shifts the pages right so the column has its space.
  const marginGutter = marginView ? MARGIN_NOTES_W : 0
  const marginGutterRef = useRef(marginGutter)
  marginGutterRef.current = marginGutter

  const layout = useMemo(() => {
    if (sizes.length === 0 || scale <= 0 || containerWidth === 0) return null
    const lay = buildRows(
      sizes,
      scale,
      rotation,
      spread,
      {
        containerWidth: Math.max(containerWidth - marginGutter, 120),
        pageGap: PAGE_GAP,
        padTop: PAD_TOP,
        padBottom: PAD_BOTTOM,
        sidePad: SIDE_PAD,
        spreadGap: SPREAD_GAP
      },
      coverPage
    )
    return shiftLayoutX(lay, marginView?.side === 'left' ? marginGutter : 0)
  }, [sizes, scale, containerWidth, rotation, spread, coverPage, marginGutter, marginView?.side])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const fitDenom = useCallback(
    (page: number): { w: number; h: number } => {
      if (sizes.length === 0) return { w: 1, h: 1 }
      const cur = Math.min(Math.max(page - 1, 0), sizes.length - 1)
      const row = spread ? spreadRow(cur, sizes.length, coverPage) : [cur]
      const v0 = viewSize(sizes[row[0]].w, sizes[row[0]].h, rotation)
      if (row.length > 1) {
        const v1 = viewSize(sizes[row[1]].w, sizes[row[1]].h, rotation)
        return { w: v0.w + v1.w + SPREAD_GAP, h: Math.max(v0.h, v1.h) }
      }
      return v0
    },
    [sizes, rotation, spread, coverPage]
  )

  const currentPageRef = useRef(1)

  const updateRange = useCallback(() => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const top = el.scrollTop - RENDER_MARGIN
    const bottom = el.scrollTop + el.clientHeight + RENDER_MARGIN
    let from = 1
    let to = 1
    for (let i = 0; i < lay.tops.length; i++) {
      if (lay.tops[i] + lay.heights[i] < top) from = i + 2
      if (lay.tops[i] <= bottom) to = i + 1
    }
    setRange((prev) => (prev[0] === from && prev[1] === to ? prev : [from, Math.max(from, to)]))
    // Same 35 % anchor as the main column, so both agree on "current page"
    const probe = el.scrollTop + el.clientHeight * 0.35
    let row = lay.rows[0]
    for (const r of lay.rows) {
      if (r.top <= probe) row = r
      else break
    }
    const page = (row?.pages[0]?.index ?? 0) + 1
    if (page !== currentPageRef.current) {
      currentPageRef.current = page
      onPageChange(page)
    }
  }, [onPageChange])
  const updateRangeRef = useRef(updateRange)
  updateRangeRef.current = updateRange

  // First scale once the width is known: fit-width, because a split column is
  // narrow and a shrunk-to-fit whole page would be a stamp.
  useEffect(() => {
    if (scale > 0 || sizes.length === 0 || containerWidth === 0) return
    onZoomRef.current(
      clampZoom((containerWidth - SIDE_PAD - marginGutter) / fitDenom(currentPageRef.current).w),
      'width'
    )
  }, [scale, sizes, containerWidth, fitDenom, marginGutter])

  /** Capture the page point under (fx, fy) in this column's viewport */
  const makeAnchor = useCallback((fx: number, fy: number) => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return null
    const prev = scaleRef.current
    const contentY = el.scrollTop + fy
    let pageIndex = 0
    for (let i = 0; i < lay.tops.length; i++) {
      if (lay.tops[i] <= contentY) pageIndex = i
      else break
    }
    return {
      pageIndex,
      pageX: (el.scrollLeft + fx - lay.lefts[pageIndex]) / prev,
      pageY: (contentY - lay.tops[pageIndex]) / prev,
      fx,
      fy
    }
  }, [])

  /** The orientation the current scroll position was computed against. A change
   *  means the layout was just rebuilt under the reader (rotate, spread), and
   *  scrollTop now points somewhere arbitrary — so keep them on their page. */
  const laidOutForRef = useRef<string | null>(null)

  // Consume a page jump, then a zoom anchor — both need the FRESH layout, and
  // both must land before paint or the column visibly jumps. The gesture
  // transform is dropped in this same pass (see commitGesture).
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !layout) return
    // currentPageRef still holds the page from BEFORE this relayout (only
    // updateRange moves it), which is exactly the page to land back on.
    const key = `${rotation}:${spread}:${coverPage}`
    if (laidOutForRef.current !== null && laidOutForRef.current !== key) {
      pendingPageRef.current = currentPageRef.current
      anchorRef.current = null
    }
    laidOutForRef.current = key
    const page = pendingPageRef.current
    if (page !== null) {
      pendingPageRef.current = null
      const i = Math.min(Math.max(page - 1, 0), layout.tops.length - 1)
      el.scrollTop = Math.max(0, layout.tops[i] - 8)
    }
    const anchor = anchorRef.current
    if (anchor) {
      anchorRef.current = null
      el.scrollTop = Math.max(0, layout.tops[anchor.pageIndex] + anchor.pageY * scale - anchor.fy)
      el.scrollLeft = Math.max(0, layout.lefts[anchor.pageIndex] + anchor.pageX * scale - anchor.fx)
    }
    const inner = innerRef.current
    if (inner && inner.style.transform) {
      inner.style.transform = ''
      inner.style.willChange = ''
      inner.style.transformOrigin = '0 0'
    }
    updateRangeRef.current()
  }, [layout, scale, rotation, spread, coverPage])

  const zoomTo = useCallback(
    (next: number, mode: FitMode, focalClientX?: number, focalClientY?: number) => {
      const el = containerRef.current
      const prev = scaleRef.current
      if (!el || prev <= 0) {
        onZoomRef.current(clampZoom(next), mode)
        return
      }
      const target = clampZoom(next)
      if (target === prev) {
        if (mode !== fitModeRef.current) onZoomRef.current(prev, mode)
        return
      }
      const box = el.getBoundingClientRect()
      const fx = focalClientX !== undefined ? focalClientX - box.left : el.clientWidth / 2
      const fy = focalClientY !== undefined ? focalClientY - box.top : el.clientHeight / 2
      anchorRef.current = makeAnchor(fx, fy)
      onZoomRef.current(target, mode)
    },
    [makeAnchor]
  )
  const zoomToRef = useRef(zoomTo)
  zoomToRef.current = zoomTo

  // Re-fit when the column is dragged wider/narrower (a fit mode must stay fit).
  // 'custom' keeps its exact scale, same rule as the main column.
  const refitRef = useRef<() => void>(() => {})
  refitRef.current = () => {
    const el = containerRef.current
    const mode = fitModeRef.current
    if (!el || mode === 'custom' || sizes.length === 0 || el.clientWidth === 0) return
    const denom = fitDenom(currentPageRef.current)
    const usable = el.clientWidth - SIDE_PAD - marginGutterRef.current
    const next = clampZoom(
      mode === 'width'
        ? usable / denom.w
        : Math.min(usable / denom.w, (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h)
    )
    const prev = scaleRef.current
    if (prev <= 0 || Math.abs(next - prev) / prev < 0.002) return
    anchorRef.current = makeAnchor(el.clientWidth / 2, el.clientHeight / 2)
    onZoomRef.current(next, mode)
  }
  useEffect(() => {
    refitRef.current()
  }, [containerWidth])

  // The toolbar can switch this column into a fit mode without touching the
  // scale — recompute it here. Rotating or spreading changes what "fits" too
  // (a landscape page needs a different width), so re-fit on those as well.
  // Safe against loops: refit is a no-op once the scale already matches.
  useEffect(() => {
    if (fitMode !== 'custom') refitRef.current()
  }, [fitMode, rotation, spread, coverPage, marginGutter])

  /** Commit a pinch: swap the cheap CSS transform for a crisp re-render at the
   *  accumulated scale. The transform is dropped by the layout effect above,
   *  once the new layout is in place — that is what makes release seamless. */
  const commitGesture = useCallback(() => {
    const g = gestureRef.current
    const el = containerRef.current
    if (!g || !el) return
    gestureRef.current = null
    window.clearTimeout(g.timer)
    const prev = scaleRef.current
    const next = clampZoom(prev * g.factor)
    const anchor = makeAnchor(g.fx, g.fy)
    if (next === prev || !anchor) {
      const inner = innerRef.current
      if (inner) {
        inner.style.transform = ''
        inner.style.willChange = ''
        inner.style.transformOrigin = '0 0'
      }
      updateRangeRef.current()
      return
    }
    anchorRef.current = anchor
    onZoomRef.current(next, 'custom')
  }, [makeAnchor])
  const commitGestureRef = useRef(commitGesture)
  commitGestureRef.current = commitGesture

  const beginGesture = useCallback((clientX: number, clientY: number): boolean => {
    const el = containerRef.current
    const inner = innerRef.current
    if (!el || !inner || scaleRef.current <= 0) return false
    const rect = el.getBoundingClientRect()
    const hasHScroll = el.scrollWidth > el.clientWidth + 1
    const fx = hasHScroll ? clientX - rect.left : el.clientWidth / 2
    const fy = clientY - rect.top
    gestureRef.current = {
      factor: 1,
      originX: el.scrollLeft + fx,
      originY: el.scrollTop + fy,
      fx,
      fy,
      timer: 0
    }
    inner.style.willChange = 'transform'
    inner.style.transformOrigin = `${gestureRef.current.originX}px ${gestureRef.current.originY}px`
    return true
  }, [])

  // Ctrl+wheel (and trackpad pinch, which Chromium reports as ctrl+wheel) —
  // the same CSS-preview + anchored-commit pipeline as the main column, so a
  // pinch feels identical whichever column the cursor is over.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const inner = innerRef.current
      if (!inner) return
      if (!gestureRef.current && !beginGesture(e.clientX, e.clientY)) return
      const g = gestureRef.current
      if (!g) return
      const step =
        Math.abs(e.deltaY) >= 90 ? (e.deltaY < 0 ? 1.22 : 1 / 1.22) : Math.exp(-e.deltaY * 0.006)
      const target = clampZoom(scaleRef.current * g.factor * step)
      g.factor = target / scaleRef.current
      inner.style.transform = `scale(${g.factor})`
      window.clearTimeout(g.timer)
      // Long pinches blur (a CSS-scaled canvas): re-render mid-gesture once the
      // factor drifts far enough; the anchored commit keeps that seamless.
      if (g.factor > 1.3 || g.factor < 1 / 1.3) commitGestureRef.current()
      else g.timer = window.setTimeout(() => commitGestureRef.current(), GESTURE_SETTLE)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (gestureRef.current) window.clearTimeout(gestureRef.current.timer)
    }
  }, [beginGesture])

  // Touch pinch (Surface Pro): fingers on glass arrive as touch events, not as
  // ctrl+wheel. Same pipeline again. Single-touch drag/scroll is left alone —
  // annotation dragging and the edge swipes are handled viewer-wide.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const pinch = { active: false, startDist: 0 }
    const dist = (t: TouchList): number =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

    const onStart = (e: TouchEvent): void => {
      if (drawTool || e.touches.length < 2) return
      e.preventDefault()
      if (pinch.active) return
      const mid = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      }
      if (!beginGesture(mid.x, mid.y)) return
      pinch.startDist = dist(e.touches)
      pinch.active = true
    }
    const onMove = (e: TouchEvent): void => {
      const g = gestureRef.current
      const inner = innerRef.current
      if (!pinch.active || !g || !inner || e.touches.length < 2 || pinch.startDist <= 0) return
      e.preventDefault()
      const target = clampZoom(scaleRef.current * (dist(e.touches) / pinch.startDist))
      g.factor = target / scaleRef.current
      inner.style.transform = `scale(${g.factor})`
    }
    const onEnd = (e: TouchEvent): void => {
      if (!pinch.active || e.touches.length >= 2) return
      pinch.active = false
      pinch.startDist = 0
      commitGestureRef.current()
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [beginGesture, drawTool])

  /** Book-style page turn, same contract as the main column's: land the
   *  previous/next row's top, a whole spread at a time, and in a fit mode
   *  re-fit against the landing row first (only on a turn — never mid-scroll). */
  const flipPage = (dir: -1 | 1): void => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const target = flipTarget(currentPageRef.current - 1, dir, sizes.length, spread, coverPage)
    if (target === null) return
    if (fitMode !== 'custom') {
      const denom = fitDenom(target + 1)
      const usable = el.clientWidth - SIDE_PAD - marginGutterRef.current
      const next = clampZoom(
        fitMode === 'width'
          ? usable / denom.w
          : Math.min(usable / denom.w, (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h)
      )
      const prev = scaleRef.current
      if (prev > 0 && Math.abs(next - prev) / prev >= 0.002) {
        // Land after the relayout, not before — the tops move with the scale.
        anchorRef.current = null
        pendingPageRef.current = target + 1
        onZoomRef.current(next, fitMode)
        return
      }
    }
    el.scrollTop = Math.max(0, lay.tops[target] - 8)
    updateRangeRef.current()
  }
  const flipPageRef = useRef(flipPage)
  flipPageRef.current = flipPage

  // This column's scroll API, published upward so the viewer can aim any go-to
  // action at it. Rebuilt only when `sizes` changes — everything else is read
  // through refs, so the handle identity stays stable.
  const onHandleRef = useRef(onHandle)
  onHandleRef.current = onHandle
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  useEffect(() => {
    const handle = makePaneHandle({
      el: () => containerRef.current,
      layout: () => layoutRef.current,
      scale: () => scaleRef.current,
      rotation: () => rotationRef.current,
      sizes: () => sizesRef.current,
      afterScroll: () => updateRangeRef.current(),
      flipPage: (dir) => flipPageRef.current(dir)
    })
    onHandleRef.current(handle)
    return () => onHandleRef.current(null)
  }, [])

  // Stable identities for PdfPage — fresh callbacks re-render every page canvas
  const linkRef = useRef(onInternalLink)
  linkRef.current = onInternalLink
  const handleInternalLink = useCallback(
    (d: unknown, toOther: boolean) => linkRef.current(d, toOther),
    []
  )

  const handleScroll = useCallback(() => {
    updateRangeRef.current()
    onScroll()
  }, [onScroll])

  return (
    <div className={`pages-host pane-b${flash ? ' pane-flash' : ''}`}>
      <div
        className={`pages${drawTool ? ' drawing' : ''}`}
        data-pane="b"
        // Published so PdfViewer's pointer handlers can map a click in THIS
        // column into page space at its own zoom and orientation
        data-rotation={rotation}
        ref={containerRef}
        tabIndex={-1}
        onScroll={handleScroll}
        onContextMenu={onContextMenu}
        onMouseUp={onMouseUp}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {layout ? (
          <div
            className="pages-inner"
            ref={innerRef}
            style={{ height: layout.total, width: layout.contentWidth + marginGutter }}
          >
            {sizes.map((size, i) => {
              const pageNumber = i + 1
              return (
                <PdfPage
                  key={pageNumber}
                  pdf={pdf}
                  docKey={docKey}
                  pageNumber={pageNumber}
                  top={layout.tops[i]}
                  left={layout.lefts[i]}
                  cssWidth={layout.widths[i]}
                  cssHeight={layout.heights[i]}
                  scale={scale}
                  rotation={rotation}
                  pageW={size.w}
                  pageH={size.h}
                  active={pageNumber >= range[0] && pageNumber <= range[1]}
                  annotations={annots.get(pageNumber) ?? EMPTY_ANNOTS}
                  hideAnnots={annotsHidden}
                  selectedId={selected?.pageNumber === pageNumber ? selected.localId : null}
                  searchRects={searchHits?.pageNumber === pageNumber ? searchHits.rects : EMPTY_RECTS}
                  searchAllRects={searchAllHits?.get(pageNumber) ?? EMPTY_RECTS}
                  searchFlash={!!searchHits?.flash && searchHits.pageNumber === pageNumber}
                  searchFlashId={
                    searchHits?.flash && searchHits.pageNumber === pageNumber
                      ? searchHits.flashId
                      : undefined
                  }
                  drawTool={drawTool}
                  fingerDraws={fingerDraws}
                  penPressure={penPressure}
                  onInternalLink={handleInternalLink}
                  onExternalLink={onExternalLink}
                  onStrokeComplete={onStrokeComplete}
                  onErase={onErase}
                  onShapeComplete={onShapeComplete}
                  onPlaceText={onPlaceText}
                  onResizeStart={onResizeStart}
                  onMarkupEndStart={onMarkupEndStart}
                  markupPreview={markupPreview?.get(pageNumber) ?? EMPTY_RECTS}
                  marginView={marginView}
                  onMarginCommit={onMarginCommit}
                  onMarginSelect={onMarginSelect}
                  onMarginDelete={onMarginDelete}
                  onMarginMenu={onMarginMenu}
                />
              )
            })}
            {overlay?.({ layout, scale })}
          </div>
        ) : (
          <div className="viewer-loading">
            <div className="spinner" />
          </div>
        )}
      </div>
      {marginView && !annotsHidden && (
        <MarginJumpArrows
          scrollRef={containerRef}
          layout={layout}
          annots={annots}
          sizes={sizes}
          scale={scale}
          rotation={rotation}
          side={marginView.side}
          onJump={onMarginJump}
        />
      )}
      <OverlayScrollbars
        scrollRef={containerRef}
        layoutKey={layout ? `${layout.total}:${layout.contentWidth}` : 'none'}
      />
    </div>
  )
}

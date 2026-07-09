import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import type { FilePayload, ReadingPosition, ThemeName } from '../../../shared/types'
import { bridge } from '../bridge'
import PdfPage from './PdfPage'
import Toolbar from './Toolbar'

GlobalWorkerOptions.workerPort = new PdfWorker()

const PAGE_GAP = 16
const PAD_TOP = 28
const PAD_BOTTOM = 28
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
/** Pages within this many px of the viewport get rendered */
const RENDER_MARGIN = 800

interface PageSize {
  w: number
  h: number
}

interface Props {
  payload: FilePayload
  initialPosition: ReadingPosition | null
  theme: ThemeName
  onThemeChange(theme: ThemeName): void
  onClose(): void
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export default function PdfViewer({
  payload,
  initialPosition,
  theme,
  onThemeChange,
  onClose
}: Props): React.JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [scale, setScale] = useState(initialPosition?.zoom ?? 0)
  const [range, setRange] = useState<[number, number]>([1, 1])
  const [currentPage, setCurrentPage] = useState(initialPosition?.page ?? 1)
  const [error, setError] = useState<string | null>(null)
  const [chromeHidden, setChromeHidden] = useState(false)
  const [peek, setPeek] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const restoreRef = useRef<ReadingPosition | null>(initialPosition)
  const pendingScrollRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  // Load the document and gather page sizes
  useEffect(() => {
    let destroyed = false
    // pdf.js transfers the underlying buffer to its worker, so hand it a copy
    const loadingTask = getDocument({ data: payload.data.slice() })
    ;(async () => {
      const doc = await loadingTask.promise
      if (destroyed) return
      setPdf(doc)
      const collected: PageSize[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        if (destroyed) return
        const vp = page.getViewport({ scale: 1 })
        collected.push({ w: vp.width, h: vp.height })
      }
      setSizes(collected)
    })().catch((err) => {
      if (!destroyed) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      destroyed = true
      loadingTask.destroy()
    }
  }, [payload])

  // Pick an initial fit-width zoom if none was restored
  useEffect(() => {
    if (scale !== 0 && sizes.length > 0) return
    const el = containerRef.current
    if (!el || sizes.length === 0) return
    const fit = clamp((el.clientWidth - 96) / sizes[0].w, ZOOM_MIN, ZOOM_MAX)
    setScale(fit)
  }, [sizes, scale])

  const layout = useMemo(() => {
    if (sizes.length === 0 || scale <= 0) return null
    const tops: number[] = []
    let y = PAD_TOP
    for (const s of sizes) {
      tops.push(y)
      y += s.h * scale + PAGE_GAP
    }
    return { tops, total: y - PAGE_GAP + PAD_BOTTOM }
  }, [sizes, scale])

  const computeCurrent = useCallback((): { page: number; offset: number } | null => {
    const el = containerRef.current
    if (!el || !layout) return null
    const anchor = el.scrollTop + el.clientHeight * 0.35
    let page = 1
    for (let i = 0; i < layout.tops.length; i++) {
      if (layout.tops[i] <= anchor) page = i + 1
      else break
    }
    const pageHeight = sizes[page - 1].h * scale
    const offset = clamp((el.scrollTop - layout.tops[page - 1]) / pageHeight, 0, 1)
    return { page, offset }
  }, [layout, sizes, scale])

  const updateRange = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout) return
    const top = el.scrollTop - RENDER_MARGIN
    const bottom = el.scrollTop + el.clientHeight + RENDER_MARGIN
    let from = 1
    let to = 1
    for (let i = 0; i < layout.tops.length; i++) {
      const pageTop = layout.tops[i]
      const pageBottom = pageTop + sizes[i].h * scale
      if (pageBottom < top) from = i + 2
      if (pageTop <= bottom) to = i + 1
    }
    setRange((prev) => (prev[0] === from && prev[1] === to ? prev : [from, Math.max(from, to)]))
    const current = computeCurrent()
    if (current) setCurrentPage(current.page)
  }, [layout, sizes, scale, computeCurrent])

  const schedulePositionSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const current = computeCurrent()
      if (current) {
        bridge.setPosition(payload.path, { ...current, zoom: scaleRef.current })
      }
    }, 600)
  }, [computeCurrent, payload.path])

  // Restore reading position once the layout is known
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !layout) return
    if (restoreRef.current) {
      const pos = restoreRef.current
      restoreRef.current = null
      const page = clamp(pos.page, 1, layout.tops.length)
      el.scrollTop = layout.tops[page - 1] + pos.offset * sizes[page - 1].h * scale - 8
    }
    updateRange()
  }, [layout, sizes, scale, updateRange])

  // Apply scroll adjustment after a zoom change
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el && pendingScrollRef.current !== null) {
      el.scrollTop = pendingScrollRef.current
      pendingScrollRef.current = null
      updateRange()
    }
  }, [scale, updateRange])

  const onScroll = useCallback(() => {
    updateRange()
    schedulePositionSave()
  }, [updateRange, schedulePositionSave])

  const zoomTo = useCallback(
    (next: number, focalClientY?: number) => {
      const el = containerRef.current
      const prev = scaleRef.current
      if (!el || prev <= 0) return
      next = clamp(next, ZOOM_MIN, ZOOM_MAX)
      if (next === prev) return
      const rect = el.getBoundingClientRect()
      const focal = focalClientY !== undefined ? focalClientY - rect.top : el.clientHeight / 2
      pendingScrollRef.current = ((el.scrollTop + focal) * next) / prev - focal
      setScale(next)
      schedulePositionSave()
    },
    [schedulePositionSave]
  )

  const fitWidth = useCallback(() => {
    const el = containerRef.current
    if (!el || sizes.length === 0) return
    zoomTo((el.clientWidth - 96) / sizes[0].w)
  }, [sizes, zoomTo])

  // Ctrl+wheel (and trackpad pinch, which Chromium reports as ctrl+wheel) zooms
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      zoomTo(scaleRef.current * factor, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // Re-evaluate visible range when the window resizes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => updateRange())
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateRange])

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const toggleChrome = useCallback(() => {
    setChromeHidden((hidden) => {
      const next = !hidden
      setPeek(false)
      if (next) showToast('Distraksjonsfri lesing — trykk Esc for å vise verktøylinjen')
      return next
    })
  }, [showToast])

  const goToPage = useCallback(
    (page: number) => {
      const el = containerRef.current
      if (!el || !layout) return
      page = clamp(Math.round(page), 1, layout.tops.length)
      el.scrollTop = layout.tops[page - 1] - 8
    },
    [layout]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && chromeHidden) {
        setChromeHidden(false)
        setPeek(false)
      } else if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        zoomTo(scaleRef.current * 1.15)
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault()
        zoomTo(scaleRef.current / 1.15)
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault()
        fitWidth()
      }
    },
    [chromeHidden, zoomTo, fitWidth]
  )

  // Focus the scroll container so PageUp/PageDown/arrows work immediately
  useEffect(() => {
    containerRef.current?.focus()
  }, [pdf])

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    },
    []
  )

  if (error) {
    return (
      <div className="viewer-error">
        <p>Kunne ikke vise dokumentet.</p>
        <p className="viewer-error-detail">{error}</p>
        <button className="btn-primary" onClick={onClose}>
          Tilbake
        </button>
      </div>
    )
  }

  return (
    <div className={`viewer${chromeHidden ? ' chrome-hidden' : ''}`} onKeyDown={onKeyDown}>
      <div
        className={`toolbar-wrap${chromeHidden && !peek ? ' tucked' : ''}`}
        onMouseLeave={() => chromeHidden && setPeek(false)}
      >
        <Toolbar
          fileName={payload.name}
          page={currentPage}
          pageCount={sizes.length}
          zoomPercent={scale > 0 ? Math.round(scale * 100) : 100}
          theme={theme}
          onBack={onClose}
          onGoToPage={goToPage}
          onZoomIn={() => zoomTo(scaleRef.current * 1.15)}
          onZoomOut={() => zoomTo(scaleRef.current / 1.15)}
          onFitWidth={fitWidth}
          onThemeChange={onThemeChange}
          onToggleChrome={toggleChrome}
        />
      </div>
      {chromeHidden && <div className="reveal-zone" onMouseEnter={() => setPeek(true)} />}

      <div className="pages" ref={containerRef} tabIndex={-1} onScroll={onScroll}>
        {layout && pdf ? (
          <div className="pages-inner" style={{ height: layout.total }}>
            {sizes.map((size, i) => {
              const pageNumber = i + 1
              const active = pageNumber >= range[0] && pageNumber <= range[1]
              return (
                <PdfPage
                  key={pageNumber}
                  pdf={pdf}
                  pageNumber={pageNumber}
                  top={layout.tops[i]}
                  cssWidth={size.w * scale}
                  cssHeight={size.h * scale}
                  scale={scale}
                  active={active}
                />
              )
            })}
          </div>
        ) : (
          <div className="viewer-loading">
            <div className="spinner" />
            <span>Åpner {payload.name} …</span>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import type {
  AnnotationType,
  FilePayload,
  PageRect,
  ReadingPosition,
  Settings,
  ThemeName
} from '../../../shared/types'
import { bridge } from '../bridge'
import {
  NOTE_COLOR,
  STRIKEOUT_COLOR,
  UNDERLINE_COLOR,
  nextAnnotationId,
  selectionRectsForPage
} from '../annotations'
import type { PageAnnotation } from '../annotations'
import PdfPage from './PdfPage'
import Sidebar from './Sidebar'
import Toolbar from './Toolbar'
import { NotePopover, SelectionMenu } from './SelectionMenu'
import type { MenuAction, MenuState } from './SelectionMenu'

GlobalWorkerOptions.workerPort = new PdfWorker()

const PAGE_GAP = 16
const PAD_TOP = 28
const PAD_BOTTOM = 28
const SIDE_PAD = 64
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
/** Pages within this many px of the viewport get rendered */
const RENDER_MARGIN = 800
/** ms of wheel silence before a pinch/ctrl-wheel gesture commits a re-render */
const GESTURE_SETTLE = 160

const EMPTY_ANNOTS: PageAnnotation[] = []

interface PageSize {
  w: number
  h: number
}

interface NoteDraft {
  x: number
  y: number
  pageNumber: number
  anchor: PageRect
}

interface Props {
  payload: FilePayload
  initialPosition: ReadingPosition | null
  settings: Settings
  resolvedTheme: ThemeName
  onSettingsChange(patch: Partial<Settings>): void
  onClose(): void
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export default function PdfViewer({
  payload,
  initialPosition,
  settings,
  resolvedTheme,
  onSettingsChange,
  onClose
}: Props): React.JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [scale, setScale] = useState(initialPosition?.zoom ?? 0)
  const [containerWidth, setContainerWidth] = useState(0)
  const [range, setRange] = useState<[number, number]>([1, 1])
  const [currentPage, setCurrentPage] = useState(initialPosition?.page ?? 1)
  const [error, setError] = useState<string | null>(null)
  const [chromeHidden, setChromeHidden] = useState(false)
  const [peek, setPeek] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [sessionAnnots, setSessionAnnots] = useState<ReadonlyMap<number, PageAnnotation[]>>(
    new Map()
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [backStack, setBackStack] = useState<{ page: number; offset: number }[]>([])
  const [pillEditing, setPillEditing] = useState(false)
  const [pillInput, setPillInput] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const restoreRef = useRef<ReadingPosition | null>(initialPosition)
  /** Page-anchored focal point consumed by the post-zoom commit effect */
  const pendingAnchorRef = useRef<{
    pageIndex: number
    pageX: number
    pageY: number
    fx: number
    fy: number
  } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const gestureRef = useRef<{
    factor: number
    originX: number
    originY: number
    fx: number
    fy: number
    timer: number
  } | null>(null)

  // ---------- Document loading ----------

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

  // Track container width (for fit-width zoom and horizontal layout).
  // Fall back to the window width so layout never deadlocks if the element
  // has no size yet (e.g. window minimized at startup, hidden preview tab).
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (): void => setContainerWidth(el.clientWidth || window.innerWidth || 1200)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Pick an initial fit-width zoom if none was restored
  useEffect(() => {
    if (scale > 0 || sizes.length === 0 || containerWidth === 0) return
    setScale(clamp((containerWidth - SIDE_PAD) / sizes[0].w, ZOOM_MIN, ZOOM_MAX))
  }, [sizes, scale, containerWidth])

  // ---------- Layout ----------

  const layout = useMemo(() => {
    if (sizes.length === 0 || scale <= 0 || containerWidth === 0) return null
    const maxW = Math.max(...sizes.map((s) => s.w))
    const contentWidth = Math.max(containerWidth, maxW * scale + SIDE_PAD)
    const tops: number[] = []
    const lefts: number[] = []
    let y = PAD_TOP
    for (const s of sizes) {
      tops.push(y)
      lefts.push((contentWidth - s.w * scale) / 2)
      y += s.h * scale + PAGE_GAP
    }
    return { tops, lefts, total: y - PAGE_GAP + PAD_BOTTOM, contentWidth }
  }, [sizes, scale, containerWidth])

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

  // Commit a zoom: reposition the anchored page point under the focal spot
  // and drop the gesture transform in the SAME pre-paint frame — this is what
  // makes pinch-release seamless (gaps/margins don't scale with zoom, so a
  // plain scroll*ratio would jump).
  useLayoutEffect(() => {
    const el = containerRef.current
    const anchor = pendingAnchorRef.current
    if (!el || !layout || !anchor) return
    pendingAnchorRef.current = null
    el.scrollTop = Math.max(0, layout.tops[anchor.pageIndex] + anchor.pageY * scale - anchor.fy)
    el.scrollLeft = Math.max(0, layout.lefts[anchor.pageIndex] + anchor.pageX * scale - anchor.fx)
    const inner = innerRef.current
    if (inner) {
      inner.style.transform = ''
      inner.style.willChange = ''
      inner.style.transformOrigin = '0 0'
    }
    updateRange()
  }, [scale, layout, updateRange])

  const onScroll = useCallback(() => {
    updateRange()
    schedulePositionSave()
    setMenu((m) => (m ? null : m))
  }, [updateRange, schedulePositionSave])

  // ---------- Zoom ----------

  /** Capture the page point currently under (fx, fy) in the scroll viewport */
  const makeAnchor = useCallback(
    (fx: number, fy: number): typeof pendingAnchorRef.current => {
      const el = containerRef.current
      if (!el || !layout) return null
      const prev = scaleRef.current
      const contentY = el.scrollTop + fy
      let pageIndex = 0
      for (let i = 0; i < layout.tops.length; i++) {
        if (layout.tops[i] <= contentY) pageIndex = i
        else break
      }
      return {
        pageIndex,
        pageX: (el.scrollLeft + fx - layout.lefts[pageIndex]) / prev,
        pageY: (contentY - layout.tops[pageIndex]) / prev,
        fx,
        fy
      }
    },
    [layout]
  )

  const zoomTo = useCallback(
    (next: number, focalClientY?: number) => {
      const el = containerRef.current
      const prev = scaleRef.current
      if (!el || prev <= 0) return
      next = clamp(next, ZOOM_MIN, ZOOM_MAX)
      if (next === prev) return
      const rect = el.getBoundingClientRect()
      const fy = focalClientY !== undefined ? focalClientY - rect.top : el.clientHeight / 2
      pendingAnchorRef.current = makeAnchor(el.clientWidth / 2, fy)
      setScale(next)
      schedulePositionSave()
    },
    [makeAnchor, schedulePositionSave]
  )

  const fitWidth = useCallback(() => {
    if (sizes.length === 0 || containerWidth === 0) return
    zoomTo((containerWidth - SIDE_PAD) / sizes[0].w)
  }, [sizes, containerWidth, zoomTo])

  // Commit a pinch/ctrl-wheel gesture: swap the cheap CSS transform for a
  // crisp re-render at the accumulated scale. The transform is NOT removed
  // here — the commit effect does that once the new layout is in place, so
  // there is no jump or flash on release.
  const commitGesture = useCallback(() => {
    const g = gestureRef.current
    const el = containerRef.current
    if (!g || !el) return
    gestureRef.current = null
    window.clearTimeout(g.timer)
    const prev = scaleRef.current
    const next = clamp(prev * g.factor, ZOOM_MIN, ZOOM_MAX)
    const anchor = makeAnchor(g.fx, g.fy)
    if (next === prev || !anchor) {
      const inner = innerRef.current
      if (inner) {
        inner.style.transform = ''
        inner.style.willChange = ''
        inner.style.transformOrigin = '0 0'
      }
      updateRange()
      return
    }
    pendingAnchorRef.current = anchor
    setScale(next)
    schedulePositionSave()
  }, [makeAnchor, updateRange, schedulePositionSave])
  const commitGestureRef = useRef(commitGesture)
  commitGestureRef.current = commitGesture

  // Ctrl+wheel (and trackpad pinch, which Chromium reports as ctrl+wheel):
  // accumulate into a CSS transform for 60 fps feedback, re-render on settle.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const inner = innerRef.current
      if (!inner || scaleRef.current <= 0) return
      const rect = el.getBoundingClientRect()
      let g = gestureRef.current
      if (!g) {
        // Without a horizontal scrollbar pages stay centered after the commit,
        // so scale around the viewport's center axis to match; with one, scale
        // around the cursor.
        const hasHScroll = el.scrollWidth > el.clientWidth + 1
        const fx = hasHScroll ? e.clientX - rect.left : el.clientWidth / 2
        const fy = e.clientY - rect.top
        g = gestureRef.current = {
          factor: 1,
          originX: el.scrollLeft + fx,
          originY: el.scrollTop + fy,
          fx,
          fy,
          timer: 0
        }
        inner.style.willChange = 'transform'
        inner.style.transformOrigin = `${g.originX}px ${g.originY}px`
        setMenu((m) => (m ? null : m))
      }
      // Trackpad pinches arrive as many small deltas — scale the factor by
      // delta magnitude so the gesture tracks finger distance smoothly.
      const step = Math.exp(-e.deltaY * 0.0022)
      const target = clamp(scaleRef.current * g.factor * step, ZOOM_MIN, ZOOM_MAX)
      g.factor = target / scaleRef.current
      inner.style.transform = `scale(${g.factor})`
      window.clearTimeout(g.timer)
      g.timer = window.setTimeout(() => commitGestureRef.current(), GESTURE_SETTLE)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- Annotation + context menu ----------

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const addSessionAnnotation = useCallback((pageNumber: number, record: PageAnnotation) => {
    setSessionAnnots((prev) => {
      const next = new Map(prev)
      next.set(pageNumber, [...(prev.get(pageNumber) ?? []), record])
      return next
    })
  }, [])

  const persistAnnotation = useCallback(
    async (
      pageNumber: number,
      type: AnnotationType,
      quads: PageRect[],
      color: [number, number, number],
      opacity: number,
      contents?: string
    ) => {
      addSessionAnnotation(pageNumber, {
        id: nextAnnotationId(),
        type,
        quads,
        color,
        opacity,
        contents
      })
      const result = await bridge.annotate({
        path: payload.path,
        pageIndex: pageNumber - 1,
        type,
        quads,
        color,
        opacity,
        contents
      })
      if ('error' in result) showToast(`Kunne ikke lagre annotasjonen: ${result.error}`)
    },
    [payload.path, addSessionAnnotation, showToast]
  )

  /** Selection rects per page, for every rendered page the selection touches */
  const collectSelectionRects = useCallback((): { pageNumber: number; rects: PageRect[] }[] => {
    const el = containerRef.current
    const sel = window.getSelection()
    const out: { pageNumber: number; rects: PageRect[] }[] = []
    if (!el || !sel || sel.isCollapsed) return out
    for (const pageEl of el.querySelectorAll<HTMLElement>('.pdf-page')) {
      const rects = selectionRectsForPage(sel, pageEl, scaleRef.current)
      if (rects) out.push({ pageNumber: Number(pageEl.dataset.page), rects })
    }
    return out
  }, [])

  const applyMarkup = useCallback(
    (type: 'highlight' | 'underline' | 'strikeout', color: [number, number, number]) => {
      const perPage = collectSelectionRects()
      setMenu(null)
      if (perPage.length === 0) return
      const opacity = type === 'highlight' ? 0.5 : 1
      for (const { pageNumber, rects } of perPage) {
        void persistAnnotation(pageNumber, type, rects, color, opacity)
      }
      window.getSelection()?.removeAllRanges()
    },
    [collectSelectionRects, persistAnnotation]
  )

  const onMenuAction = useCallback(
    (action: MenuAction) => {
      const selText = window.getSelection()?.toString().trim().slice(0, 500) ?? ''
      switch (action.kind) {
        case 'highlight':
          applyMarkup('highlight', action.color.rgb)
          break
        case 'underline':
          applyMarkup('underline', UNDERLINE_COLOR)
          break
        case 'strikeout':
          applyMarkup('strikeout', STRIKEOUT_COLOR)
          break
        case 'note': {
          if (!menu) break
          if (menu.mode === 'selection') {
            const perPage = collectSelectionRects()
            const last = perPage.at(-1)
            if (last) {
              const r = last.rects[last.rects.length - 1]
              setNoteDraft({
                x: menu.x,
                y: menu.y,
                pageNumber: last.pageNumber,
                anchor: { x: r.x + r.w + 4, y: r.y, w: 20, h: 20 }
              })
            }
          } else if (menu.pagePoint) {
            setNoteDraft({
              x: menu.x,
              y: menu.y,
              pageNumber: menu.pageNumber,
              anchor: { x: menu.pagePoint.x, y: menu.pagePoint.y, w: 20, h: 20 }
            })
          }
          setMenu(null)
          break
        }
        case 'copy':
          if (selText) {
            navigator.clipboard?.writeText(window.getSelection()?.toString() ?? '').catch(() => {})
          }
          setMenu(null)
          break
        case 'search':
          if (selText) {
            bridge.openExternal(`https://www.google.com/search?q=${encodeURIComponent(selText)}`)
          }
          setMenu(null)
          break
        case 'dictionary':
          if (selText) {
            bridge.openExternal(
              `https://www.google.com/search?q=define+${encodeURIComponent(selText)}`
            )
          }
          setMenu(null)
          break
        case 'translate':
          if (selText) {
            bridge.openExternal(
              `https://translate.google.com/?sl=auto&tl=no&text=${encodeURIComponent(selText)}&op=translate`
            )
          }
          setMenu(null)
          break
      }
    },
    [menu, applyMarkup, collectSelectionRects]
  )

  const saveNote = useCallback(
    (text: string) => {
      if (!noteDraft) return
      void persistAnnotation(noteDraft.pageNumber, 'note', [noteDraft.anchor], NOTE_COLOR, 1, text)
      setNoteDraft(null)
      window.getSelection()?.removeAllRanges()
    },
    [noteDraft, persistAnnotation]
  )

  const openMenuAt = useCallback((clientX: number, clientY: number, target: EventTarget | null) => {
    const pageEl = (target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
    const sel = window.getSelection()
    const hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
    if (hasSelection) {
      const anchorNode = sel.anchorNode
      const anchorEl =
        anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null)
      const selPage = (anchorEl?.closest?.('.pdf-page') as HTMLElement | null) ?? pageEl
      if (!selPage) return
      setMenu({
        x: clientX,
        y: clientY,
        pageNumber: Number(selPage.dataset.page),
        mode: 'selection'
      })
    } else if (pageEl) {
      const rect = pageEl.getBoundingClientRect()
      setMenu({
        x: clientX,
        y: clientY,
        pageNumber: Number(pageEl.dataset.page),
        mode: 'point',
        pagePoint: {
          x: (clientX - rect.left) / scaleRef.current,
          y: (clientY - rect.top) / scaleRef.current
        }
      })
    } else {
      setMenu(null)
    }
  }, [])

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      openMenuAt(e.clientX, e.clientY, e.target)
    },
    [openMenuAt]
  )

  // PDF Expert-style: the menu pops up right after finishing a text selection
  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const { clientX, clientY, target } = e
      window.setTimeout(() => {
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          openMenuAt(clientX, clientY, target)
        }
      }, 0)
    },
    [openMenuAt]
  )

  const onMouseDown = useCallback(() => {
    setMenu((m) => (m ? null : m))
  }, [])

  // ---------- Chrome / fullscreen / keyboard ----------

  const toggleChrome = useCallback(() => {
    setChromeHidden((hidden) => {
      const next = !hidden
      setPeek(false)
      if (next) showToast('Distraksjonsfri lesing — trykk Esc for å vise verktøylinjen')
      return next
    })
  }, [showToast])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => {
      const next = !f
      bridge.setFullscreen(next)
      setChromeHidden(next)
      setPeek(false)
      if (next) showToast('Fullskjerm — trykk Esc eller F11 for å avslutte')
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

  // ---------- Navigation history ----------

  const pushBack = useCallback(() => {
    const current = computeCurrent()
    if (current) setBackStack((s) => [...s.slice(-49), current])
  }, [computeCurrent])

  /** Jump with a breadcrumb so the reader can return (sidebar, links, go-to) */
  const jumpToPage = useCallback(
    (page: number) => {
      pushBack()
      goToPage(page)
    },
    [pushBack, goToPage]
  )

  const goBack = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout) return
    setBackStack((stack) => {
      const target = stack[stack.length - 1]
      if (target) {
        const page = clamp(target.page, 1, layout.tops.length)
        el.scrollTop = layout.tops[page - 1] + target.offset * sizes[page - 1].h * scale - 8
      }
      return stack.slice(0, -1)
    })
  }, [layout, sizes, scale])

  const jumpToDest = useCallback(
    async (dest: unknown) => {
      const el = containerRef.current
      if (!pdf || !el || !layout) return
      try {
        const explicit =
          typeof dest === 'string' ? await pdf.getDestination(dest) : (dest as unknown[] | null)
        if (!Array.isArray(explicit) || explicit.length === 0) return
        const ref = explicit[0]
        const pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as never)
        if (pageIndex < 0 || pageIndex >= sizes.length) return
        pushBack()
        // XYZ destinations carry a precise y in PDF user space (bottom-up)
        const destName = (explicit[1] as { name?: string } | undefined)?.name
        let top = layout.tops[pageIndex] - 8
        if (destName === 'XYZ' && typeof explicit[3] === 'number') {
          const pageH = sizes[pageIndex].h
          top = layout.tops[pageIndex] + clamp(pageH - explicit[3], 0, pageH) * scale - 8
        }
        el.scrollTop = Math.max(0, top)
      } catch (err) {
        console.error('pdfx: klarte ikke å følge lenken', err)
      }
    },
    [pdf, layout, sizes, scale, pushBack]
  )

  // Stable identities for PdfPage — new callbacks would re-render page canvases
  const linkActionsRef = useRef({
    internal: (_d: unknown): void => {},
    external: (_u: string): void => {}
  })
  linkActionsRef.current = {
    internal: (d: unknown) => void jumpToDest(d),
    external: (u: string) => bridge.openExternal(u)
  }
  const onInternalLink = useCallback((d: unknown) => linkActionsRef.current.internal(d), [])
  const onExternalLink = useCallback((u: string) => linkActionsRef.current.external(u), [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === 'Escape') {
        if (noteDraft) setNoteDraft(null)
        else if (menu) setMenu(null)
        else if (fullscreen) toggleFullscreen()
        else if (chromeHidden) {
          setChromeHidden(false)
          setPeek(false)
        }
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [noteDraft, menu, fullscreen, chromeHidden, toggleFullscreen, zoomTo, fitWidth])

  // Focus the scroll container so PageUp/PageDown/arrows work immediately
  useEffect(() => {
    containerRef.current?.focus()
  }, [pdf])

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
      if (gestureRef.current) window.clearTimeout(gestureRef.current.timer)
      if (fullscreen) bridge.setFullscreen(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // ---------- Render ----------

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
    <div className={`viewer${chromeHidden ? ' chrome-hidden' : ''}`}>
      <div
        className={`toolbar-wrap${chromeHidden && !peek ? ' tucked' : ''}`}
        onMouseLeave={() => chromeHidden && setPeek(false)}
      >
        <Toolbar
          fileName={payload.name}
          page={currentPage}
          pageCount={sizes.length}
          zoomPercent={scale > 0 ? Math.round(scale * 100) : 100}
          settings={settings}
          resolvedTheme={resolvedTheme}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onBack={onClose}
          onGoToPage={jumpToPage}
          onZoomIn={() => zoomTo(scaleRef.current * 1.15)}
          onZoomOut={() => zoomTo(scaleRef.current / 1.15)}
          onFitWidth={fitWidth}
          onSettingsChange={onSettingsChange}
          onToggleChrome={toggleChrome}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
      {chromeHidden && <div className="reveal-zone" onMouseEnter={() => setPeek(true)} />}

      <div className="viewer-body">
        <Sidebar
          open={sidebarOpen && !chromeHidden}
          pdf={pdf}
          sizes={sizes}
          currentPage={currentPage}
          onJumpToPage={jumpToPage}
          onJumpToDest={(d) => void jumpToDest(d)}
        />

        <div
          className="pages"
          ref={containerRef}
          tabIndex={-1}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          onMouseUp={onMouseUp}
          onMouseDown={onMouseDown}
        >
          {layout && pdf ? (
            <div
              className="pages-inner"
              ref={innerRef}
              style={{ height: layout.total, width: layout.contentWidth }}
            >
              {sizes.map((size, i) => {
                const pageNumber = i + 1
                const active = pageNumber >= range[0] && pageNumber <= range[1]
                return (
                  <PdfPage
                    key={pageNumber}
                    pdf={pdf}
                    pageNumber={pageNumber}
                    top={layout.tops[i]}
                    left={layout.lefts[i]}
                    cssWidth={size.w * scale}
                    cssHeight={size.h * scale}
                    scale={scale}
                    active={active}
                    annotations={sessionAnnots.get(pageNumber) ?? EMPTY_ANNOTS}
                    onInternalLink={onInternalLink}
                    onExternalLink={onExternalLink}
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
      </div>

      {backStack.length > 0 && layout && (
        <button className="back-pill" onClick={goBack}>
          ‹ Tilbake til s. {backStack[backStack.length - 1].page}
        </button>
      )}

      {chromeHidden &&
        layout &&
        (pillEditing ? (
          <form
            className="page-pill editing"
            onSubmit={(e) => {
              e.preventDefault()
              const n = parseInt(pillInput, 10)
              if (!Number.isNaN(n)) jumpToPage(n)
              setPillEditing(false)
            }}
          >
            <input
              autoFocus
              value={pillInput}
              onChange={(e) => setPillInput(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={() => setPillEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setPillEditing(false)
                }
              }}
              aria-label="Gå til side"
            />
            <span>av {sizes.length}</span>
          </form>
        ) : (
          <button
            className="page-pill"
            title="Gå til side"
            onClick={() => {
              setPillInput(String(currentPage))
              setPillEditing(true)
            }}
          >
            {currentPage} av {sizes.length}
          </button>
        ))}

      {menu && <SelectionMenu menu={menu} onAction={onMenuAction} />}
      {noteDraft && (
        <NotePopover
          x={noteDraft.x}
          y={noteDraft.y}
          onSave={saveNote}
          onCancel={() => setNoteDraft(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

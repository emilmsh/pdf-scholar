import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorkerCtor from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import type {
  AnnotationType,
  FilePayload,
  PageRect,
  ReadingPosition,
  Settings,
  ThemeName
} from '../../../shared/types'
import { bridge, isElectron } from '../bridge'
import {
  FREETEXT_COLOR,
  FREETEXT_SIZE,
  MARKER_DEFAULT,
  MARKER_OPACITY,
  NOTE_COLOR,
  PEN_DEFAULT,
  SHAPE_DEFAULT,
  STRIKEOUT_COLOR,
  UNDERLINE_COLOR,
  annotTypeLabel,
  annotationAtPoint,
  fromPdfJsAnnotation,
  inkHitTest,
  nextAnnotationId,
  selectionRectsForPage
} from '../annotations'
import type {
  DrawTool,
  DrawToolType,
  PageAnnotation,
  PdfJsAnnotationData,
  ShapeToolType
} from '../annotations'
import AiPanel, { AiQuickPopover } from './AiPanel'
import type { AiQuickState, AiSeed, EnsuredDocument } from './AiPanel'
import { buildAiDocument } from '../ai'
import type { ResolvedCitation } from '../ai'
import AnnotPopover from './AnnotPopover'
import PdfPage from './PdfPage'
import Sidebar from './Sidebar'
import SearchBar from './SearchBar'
import Toolbar from './Toolbar'
import { NotePopover, SelectionMenu } from './SelectionMenu'
import type { MenuAction, MenuState } from './SelectionMenu'
import { locale, t, useLang } from '../i18n'
import { buildPageTexts, findMatches, resolveMatchRects } from '../search'
import type { PageText, SearchMatch, SearchOptions } from '../search'
import { collectExportRows, computeExcerpts, toHtml, toMarkdown, toPlainText } from '../annot-export'
import type { ExportFormat } from './Sidebar'

// One worker per open document (not a shared global port) so the document can
// be re-opened after the annotation engine rewrites the file on disk.
interface DocResources {
  task: PDFDocumentLoadingTask
  port: Worker
}

function openDocument(data: Uint8Array): DocResources {
  const port = new PdfWorkerCtor()
  const task = getDocument({ data, worker: PDFWorker.create({ port }) })
  return { task, port }
}

async function collectAnnotations(
  doc: PDFDocumentProxy
): Promise<Map<number, PageAnnotation[]>> {
  const map = new Map<number, PageAnnotation[]>()
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const raw = (await page.getAnnotations()) as PdfJsAnnotationData[]
    const records = raw
      .map((r) => fromPdfJsAnnotation(r, pageHeight))
      .filter((r): r is PageAnnotation => r !== null)
    if (records.length > 0) map.set(i, records)
  }
  return map
}

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
const EMPTY_RECTS: PageRect[] = []

interface PageSize {
  w: number
  h: number
}

interface AnnotPatch {
  color?: [number, number, number]
  contents?: string
}

/** Mutable identity for an annotation across undo/redo and document reloads */
interface AnnotHandle {
  pageNumber: number
  localId: string
  fileId: number | null
}

type UndoEntry =
  | { kind: 'create'; handle: AnnotHandle; snapshot: PageAnnotation }
  | { kind: 'delete'; handle: AnnotHandle; snapshot: PageAnnotation }
  | { kind: 'change'; handle: AnnotHandle; before: AnnotPatch; after: AnnotPatch }

interface NavPosition {
  page: number
  offset: number
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
  /** False when this viewer sits in a background tab: window-level listeners
   *  are disabled and the reading position is flushed */
  active: boolean
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
  active,
  settings,
  resolvedTheme,
  onSettingsChange,
  onClose
}: Props): React.JSX.Element {
  useLang()
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
  /** All annotations per page: 'file' records (painted by pdf.js) + 'session'
   *  records created now (painted by our overlay) */
  const [annots, setAnnots] = useState<ReadonlyMap<number, PageAnnotation[]>>(new Map())
  const [annotPopover, setAnnotPopover] = useState<{
    x: number
    y: number
    pageNumber: number
    localId: string
  } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [navStacks, setNavStacks] = useState<{ back: NavPosition[]; forward: NavPosition[] }>({
    back: [],
    forward: []
  })
  const [pillsFaded, setPillsFaded] = useState(false)
  const pillsTimerRef = useRef<number | null>(null)
  const [activeTool, setActiveTool] = useState<DrawToolType | null>(null)
  const [toolPrefs, setToolPrefs] = useState({
    pen: PEN_DEFAULT,
    marker: MARKER_DEFAULT,
    shape: SHAPE_DEFAULT
  })
  const [freeTextDraft, setFreeTextDraft] = useState<{
    pageNumber: number
    x: number
    y: number
    clientX: number
    clientY: number
  } | null>(null)

  const drawTool = useMemo<DrawTool | null>(() => {
    if (!activeTool) return null
    if (activeTool === 'eraser') return { type: 'eraser', color: [0, 0, 0], width: 0, opacity: 0 }
    if (activeTool === 'text') {
      return { type: 'text', color: FREETEXT_COLOR, width: 0, opacity: 1 }
    }
    if (activeTool === 'pen' || activeTool === 'marker') {
      const prefs = toolPrefs[activeTool]
      return {
        type: activeTool,
        color: prefs.color,
        width: prefs.width,
        opacity: activeTool === 'marker' ? MARKER_OPACITY : 1
      }
    }
    return { type: activeTool, color: toolPrefs.shape.color, width: toolPrefs.shape.width, opacity: 1 }
  }, [activeTool, toolPrefs])
  const drawToolRef = useRef(drawTool)
  drawToolRef.current = drawTool
  const [pillEditing, setPillEditing] = useState(false)
  const [pillInput, setPillInput] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({
    matchCase: false,
    wholeWords: false
  })
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [searchIndex, setSearchIndex] = useState(-1)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchHits, setSearchHits] = useState<{ pageNumber: number; rects: PageRect[] } | null>(
    null
  )
  const [aiOpen, setAiOpen] = useState(false)
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null)
  const [aiQuick, setAiQuick] = useState<AiQuickState | null>(null)
  /** Bumped to make the AI panel fire the "ask my annotations" question */
  const [annotsAskId, setAnnotsAskId] = useState(0)

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
  const pageTextsRef = useRef<PageText[] | null>(null)
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen
  const aiHitTimerRef = useRef<number | null>(null)
  const searchSeqRef = useRef(0)
  const gotoSeqRef = useRef(0)
  const searchJumpedRef = useRef(false)
  const annotsRef = useRef(annots)
  annotsRef.current = annots
  const [excerpts, setExcerpts] = useState<ReadonlyMap<string, string>>(new Map())

  // Recover the marked-up text for the sidebar list (debounced; text geometry
  // work happens off the interaction path)
  useEffect(() => {
    if (!pdf || annots.size === 0) return
    let stale = false
    const timer = window.setTimeout(async () => {
      try {
        const map = await computeExcerpts(pdf, annots)
        if (!stale) setExcerpts(map)
      } catch {
        /* excerpts are cosmetic */
      }
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [pdf, annots])

  // ---------- Document loading ----------

  const docResourcesRef = useRef<DocResources | null>(null)

  useEffect(() => {
    let destroyed = false
    // pdf.js transfers the underlying buffer to its worker, so hand it a copy
    const resources = openDocument(payload.data.slice())
    docResourcesRef.current = resources
    ;(async () => {
      const doc = await resources.task.promise
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
      const fileAnnots = await collectAnnotations(doc)
      if (!destroyed) setAnnots(fileAnnots)
    })().catch((err) => {
      if (!destroyed) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      destroyed = true
      // Destroy whatever is CURRENT (a reload may have swapped resources)
      docResourcesRef.current?.task.destroy()
      docResourcesRef.current?.port.terminate()
      docResourcesRef.current = null
    }
  }, [payload])

  /** Re-open the file after the engine rewrote it, seamlessly swapping the
   *  document (old canvases stay visible until re-rendered). */
  const reloadDocument = useCallback(async () => {
    if (!isElectron) return
    const result = await bridge.readFile(payload.path)
    if ('error' in result) return
    const resources = openDocument(result.data.slice())
    try {
      const doc = await resources.task.promise
      const fileAnnots = await collectAnnotations(doc)
      const old = docResourcesRef.current
      docResourcesRef.current = resources
      setPdf(doc)
      setAnnots(fileAnnots)
      old?.task.destroy()
      old?.port.terminate()
    } catch {
      resources.task.destroy()
      resources.port.terminate()
    }
  }, [payload.path])

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

  // Pick an initial zoom if none was restored: fit the WHOLE first page
  // (fit-page), so a fresh document opens centered without vertical cropping
  useEffect(() => {
    if (scale > 0 || sizes.length === 0 || containerWidth === 0) return
    const height = containerRef.current?.clientHeight || window.innerHeight - 60
    const fitW = (containerWidth - SIDE_PAD) / sizes[0].w
    const fitH = (height - PAD_TOP - PAD_BOTTOM) / sizes[0].h
    setScale(clamp(Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX))
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
  const layoutRef = useRef(layout)
  layoutRef.current = layout

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
    setAnnotPopover((p) => (p ? null : p))
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

  /** Snap a pinch-commit scale to fit-width/fit-height/fit-page when close.
   *  Tight threshold: the snap adjusts the committed scale away from what the
   *  gesture showed on screen, so anything above ~2.5% reads as a jump. */
  const snapScale = useCallback(
    (raw: number): number => {
      const el = containerRef.current
      if (!el || sizes.length === 0 || el.clientWidth === 0) return raw
      const { w, h } = sizes[0]
      const fitW = (el.clientWidth - SIDE_PAD) / w
      const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / h
      for (const candidate of [fitW, fitH, Math.min(fitW, fitH)]) {
        if (
          candidate >= ZOOM_MIN &&
          candidate <= ZOOM_MAX &&
          Math.abs(raw - candidate) / candidate < 0.025
        ) {
          return candidate
        }
      }
      return raw
    },
    [sizes]
  )

  // Commit a pinch/ctrl-wheel gesture: swap the cheap CSS transform for a
  // crisp re-render at the accumulated scale. The transform is NOT removed
  // here — the commit effect does that once the new layout is in place, so
  // there is no jump or flash on release. Mid-gesture commits skip the
  // fit-snap: snapping while the fingers are still moving fights the user.
  const commitGesture = useCallback((snap = true) => {
    const g = gestureRef.current
    const el = containerRef.current
    if (!g || !el) return
    gestureRef.current = null
    window.clearTimeout(g.timer)
    const prev = scaleRef.current
    const raw = clamp(prev * g.factor, ZOOM_MIN, ZOOM_MAX)
    const next = snap ? snapScale(raw) : raw
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
  }, [snapScale, makeAnchor, updateRange, schedulePositionSave])
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
      // delta magnitude so the gesture tracks finger distance. Mouse wheels
      // send big notches (±100+); give those a fixed, calmer step.
      const step =
        Math.abs(e.deltaY) >= 90
          ? e.deltaY < 0
            ? 1.18
            : 1 / 1.18
          : Math.exp(-e.deltaY * 0.0038)
      const target = clamp(scaleRef.current * g.factor * step, ZOOM_MIN, ZOOM_MAX)
      g.factor = target / scaleRef.current
      inner.style.transform = `scale(${g.factor})`
      window.clearTimeout(g.timer)
      // Long pinches blur (CSS-scaled canvas): re-render mid-gesture once the
      // factor drifts far enough; the anchored commit makes this seamless and
      // the next wheel event just starts a fresh gesture segment.
      if (g.factor > 1.3 || g.factor < 1 / 1.3) {
        commitGestureRef.current(false)
      } else {
        g.timer = window.setTimeout(() => commitGestureRef.current(), GESTURE_SETTLE)
      }
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

  /** Immutably patch one page's annotation list */
  const mutatePage = useCallback(
    (pageNumber: number, fn: (list: PageAnnotation[]) => PageAnnotation[]) => {
      setAnnots((prev) => {
        const next = new Map(prev)
        const list = fn(prev.get(pageNumber) ?? [])
        if (list.length > 0) next.set(pageNumber, list)
        else next.delete(pageNumber)
        return next
      })
    },
    []
  )

  // Annotations are identified across undo/redo cycles by a mutable handle:
  // re-creating an annotation gives it a NEW PDF object number, and a document
  // reload regenerates local ids — the handle tracks both.
  const matchesHandle = useCallback(
    (r: PageAnnotation, handle: AnnotHandle): boolean =>
      (handle.fileId !== null && r.fileId === handle.fileId) || r.id === handle.localId,
    []
  )

  const findRecord = useCallback(
    (handle: AnnotHandle): PageAnnotation | null =>
      (annotsRef.current.get(handle.pageNumber) ?? []).find((r) => matchesHandle(r, handle)) ??
      null,
    [matchesHandle]
  )

  /** Add + persist an annotation (used by user actions, redo-create, undo-delete) */
  const engineCreate = useCallback(
    async (handle: AnnotHandle, snapshot: PageAnnotation) => {
      const record: PageAnnotation = {
        ...snapshot,
        id: handle.localId,
        fileId: null,
        source: 'session'
      }
      mutatePage(handle.pageNumber, (list) => [...list, record])
      const result = await bridge.annotate({
        path: payload.path,
        pageIndex: handle.pageNumber - 1,
        type: snapshot.type,
        quads: snapshot.quads,
        color: snapshot.color,
        opacity: snapshot.opacity,
        contents: snapshot.contents,
        author: snapshot.author,
        strokes: snapshot.strokes,
        width: snapshot.width,
        fontSize: snapshot.fontSize
      })
      if ('error' in result) {
        showToast(t('viewer.annotSaveFailed', { error: result.error }))
        mutatePage(handle.pageNumber, (list) => list.filter((r) => r.id !== handle.localId))
      } else {
        handle.fileId = result.id
        mutatePage(handle.pageNumber, (list) =>
          list.map((r) => (r.id === handle.localId ? { ...r, fileId: result.id } : r))
        )
      }
    },
    [payload.path, mutatePage, showToast]
  )

  const engineDelete = useCallback(
    async (handle: AnnotHandle) => {
      const wasFilePainted = findRecord(handle)?.source === 'file'
      mutatePage(handle.pageNumber, (list) => list.filter((r) => !matchesHandle(r, handle)))
      if (handle.fileId === null) return
      const result = await bridge.deleteAnnotation({
        path: payload.path,
        pageIndex: handle.pageNumber - 1,
        id: handle.fileId
      })
      if ('error' in result) showToast(t('viewer.annotDeleteFailed', { error: result.error }))
      else if (wasFilePainted) void reloadDocument()
    },
    [payload.path, mutatePage, matchesHandle, findRecord, showToast, reloadDocument]
  )

  const engineChange = useCallback(
    async (handle: AnnotHandle, patch: AnnotPatch) => {
      const wasFilePainted = findRecord(handle)?.source === 'file'
      mutatePage(handle.pageNumber, (list) =>
        list.map((r) => (matchesHandle(r, handle) ? { ...r, ...patch } : r))
      )
      if (handle.fileId === null) {
        showToast(t('viewer.annotStillSaving'))
        return
      }
      const result = await bridge.updateAnnotation({
        path: payload.path,
        pageIndex: handle.pageNumber - 1,
        id: handle.fileId,
        ...patch
      })
      if ('error' in result) showToast(t('viewer.annotChangeFailed', { error: result.error }))
      // 'file' annots are painted by pdf.js from the file — refresh the canvas
      else if (wasFilePainted && patch.color) void reloadDocument()
    },
    [payload.path, mutatePage, matchesHandle, findRecord, showToast, reloadDocument]
  )

  // ---------- Undo / redo ----------

  const undoStackRef = useRef<UndoEntry[]>([])
  const redoStackRef = useRef<UndoEntry[]>([])
  const undoBusyRef = useRef(false)

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStackRef.current.push(entry)
    if (undoStackRef.current.length > 100) undoStackRef.current.shift()
    redoStackRef.current = []
  }, [])

  const performUndoRedo = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (undoBusyRef.current) return
      const source = direction === 'undo' ? undoStackRef : redoStackRef
      const target = direction === 'undo' ? redoStackRef : undoStackRef
      const entry = source.current.pop()
      if (!entry) return
      undoBusyRef.current = true
      try {
        if (entry.kind === 'create') {
          if (direction === 'undo') await engineDelete(entry.handle)
          else await engineCreate(entry.handle, entry.snapshot)
        } else if (entry.kind === 'delete') {
          if (direction === 'undo') await engineCreate(entry.handle, entry.snapshot)
          else await engineDelete(entry.handle)
        } else {
          await engineChange(entry.handle, direction === 'undo' ? entry.before : entry.after)
        }
        target.current.push(entry)
      } finally {
        undoBusyRef.current = false
      }
    },
    [engineCreate, engineDelete, engineChange]
  )

  // ---------- User-facing annotation actions ----------

  const persistAnnotation = useCallback(
    async (
      pageNumber: number,
      type: AnnotationType,
      quads: PageRect[],
      color: [number, number, number],
      opacity: number,
      contents?: string,
      extras?: { strokes?: [number, number][][]; width?: number; fontSize?: number }
    ) => {
      const handle: AnnotHandle = { pageNumber, localId: nextAnnotationId(), fileId: null }
      const snapshot: PageAnnotation = {
        id: handle.localId,
        fileId: null,
        source: 'session',
        type,
        quads,
        color,
        opacity,
        contents,
        author: 'PDF Scholar',
        strokes: extras?.strokes,
        width: extras?.width,
        fontSize: extras?.fontSize
      }
      pushUndo({ kind: 'create', handle, snapshot })
      await engineCreate(handle, snapshot)
    },
    [pushUndo, engineCreate]
  )

  const changeAnnotation = useCallback(
    (pageNumber: number, record: PageAnnotation, patch: AnnotPatch) => {
      const handle: AnnotHandle = { pageNumber, localId: record.id, fileId: record.fileId }
      const before: AnnotPatch = {}
      if (patch.color) before.color = record.color
      if (patch.contents !== undefined) before.contents = record.contents ?? ''
      pushUndo({ kind: 'change', handle, before, after: patch })
      void engineChange(handle, patch)
    },
    [pushUndo, engineChange]
  )

  const removeAnnotation = useCallback(
    (pageNumber: number, record: PageAnnotation) => {
      const handle: AnnotHandle = { pageNumber, localId: record.id, fileId: record.fileId }
      pushUndo({ kind: 'delete', handle, snapshot: { ...record } })
      setAnnotPopover(null)
      void engineDelete(handle)
    },
    [pushUndo, engineDelete]
  )

  // ---------- Freehand drawing ----------

  const completeStroke = useCallback(
    (pageNumber: number, points: [number, number][]) => {
      const tool = drawToolRef.current
      if (!tool || tool.type === 'eraser') return
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [x, y] of points) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      const pad = tool.width / 2 + 1
      const quads = [
        { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad }
      ]
      void persistAnnotation(pageNumber, 'ink', quads, tool.color, tool.opacity, undefined, {
        strokes: [points],
        width: tool.width
      })
    },
    [persistAnnotation]
  )

  const eraseAt = useCallback(
    (pageNumber: number, x: number, y: number) => {
      const list = annotsRef.current.get(pageNumber) ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        const record = list[i]
        if (record.type !== 'ink') continue
        if (inkHitTest(record, x, y, 4)) {
          removeAnnotation(pageNumber, record)
          return
        }
      }
    },
    [removeAnnotation]
  )

  const completeShape = useCallback(
    (pageNumber: number, type: ShapeToolType, a: [number, number], b: [number, number]) => {
      const tool = drawToolRef.current
      if (!tool) return
      const isLine = type === 'line' || type === 'arrow'
      const pad = isLine ? Math.max(6, tool.width * 3.2) : 0
      const quads = [
        {
          x: Math.min(a[0], b[0]) - pad,
          y: Math.min(a[1], b[1]) - pad,
          w: Math.abs(b[0] - a[0]) + 2 * pad,
          h: Math.abs(b[1] - a[1]) + 2 * pad
        }
      ]
      void persistAnnotation(pageNumber, type, quads, tool.color, 1, undefined, {
        width: tool.width,
        strokes: isLine ? [[a, b]] : undefined
      })
    },
    [persistAnnotation]
  )

  const placeFreeText = useCallback(
    (pageNumber: number, x: number, y: number, clientX: number, clientY: number) => {
      setFreeTextDraft({ pageNumber, x, y, clientX, clientY })
    },
    []
  )

  const saveFreeText = useCallback(
    (text: string) => {
      if (!freeTextDraft) return
      const lines = text.split('\n')
      const longest = Math.max(...lines.map((l) => l.length))
      const w = Math.min(260, Math.max(80, longest * FREETEXT_SIZE * 0.52 + 8))
      const h = lines.length * FREETEXT_SIZE * 1.35 + 8
      void persistAnnotation(
        freeTextDraft.pageNumber,
        'freetext',
        [{ x: freeTextDraft.x, y: freeTextDraft.y, w, h }],
        FREETEXT_COLOR,
        1,
        text,
        { fontSize: FREETEXT_SIZE }
      )
      setFreeTextDraft(null)
    },
    [freeTextDraft, persistAnnotation]
  )

  // Stable identities for PdfPage (fresh callbacks would re-render canvases)
  const drawActionsRef = useRef({
    stroke: completeStroke,
    erase: eraseAt,
    shape: completeShape,
    text: placeFreeText
  })
  drawActionsRef.current = {
    stroke: completeStroke,
    erase: eraseAt,
    shape: completeShape,
    text: placeFreeText
  }
  const onStrokeComplete = useCallback(
    (pageNumber: number, points: [number, number][]) =>
      drawActionsRef.current.stroke(pageNumber, points),
    []
  )
  const onEraseAt = useCallback(
    (pageNumber: number, x: number, y: number) => drawActionsRef.current.erase(pageNumber, x, y),
    []
  )
  const onShapeComplete = useCallback(
    (pageNumber: number, type: ShapeToolType, a: [number, number], b: [number, number]) =>
      drawActionsRef.current.shape(pageNumber, type, a, b),
    []
  )
  const onPlaceText = useCallback(
    (pageNumber: number, x: number, y: number, clientX: number, clientY: number) =>
      drawActionsRef.current.text(pageNumber, x, y, clientX, clientY),
    []
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
    (
      type: 'highlight' | 'underline' | 'strikeout' | 'squiggly',
      color: [number, number, number]
    ) => {
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
          applyMarkup('underline', action.color?.rgb ?? UNDERLINE_COLOR)
          break
        case 'strikeout':
          applyMarkup('strikeout', STRIKEOUT_COLOR)
          break
        case 'squiggly':
          applyMarkup('squiggly', UNDERLINE_COLOR)
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
        case 'ai': {
          if (!selText || !menu || !pdf) {
            setMenu(null)
            break
          }
          const { x, y, pageNumber } = menu
          const mode = action.mode
          setMenu(null)
          window.getSelection()?.removeAllRanges()
          // Fetch the page text (context) before opening the popover
          void (async () => {
            let pageContext = ''
            try {
              const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
              const pageText = texts[pageNumber - 1]?.text ?? ''
              const at = pageText.indexOf(selText.slice(0, 80))
              pageContext =
                at === -1
                  ? pageText.slice(0, 2000)
                  : pageText.slice(Math.max(0, at - 1000), at + selText.length + 1000)
            } catch {
              /* context is best-effort */
            }
            setAiQuick({ x, y, mode, selection: selText, pageNumber, pageContext })
          })()
          break
        }
      }
    },
    [menu, pdf, applyMarkup, collectSelectionRects]
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
      const pageNumber = Number(pageEl.dataset.page)
      const px = (clientX - rect.left) / scaleRef.current
      const py = (clientY - rect.top) / scaleRef.current
      // An annotation under the cursor takes precedence over the point menu
      const hit = annotationAtPoint(annotsRef.current.get(pageNumber) ?? [], px, py)
      if (hit) {
        setMenu(null)
        setAnnotPopover({ x: clientX, y: clientY, pageNumber, localId: hit.id })
        return
      }
      setMenu({
        x: clientX,
        y: clientY,
        pageNumber,
        mode: 'point',
        pagePoint: { x: px, y: py }
      })
    } else {
      setMenu(null)
    }
  }, [])

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (drawToolRef.current) return
      openMenuAt(e.clientX, e.clientY, e.target)
    },
    [openMenuAt]
  )

  // PDF Expert-style: the menu pops up right after finishing a text selection;
  // a plain click hit-tests annotations and opens the properties popover
  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || drawToolRef.current) return
      const { clientX, clientY, target } = e
      window.setTimeout(() => {
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          openMenuAt(clientX, clientY, target)
          return
        }
        const pageEl = (target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
        if (!pageEl) return
        const rect = pageEl.getBoundingClientRect()
        const pageNumber = Number(pageEl.dataset.page)
        const hit = annotationAtPoint(
          annotsRef.current.get(pageNumber) ?? [],
          (clientX - rect.left) / scaleRef.current,
          (clientY - rect.top) / scaleRef.current
        )
        if (hit) setAnnotPopover({ x: clientX, y: clientY, pageNumber, localId: hit.id })
      }, 0)
    },
    [openMenuAt]
  )

  const onMouseDown = useCallback(() => {
    setMenu((m) => (m ? null : m))
    setAnnotPopover((p) => (p ? null : p))
    // A lingering citation highlight releases on the next interaction with
    // the document (while searching, the search UI owns the highlight)
    if (!searchOpenRef.current) setSearchHits((h) => (h ? null : h))
  }, [])

  // ---------- Chrome / fullscreen / keyboard ----------

  const toggleChrome = useCallback(() => {
    setChromeHidden((hidden) => {
      const next = !hidden
      setPeek(false)
      if (next) showToast(t('viewer.distractionToast'))
      return next
    })
  }, [showToast])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => {
      const next = !f
      bridge.setFullscreen(next)
      setChromeHidden(next)
      setPeek(false)
      if (next) showToast(t('viewer.fullscreenToast'))
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

  const scrollToNavPosition = useCallback(
    (pos: NavPosition) => {
      const el = containerRef.current
      if (!el || !layout) return
      const page = clamp(pos.page, 1, layout.tops.length)
      el.scrollTop = layout.tops[page - 1] + pos.offset * sizes[page - 1].h * scale - 8
    },
    [layout, sizes, scale]
  )

  /** A NEW jump clears the forward stack (like browser history) */
  const pushBack = useCallback(() => {
    const current = computeCurrent()
    if (current) {
      setNavStacks(({ back }) => ({ back: [...back.slice(-49), current], forward: [] }))
    }
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
    const target = navStacks.back[navStacks.back.length - 1]
    if (!target) return
    const current = computeCurrent()
    scrollToNavPosition(target)
    setNavStacks(({ back, forward }) => ({
      back: back.slice(0, -1),
      forward: current ? [...forward, current] : forward
    }))
  }, [navStacks.back, computeCurrent, scrollToNavPosition])

  const goForward = useCallback(() => {
    const target = navStacks.forward[navStacks.forward.length - 1]
    if (!target) return
    const current = computeCurrent()
    scrollToNavPosition(target)
    setNavStacks(({ back, forward }) => ({
      back: current ? [...back, current] : back,
      forward: forward.slice(0, -1)
    }))
  }, [navStacks.forward, computeCurrent, scrollToNavPosition])

  // The nav pills fade out after idle time; navigation or hovering their
  // corner brings them back
  const revealPills = useCallback(() => {
    if (pillsTimerRef.current) window.clearTimeout(pillsTimerRef.current)
    setPillsFaded(false)
  }, [])

  const schedulePillsFade = useCallback((delay = 2600) => {
    if (pillsTimerRef.current) window.clearTimeout(pillsTimerRef.current)
    pillsTimerRef.current = window.setTimeout(() => setPillsFaded(true), delay)
  }, [])

  useEffect(() => {
    if (navStacks.back.length === 0 && navStacks.forward.length === 0) return
    revealPills()
    schedulePillsFade()
  }, [navStacks, revealPills, schedulePillsFade])

  const exportAnnotations = useCallback(
    async (format: ExportFormat) => {
      if (!pdf) return
      const rows = await collectExportRows(pdf, annotsRef.current)
      if (rows.length === 0) {
        showToast(t('viewer.nothingToExport'))
        return
      }
      const meta = { fileName: payload.name, exportedAt: new Date().toLocaleString(locale()) }
      const base = payload.name.replace(/\.pdf$/i, '')
      const suffix = t('export.suffix')
      const [content, name] =
        format === 'markdown'
          ? [toMarkdown(rows, meta), `${base} - ${suffix}.md`]
          : format === 'html'
            ? [toHtml(rows, meta), `${base} - ${suffix}.html`]
            : [toPlainText(rows, meta), `${base} - ${suffix}.txt`]
      const result = await bridge.saveTextFile(name, content)
      if (result && 'error' in result) showToast(t('viewer.saveFailed', { error: result.error }))
      else if (result) showToast(t('viewer.exported', { path: result.path }))
    },
    [pdf, payload.name, showToast]
  )

  const jumpToAnnot = useCallback(
    (pageNumber: number, record: PageAnnotation) => {
      const el = containerRef.current
      if (!el || !layout) return
      pushBack()
      const y = record.quads[0]?.y ?? 0
      el.scrollTop = Math.max(0, layout.tops[pageNumber - 1] + y * scale - el.clientHeight * 0.3)
    },
    [layout, scale, pushBack]
  )

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

  // ---------- Search ----------

  /** Poll until the page's text layer exists (it renders asynchronously) */
  const waitForTextLayer = useCallback(
    (pageNumber: number, timeoutMs = 4000): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        const t0 = Date.now()
        const tick = (): void => {
          const pageEl = containerRef.current?.querySelector<HTMLElement>(
            `.pdf-page[data-page="${pageNumber}"]`
          )
          if (pageEl?.querySelector('.text-host .textLayer > span')) return resolve(pageEl)
          if (Date.now() - t0 > timeoutMs) return resolve(pageEl ?? null)
          window.setTimeout(tick, 120)
        }
        tick()
      }),
    []
  )

  const gotoMatch = useCallback(
    async (matches: SearchMatch[], i: number, recordBack: boolean) => {
      const el = containerRef.current
      const lay = layoutRef.current
      const texts = pageTextsRef.current
      if (!el || !lay || !texts || matches.length === 0) return
      const match = matches[i]
      setSearchIndex(i)
      if (recordBack) pushBack()
      const seq = ++gotoSeqRef.current
      // Bring the page into view so its text layer renders, then refine
      el.scrollTop = Math.max(0, lay.tops[match.pageNumber - 1] - 8)
      updateRange()
      const pageEl = await waitForTextLayer(match.pageNumber)
      if (seq !== gotoSeqRef.current || !pageEl) return
      const rects = resolveMatchRects(pageEl, texts[match.pageNumber - 1], match, scaleRef.current)
      if (!rects) {
        setSearchHits(null)
        return
      }
      setSearchHits({ pageNumber: match.pageNumber, rects })
      const lay2 = layoutRef.current
      if (lay2) {
        el.scrollTop = Math.max(
          0,
          lay2.tops[match.pageNumber - 1] + rects[0].y * scaleRef.current - el.clientHeight * 0.35
        )
        updateRange()
        schedulePositionSave()
      }
    },
    [pushBack, updateRange, waitForTextLayer, schedulePositionSave]
  )

  // Debounced live search whenever the query/options change
  useEffect(() => {
    if (!searchOpen || !pdf) return
    const seq = ++searchSeqRef.current
    const query = searchQuery.trim()
    if (!query) {
      setSearchMatches([])
      setSearchIndex(-1)
      setSearchHits(null)
      setSearchBusy(false)
      return
    }
    setSearchBusy(true)
    const timer = window.setTimeout(async () => {
      try {
        const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
        if (seq !== searchSeqRef.current) return
        const matches = findMatches(texts, query, searchOptions)
        setSearchMatches(matches)
        setSearchBusy(false)
        if (matches.length > 0) {
          const recordBack = !searchJumpedRef.current
          searchJumpedRef.current = true
          void gotoMatch(matches, 0, recordBack)
        } else {
          setSearchIndex(-1)
          setSearchHits(null)
        }
      } catch {
        if (seq === searchSeqRef.current) setSearchBusy(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchOpen, searchQuery, searchOptions, pdf, gotoMatch])

  const openSearch = useCallback(() => {
    searchJumpedRef.current = false
    setSearchOpen(true)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchHits(null)
  }, [])

  const searchStep = useCallback(
    (delta: number) => {
      if (searchMatches.length === 0) return
      const next = (searchIndex + delta + searchMatches.length) % searchMatches.length
      void gotoMatch(searchMatches, next, false)
    },
    [searchMatches, searchIndex, gotoMatch]
  )

  // ---------- AI ----------

  const ensureAiDocument = useCallback(async (): Promise<EnsuredDocument | null> => {
    if (!pdf) return null
    const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
    return { pages, doc: buildAiDocument(pages) }
  }, [pdf])

  /** Citation chip clicked: jump to the cited passage and highlight it,
   *  reusing the search-hit overlay and the text-layer rect machinery */
  const jumpToAiCitation = useCallback(
    async (resolved: ResolvedCitation) => {
      const el = containerRef.current
      const lay = layoutRef.current
      const texts = pageTextsRef.current
      if (!el || !lay || !texts) return
      pushBack()
      const seq = ++gotoSeqRef.current
      el.scrollTop = Math.max(0, lay.tops[resolved.pageNumber - 1] - 8)
      updateRange()
      const pageEl = await waitForTextLayer(resolved.pageNumber)
      if (seq !== gotoSeqRef.current || !pageEl) return
      const rects = resolveMatchRects(
        pageEl,
        texts[resolved.pageNumber - 1],
        { ...resolved, snippet: '', snippetOffset: 0 },
        scaleRef.current
      )
      if (!rects || rects.length === 0) return
      setSearchHits({ pageNumber: resolved.pageNumber, rects })
      // The citation highlight releases by itself after a moment (or on the
      // next click in the document) — it's a pointer, not a selection
      if (aiHitTimerRef.current) window.clearTimeout(aiHitTimerRef.current)
      aiHitTimerRef.current = window.setTimeout(() => {
        if (!searchOpenRef.current) setSearchHits(null)
      }, 4000)
      const lay2 = layoutRef.current
      if (lay2) {
        el.scrollTop = Math.max(
          0,
          lay2.tops[resolved.pageNumber - 1] + rects[0].y * scaleRef.current - el.clientHeight * 0.35
        )
        updateRange()
        schedulePositionSave()
      }
    },
    [pushBack, updateRange, waitForTextLayer, schedulePositionSave]
  )

  const consumeAiSeed = useCallback(() => setAiSeed(null), [])

  /** The user's annotations as a compact text block for the AI (same data as
   *  the export: page, type, marked-up excerpt, comment) */
  const getAnnotationsText = useCallback(async (): Promise<string | null> => {
    if (!pdf) return null
    const rows = await collectExportRows(pdf, annotsRef.current)
    if (rows.length === 0) return null
    return rows
      .map(({ pageNumber, record, excerpt }) => {
        let line = `[${t('app.pageAbbrev')} ${pageNumber}] ${annotTypeLabel(record.type)}`
        if (excerpt) line += `: «${excerpt}»`
        if (record.contents) line += ` — ${record.contents}`
        return line
      })
      .join('\n')
  }, [pdf])

  const hasAnnotations = useMemo(
    () => [...annots.values()].some((list) => list.length > 0),
    [annots]
  )

  const askAnnotations = useCallback(() => {
    setAiOpen(true)
    setAnnotsAskId((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
      } else if (!isTyping && e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        void performUndoRedo('undo')
      } else if (
        !isTyping &&
        e.ctrlKey &&
        ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')
      ) {
        e.preventDefault()
        void performUndoRedo('redo')
      } else if (!isTyping && e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      } else if (!isTyping && e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        goForward()
      } else if (e.key === 'Escape') {
        if (freeTextDraft) setFreeTextDraft(null)
        else if (noteDraft) setNoteDraft(null)
        else if (menu) setMenu(null)
        else if (aiQuick) setAiQuick(null)
        else if (annotPopover) setAnnotPopover(null)
        else if (activeTool) setActiveTool(null)
        else if (searchOpen) closeSearch()
        else if (searchHits) setSearchHits(null)
        else if (aiOpen) setAiOpen(false)
        else if (fullscreen) toggleFullscreen()
        else if (chromeHidden) {
          setChromeHidden(false)
          setPeek(false)
        }
      } else if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openSearch()
      } else if (e.key === 'F3') {
        e.preventDefault()
        searchStep(e.shiftKey ? -1 : 1)
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
  }, [
    active,
    freeTextDraft,
    noteDraft,
    menu,
    aiQuick,
    aiOpen,
    annotPopover,
    activeTool,
    searchOpen,
    searchHits,
    fullscreen,
    chromeHidden,
    toggleFullscreen,
    closeSearch,
    openSearch,
    searchStep,
    zoomTo,
    fitWidth,
    performUndoRedo,
    goBack,
    goForward
  ])

  // Focus the scroll container so PageUp/PageDown/arrows work immediately
  useEffect(() => {
    if (active) containerRef.current?.focus()
  }, [pdf, active])

  // Persist the reading position immediately when the tab goes to the
  // background or the viewer unmounts (the debounced save may not have fired)
  const flushPosition = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    const current = computeCurrent()
    if (current) bridge.setPosition(payload.path, { ...current, zoom: scaleRef.current })
  }, [computeCurrent, payload.path])
  const flushPositionRef = useRef(flushPosition)
  flushPositionRef.current = flushPosition

  useEffect(() => {
    if (!active) flushPositionRef.current()
  }, [active])

  useEffect(() => () => flushPositionRef.current(), [])

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
      if (gestureRef.current) window.clearTimeout(gestureRef.current.timer)
      if (pillsTimerRef.current) window.clearTimeout(pillsTimerRef.current)
      if (aiHitTimerRef.current) window.clearTimeout(aiHitTimerRef.current)
      if (fullscreen) bridge.setFullscreen(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // ---------- Render ----------

  if (error) {
    return (
      <div className="viewer-error">
        <p>{t('viewer.errorTitle')}</p>
        <p className="viewer-error-detail">{error}</p>
        <button className="btn-primary" onClick={onClose}>
          {t('app.back')}
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
          canNavBack={navStacks.back.length > 0}
          canNavForward={navStacks.forward.length > 0}
          onNavBack={goBack}
          onNavForward={goForward}
          activeTool={activeTool}
          toolPrefs={toolPrefs}
          onToolSelect={setActiveTool}
          onToolPrefChange={(tool, patch) =>
            setToolPrefs((prev) => ({ ...prev, [tool]: { ...prev[tool], ...patch } }))
          }
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onBack={onClose}
          onGoToPage={jumpToPage}
          onZoomIn={() => zoomTo(scaleRef.current * 1.15)}
          onZoomOut={() => zoomTo(scaleRef.current / 1.15)}
          onFitWidth={fitWidth}
          onSettingsChange={onSettingsChange}
          onToggleSearch={() => (searchOpen ? closeSearch() : openSearch())}
          aiOpen={aiOpen}
          onToggleAi={() => setAiOpen((o) => !o)}
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
          annotations={annots}
          excerpts={excerpts}
          onJumpToPage={jumpToPage}
          onJumpToDest={(d) => void jumpToDest(d)}
          onJumpToAnnot={jumpToAnnot}
          onDeleteAnnot={removeAnnotation}
          onExport={(format) => void exportAnnotations(format)}
          onAskAi={askAnnotations}
        />

        <div
          className={`pages${drawTool ? ' drawing' : ''}`}
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
                    annotations={annots.get(pageNumber) ?? EMPTY_ANNOTS}
                    searchRects={
                      searchHits?.pageNumber === pageNumber ? searchHits.rects : EMPTY_RECTS
                    }
                    drawTool={drawTool}
                    onInternalLink={onInternalLink}
                    onExternalLink={onExternalLink}
                    onStrokeComplete={onStrokeComplete}
                    onErase={onEraseAt}
                    onShapeComplete={onShapeComplete}
                    onPlaceText={onPlaceText}
                  />
                )
              })}
            </div>
          ) : (
            <div className="viewer-loading">
              <div className="spinner" />
              <span>{t('viewer.opening', { name: payload.name })}</span>
            </div>
          )}
        </div>

        <AiPanel
          open={aiOpen && !chromeHidden}
          docTitle={payload.name}
          seed={aiSeed}
          onSeedConsumed={consumeAiSeed}
          ensureDocument={ensureAiDocument}
          hasAnnotations={hasAnnotations}
          annotsAskId={annotsAskId}
          getAnnotationsText={getAnnotationsText}
          onCitationClick={(resolved) => void jumpToAiCitation(resolved)}
          onClose={() => setAiOpen(false)}
        />
      </div>

      {(navStacks.back.length > 0 || navStacks.forward.length > 0) && layout && (
        <div
          className={`nav-pills${pillsFaded ? ' faded' : ''}`}
          onMouseEnter={revealPills}
          onMouseLeave={() => schedulePillsFade(1400)}
        >
          {navStacks.back.length > 0 && (
            <button className="back-pill" onClick={goBack} title="Alt+←">
              {t('viewer.backToPage', { page: navStacks.back[navStacks.back.length - 1].page })}
            </button>
          )}
          {navStacks.forward.length > 0 && (
            <button className="back-pill" onClick={goForward} title="Alt+→">
              {t('viewer.forwardToPage', { page: navStacks.forward[navStacks.forward.length - 1].page })}
            </button>
          )}
        </div>
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
              aria-label={t('tb.goToPage')}
            />
            <span>{t('viewer.ofPages', { count: sizes.length })}</span>
          </form>
        ) : (
          <button
            className="page-pill"
            title={t('tb.goToPage')}
            onClick={() => {
              setPillInput(String(currentPage))
              setPillEditing(true)
            }}
          >
            {currentPage} {t('viewer.ofPages', { count: sizes.length })}
          </button>
        ))}

      {searchOpen && (
        <SearchBar
          query={searchQuery}
          options={searchOptions}
          matches={searchMatches}
          index={searchIndex}
          busy={searchBusy}
          onQueryChange={setSearchQuery}
          onOptionsChange={setSearchOptions}
          onNext={() => searchStep(1)}
          onPrev={() => searchStep(-1)}
          onPick={(i) => void gotoMatch(searchMatches, i, false)}
          onClose={closeSearch}
        />
      )}

      {menu && <SelectionMenu menu={menu} onAction={onMenuAction} />}
      {aiQuick && (
        <AiQuickPopover
          state={aiQuick}
          onSendToChat={(seed) => {
            setAiSeed(seed)
            setAiQuick(null)
            setAiOpen(true)
          }}
          onClose={() => setAiQuick(null)}
        />
      )}
      {annotPopover &&
        (() => {
          const record = (annots.get(annotPopover.pageNumber) ?? []).find(
            (r) => r.id === annotPopover.localId
          )
          if (!record) return null
          return (
            <AnnotPopover
              x={annotPopover.x}
              y={annotPopover.y}
              annotation={record}
              onColor={(color) => changeAnnotation(annotPopover.pageNumber, record, { color })}
              onContents={(contents) =>
                changeAnnotation(annotPopover.pageNumber, record, { contents })
              }
              onDelete={() => removeAnnotation(annotPopover.pageNumber, record)}
            />
          )
        })()}
      {noteDraft && (
        <NotePopover
          x={noteDraft.x}
          y={noteDraft.y}
          onSave={saveNote}
          onCancel={() => setNoteDraft(null)}
        />
      )}
      {freeTextDraft && (
        <NotePopover
          x={freeTextDraft.clientX}
          y={freeTextDraft.clientY}
          onSave={saveFreeText}
          onCancel={() => setFreeTextDraft(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

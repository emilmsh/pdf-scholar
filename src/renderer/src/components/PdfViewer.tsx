import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorkerCtor from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import type {
  AiCitation,
  AnnotationType,
  FilePayload,
  PageRect,
  ReadingPosition,
  Settings,
  ThemeName,
  ViewRotation
} from '../../../shared/types'
import { bridge, isElectron } from '../bridge'
import { primaryMod } from '../platform'
import {
  FREETEXT_COLOR,
  FREETEXT_SIZE,
  HIGHLIGHT_FILL_ALPHA,
  MARKER_DEFAULT,
  MARKER_OPACITY,
  NOTE_COLOR,
  PEN_DEFAULT,
  SHAPE_DEFAULT,
  STRIKEOUT_COLOR,
  UNDERLINE_COLOR,
  annotTypeLabel,
  annotationAtPoint,
  annotationHitTest,
  fromPdfJsAnnotation,
  inkHitTest,
  isMovableAnnotation,
  markupDefaultColor,
  nextAnnotationId,
  selectionRectsForPage
} from '../annotations'
import type {
  DrawTool,
  DrawToolType,
  MarkupToolType,
  PageAnnotation,
  PdfJsAnnotationData,
  ShapeToolType
} from '../annotations'
import {
  buildRows,
  pageRectToView,
  viewDeltaToPage,
  viewPointToPage,
  viewRectToPage,
  viewSize
} from '../rotation'
import AiPanel, { AiQuickPopover } from './AiPanel'
import type { AiQuickState, AiSeed, EnsuredDocument } from './AiPanel'
import {
  browserCurrentBytes,
  registerBrowserDoc,
  releaseBrowserDoc
} from '../annotation-engine-browser'
import { registerPdfiumDoc, releasePdfiumDoc } from '../pdfium-renderer'
import {
  buildAiDocument,
  chatSystem,
  citationPage,
  estimateCost,
  formatCost,
  nextAiRequestId,
  resolveCitation,
  semanticSearchPrompt
} from '../ai'
import type { ResolvedCitation } from '../ai'
import AnnotPopover from './AnnotPopover'
import { IconPanelLeft, IconPanelRight, IconPause, IconPlay, IconStop } from './icons'
import { OverlayScrollbars } from './OverlayScrollbars'
import PdfPage from './PdfPage'
import PresentationMode from './PresentationMode'
import Sidebar from './Sidebar'
import SearchBar from './SearchBar'
import Toolbar from './Toolbar'
import { NotePopover, SelectionMenu } from './SelectionMenu'
import type { MenuAction, MenuState } from './SelectionMenu'
import { getLanguage, locale, t, useLang } from '../i18n'
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

// pdf.js side-loads binary companions from URLs: wasm image decoders (scanned
// pages are JBIG2/JPX — without wasmUrl they render BLANK), CJK CMaps, the 14
// standard fonts and a CMYK ICC profile. vite.pdfjs-assets.ts ships the dirs
// next to index.html in every target, so resolving against the page URL works
// under http (dev), file:// (packaged app) and chrome-extension:// (extension)
// — pdf.js falls back to XHR for the non-http schemes.
const pdfjsAssetUrl = (dir: string): string => new URL(`${dir}/`, document.baseURI).href

function openDocument(data: Uint8Array): DocResources {
  const port = new PdfWorkerCtor()
  const task = getDocument({
    data,
    worker: PDFWorker.create({ port }),
    wasmUrl: pdfjsAssetUrl('wasm'),
    cMapUrl: pdfjsAssetUrl('cmaps'),
    standardFontDataUrl: pdfjsAssetUrl('standard_fonts'),
    iccUrl: pdfjsAssetUrl('iccs')
  })
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
/** Horizontal gap between the two pages of a spread */
const SPREAD_GAP = 24
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

/** Drag-resizable panel widths: defaults, clamps and persistence. Left (TOC)
 *  and right (assistant/search) share identical defaults and clamps so the two
 *  sides look and behave the same — the owner wants them symmetric. */
const PANEL_DEFAULTS = { sidebar: 340, ai: 340, web: 340 }
const PANEL_MIN = { sidebar: 264, ai: 264, web: 264 }
const PANEL_MAX = { sidebar: 600, ai: 600, web: 600 }
type PanelKey = keyof typeof PANEL_DEFAULTS
const PANEL_LS_KEY = 'pdfx-panel-widths'

const TOOLBAR_PIN_LS_KEY = 'pdfx-toolbar-pinned'

/** Toolbar starts pinned unless the user unpinned it in a previous session */
function loadToolbarPinned(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_PIN_LS_KEY) !== '0'
  } catch {
    return true
  }
}

function saveToolbarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(TOOLBAR_PIN_LS_KEY, pinned ? '1' : '0')
  } catch {
    /* pin preference is best-effort */
  }
}

function loadPanelWidths(): Record<PanelKey, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_LS_KEY) ?? '{}')
    return {
      sidebar: clamp(Number(parsed.sidebar) || PANEL_DEFAULTS.sidebar, PANEL_MIN.sidebar, PANEL_MAX.sidebar),
      ai: clamp(Number(parsed.ai) || PANEL_DEFAULTS.ai, PANEL_MIN.ai, PANEL_MAX.ai),
      web: clamp(Number(parsed.web) || PANEL_DEFAULTS.web, PANEL_MIN.web, PANEL_MAX.web)
    }
  } catch {
    return { ...PANEL_DEFAULTS }
  }
}

interface PageSize {
  w: number
  h: number
}

interface AnnotPatch {
  color?: [number, number, number]
  contents?: string
  /** Note drag: replacement quads (engine gets quads[0] as the new rect) */
  quads?: PageRect[]
  /** Drag-move of an ink/line/arrow: replacement strokes */
  strokes?: [number, number][][]
  /** Drag-move: relative shift in page space — the engine reads its own
   *  current geometry and writes it back shifted (see ModifyAnnotationRequest) */
  translate?: { dx: number; dy: number }
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
  /** Presentation-mode state of the ACTIVE viewer — the app shell tucks the
   *  tab bar so the slideshow overlay owns the whole window */
  onPresentationChange(presenting: boolean): void
  /** Unsaved-changes state (save model) — App needs it for close prompts */
  onDirtyChange(dirty: boolean): void
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
  onPresentationChange,
  onDirtyChange,
  onClose
}: Props): React.JSX.Element {
  useLang()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  const [scale, setScale] = useState(initialPosition?.zoom ?? 0)
  /** User view rotation (clockwise) and two-page spread — display settings,
   *  persisted with the reading position, never written into the file */
  const [rotation, setRotation] = useState<ViewRotation>(initialPosition?.rotation ?? 0)
  const rotationRef = useRef(rotation)
  rotationRef.current = rotation
  const [spread, setSpread] = useState(initialPosition?.spread ?? false)
  const spreadRef = useRef(spread)
  spreadRef.current = spread
  const [containerWidth, setContainerWidth] = useState(0)
  const [range, setRange] = useState<[number, number]>([1, 1])
  const [currentPage, setCurrentPage] = useState(initialPosition?.page ?? 1)
  const [error, setError] = useState<string | null>(null)
  /** Edge-style toolbar auto-hide. Pinned (default) = always visible; unpinned
   *  = tucks away and reveals on top-edge hover. Persisted across sessions. */
  const [toolbarPinned, setToolbarPinned] = useState(loadToolbarPinned)
  const [toolbarPeek, setToolbarPeek] = useState(false)
  /** Acrobat-style one-page-at-a-time slideshow (own fullscreen overlay) */
  const [presentation, setPresentation] = useState(false)
  const presentationRef = useRef(presentation)
  presentationRef.current = presentation
  /** Transient edge-hover reveal of the side panels (quick look; retracts when
   *  the pointer moves back over the pages) */
  const [tocPeek, setTocPeek] = useState(false)
  const [aiPeek, setAiPeek] = useState(false)
  const tocPeekRef = useRef(tocPeek)
  tocPeekRef.current = tocPeek
  const aiPeekRef = useRef(aiPeek)
  aiPeekRef.current = aiPeek
  /** When a panel peek was last opened. A peek slides in from off-screen over
   *  the animation, so for a beat the cursor still sits over the pages in the
   *  region the panel is about to cover — retracting on that stray move makes
   *  the panel flicker in and straight back out. Hold the retract off briefly. */
  const peekOpenedAtRef = useRef(0)
  /** Which window edge the pointer is near. Only SHOWS the rail handle — the
   *  edge strip itself is never interactive, so the pages scrollbar (which
   *  lives exactly at the right edge) stays fully clickable/draggable. */
  const [edgeHint, setEdgeHint] = useState<'left' | 'right' | null>(null)
  /** Hover-intent timer: peek opens only after the pointer RESTS on the handle
   *  briefly, so passing by (or aiming for the scrollbar) never yanks the
   *  panel out. */
  const peekTimerRef = useRef<number | null>(null)
  /** Which fit the zoom is locked to: a fit mode re-fits when the available
   *  width changes (panel open/close, window resize) so the page never gets
   *  shoved off-centre; 'custom' preserves the exact scale */
  const [fitMode, setFitMode] = useState<'width' | 'page' | 'custom'>(
    initialPosition?.zoom ? 'custom' : 'page'
  )
  const fitModeRef = useRef(fitMode)
  fitModeRef.current = fitMode
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
  /** Selected annotation (accent frame). Outlives the popover — scrolling
   *  closes the popover but keeps the frame, per ux-planer.md §1. */
  const [selected, setSelected] = useState<{ pageNumber: number; localId: string } | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /** Side panels pinned open (persistent toggle from the toolbar or the edge
   *  rail); a panel is visible when pinned OR peeked */
  const [tocPinned, setTocPinned] = useState(false)
  const tocPinnedRef = useRef(tocPinned)
  tocPinnedRef.current = tocPinned
  /** Drag-resizable panel widths (px), persisted per user */
  const [panelW, setPanelW] = useState(loadPanelWidths)
  const panelWRef = useRef(panelW)
  panelWRef.current = panelW
  const [resizingPanel, setResizingPanel] = useState<PanelKey | null>(null)
  const [navStacks, setNavStacks] = useState<{ back: NavPosition[]; forward: NavPosition[] }>({
    back: [],
    forward: []
  })
  const [pillsFaded, setPillsFaded] = useState(false)
  const pillsTimerRef = useRef<number | null>(null)
  /** Distraction-free: scrollbar + page pill fade after idle, wake on activity */
  const [hudFaded, setHudFaded] = useState(false)
  const hudTimerRef = useRef<number | null>(null)
  const [activeTool, setActiveTool] = useState<DrawToolType | null>(null)
  /** Text-anchored markup tool (highlight/underline/strikeout/squiggly). It
   *  marks up the text selection on mouse-up and stays armed for the next one;
   *  mutually exclusive with the freehand draw tools. */
  const [markupTool, setMarkupTool] = useState<MarkupToolType | null>(null)
  const markupToolRef = useRef(markupTool)
  markupToolRef.current = markupTool
  const [markupColors, setMarkupColors] = useState<Record<MarkupToolType, [number, number, number]>>({
    highlight: markupDefaultColor('highlight'),
    underline: markupDefaultColor('underline'),
    strikeout: markupDefaultColor('strikeout'),
    squiggly: markupDefaultColor('squiggly')
  })
  const markupColorsRef = useRef(markupColors)
  markupColorsRef.current = markupColors
  const [toolPrefs, setToolPrefs] = useState({
    pen: PEN_DEFAULT,
    marker: MARKER_DEFAULT,
    shape: SHAPE_DEFAULT
  })
  /** The floating text-box editor. Carries its own box size (page points) so it
   *  is drag-resizable before commit; `editingId` is set when re-opening an
   *  existing FreeText annotation (double-click) so commit resizes/edits it in
   *  place rather than creating a new one. */
  const [freeTextDraft, setFreeTextDraft] = useState<{
    pageNumber: number
    x: number
    y: number
    clientX: number
    clientY: number
    w: number
    h: number
    editingId?: string
    text?: string
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
  const [searchHits, setSearchHits] = useState<{
    pageNumber: number
    rects: PageRect[]
    /** Citation-jump flash (holds then fades); absent for persistent search hits */
    flash?: boolean
  } | null>(null)
  // Semantic (AI) search mode alongside exact text search
  const [searchMode, setSearchMode] = useState<'text' | 'ai'>('text')
  const [semantic, setSemantic] = useState<{
    status: 'idle' | 'running' | 'done' | 'noKey' | 'error'
    hits: { label: string; citation: AiCitation; pageNumber: number | null }[]
    index: number
    note: string | null
    cost: string | null
  }>({ status: 'idle', hits: [], index: -1, note: null, cost: null })
  const semanticReqRef = useRef<number | null>(null)
  const [aiPinned, setAiPinned] = useState(false)
  const aiPinnedRef = useRef(aiPinned)
  aiPinnedRef.current = aiPinned
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null)
  const [aiQuick, setAiQuick] = useState<AiQuickState | null>(null)
  /** Bumped to make the AI panel fire the "ask my annotations" question */
  const [annotsAskId, setAnnotsAskId] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** The viewer root — used to reveal the unpinned toolbar from the whole top
   *  strip (tab bar included), so the pointer only has to reach the top edge. */
  const viewerRootRef = useRef<HTMLDivElement>(null)
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
    // In the browser the annotation engine edits an in-memory twin of the
    // document (desktop edits a draft file instead) — register the bytes so
    // bridge.annotate/update/delete have a document to write into.
    if (!isElectron) registerBrowserDoc(payload.path, payload.data)
    // Spike: when the PDFium raster flag is on, the same bytes also feed the
    // render engine (no-op otherwise — the register call guards on the flag)
    registerPdfiumDoc(payload.path, payload.data)
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
      if (!isElectron) void releaseBrowserDoc(payload.path)
      void releasePdfiumDoc(payload.path)
      // Destroy whatever is CURRENT (a reload may have swapped resources)
      docResourcesRef.current?.task.destroy()
      docResourcesRef.current?.port.terminate()
      docResourcesRef.current = null
    }
  }, [payload])

  /** Re-open the document after the engine rewrote it, seamlessly swapping it
   *  (old canvases stay visible until re-rendered). Desktop re-reads the draft
   *  file; the browser serializes the live in-memory document — same effect:
   *  pdf.js repaints file annotations as the engine now has them. */
  const reloadDocument = useCallback(async () => {
    let data: Uint8Array
    if (isElectron) {
      const result = await bridge.readFile(payload.path)
      if ('error' in result) return
      data = result.data
    } else {
      const bytes = await browserCurrentBytes(payload.path)
      if (!bytes) return
      data = bytes
    }
    // Fresh bytes carry the engine's annotation edits — the PDFium raster
    // source must see them too (no-op when the spike flag is off)
    registerPdfiumDoc(payload.path, data)
    const resources = openDocument(data.slice())
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

  // When a side panel is pinned open or closed the pages column changes width
  // in the SAME commit (flex reflow) — but the React layout (tops/lefts/
  // centring) would only catch up via ResizeObserver -> setContainerWidth,
  // which lands AFTER paint: the reader sees one frame of the old centring in
  // the new width (a sideways jump), then the re-centre, then the re-fit.
  // Resync everything synchronously here instead, pre-paint, so a panel
  // toggle paints exactly once: measured width, re-centred layout and (in fit
  // modes) the new fit scale all commit together.
  const pagesWidthRef = useRef(0)
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const newW = el.clientWidth
    const oldW = pagesWidthRef.current
    pagesWidthRef.current = newW
    if (oldW === newW) return
    if (fitModeRef.current === 'custom') {
      // Custom zoom keeps its exact scale — preserve the page point under the
      // viewport centre so the document isn't shoved sideways.
      if (oldW && newW && el.scrollWidth > newW + 1) {
        const center = el.scrollLeft + oldW / 2
        el.scrollLeft = Math.max(0, center - newW / 2)
      }
      setContainerWidth(newW)
    } else {
      // Fit modes: commit the new width AND the new fit scale in this same
      // pre-paint pass (refit anchors the viewport-centre page point; the
      // pending-anchor effect lands it against the fresh layout).
      setContainerWidth(newW)
      refitRef.current()
    }
  }, [tocPinned, aiPinned])

  // View-space reference dimensions (page units) that fit-width/fit-page zoom
  // against: the first page under the current rotation, widened to a pair when
  // spread is on.
  const fitDenom = useCallback((): { w: number; h: number } => {
    if (sizes.length === 0) return { w: 1, h: 1 }
    // Fit against the page currently in view, not always page 1 — so a document
    // that mixes portrait and landscape pages fits the page you are actually
    // reading (fit-width on a wide page fills the width, not overflows it).
    const idx = spread
      ? clamp(currentPage - 1 - ((currentPage - 1) % 2), 0, sizes.length - 1)
      : clamp(currentPage - 1, 0, sizes.length - 1)
    const v0 = viewSize(sizes[idx].w, sizes[idx].h, rotation)
    if (spread && idx + 1 < sizes.length) {
      const v1 = viewSize(sizes[idx + 1].w, sizes[idx + 1].h, rotation)
      return { w: v0.w + v1.w + SPREAD_GAP, h: Math.max(v0.h, v1.h) }
    }
    return { w: v0.w, h: v0.h }
  }, [sizes, rotation, spread, currentPage])

  // Pick an initial zoom if none was restored: fit the WHOLE first page
  // (fit-page), so a fresh document opens centered without vertical cropping
  useEffect(() => {
    if (scale > 0 || sizes.length === 0 || containerWidth === 0) return
    const height = containerRef.current?.clientHeight || window.innerHeight - 60
    const denom = fitDenom()
    const fitW = (containerWidth - SIDE_PAD) / denom.w
    const fitH = (height - PAD_TOP - PAD_BOTTOM) / denom.h
    setScale(clamp(Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX))
  }, [sizes, scale, containerWidth, fitDenom])

  // ---------- Layout ----------

  const layout = useMemo(() => {
    if (sizes.length === 0 || scale <= 0 || containerWidth === 0) return null
    return buildRows(sizes, scale, rotation, spread, {
      containerWidth,
      pageGap: PAGE_GAP,
      padTop: PAD_TOP,
      padBottom: PAD_BOTTOM,
      sidePad: SIDE_PAD,
      spreadGap: SPREAD_GAP
    })
  }, [sizes, scale, containerWidth, rotation, spread])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const computeCurrent = useCallback((): { page: number; offset: number } | null => {
    const el = containerRef.current
    if (!el || !layout) return null
    const anchor = el.scrollTop + el.clientHeight * 0.35
    // Walk rows (a spread row holds two pages); report the LEFT page of the row
    let row = layout.rows[0]
    for (const r of layout.rows) {
      if (r.top <= anchor) row = r
      else break
    }
    const pageIndex = row.pages[0].index
    const offset = clamp((el.scrollTop - layout.tops[pageIndex]) / layout.heights[pageIndex], 0, 1)
    return { page: pageIndex + 1, offset }
  }, [layout])

  const updateRange = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout) return
    const top = el.scrollTop - RENDER_MARGIN
    const bottom = el.scrollTop + el.clientHeight + RENDER_MARGIN
    let from = 1
    let to = 1
    for (let i = 0; i < layout.tops.length; i++) {
      const pageTop = layout.tops[i]
      const pageBottom = pageTop + layout.heights[i]
      if (pageBottom < top) from = i + 2
      if (pageTop <= bottom) to = i + 1
    }
    setRange((prev) => (prev[0] === from && prev[1] === to ? prev : [from, Math.max(from, to)]))
    const current = computeCurrent()
    if (current) setCurrentPage(current.page)
  }, [layout, computeCurrent])

  const schedulePositionSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const current = computeCurrent()
      if (current) {
        bridge.setPosition(payload.path, {
          ...current,
          zoom: scaleRef.current,
          rotation: rotationRef.current,
          spread: spreadRef.current
        })
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
      el.scrollTop = layout.tops[page - 1] + pos.offset * layout.heights[page - 1] - 8
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
    // `rotation` is in the deps deliberately: a rotate that changes the layout
    // must never leave a pending anchor (set under the old rotation) to be
    // consumed here with stale coords (rotateView also clears it).
  }, [scale, layout, rotation, updateRange])

  // "Immersive" reading = the toolbar auto-hides (unpinned). Drives the HUD
  // fade (scrollbar + page pill) and the floating page pill.
  const immersive = !toolbarPinned
  const immersiveRef = useRef(immersive)
  immersiveRef.current = immersive

  // Reveal the tucked toolbar from the ENTIRE top strip, not just a thin band
  // below the tab bar: a window-level move check treats everything at or above
  // (viewer top + a small margin) as the reveal zone. Because the tab bar sits
  // above the viewer's top edge, hovering it — or just shoving the pointer to
  // the very top of the screen — reveals the toolbar. Retract stays with the
  // toolbar-wrap's onMouseLeave so open dropdowns are never yanked away.
  useEffect(() => {
    if (!active || !immersive) return
    const onMove = (e: MouseEvent): void => {
      const top = viewerRootRef.current?.getBoundingClientRect().top ?? 0
      if (e.clientY <= top + 14) setToolbarPeek(true)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [active, immersive])

  // Edge-rail handles fade in when the pointer nears a side edge. This is a
  // pure visibility hint — no overlay strip intercepts events, so the pages
  // scrollbar at the right edge is always clickable and draggable.
  useEffect(() => {
    if (!active) return
    // Hysteresis: the hint arms close to the edge but stays alive across the
    // handle's full footprint (which reaches past the arm zone) — otherwise
    // the handle would fade out under the cursor at its inner edge.
    const ARM = 28
    const KEEP = 46
    const onMove = (e: MouseEvent): void => {
      if (drawToolRef.current) {
        setEdgeHint((h) => (h ? null : h))
        return
      }
      const left = e.clientX
      const right = window.innerWidth - e.clientX
      setEdgeHint((h) => {
        if (h === 'left' && left <= KEEP) return h
        if (h === 'right' && right <= KEEP) return h
        return left <= ARM ? 'left' : right <= ARM ? 'right' : null
      })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [active])

  const cancelPeekTimer = useCallback(() => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current)
      peekTimerRef.current = null
    }
  }, [])

  /** Open a peek after a short rest on the handle (hover-intent) */
  const armPeek = useCallback(
    (side: 'left' | 'right') => {
      cancelPeekTimer()
      peekTimerRef.current = window.setTimeout(() => {
        peekTimerRef.current = null
        peekOpenedAtRef.current = performance.now()
        if (side === 'left') setTocPeek(true)
        else setAiPeek(true)
      }, 120)
    },
    [cancelPeekTimer]
  )

  useEffect(() => cancelPeekTimer, [cancelPeekTimer])

  const onScroll = useCallback(() => {
    updateRange()
    schedulePositionSave()
    setMenu((m) => (m ? null : m))
    setAnnotPopover((p) => (p ? null : p))
    if (immersiveRef.current) wakeHudRef.current()
  }, [updateRange, schedulePositionSave])

  const wakeHudRef = useRef<() => void>(() => {})

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

  /** A hand-set zoom (buttons, keyboard, exact %) leaves the fit modes so the
   *  scale is preserved verbatim when panels open or the window resizes */
  const manualZoom = useCallback(
    (next: number, focalClientY?: number) => {
      setFitMode('custom')
      zoomTo(next, focalClientY)
    },
    [zoomTo]
  )

  const fitWidth = useCallback(() => {
    if (sizes.length === 0 || containerWidth === 0) return
    setFitMode('width')
    zoomTo((containerWidth - SIDE_PAD) / fitDenom().w)
  }, [sizes, containerWidth, zoomTo, fitDenom])

  /** Whole page visible (Edge-style toggle companion to fit-width) */
  const fitPage = useCallback(() => {
    const el = containerRef.current
    if (!el || sizes.length === 0 || el.clientWidth === 0) return
    setFitMode('page')
    const denom = fitDenom()
    const fitW = (el.clientWidth - SIDE_PAD) / denom.w
    const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h
    zoomTo(Math.min(fitW, fitH))
  }, [sizes, zoomTo, fitDenom])

  // Re-fit when the usable width changes (a side panel pinned open/closed, or
  // the window resized). In a fit mode the page rescales to the new width and
  // stays centred — no manual pan back. 'custom' zoom is left untouched (the
  // width-measure keeps its centre point instead).
  const refit = useCallback(() => {
    const el = containerRef.current
    const mode = fitModeRef.current
    if (!el || mode === 'custom' || sizes.length === 0) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    if (cw === 0) return
    const denom = fitDenom()
    const fitW = (cw - SIDE_PAD) / denom.w
    const fitH = (ch - PAD_TOP - PAD_BOTTOM) / denom.h
    const next = clamp(mode === 'width' ? fitW : Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX)
    const prev = scaleRef.current
    if (prev <= 0 || Math.abs(next - prev) / prev < 0.002) return
    pendingAnchorRef.current = makeAnchor(cw / 2, ch / 2)
    setScale(next)
    schedulePositionSave()
  }, [sizes, makeAnchor, schedulePositionSave, fitDenom])
  const refitRef = useRef(refit)
  refitRef.current = refit

  useEffect(() => {
    refitRef.current()
  }, [containerWidth])

  /** Which fit the toggle button should offer next: 'page' when we are at
   *  (or near) fit-width, otherwise 'width' */
  const fitTarget: 'width' | 'page' = useMemo(() => {
    if (sizes.length === 0 || containerWidth === 0) return 'page'
    const fitW = (containerWidth - SIDE_PAD) / fitDenom().w
    return Math.abs(scale - fitW) / fitW < 0.02 ? 'page' : 'width'
  }, [scale, sizes, containerWidth, fitDenom])

  /** Snap a pinch-commit scale to fit-width/fit-height/fit-page when close.
   *  Tight threshold: the snap adjusts the committed scale away from what the
   *  gesture showed on screen, so anything above ~2.5% reads as a jump. */
  const snapScale = useCallback(
    (raw: number): number => {
      const el = containerRef.current
      if (!el || sizes.length === 0 || el.clientWidth === 0) return raw
      const { w, h } = sizes[clamp(currentPage - 1, 0, sizes.length - 1)]
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
    [sizes, currentPage]
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
    setFitMode('custom')
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
            ? 1.22
            : 1 / 1.22
          : Math.exp(-e.deltaY * 0.006)
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

  // ---------- Touch input (Surface Pro & co.) ----------
  // Chromium only synthesizes ctrl+wheel for TRACKPAD pinches; fingers on the
  // glass arrive as touch events. One native handler set gives touch users:
  //  - two-finger pinch zoom (same CSS-preview + anchored-commit pipeline)
  //  - drag of movable annotations (scroll suppressed via touchstart)
  //  - edge swipe-in to open the side panels (the touch twin of hover-peek)
  //  - swipe down from the top strip to reveal a tucked toolbar
  // Long-press already works: Chromium synthesizes contextmenu for touch.
  const touchToolbarTimerRef = useRef<number | null>(null)
  /** pagePointFromClient is declared further down (after the annotation
   *  machinery) — the touch effect reads it through this ref to avoid TDZ */
  const pagePointFromClientRef = useRef<(x: number, y: number, el: HTMLElement) => [number, number]>(
    () => [0, 0]
  )
  /** Touch-revealed toolbar tucks itself back after a beat (no mouseleave on touch) */
  const revealToolbarTouch = useCallback(() => {
    setToolbarPeek(true)
    if (touchToolbarTimerRef.current) window.clearTimeout(touchToolbarTimerRef.current)
    touchToolbarTimerRef.current = window.setTimeout(() => setToolbarPeek(false), 6000)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !active) return
    const EDGE = 24
    const pinch = { active: false, startDist: 0 }
    const swipe = { edge: null as 'left' | 'right' | 'top' | null, x: 0, y: 0, done: false }

    const dist = (t: TouchList): number =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

    const beginPinchSegment = (t: TouchList): void => {
      const inner = innerRef.current
      if (!inner || scaleRef.current <= 0) return
      const rect = el.getBoundingClientRect()
      const midX = (t[0].clientX + t[1].clientX) / 2 - rect.left
      const midY = (t[0].clientY + t[1].clientY) / 2 - rect.top
      const hasHScroll = el.scrollWidth > el.clientWidth + 1
      const fx = hasHScroll ? midX : el.clientWidth / 2
      gestureRef.current = {
        factor: 1,
        originX: el.scrollLeft + fx,
        originY: el.scrollTop + midY,
        fx,
        fy: midY,
        timer: 0
      }
      inner.style.willChange = 'transform'
      inner.style.transformOrigin = `${gestureRef.current.originX}px ${gestureRef.current.originY}px`
      pinch.startDist = dist(t)
      pinch.active = true
      setMenu((m) => (m ? null : m))
    }

    const onTouchStart = (e: TouchEvent): void => {
      if (drawToolRef.current) return // the draw layer owns single-touch; pinch-while-drawing is a follow-up
      if (e.touches.length >= 2) {
        // Two fingers = pinch. preventDefault stops native panning/zooming so
        // we keep receiving moves; a stray swipe/drag in progress is dropped.
        e.preventDefault()
        swipe.edge = null
        annotDragRef.current = null
        if (!pinch.active) beginPinchSegment(e.touches)
        return
      }
      const t = e.touches[0]
      // Single finger on a movable annotation arms the same drag the mouse
      // path uses; preventDefault suppresses scrolling AND compat mouse events.
      if (!annotsHiddenRef.current) {
        const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
        if (pageEl) {
          const pageNumber = Number(pageEl.dataset.page)
          const [hx, hy] = pagePointFromClientRef.current(t.clientX, t.clientY, pageEl)
          const hit = annotationHitTest(annotsRef.current.get(pageNumber) ?? [], hx, hy)
          if (hit && isMovableAnnotation(hit) && hit.quads[0]) {
            e.preventDefault()
            annotDragRef.current = {
              pageNumber,
              record: hit,
              startClientX: t.clientX,
              startClientY: t.clientY,
              moved: false
            }
            return
          }
        }
      }
      // Edge starts arm a swipe-in: left/right open the panels, top reveals a
      // tucked toolbar. preventDefault so the browser doesn't claim the scroll.
      const rect = el.getBoundingClientRect()
      const fromLeft = t.clientX - rect.left
      const fromRight = rect.right - t.clientX
      const fromTop = t.clientY - rect.top
      if (immersiveRef.current && !toolbarPinned && fromTop <= EDGE) {
        swipe.edge = 'top'
      } else if (fromLeft <= EDGE) {
        swipe.edge = 'left'
      } else if (fromRight <= EDGE) {
        swipe.edge = 'right'
      } else {
        swipe.edge = null
        return
      }
      e.preventDefault()
      swipe.x = t.clientX
      swipe.y = t.clientY
      swipe.done = false
    }

    const onTouchMove = (e: TouchEvent): void => {
      if (pinch.active && e.touches.length >= 2) {
        e.preventDefault()
        const g = gestureRef.current
        const inner = innerRef.current
        if (!g || !inner) return
        const target = clamp(
          scaleRef.current * (dist(e.touches) / pinch.startDist),
          ZOOM_MIN,
          ZOOM_MAX
        )
        g.factor = target / scaleRef.current
        inner.style.transform = `scale(${g.factor})`
        // Long pinches blur (CSS-scaled canvas) — commit mid-gesture and start
        // a fresh segment, exactly like the wheel path.
        if (g.factor > 1.3 || g.factor < 1 / 1.3) {
          commitGestureRef.current(false)
          beginPinchSegment(e.touches)
        }
        return
      }
      if (annotDragRef.current) e.preventDefault() // pointermove drives the ghost
      if (swipe.edge && !swipe.done && e.touches.length === 1) {
        e.preventDefault()
        const t = e.touches[0]
        const dx = t.clientX - swipe.x
        const dy = t.clientY - swipe.y
        if (swipe.edge === 'top' && dy > 36 && Math.abs(dx) < 48) {
          swipe.done = true
          revealToolbarTouch()
        } else if (swipe.edge === 'left' && dx > 48 && Math.abs(dy) < 40) {
          swipe.done = true
          setTocPinned(true)
        } else if (swipe.edge === 'right' && dx < -48 && Math.abs(dy) < 40) {
          swipe.done = true
          setAiPinned(true)
        }
      }
    }

    const onTouchEnd = (e: TouchEvent): void => {
      if (pinch.active && e.touches.length < 2) {
        pinch.active = false
        commitGestureRef.current()
      }
      if (e.touches.length === 0) swipe.edge = null
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [active, toolbarPinned, revealToolbarTouch])

  // ---------- Annotation + context menu ----------

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // ---------- Rotation + spread (view actions) ----------

  /** The fit-mode scale for a hypothetical rotation/spread, or null when the
   *  zoom is 'custom' (left untouched). Reads live refs so it can be computed
   *  with the NEXT rotation/spread before the state has committed. */
  const computeFitScale = useCallback((rot: ViewRotation, spr: boolean): number | null => {
    const el = containerRef.current
    const s = sizesRef.current
    if (!el || fitModeRef.current === 'custom' || s.length === 0 || el.clientWidth === 0) return null
    const v0 = viewSize(s[0].w, s[0].h, rot)
    let dw = v0.w
    let dh = v0.h
    if (spr && s.length > 1) {
      const v1 = viewSize(s[1].w, s[1].h, rot)
      dw = v0.w + v1.w + SPREAD_GAP
      dh = Math.max(v0.h, v1.h)
    }
    const fitW = (el.clientWidth - SIDE_PAD) / dw
    const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / dh
    return clamp(fitModeRef.current === 'width' ? fitW : Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX)
  }, [])

  /** Re-anchor the reading position across a rotation/spread relayout: capture
   *  the current page + fractional offset into restoreRef so the same spot is
   *  scrolled back after the layout rebuilds (batched with the state change so
   *  it happens in one relayout — pinch anchor stays cleared, no jump). */
  const reanchorFor = useCallback(
    (rot: ViewRotation, spr: boolean): void => {
      const cur = computeCurrent()
      pendingAnchorRef.current = null
      const nextScale = computeFitScale(rot, spr)
      if (nextScale !== null) setScale(nextScale)
      if (cur) {
        restoreRef.current = {
          page: cur.page,
          offset: cur.offset,
          zoom: nextScale ?? scaleRef.current,
          rotation: rot,
          spread: spr
        }
      }
    },
    [computeCurrent, computeFitScale]
  )

  const rotateView = useCallback(
    (dir: 1 | -1) => {
      const next = ((((rotationRef.current + dir * 90) % 360) + 360) % 360) as ViewRotation
      // Draw tools assume an un-rotated page — deactivate on rotate
      setActiveTool((tool) => {
        if (tool) showToast(t('viewer.rotatedToolsOff'))
        return null
      })
      setFreeTextDraft(null)
      reanchorFor(next, spreadRef.current)
      setRotation(next)
      schedulePositionSave()
    },
    [reanchorFor, showToast, schedulePositionSave]
  )

  const toggleSpread = useCallback(() => {
    const next = !spreadRef.current
    reanchorFor(rotationRef.current, next)
    setSpread(next)
    schedulePositionSave()
  }, [reanchorFor, schedulePositionSave])

  /** Tool selection guarded by rotation — draw tools are off while rotated */
  const selectTool = useCallback(
    (tool: DrawToolType | null) => {
      if (tool && rotationRef.current !== 0) {
        showToast(t('viewer.rotatedToolsOff'))
        return
      }
      setActiveTool(tool)
      if (tool) setMarkupTool(null) // freehand and text-markup tools are exclusive
    },
    [showToast]
  )

  /** Arm/disarm a text-markup tool. Turning one on clears any freehand tool so
   *  the two modes never fight over the pointer. */
  const selectMarkupTool = useCallback((type: MarkupToolType | null) => {
    if (type) setActiveTool(null)
    setMarkupTool(type)
  }, [])

  // Hide all annotations (clean reading view) — hit-testing pauses too so
  // invisible annotations can't swallow clicks or show tooltips
  const [annotsHidden, setAnnotsHidden] = useState(false)
  const annotsHiddenRef = useRef(annotsHidden)
  annotsHiddenRef.current = annotsHidden

  // ---------- Panel resizing (sidebar / AI panel dividers) ----------

  const persistPanelWidths = (): void => {
    try {
      localStorage.setItem(PANEL_LS_KEY, JSON.stringify(panelWRef.current))
    } catch {
      /* width preference is best-effort */
    }
  }

  const beginPanelResize = useCallback((panel: PanelKey, e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWRef.current[panel]
    setResizingPanel(panel)
    const onMove = (ev: PointerEvent): void => {
      // The sidebar grows rightwards, the AI panel leftwards
      const raw = panel === 'sidebar' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX)
      const w = clamp(Math.round(raw), PANEL_MIN[panel], PANEL_MAX[panel])
      setPanelW((p) => (p[panel] === w ? p : { ...p, [panel]: w }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizingPanel(null)
      persistPanelWidths()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const resetPanelWidth = useCallback((panel: PanelKey) => {
    setPanelW((p) => ({ ...p, [panel]: PANEL_DEFAULTS[panel] }))
    window.setTimeout(persistPanelWidths, 0)
  }, [])

  // ---------- Save model (dirty = unsaved draft exists) ----------

  const [dirty, setDirty] = useState(false)
  const markDirtyRef = useRef<() => void>(() => {})
  markDirtyRef.current = () => setDirty(true)

  // Mirror the dirty flag up to App from an effect. Calling onDirtyChange
  // inside the setDirty updater looked equivalent, but React runs updaters
  // DURING render — updating App mid-render trips "Cannot update a component
  // while rendering a different component". App's setTabDirty bails on
  // unchanged values, so this can't ping-pong.
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  // A leftover draft from a previous session is loaded silently — surface it
  useEffect(() => {
    let stale = false
    void bridge.docIsDirty(payload.path).then((isDirty) => {
      if (stale || !isDirty) return
      setDirty(true)
      showToast(t('viewer.recovered'))
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.path])

  const saveDocument = useCallback(async () => {
    // Electron writes annotation changes back to the file in place via the
    // in-process engine.
    if (isElectron) {
      const result = await bridge.docSave(payload.path)
      if (result && 'error' in result) {
        showToast(t('viewer.saveFailed', { error: result.error }))
        return
      }
      setDirty(false)
      showToast(t('viewer.saved'))
      return
    }
    // Browser/extension: the engine's live document already carries every
    // annotation edit (create/update/delete — session AND pre-existing file
    // annotations). Serialize it, then overwrite the local file if it was
    // opened from disk, or save-picker/download for a URL-opened PDF.
    const bytes = await browserCurrentBytes(payload.path)
    if (!bytes) {
      showToast(t('viewer.saveFailed', { error: 'dokumentet er ikke åpent' }))
      return
    }
    const result = await bridge.saveDocumentBytes(payload.path, payload.name, bytes)
    if (!result) return // user cancelled the location picker
    if ('error' in result) {
      showToast(t('viewer.saveFailed', { error: result.error }))
      return
    }
    setDirty(false)
    showToast(t('viewer.saved'))
  }, [payload.path, payload.name, payload.data, showToast])

  // Save a copy to a user-chosen location. Electron pulls the current bytes
  // (draft-or-original) from `path`; the browser serializes its live document
  // so the copy carries annotation edits — parity with the desktop draft.
  const saveDocumentAs = useCallback(async () => {
    const bytes = isElectron ? payload.data.slice() : ((await browserCurrentBytes(payload.path)) ?? payload.data.slice())
    const result = await bridge.saveFileAs(payload.name, bytes, payload.path)
    if (!result) return // user cancelled the dialog
    if ('error' in result) {
      showToast(t('viewer.saveFailed', { error: result.error }))
      return
    }
    showToast(t('viewer.savedCopy'))
  }, [payload.name, payload.data, payload.path, showToast])

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
        fontSize: snapshot.fontSize,
        blend: snapshot.blend
      })
      if ('error' in result) {
        showToast(t('viewer.annotSaveFailed', { error: result.error }))
        mutatePage(handle.pageNumber, (list) => list.filter((r) => r.id !== handle.localId))
      } else {
        handle.fileId = result.id
        markDirtyRef.current()
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
      else {
        markDirtyRef.current()
        if (wasFilePainted) void reloadDocument()
      }
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
        color: patch.color,
        contents: patch.contents,
        rect: patch.translate ? undefined : patch.quads?.[0],
        translate: patch.translate
      })
      if ('error' in result) showToast(t('viewer.annotChangeFailed', { error: result.error }))
      else {
        markDirtyRef.current()
        // 'file' annots are painted by pdf.js from the file — refresh the canvas
        if (wasFilePainted && (patch.color || patch.quads || patch.strokes || patch.translate)) {
          void reloadDocument()
        }
      }
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
      extras?: {
        strokes?: [number, number][][]
        width?: number
        fontSize?: number
        blend?: 'multiply'
      }
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
        fontSize: extras?.fontSize,
        blend: extras?.blend
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
      if (patch.quads) before.quads = record.quads
      if (patch.strokes) before.strokes = record.strokes
      if (patch.translate) before.translate = { dx: -patch.translate.dx, dy: -patch.translate.dy }
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
      setSelected((s) => (s && s.localId === record.id ? null : s))
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
        width: tool.width,
        // The marker is the freehand twin of a text highlight: multiply keeps
        // the text under the stroke black, live and in the saved file alike
        blend: tool.type === 'marker' ? 'multiply' : undefined
      })
    },
    [persistAnnotation]
  )

  const eraseAt = useCallback(
    (pageNumber: number, x: number, y: number) => {
      const list = annotsRef.current.get(pageNumber) ?? []
      // Ink strokes first (path-precise hit), then any other annotation type
      for (let i = list.length - 1; i >= 0; i--) {
        const record = list[i]
        if (record.type !== 'ink') continue
        if (inkHitTest(record, x, y, 4)) {
          removeAnnotation(pageNumber, record)
          return
        }
      }
      const hit = annotationAtPoint(list, x, y)
      if (hit) removeAnnotation(pageNumber, hit)
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

  /** Re-open an existing FreeText box in the editor (double-click) so its text
   *  and box size can be changed after insertion; commit updates it in place. */
  const openFreeTextEditor = useCallback((pageNumber: number, record: PageAnnotation) => {
    const q = record.quads[0]
    if (!q) return
    setSelected(null)
    setAnnotPopover(null)
    setFreeTextDraft({
      pageNumber,
      x: q.x,
      y: q.y,
      clientX: 0,
      clientY: 0,
      w: q.w,
      h: q.h,
      editingId: record.id,
      text: record.contents ?? ''
    })
  }, [])

  const placeFreeText = useCallback(
    (pageNumber: number, x: number, y: number, clientX: number, clientY: number) => {
      // Pointerdown fires before the editor's blur: clicking outside an open
      // draft must commit it in place, never re-anchor it under the cursor.
      const editor = document.querySelector<HTMLTextAreaElement>('.freetext-editor')
      if (editor) {
        editor.blur()
        return
      }
      // Clicking an existing text box with the tool armed edits that box —
      // stacking a fresh draft on top of it is never what the user meant.
      const existing = annotationHitTest(
        (annotsRef.current.get(pageNumber) ?? []).filter((a) => a.type === 'freetext'),
        x,
        y
      )
      if (existing) {
        openFreeTextEditor(pageNumber, existing)
        return
      }
      setFreeTextDraft({ pageNumber, x, y, clientX, clientY, w: 200, h: 48 })
    },
    [openFreeTextEditor]
  )

  // Commit the editor. `wPt`/`hPt` are the editor's drag-resized box in page
  // points; editing an existing box resizes/edits it in place, otherwise a new
  // FreeText is created at the drawn box size.
  const saveFreeText = useCallback(
    (text: string, wPt?: number, hPt?: number) => {
      if (!freeTextDraft) return
      const w = wPt && wPt > 24 ? wPt : freeTextDraft.w
      const h = hPt && hPt > 14 ? hPt : freeTextDraft.h
      const rect = { x: freeTextDraft.x, y: freeTextDraft.y, w, h }
      if (freeTextDraft.editingId) {
        const record = (annotsRef.current.get(freeTextDraft.pageNumber) ?? []).find(
          (r) => r.id === freeTextDraft.editingId
        )
        if (record) changeAnnotation(freeTextDraft.pageNumber, record, { quads: [rect], contents: text })
        setFreeTextDraft(null)
        return
      }
      void persistAnnotation(freeTextDraft.pageNumber, 'freetext', [rect], FREETEXT_COLOR, 1, text, {
        fontSize: FREETEXT_SIZE
      })
      setFreeTextDraft(null)
      // Text boxes are one-shot: unlike pen strokes, nobody places several in
      // a row, and a lingering armed tool blocks selecting/moving the new box
      setActiveTool((tool) => (tool === 'text' ? null : tool))
    },
    [freeTextDraft, persistAnnotation, changeAnnotation]
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
      // selectionRectsForPage divides client offsets by scale → VIEW-space
      // rects (the on-screen rotated frame). Convert to PAGE space before they
      // become annotation quads written to the file.
      const viewRects = selectionRectsForPage(sel, pageEl, scaleRef.current)
      if (!viewRects) continue
      const pageNumber = Number(pageEl.dataset.page)
      const size = sizesRef.current[pageNumber - 1]
      const rot = rotationRef.current
      const rects =
        size && rot !== 0
          ? viewRects.map((r) => viewRectToPage(r, size.w, size.h, rot))
          : viewRects
      out.push({ pageNumber, rects })
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
      const opacity = type === 'highlight' ? HIGHLIGHT_FILL_ALPHA : 1
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
          applyMarkup('strikeout', action.color?.rgb ?? STRIKEOUT_COLOR)
          break
        case 'squiggly':
          applyMarkup('squiggly', action.color?.rgb ?? UNDERLINE_COLOR)
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
        case 'reference': {
          if (!selText || !menu || !pdf) {
            setMenu(null)
            break
          }
          const { x, y, pageNumber } = menu
          setMenu(null)
          window.getSelection()?.removeAllRanges()
          // Attach the whole document so the model can find the bibliography
          // entry itself; also grab local context around the citation.
          void (async () => {
            let pageContext = ''
            let document: { title: string; text: string; pageStarts: number[] } | null = null
            try {
              // Build the document inline (buildAiDocument is a module fn) —
              // ensureAiDocument is declared later in the component, so
              // depending on it here would hit the const TDZ.
              const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
              const doc = buildAiDocument(pages)
              document = { title: payload.name, text: doc.text, pageStarts: doc.pageStarts }
              const pageText = pages[pageNumber - 1]?.text ?? ''
              const at = pageText.indexOf(selText.slice(0, 80))
              pageContext =
                at === -1
                  ? pageText.slice(0, 1500)
                  : pageText.slice(Math.max(0, at - 800), at + selText.length + 800)
            } catch {
              /* context is best-effort */
            }
            setAiQuick({ x, y, mode: 'reference', selection: selText, pageNumber, pageContext, document })
          })()
          break
        }
      }
    },
    [menu, pdf, payload.name, applyMarkup, collectSelectionRects]
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

  // Convert client (screen) coordinates to PAGE space (what annotations store
  // and hit-tests expect), routing through the rotation transform. The one
  // boundary all pointer→page conversions go through — a raw
  // (clientX-rect.left)/scale would be VIEW space and corrupt coords when
  // rotated. Identity at rotation 0.
  const pagePointFromClient = useCallback(
    (clientX: number, clientY: number, pageEl: HTMLElement): [number, number] => {
      const rect = pageEl.getBoundingClientRect()
      const vx = (clientX - rect.left) / scaleRef.current
      const vy = (clientY - rect.top) / scaleRef.current
      const pageNumber = Number(pageEl.dataset.page)
      const size = sizesRef.current[pageNumber - 1]
      if (!size) return [vx, vy]
      return viewPointToPage(vx, vy, size.w, size.h, rotationRef.current)
    },
    []
  )
  pagePointFromClientRef.current = pagePointFromClient

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
      const pageNumber = Number(pageEl.dataset.page)
      const [px, py] = pagePointFromClient(clientX, clientY, pageEl)
      // An annotation under the cursor takes precedence over the point menu
      const hit = annotsHiddenRef.current
        ? null
        : annotationHitTest(annotsRef.current.get(pageNumber) ?? [], px, py)
      if (hit) {
        setMenu(null)
        setSelected({ pageNumber, localId: hit.id })
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
  }, [pagePointFromClient])

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
      // A completed note drag must not open the properties popover
      if (performance.now() - dragEndAtRef.current < 400) return
      const { clientX, clientY, target } = e
      window.setTimeout(() => {
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          // An armed text-markup tool marks the selection immediately (and stays
          // armed for the next one) instead of opening the selection menu.
          const mt = markupToolRef.current
          if (mt) {
            applyMarkup(mt, markupColorsRef.current[mt])
            return
          }
          openMenuAt(clientX, clientY, target)
          return
        }
        const pageEl = (target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
        if (!pageEl) {
          setSelected(null)
          return
        }
        const pageNumber = Number(pageEl.dataset.page)
        if (annotsHiddenRef.current) return
        const [px, py] = pagePointFromClient(clientX, clientY, pageEl)
        const hit = annotationHitTest(annotsRef.current.get(pageNumber) ?? [], px, py)
        if (hit) {
          // PDF Expert model: a single click SELECTS a text box (frame +
          // drag-to-move); double-click opens the text editor.
          setSelected({ pageNumber, localId: hit.id })
          setAnnotPopover({ x: clientX, y: clientY, pageNumber, localId: hit.id })
        } else {
          setSelected(null)
        }
      }, 0)
    },
    [openMenuAt, pagePointFromClient, applyMarkup]
  )

  // Double-click a text box to re-open it in the editor (edit text + resize the
  // box after insertion). Ignored while a draw/markup tool is armed.
  const onPagesDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (drawToolRef.current || markupToolRef.current) return
      const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
      if (!pageEl) return
      const pageNumber = Number(pageEl.dataset.page)
      const [px, py] = pagePointFromClient(e.clientX, e.clientY, pageEl)
      const hit = annotationHitTest(annotsRef.current.get(pageNumber) ?? [], px, py)
      if (hit && hit.type === 'freetext') {
        e.preventDefault()
        openFreeTextEditor(pageNumber, hit)
      }
    },
    [pagePointFromClient, openFreeTextEditor]
  )

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    setMenu((m) => (m ? null : m))
    setAnnotPopover((p) => (p ? null : p))
    // A lingering citation highlight releases on the next interaction with
    // the document (while searching, the search UI owns the highlight)
    if (!searchOpenRef.current) setSearchHits((h) => (h ? null : h))
    // Mousedown on a note bubble arms a drag (movement threshold decides
    // between drag and the plain click that opens the popover)
    if (e.button !== 0 || drawToolRef.current || annotsHiddenRef.current) return
    const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
    if (!pageEl) return
    const pageNumber = Number(pageEl.dataset.page)
    const [hx, hy] = pagePointFromClient(e.clientX, e.clientY, pageEl)
    const hit = annotationHitTest(annotsRef.current.get(pageNumber) ?? [], hx, hy)
    if (hit && isMovableAnnotation(hit) && hit.quads[0]) {
      annotDragRef.current = {
        pageNumber,
        record: hit,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false
      }
      e.preventDefault()
    }
  }, [pagePointFromClient])

  // ---------- Hover comment tooltip ----------

  const [hoverTip, setHoverTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const hoverThrottleRef = useRef(0)

  const onPagesMouseMove = useCallback((e: React.MouseEvent) => {
    const now = performance.now()
    if (now - hoverThrottleRef.current < 80) return
    hoverThrottleRef.current = now
    if (immersiveRef.current) wakeHudRef.current()
    // Moving back over the pages retracts any peeked edge panel — but not
    // during the slide-in, or the panel flickers straight back out (see
    // peekOpenedAtRef).
    if (now - peekOpenedAtRef.current > 260) {
      if (tocPeekRef.current) setTocPeek(false)
      if (aiPeekRef.current) setAiPeek(false)
    }
    if (drawToolRef.current || annotDragRef.current || annotsHiddenRef.current) {
      setHoverTip((tip) => (tip ? null : tip))
      return
    }
    const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
    if (!pageEl) {
      setHoverTip((tip) => (tip ? null : tip))
      return
    }
    const pageNumber = Number(pageEl.dataset.page)
    const [hx, hy] = pagePointFromClient(e.clientX, e.clientY, pageEl)
    const hit = annotationHitTest(annotsRef.current.get(pageNumber) ?? [], hx, hy)
    const text = hit?.type !== 'freetext' ? hit?.contents?.trim() : undefined
    if (text) {
      setHoverTip((tip) =>
        tip && tip.text === text ? tip : { x: e.clientX, y: e.clientY, text }
      )
    } else {
      setHoverTip((tip) => (tip ? null : tip))
    }
  }, [pagePointFromClient])

  // ---------- Annotation dragging (note bubbles + geometric shapes) ----------

  const annotDragRef = useRef<{
    pageNumber: number
    record: PageAnnotation
    startClientX: number
    startClientY: number
    moved: boolean
  } | null>(null)
  const dragEndAtRef = useRef(0)
  const [dragGhost, setDragGhost] = useState<{
    pageNumber: number
    x: number
    y: number
    w: number
    h: number
    color: [number, number, number]
    kind: 'bubble' | 'outline'
  } | null>(null)

  /** Where the dragged annotation lands for a given cursor position (page space, clamped) */
  const dragTarget = useCallback(
    (drag: NonNullable<typeof annotDragRef.current>, clientX: number, clientY: number) => {
      const q = drag.record.quads[0]
      const size = sizes[drag.pageNumber - 1]
      const scale = scaleRef.current
      // The cursor delta is a VIEW-space vector; rotate it into page space so
      // the annotation follows the pointer under any rotation.
      const view = viewDeltaToPage(
        (clientX - drag.startClientX) / scale,
        (clientY - drag.startClientY) / scale,
        rotationRef.current
      )
      const x = q.x + view.dx
      const y = q.y + view.dy
      return {
        x: clamp(x, 0, Math.max(0, (size?.w ?? q.x + q.w) - q.w)),
        y: clamp(y, 0, Math.max(0, (size?.h ?? q.y + q.h) - q.h))
      }
    },
    [sizes]
  )

  // Pointer events serve BOTH mouse and touch here: the mouse arms the drag in
  // onMouseDown, touch arms it in the touchstart handler (which suppresses
  // scrolling); either way these listeners move the ghost and commit the drop.
  useEffect(() => {
    if (!active) return
    const onMove = (e: PointerEvent): void => {
      const drag = annotDragRef.current
      if (!drag) return
      if (
        !drag.moved &&
        Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) < 3
      ) {
        return
      }
      drag.moved = true
      const { x, y } = dragTarget(drag, e.clientX, e.clientY)
      const q = drag.record.quads[0]
      setDragGhost({
        pageNumber: drag.pageNumber,
        x,
        y,
        w: q.w,
        h: q.h,
        color: drag.record.color,
        kind: drag.record.type === 'note' ? 'bubble' : 'outline'
      })
    }
    const onUp = (e: PointerEvent): void => {
      const drag = annotDragRef.current
      annotDragRef.current = null
      if (!drag) return
      setDragGhost(null)
      if (!drag.moved) {
        // Touch taps never get the compat mouseup (touchstart preventDefault
        // suppresses it), so give them the same affordance as a mouse click:
        // tap selects (frame + popover); a second tap on an already-selected
        // text box opens the editor (the touch stand-in for double-click).
        if (e.pointerType === 'touch') {
          const sel = selectedRef.current
          if (
            drag.record.type === 'freetext' &&
            sel?.pageNumber === drag.pageNumber &&
            sel.localId === drag.record.id
          ) {
            openFreeTextEditor(drag.pageNumber, drag.record)
          } else {
            setSelected({ pageNumber: drag.pageNumber, localId: drag.record.id })
            setAnnotPopover({
              x: e.clientX,
              y: e.clientY,
              pageNumber: drag.pageNumber,
              localId: drag.record.id
            })
          }
        }
        return
      }
      dragEndAtRef.current = performance.now()
      const { x, y } = dragTarget(drag, e.clientX, e.clientY)
      const q = drag.record.quads[0]
      const dx = x - q.x
      const dy = y - q.y
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return
      const patch: AnnotPatch = {
        quads: drag.record.quads.map((quad) => ({ ...quad, x: quad.x + dx, y: quad.y + dy })),
        translate: { dx, dy }
      }
      if (drag.record.strokes) {
        patch.strokes = drag.record.strokes.map((s) =>
          s.map(([px, py]) => [px + dx, py + dy] as [number, number])
        )
      }
      setSelected({ pageNumber: drag.pageNumber, localId: drag.record.id })
      changeAnnotation(drag.pageNumber, drag.record, patch)
    }
    const onCancel = (): void => {
      if (!annotDragRef.current) return
      annotDragRef.current = null
      setDragGhost(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [active, dragTarget, changeAnnotation, openFreeTextEditor])

  // ---------- Chrome / fullscreen / keyboard ----------

  /** Any activity wakes the reading HUD; it fades again after idle */
  const wakeHud = useCallback(() => {
    setHudFaded((f) => (f ? false : f))
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current)
    hudTimerRef.current = window.setTimeout(() => setHudFaded(true), 2600)
  }, [])
  wakeHudRef.current = wakeHud

  useEffect(() => {
    if (immersive) wakeHud()
    else {
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current)
      setHudFaded(false)
    }
  }, [immersive, wakeHud])

  // Only the active tab's presentation state drives the app shell (it tucks
  // the tab bar so the slideshow overlay owns the whole window).
  useEffect(() => {
    if (active) onPresentationChange(presentation)
  }, [active, presentation, onPresentationChange])

  // Pin / unpin the toolbar (Edge-style). Unpinned, it hides itself and
  // reveals on top-edge hover; the choice is remembered across sessions.
  // Unpinning is treated as "immersive reading": the side panels collapse to
  // hover-only too (their open state is remembered and restored on re-pin) so
  // the whole chrome gets out of the way in one gesture.
  const preUnpinPanelsRef = useRef<{ toc: boolean; ai: boolean } | null>(null)
  const togglePin = useCallback(() => {
    setToolbarPinned((pinned) => {
      const next = !pinned
      saveToolbarPinned(next)
      if (!next) {
        setToolbarPeek(false)
        preUnpinPanelsRef.current = { toc: tocPinnedRef.current, ai: aiPinnedRef.current }
        setTocPinned(false)
        setAiPinned(false)
        showToast(t('viewer.toolbarUnpinnedToast'))
      } else {
        // Restore panels that were open before unpinning, but never close one
        // the reader opened while immersive.
        const saved = preUnpinPanelsRef.current
        if (saved) {
          if (saved.toc) setTocPinned(true)
          if (saved.ai) setAiPinned(true)
          preUnpinPanelsRef.current = null
        }
      }
      return next
    })
  }, [showToast])

  // Fullscreen is just OS fullscreen — the pin state and presentation mode are
  // independent, and the user combines them as they like
  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => {
      const next = !f
      bridge.setFullscreen(next)
      if (next) showToast(t('viewer.fullscreenToast'))
      return next
    })
  }, [showToast])

  // Presentation mode: a self-contained fullscreen slideshow overlay. Entering
  // takes the window into OS fullscreen (if it wasn't already) so nothing but
  // the current page shows; exiting restores the previous fullscreen state.
  const presFullscreenRef = useRef(false)
  const enterPresentation = useCallback(() => {
    presFullscreenRef.current = !fullscreen
    if (!fullscreen) bridge.setFullscreen(true)
    setPresentation(true)
    setToolbarPeek(false)
    setTocPeek(false)
    setAiPeek(false)
    showToast(t('viewer.presentToast'))
  }, [fullscreen, showToast])

  const exitPresentation = useCallback(() => {
    setPresentation(false)
    if (presFullscreenRef.current) {
      presFullscreenRef.current = false
      bridge.setFullscreen(false)
    }
  }, [])

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
      const q = record.quads[0]
      const size = sizes[pageNumber - 1]
      // Scroll to the annotation's VIEW-space top so it lands correctly under
      // rotation (identity at rotation 0)
      const vy = q && size ? pageRectToView(q, size.w, size.h, rotation).y : (q?.y ?? 0)
      el.scrollTop = Math.max(0, layout.tops[pageNumber - 1] + vy * scale - el.clientHeight * 0.3)
    },
    [layout, scale, sizes, rotation, pushBack]
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
          const size = sizes[pageIndex]
          const pageY = clamp(size.h - explicit[3], 0, size.h)
          // Map the page-space y to view space so the link lands under rotation
          const vy = pageRectToView({ x: 0, y: pageY, w: 0, h: 0 }, size.w, size.h, rotation).y
          top = layout.tops[pageIndex] + vy * scale - 8
        }
        el.scrollTop = Math.max(0, top)
      } catch (err) {
        console.error('pdfx: klarte ikke å følge lenken', err)
      }
    },
    [pdf, layout, sizes, scale, rotation, pushBack]
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

  // Debounced live search whenever the query/options change (exact-text mode
  // only — AI mode searches on Enter, never live)
  useEffect(() => {
    if (!searchOpen || !pdf || searchMode === 'ai') return
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
    if (semanticReqRef.current !== null) {
      bridge.aiAbort(semanticReqRef.current)
      semanticReqRef.current = null
    }
    setSemantic({ status: 'idle', hits: [], index: -1, note: null, cost: null })
  }, [])

  // ---------- Semantic (AI) search ----------

  const runSemanticSearch = useCallback(async () => {
    if (!pdf) return
    const query = searchQuery.trim()
    if (!query) return
    const config = await bridge.aiGetConfig()
    if (!config.hasKey[config.provider]) {
      setSemantic({ status: 'noKey', hits: [], index: -1, note: null, cost: null })
      return
    }
    setSemantic({ status: 'running', hits: [], index: -1, note: null, cost: null })
    const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
    const doc = buildAiDocument(pages)
    const requestId = nextAiRequestId()
    semanticReqRef.current = requestId
    // System + document block are byte-identical to the chat panel so the
    // Anthropic prompt cache is shared; the search instruction is in the user
    // message only.
    const result = await bridge.aiChat({
      requestId,
      system: chatSystem(),
      messages: [{ role: 'user', text: semanticSearchPrompt(query) }],
      document: { title: payload.name, text: doc.text }
    })
    if (semanticReqRef.current !== requestId) return // superseded/aborted
    semanticReqRef.current = null
    if ('error' in result) {
      setSemantic({ status: 'error', hits: [], index: -1, note: result.error, cost: null })
      return
    }
    const hits: { label: string; citation: AiCitation; pageNumber: number | null }[] = []
    for (const part of result.parts) {
      const label = part.text.replace(/^\s*\d+[.)]\s*/, '').trim()
      for (const c of part.citations) {
        const fallback = c.kind === 'char' ? c.citedText : c.quote
        hits.push({ label: label || fallback.slice(0, 80), citation: c, pageNumber: citationPage(c, doc) })
      }
    }
    const cost = estimateCost(result.model, result.usage)
    setSemantic({
      status: 'done',
      hits,
      index: -1,
      note: hits.length === 0 ? result.parts.map((p) => p.text).join(' ').trim() : null,
      cost: cost !== null ? formatCost(cost) : null
    })
  }, [pdf, searchQuery, payload.name])

  const pickSemanticHit = useCallback(
    (i: number) => {
      const hit = semantic.hits[i]
      if (!hit) return
      setSemantic((s) => ({ ...s, index: i }))
      const pages = pageTextsRef.current
      if (!pages) return
      const doc = buildAiDocument(pages)
      const resolved = resolveCitation(hit.citation, pages, doc)
      if (resolved) void jumpToAiCitation(resolved)
      else if (hit.pageNumber && hit.pageNumber >= 1 && hit.pageNumber <= pages.length) {
        void jumpToAiCitation({ pageNumber: hit.pageNumber, start: 0, end: 0 })
      }
    },
    [semantic.hits]
  )

  const searchStep = useCallback(
    (delta: number) => {
      if (searchMatches.length === 0) return
      const next = (searchIndex + delta + searchMatches.length) % searchMatches.length
      void gotoMatch(searchMatches, next, false)
    },
    [searchMatches, searchIndex, gotoMatch]
  )

  // ---------- Read aloud ----------

  interface ReadSentence {
    pageNumber: number
    start: number
    end: number
    text: string
  }

  const [readAloud, setReadAloud] = useState<'closed' | 'playing' | 'paused'>('closed')
  const [readRate, setReadRate] = useState(1)
  const [readVoice, setReadVoice] = useState<string>('')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const readSessionRef = useRef<{
    sentences: ReadSentence[]
    index: number
    stopped: boolean
  } | null>(null)
  const readPrefsRef = useRef({ rate: 1, voiceURI: '' })
  readPrefsRef.current = { rate: readRate, voiceURI: readVoice }

  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const load = (): void => setVoices(synth.getVoices())
    load()
    synth.addEventListener('voiceschanged', load)
    return () => synth.removeEventListener('voiceschanged', load)
  }, [])

  // Default voice: match the app language when such a voice exists
  useEffect(() => {
    if (readVoice || voices.length === 0) return
    const wanted = getLanguage() === 'nb' ? ['nb', 'no'] : ['en']
    const match = voices.find((v) => wanted.some((p) => v.lang.toLowerCase().startsWith(p)))
    setReadVoice((match ?? voices.find((v) => v.default) ?? voices[0]).voiceURI)
  }, [voices, readVoice])

  /** The user picked a voice by hand — stop auto-selecting per document */
  const voiceManualRef = useRef(false)

  /** Crude but effective: is the document Norwegian or English? */
  const detectDocLanguage = useCallback((texts: PageText[]): 'nb' | 'en' => {
    const sample = texts
      .slice(0, 3)
      .map((p) => p.text)
      .join(' ')
      .toLowerCase()
      .slice(0, 4000)
    const nbHits =
      ((sample.match(/\b(og|ikke|det|som|på|til|med|har|å|skal|kan|fra|ved|også|eller|være)\b/g) ??
        []).length +
        (sample.match(/[æøå]/g) ?? []).length * 2)
    const enHits = (sample.match(/\b(the|of|and|that|with|this|from|which|are|have|been|their)\b/g) ??
      []).length
    return nbHits > enHits ? 'nb' : 'en'
  }, [])

  /** Best available voice for a language ("Natural" Windows voices first) */
  const pickVoiceFor = useCallback(
    (lang: 'nb' | 'en'): SpeechSynthesisVoice | null => {
      const prefixes = lang === 'nb' ? ['nb', 'no'] : ['en']
      const candidates = voices.filter((v) =>
        prefixes.some((p) => v.lang.toLowerCase().startsWith(p))
      )
      if (candidates.length === 0) return null
      return candidates.find((v) => /natural/i.test(v.name)) ?? candidates[0]
    },
    [voices]
  )

  /** Follow the spoken sentence: highlight it and keep it comfortably in view */
  const highlightSentence = useCallback(
    async (s: ReadSentence) => {
      const el = containerRef.current
      const lay = layoutRef.current
      const texts = pageTextsRef.current
      if (!el || !lay || !texts) return
      const pageTop = lay.tops[s.pageNumber - 1]
      if (Math.abs(el.scrollTop - pageTop) > el.clientHeight * 2) {
        el.scrollTop = Math.max(0, pageTop - 8)
        updateRange()
      }
      const pageEl = await waitForTextLayer(s.pageNumber)
      if (!pageEl || readSessionRef.current?.stopped !== false) return
      const rects = resolveMatchRects(
        pageEl,
        texts[s.pageNumber - 1],
        { pageNumber: s.pageNumber, start: s.start, end: s.end, snippet: '', snippetOffset: 0 },
        scaleRef.current
      )
      if (!rects || rects.length === 0) return
      setSearchHits({ pageNumber: s.pageNumber, rects })
      const lay2 = layoutRef.current
      if (!lay2) return
      const y = lay2.tops[s.pageNumber - 1] + rects[0].y * scaleRef.current
      const viewTop = el.scrollTop
      if (y < viewTop + 70 || y > viewTop + el.clientHeight - 150) {
        el.scrollTo({ top: Math.max(0, y - el.clientHeight * 0.3), behavior: 'smooth' })
      }
    },
    [updateRange, waitForTextLayer]
  )

  const speakFrom = useCallback(
    (index: number) => {
      const session = readSessionRef.current
      const synth = window.speechSynthesis
      if (!session || session.stopped || !synth) return
      if (index >= session.sentences.length) {
        session.stopped = true
        readSessionRef.current = null
        setReadAloud('closed')
        setSearchHits(null)
        return
      }
      session.index = index
      const s = session.sentences[index]
      const utterance = new SpeechSynthesisUtterance(s.text)
      utterance.rate = readPrefsRef.current.rate
      const voice = synth.getVoices().find((v) => v.voiceURI === readPrefsRef.current.voiceURI)
      if (voice) utterance.voice = voice
      utterance.onstart = () => void highlightSentence(s)
      utterance.onend = () => {
        if (readSessionRef.current === session && !session.stopped) speakFrom(index + 1)
      }
      utterance.onerror = () => {
        if (readSessionRef.current === session && !session.stopped) speakFrom(index + 1)
      }
      synth.speak(utterance)
    },
    [highlightSentence]
  )

  /** Split page texts into sentences with char offsets (from a given page) */
  const buildSentences = useCallback((texts: PageText[], fromPage: number): ReadSentence[] => {
    const out: ReadSentence[] = []
    for (let p = fromPage - 1; p < texts.length; p++) {
      const text = texts[p].text
      const regex = /[^.!?\n]+[.!?]*[\s]*/g
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const raw = match[0]
        const trimmed = raw.trim()
        if (trimmed.length < 2) continue
        const leading = raw.indexOf(trimmed[0])
        out.push({
          pageNumber: p + 1,
          start: match.index + leading,
          end: match.index + leading + trimmed.length,
          text: trimmed
        })
      }
    }
    return out
  }, [])

  const stopReadAloud = useCallback(() => {
    const session = readSessionRef.current
    if (session) session.stopped = true
    readSessionRef.current = null
    window.speechSynthesis?.cancel()
    setReadAloud('closed')
    setSearchHits(null)
  }, [])

  const startReadAloud = useCallback(async () => {
    if (!pdf || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
    const sentences = buildSentences(texts, currentPage)
    if (sentences.length === 0) return
    // Read English papers with an English voice even when the UI is Norwegian
    // (and vice versa) — unless the user picked a voice themselves
    if (!voiceManualRef.current) {
      const voice = pickVoiceFor(detectDocLanguage(texts))
      if (voice) {
        setReadVoice(voice.voiceURI)
        readPrefsRef.current.voiceURI = voice.voiceURI
      }
    }
    readSessionRef.current = { sentences, index: 0, stopped: false }
    setReadAloud('playing')
    speakFrom(0)
  }, [pdf, currentPage, buildSentences, speakFrom, detectDocLanguage, pickVoiceFor])

  const toggleReadPause = useCallback(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    setReadAloud((state) => {
      if (state === 'playing') {
        synth.pause()
        return 'paused'
      }
      if (state === 'paused') {
        synth.resume()
        return 'playing'
      }
      return state
    })
  }, [])

  // Never keep speaking from a background tab / after close
  useEffect(() => {
    if (!active && readSessionRef.current) stopReadAloud()
  }, [active, stopReadAloud])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])

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
      setSearchHits({ pageNumber: resolved.pageNumber, rects, flash: true })
      // The citation highlight releases by itself after a moment (or on the
      // next click in the document) — it's a pointer, not a selection
      if (aiHitTimerRef.current) window.clearTimeout(aiHitTimerRef.current)
      aiHitTimerRef.current = window.setTimeout(() => {
        if (!searchOpenRef.current) setSearchHits(null)
      }, 7000)
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
    setAiPinned(true)
    setAnnotsAskId((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA'
      // The presentation overlay owns the keyboard while it is open
      if (presentationRef.current) return
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
      } else if (!isTyping && primaryMod(e) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        void performUndoRedo('undo')
      } else if (
        !isTyping &&
        primaryMod(e) &&
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
      } else if (primaryMod(e) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        // Electron writes changes back in place (only when there are changes);
        // web/extension bakes annotations and saves to disk (overwrite/download).
        if (isElectron) {
          if (dirty) void saveDocument()
        } else {
          void saveDocument()
        }
      } else if (!isTyping && (e.key === 'Delete' || e.key === 'Backspace') && (selected ?? annotPopover)) {
        e.preventDefault()
        const target = selected ?? annotPopover!
        const record = (annotsRef.current.get(target.pageNumber) ?? []).find(
          (r) => r.id === target.localId
        )
        if (record) removeAnnotation(target.pageNumber, record)
      } else if (e.key === 'Escape') {
        if (freeTextDraft) setFreeTextDraft(null)
        else if (noteDraft) setNoteDraft(null)
        else if (menu) setMenu(null)
        else if (aiQuick) setAiQuick(null)
        else if (annotPopover) setAnnotPopover(null)
        else if (selected) setSelected(null)
        else if (activeTool) setActiveTool(null)
        else if (markupTool) setMarkupTool(null)
        else if (readAloud !== 'closed') stopReadAloud()
        else if (searchOpen) closeSearch()
        else if (searchHits) setSearchHits(null)
        else if (aiPinned) setAiPinned(false)
        else if (fullscreen) toggleFullscreen()
      } else if (primaryMod(e) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openSearch()
      } else if (e.key === 'F3') {
        e.preventDefault()
        searchStep(e.shiftKey ? -1 : 1)
      } else if (primaryMod(e) && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        manualZoom(scaleRef.current * 1.15)
      } else if (primaryMod(e) && e.key === '-') {
        e.preventDefault()
        manualZoom(scaleRef.current / 1.15)
      } else if (primaryMod(e) && e.key === '0') {
        // Actual size (100%), matching Acrobat/PDF Expert convention
        e.preventDefault()
        manualZoom(1)
      } else if (!isTyping && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Single-key reading shortcuts (never fire while typing)
        const k = e.key.toLowerCase()
        // Rotation MUST be checked before the k==='r' read-aloud branch below
        // (Shift+R rotates; bracket keys rotate too)
        if (e.shiftKey && k === 'r') {
          e.preventDefault()
          rotateView(1)
        } else if (k === ']') {
          e.preventDefault()
          rotateView(1)
        } else if (k === '[') {
          e.preventDefault()
          rotateView(-1)
        } else if (k === 'p') {
          e.preventDefault()
          enterPresentation()
        } else if (k === 't') {
          e.preventDefault()
          setTocPinned((o) => !o)
        } else if (k === 'a') {
          e.preventDefault()
          setAiPinned((o) => !o)
        } else if (k === 'v') {
          e.preventDefault()
          togglePin()
        } else if (k === 'h') {
          e.preventDefault()
          setAnnotsHidden((h) => !h)
        } else if (k === 'r') {
          e.preventDefault()
          if (readAloud === 'closed') void startReadAloud()
          else stopReadAloud()
        } else if (k === 'f') {
          e.preventDefault()
          toggleFullscreen()
        } else if (k === 'w') {
          e.preventDefault()
          if (fitTarget === 'page') fitPage()
          else fitWidth()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    active,
    enterPresentation,
    startReadAloud,
    fitTarget,
    fitPage,
    freeTextDraft,
    noteDraft,
    menu,
    aiQuick,
    aiPinned,
    annotPopover,
    selected,
    activeTool,
    markupTool,
    readAloud,
    stopReadAloud,
    dirty,
    saveDocument,
    saveDocumentAs,
    searchOpen,
    searchHits,
    fullscreen,
    toggleFullscreen,
    closeSearch,
    openSearch,
    searchStep,
    manualZoom,
    fitWidth,
    performUndoRedo,
    removeAnnotation,
    goBack,
    goForward,
    rotateView,
    togglePin
  ])

  // Hiding annotations (H) or activating a draw tool pauses hit-testing —
  // clear the selection frame so it never floats over a mode where it can't
  // be interacted with.
  useEffect(() => {
    if (annotsHidden || activeTool) {
      setSelected(null)
      setAnnotPopover(null)
    }
  }, [annotsHidden, activeTool])

  // Focus the scroll container so PageUp/PageDown/arrows work immediately
  useEffect(() => {
    if (active) containerRef.current?.focus()
  }, [pdf, active])

  // Persist the reading position immediately when the tab goes to the
  // background or the viewer unmounts (the debounced save may not have fired)
  const flushPosition = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    const current = computeCurrent()
    if (current)
      bridge.setPosition(payload.path, {
        ...current,
        zoom: scaleRef.current,
        rotation: rotationRef.current,
        spread: spreadRef.current
      })
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
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current)
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

  const toolbarVisible = toolbarPinned || toolbarPeek
  const tocVisible = tocPinned || tocPeek
  const aiVisible = aiPinned || aiPeek
  // The native web view only ever shows for the active tab (a background tab's
  // placeholder rect would float it over another document)
  return (
    <div
      ref={viewerRootRef}
      className={`viewer${immersive ? ' toolbar-unpinned' : ''}${immersive && hudFaded ? ' hud-faded' : ''}`}
    >
      <div
        className={`toolbar-wrap${toolbarVisible ? '' : ' tucked'}`}
        onMouseLeave={() => !toolbarPinned && setToolbarPeek(false)}
      >
        <Toolbar
          page={currentPage}
          pageCount={sizes.length}
          zoomPercent={scale > 0 ? Math.round(scale * 100) : 100}
          settings={settings}
          resolvedTheme={resolvedTheme}
          sidebarOpen={tocPinned}
          canNavBack={navStacks.back.length > 0}
          canNavForward={navStacks.forward.length > 0}
          onNavBack={goBack}
          onNavForward={goForward}
          activeTool={activeTool}
          toolPrefs={toolPrefs}
          onToolSelect={selectTool}
          activeMarkup={markupTool}
          markupColor={markupColors[markupTool ?? 'highlight']}
          onMarkupSelect={selectMarkupTool}
          onMarkupColorChange={(color) =>
            setMarkupColors((prev) => ({ ...prev, [markupTool ?? 'highlight']: color }))
          }
          spread={spread}
          onRotate={rotateView}
          onToggleSpread={toggleSpread}
          onToolPrefChange={(tool, patch) =>
            setToolPrefs((prev) => ({ ...prev, [tool]: { ...prev[tool], ...patch } }))
          }
          onToggleSidebar={() => setTocPinned((o) => !o)}
          onGoToPage={jumpToPage}
          onZoomIn={() => manualZoom(scaleRef.current * 1.15)}
          onZoomOut={() => manualZoom(scaleRef.current / 1.15)}
          onZoomTo={(percent) => manualZoom(percent / 100)}
          onFitWidth={fitWidth}
          onFitPage={fitPage}
          fitMode={fitMode}
          onSettingsChange={onSettingsChange}
          onToggleSearch={() => (searchOpen ? closeSearch() : openSearch())}
          dirty={dirty}
          onSave={() => void saveDocument()}
          onSaveAs={() => void saveDocumentAs()}
          canSaveInPlace={isElectron}
          annotsHidden={annotsHidden}
          onToggleAnnots={() => setAnnotsHidden((h) => !h)}
          onPrint={() => {
            void (async () => {
              // Browser parity: print the live document (annotation edits
              // included) via a blob in Chromium's viewer — the desktop prints
              // the draft file the same way through a hidden window.
              if (!isElectron) {
                const bytes = await browserCurrentBytes(payload.path)
                if (bytes) {
                  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
                  window.open(url, '_blank', 'noopener')
                  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
                  return
                }
              }
              const result = await bridge.printFile(payload.path)
              if (result && 'error' in result) showToast(t('viewer.printFailed', { error: result.error }))
            })()
          }}
          readAloudOpen={readAloud !== 'closed'}
          onToggleReadAloud={() => {
            if (readAloud === 'closed') void startReadAloud()
            else stopReadAloud()
          }}
          aiOpen={aiPinned}
          onToggleAi={() => setAiPinned((o) => !o)}
          toolbarPinned={toolbarPinned}
          onTogglePin={togglePin}
          onPresent={enterPresentation}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
      {/* Tucked-toolbar reveal: mouse hovers this top hot-zone; touch swipes
          down from the top edge (handled in the touch effect) — no permanent
          on-screen affordance. */}
      {immersive && <div className="reveal-zone" onMouseEnter={() => setToolbarPeek(true)} />}

      {/* Edge rails — pointer near an edge fades the HANDLE in (window-level
          hint, no interactive strip: the pages scrollbar at the right edge
          must stay clickable). Resting on the handle peeks the panel; click
          toggles it pinned. */}
      <div className={`edge-rail edge-rail-left${tocVisible ? ' panel-open' : ''}${edgeHint === 'left' && !tocVisible ? ' hint' : ''}`}>
        <span
          className="edge-rail-handle"
          title={t('tb.tocRailTip')}
          onMouseEnter={() => {
            if (!tocPinned) armPeek('left')
          }}
          onMouseLeave={cancelPeekTimer}
          onClick={() => {
            cancelPeekTimer()
            setTocPeek(false)
            setTocPinned((o) => !o)
          }}
        >
          <IconPanelLeft size={15} />
        </span>
      </div>
      <div className={`edge-rail edge-rail-right${aiVisible ? ' panel-open' : ''}${edgeHint === 'right' && !aiVisible ? ' hint' : ''}`}>
        <span
          className="edge-rail-handle"
          title={t('tb.aiRailTip')}
          onMouseEnter={() => {
            if (!aiPinned) armPeek('right')
          }}
          onMouseLeave={cancelPeekTimer}
          onClick={() => {
            cancelPeekTimer()
            setAiPeek(false)
            setAiPinned((o) => !o)
          }}
        >
          <IconPanelRight size={15} />
        </span>
      </div>

      <div
        className={`viewer-body${resizingPanel ? ' panel-resizing' : ''}${
          tocPeek && !tocPinned ? ' toc-peek' : ''
        }${aiPeek && !aiPinned ? ' ai-peek' : ''}`}
        style={{ '--sidebar-w': `${panelW.sidebar}px`, '--ai-w': `${panelW.ai}px` } as React.CSSProperties}
      >
        <Sidebar
          open={tocVisible}
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
        {tocPinned && (
          <div
            className={`panel-resizer${resizingPanel === 'sidebar' ? ' active' : ''}`}
            title={t('viewer.resizerTip')}
            onPointerDown={(e) => beginPanelResize('sidebar', e)}
            onDoubleClick={() => resetPanelWidth('sidebar')}
          />
        )}

        <div className="pages-host">
        <div
          className={`pages${drawTool ? ' drawing' : ''}`}
          ref={containerRef}
          tabIndex={-1}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          onMouseUp={onMouseUp}
          onMouseDown={onMouseDown}
          onDoubleClick={onPagesDoubleClick}
          onMouseMove={onPagesMouseMove}
          onMouseLeave={() => setHoverTip(null)}
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
                    docKey={payload.path}
                    pageNumber={pageNumber}
                    top={layout.tops[i]}
                    left={layout.lefts[i]}
                    cssWidth={layout.widths[i]}
                    cssHeight={layout.heights[i]}
                    scale={scale}
                    rotation={rotation}
                    pageW={size.w}
                    pageH={size.h}
                    active={active}
                    annotations={annots.get(pageNumber) ?? EMPTY_ANNOTS}
                    hideAnnots={annotsHidden}
                    selectedId={selected?.pageNumber === pageNumber ? selected.localId : null}
                    searchRects={
                      searchHits?.pageNumber === pageNumber ? searchHits.rects : EMPTY_RECTS
                    }
                    searchFlash={!!searchHits?.flash && searchHits.pageNumber === pageNumber}
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
              {freeTextDraft && (
                <textarea
                  className="freetext-editor"
                  autoFocus
                  spellCheck={false}
                  defaultValue={freeTextDraft.text ?? ''}
                  style={{
                    left: layout.lefts[freeTextDraft.pageNumber - 1] + freeTextDraft.x * scale,
                    top: layout.tops[freeTextDraft.pageNumber - 1] + freeTextDraft.y * scale,
                    width: freeTextDraft.w * scale,
                    height: freeTextDraft.h * scale,
                    fontSize: FREETEXT_SIZE * scale,
                    ...(freeTextDraft.editingId ? { background: 'rgba(255, 255, 255, 0.96)' } : {})
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') setFreeTextDraft(null)
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      const el = e.target as HTMLTextAreaElement
                      const value = el.value.trim()
                      if (value) saveFreeText(value, el.offsetWidth / scale, el.offsetHeight / scale)
                      else setFreeTextDraft(null)
                    }
                  }}
                  onBlur={(e) => {
                    const el = e.target
                    const value = el.value.trim()
                    if (value) saveFreeText(value, el.offsetWidth / scale, el.offsetHeight / scale)
                    else setFreeTextDraft(null)
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              )}
              {dragGhost &&
                (() => {
                  // The ghost is stored in page space; rotate it to view space
                  // so it tracks the pointer under rotation.
                  const size = sizes[dragGhost.pageNumber - 1]
                  const gv = size
                    ? pageRectToView(
                        { x: dragGhost.x, y: dragGhost.y, w: dragGhost.w, h: dragGhost.h },
                        size.w,
                        size.h,
                        rotation
                      )
                    : { x: dragGhost.x, y: dragGhost.y, w: dragGhost.w, h: dragGhost.h }
                  const style = {
                    left: layout.lefts[dragGhost.pageNumber - 1] + gv.x * scale,
                    top: layout.tops[dragGhost.pageNumber - 1] + gv.y * scale,
                    width: gv.w * scale,
                    height: gv.h * scale,
                    ...(dragGhost.kind === 'bubble'
                      ? { background: `rgb(${dragGhost.color.map((v) => Math.round(v * 255)).join(',')})` }
                      : {})
                  }
                  return (
                    <div
                      className={dragGhost.kind === 'bubble' ? 'note-drag-ghost' : 'annot-drag-ghost'}
                      style={style}
                    />
                  )
                })()}
            </div>
          ) : (
            <div className="viewer-loading">
              <div className="spinner" />
              <span>{t('viewer.opening', { name: payload.name })}</span>
            </div>
          )}
        </div>
        <OverlayScrollbars
          scrollRef={containerRef}
          layoutKey={layout ? `${layout.total}:${layout.contentWidth}` : 'none'}
        />
        </div>

        {aiPinned && (
          <div
            className={`panel-resizer${resizingPanel === 'ai' ? ' active' : ''}`}
            title={t('viewer.resizerTip')}
            onPointerDown={(e) => beginPanelResize('ai', e)}
            onDoubleClick={() => resetPanelWidth('ai')}
          />
        )}
        {/* Always mounted, collapsed to width 0 when closed — the EXACT
            structure of the left sidebar. Mount-on-hover was the source of
            the peek jank the left side never had. */}
        <div className={`right-panel${aiVisible ? ' open' : ''}`}>
          <div className="right-panel-body">
            <div className="right-pane">
              <AiPanel
                open={aiVisible}
                docTitle={payload.name}
                docPath={payload.path}
                seed={aiSeed}
                onSeedConsumed={consumeAiSeed}
                ensureDocument={ensureAiDocument}
                hasAnnotations={hasAnnotations}
                annotsAskId={annotsAskId}
                getAnnotationsText={getAnnotationsText}
                onCitationClick={(resolved) => void jumpToAiCitation(resolved)}
                onClose={() => {
                  setAiPeek(false)
                  setAiPinned(false)
                }}
              />
            </div>
          </div>
        </div>
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

      {!toolbarVisible &&
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
          mode={searchMode}
          onModeChange={setSearchMode}
          aiStatus={semantic.status}
          aiHits={semantic.hits.map((h) => ({ label: h.label, pageNumber: h.pageNumber }))}
          aiIndex={semantic.index}
          aiNote={semantic.note}
          aiCost={semantic.cost}
          onAiSearch={() => void runSemanticSearch()}
          onAiPick={pickSemanticHit}
          onOpenAiSettings={() => {
            closeSearch()
            setAiPinned(true)
          }}
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
            setAiPinned(true)
          }}
          onCitation={(c) => {
            const pages = pageTextsRef.current
            if (!pages) return
            const doc = buildAiDocument(pages)
            const resolved = resolveCitation(c, pages, doc)
            if (resolved) void jumpToAiCitation(resolved)
            else {
              const p = citationPage(c, doc)
              if (p && p >= 1 && p <= pages.length) void jumpToAiCitation({ pageNumber: p, start: 0, end: 0 })
            }
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
      {readAloud !== 'closed' && (
        <div className="readaloud-bar">
          <button className="tb-btn" onClick={toggleReadPause} title={t('ra.playPause')}>
            {readAloud === 'playing' ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <button className="tb-btn" onClick={stopReadAloud} title={t('ra.stop')}>
            <IconStop size={16} />
          </button>
          <select
            className="readaloud-rate"
            value={readRate}
            title={t('ra.rate')}
            onChange={(e) => setReadRate(Number(e.target.value))}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <select
            className="readaloud-voice"
            value={readVoice}
            title={t('ra.voice')}
            onChange={(e) => {
              voiceManualRef.current = true
              setReadVoice(e.target.value)
            }}
          >
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {hoverTip && !menu && !annotPopover && !noteDraft && (
        <div
          className="annot-hover-tip"
          style={{
            left: Math.min(hoverTip.x + 12, window.innerWidth - 280),
            top: Math.min(hoverTip.y + 14, window.innerHeight - 120)
          }}
        >
          {hoverTip.text}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {presentation && pdf && sizes.length > 0 && (
        <PresentationMode
          pdf={pdf}
          sizes={sizes}
          initialPage={currentPage}
          resolvedTheme={resolvedTheme}
          onPageChange={(page) => {
            setCurrentPage(page)
            goToPage(page)
          }}
          onExit={exitPresentation}
        />
      )}
    </div>
  )
}

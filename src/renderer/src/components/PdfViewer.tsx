import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { isPasswordException, openDocument } from '../pdf-doc'
import type { DocResources } from '../pdf-doc'
import { renderPagesAsImages as renderAiPageImages } from '../ai-page-images'
import type {
  AiCitation,
  AiImage,
  AnnotationType,
  DocBookmark,
  DocSignature,
  FileError,
  FilePayload,
  PageRect,
  ReadingPosition,
  Settings,
  ThemeName,
  ViewRotation
} from '../../../shared/types'
import { bridge, isElectron, isExtension } from '../bridge'
import { prettyModelName } from './ai-models'
import { bubblesWhileTyping, commandForEvent, isKeyboardCaptured, shortcutLabel } from '../keymap'
import { READ_ALOUD } from '../flags'
import {
  FREETEXT_SIZE,
  MIN_SHAPE_SIZE,
  NOTE_COLOR,
  STRIKEOUT_COLOR,
  UNDERLINE_COLOR,
  annotTypeLabel,
  annotationAtPoint,
  annotationHitTest,
  clearCustomColors,
  freetextMinSize,
  inkHitTest,
  inkPad,
  inkQuad,
  isMovableAnnotation,
  isTextMarkup,
  lineQuad,
  nextAnnotationId,
  quadsUnion,
  rgbCss,
  selectionRectsForPage,
  strokesBox,
  TEXT_FONT_DEFAULT,
  textFontCss
} from '../annotations'
import {
  clearToolPrefs,
  DEFAULT_TOOL_PREFS,
  loadToolPrefs,
  saveToolPrefs
} from '../tool-prefs'
import type { DrawPrefKey, EraserScope, MarkupPref, TextPref, ToolPref } from '../tool-prefs'
import type { PdfStandardFont } from '@embedpdf/models'
import { notePenEvent, palmResting, PEN_NEAR_MS } from '../pen-input'
import type { BoxSize } from '../useResizable'
import { makePaneHandle } from '../pane-handle'
import type { PaneHandle } from '../pane-handle'
import { ZOOM_MAX, ZOOM_MIN } from '../zoom'
import PagesPane from './PagesPane'
import type {
  DrawTool,
  DrawToolType,
  MarkupToolType,
  PageAnnotation,
  ResizeHandle,
  ShapeToolType
} from '../annotations'
import { collectAnnotations } from '../doc-load'
import { emitLocalDocEvent, onLocalDocEvent } from '../local-doc-events'
import {
  buildRows,
  flipTarget,
  GESTURE_SETTLE,
  MARGIN_NOTES_W,
  PAD_BOTTOM,
  PAD_TOP,
  PAGE_GAP,
  pageRectToView,
  RENDER_MARGIN,
  shiftLayoutX,
  SIDE_PAD,
  SPREAD_GAP,
  spreadRow,
  viewDeltaToPage,
  viewPointToPage,
  viewRectToPage,
  viewSize
} from '../rotation'
import type { RowLayout } from '../rotation'
import AiPanel, { AiQuickPopover } from './AiPanel'
import type { AiQuickState, AiSeed, EnsuredDocument } from './AiPanel'
import {
  browserCurrentBytes,
  getEngineWithRaw,
  registerBrowserDoc,
  releaseBrowserDoc
} from '../annotation-engine-browser'
import { buildMarginCopy } from '../../../shared/margin-export'
import type { MarginExportCard } from '../../../shared/margin-export'
import { WASM_SAFE_LIMIT } from '../../../shared/pdfium-annot-ops'
import { marginCardAnnotations, MarginJumpArrows } from './MarginNotes'
import type { MarginViewConfig } from './MarginNotes'
import { registerPdfiumDoc, releasePdfiumDoc } from '../pdfium-renderer'
import {
  buildAiDocument,
  chatSystem,
  citationPage,
  excerptSystemNote,
  nextAiRequestId,
  prepareDocumentForRequest,
  resolveCitation,
  semanticSearchPrompt
} from '../ai'
import type { AiDocument, ResolvedCitation } from '../ai'
import { charCitationsToQuotes } from '../ai-retrieval'
import AnnotPopover from './AnnotPopover'
import { PasswordPrompt } from './PasswordPrompt'
import { SignaturePad } from './SignaturePad'
import { SignatureInfo } from './SignatureInfo'
import {
  addSignature,
  dataUrlToBytes,
  loadSignatures,
  removeSignature,
  stampRectAt
} from '../signatures'
import type { SavedSignature } from '../signatures'
import { IconPanelLeft, IconPanelRight, IconPause, IconPlay, IconStop } from './icons'
import { OverlayScrollbars } from './OverlayScrollbars'
import PdfPage from './PdfPage'
import PresentationMode from './PresentationMode'
import Sidebar from './Sidebar'
import SearchBar from './SearchBar'
import Toolbar from './Toolbar'
import { NotePopover, SelectionMenu } from './SelectionMenu'
import type { MenuAction, MenuState } from './SelectionMenu'
import { SnipOverlay } from './SnipOverlay'
import { errorText, locale, t, useLang } from '../i18n'
import { useDismissable } from '../useDismissable'
import {
  buildPageText,
  buildPageTexts,
  findMatches,
  hasExtractableText,
  resolveAllMatchRects,
  resolveMatchRects
} from '../search'
import { addSearchHistory, clearSearchHistory } from '../search-history'
import { clearAiTextScale } from '../ai-text-scale'
import type { PageText, SearchMatch, SearchOptions } from '../search'
import { offsetAtPoint, rangeOfQuads, snapToWords } from '../text-range'
import type { CharRange } from '../text-range'
import { collectExportRows, computeExcerpts, toDocx, toHtml, toMarkdown, toPlainText } from '../annot-export'
import type { ExportFormat } from './Sidebar'
import { clamp } from '../clamp'
import { useReadAloud } from '../hooks/useReadAloud'
import { PANEL_DEFAULTS, PANEL_LS_KEY, usePanelWidths } from '../hooks/usePanelWidths'
import { useUndoStack } from '../hooks/useUndoStack'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'

// openDocument/isPasswordException live in pdf-doc.ts, shared with the
// detached assistant window (which opens the same bytes but mounts no page).

/** What the parser said, plus what it was actually given. A file that is still
 *  being written and a genuinely broken document fail with the same message, and
 *  only the byte count and the two ends tell them apart. Logged as well as
 *  shown, because a screenshot of the error screen is often all we get. */
function loadFailure(err: unknown, bytes: Uint8Array): Error {
  const message = err instanceof Error ? err.message : String(err)
  const printable = (part: Uint8Array): string =>
    Array.from(part, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('')
  const shape = t('viewer.errorBytes', {
    bytes: String(bytes.byteLength),
    head: printable(bytes.subarray(0, 8)),
    tail: printable(bytes.subarray(-8))
  })
  console.error(`[pdfx] document load failed: ${message} — ${shape}`)
  return new Error(`${message} ${shape}`)
}

const EMPTY_ANNOTS: PageAnnotation[] = []
const EMPTY_RECTS: PageRect[] = []

/** What the eraser removes in its default 'draw' scope: marks the user drew by
 *  hand. Ink is hit-tested against the stroke path before this set is consulted
 *  (see eraseAt), so it is only about the bbox pass. */
const ERASER_DRAWN_TYPES = new Set<AnnotationType>(['ink', 'square', 'circle', 'line', 'arrow'])

/** Which pages column something happened in. 'a' is the always-present one;
 *  'b' only exists while the split view is open. Both are equal citizens for
 *  every annotation action — the id only says WHERE to draw pane-local chrome
 *  (the text-box editor, the drag ghost) and which zoom the toolbar edits. */
export type PaneId = 'a' | 'b'

/** The pane a DOM node sits in (each `.pages` column carries data-pane) */
function paneOfEl(el: Element | null | undefined): PaneId {
  const host = el?.closest?.('.pages') as HTMLElement | null
  return host?.dataset.pane === 'b' ? 'b' : 'a'
}

/** True when the document was fetched over the network, so nothing of it exists
 *  on disk yet. Everything else names a local original: `file://` URLs from a
 *  double-click, the picker's `fsa:` pseudo-paths, and desktop paths (never
 *  URLs). Drives the one place the distinction matters — Ctrl+S on an unchanged
 *  document, which has nothing to do for a local file and means "download this
 *  one" for a web PDF. */
function isRemoteSource(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

const TOOLBAR_PIN_LS_KEY = 'pdfx-toolbar-pinned'

/** Toolbar starts pinned unless the user unpinned it in a previous session */
function loadToolbarPinned(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_PIN_LS_KEY) !== '0'
  } catch {
    return true
  }
}

const MARGIN_VIEW_LS_KEY = 'pdfx-margin-view'

interface MarginViewState {
  on: boolean
  side: 'left' | 'right'
}

/** Margin view starts off, right side; a reader's choices persist across
 *  sessions. Tolerates both older shapes: the v1 boolean key and the v2
 *  object that still carried a flow/stack mode (the stack list now lives in
 *  the Merknader tab, so the mode is simply dropped). */
function loadMarginView(): MarginViewState {
  try {
    const raw = localStorage.getItem(MARGIN_VIEW_LS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<MarginViewState>
      return { on: p.on === true, side: p.side === 'left' ? 'left' : 'right' }
    }
    return { on: localStorage.getItem('pdfx-margin-notes') === '1', side: 'right' }
  } catch {
    return { on: false, side: 'right' }
  }
}

function saveMarginView(v: MarginViewState): void {
  try {
    localStorage.setItem(MARGIN_VIEW_LS_KEY, JSON.stringify(v))
  } catch {
    /* view preference only */
  }
}

function saveToolbarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(TOOLBAR_PIN_LS_KEY, pinned ? '1' : '0')
  } catch {
    /* pin preference is best-effort */
  }
}

interface PageSize {
  w: number
  h: number
}

export interface AnnotPatch {
  color?: [number, number, number]
  contents?: string
  /** freetext: re-set an existing box in another of the Standard 14. Always
   *  sent with re-measured `quads` — a wider face needs a wider box, and the
   *  measurement (freetextMinSize) is a canvas that only exists here. */
  font?: PdfStandardFont
  /** Note drag: replacement quads (engine gets quads[0] as the new rect) */
  quads?: PageRect[]
  /** Drag-move of an ink/line/arrow: replacement strokes.
   *
   *  `| undefined` is load-bearing, unlike the other fields here. An undo patch
   *  records the record's PREVIOUS strokes, and when the forward patch added
   *  strokes to a record that had none, the previous value IS undefined —
   *  spreading that back is what erases them again. Omitting the key instead
   *  would leave the added strokes in place on undo. */
  strokes?: [number, number][][] | undefined
  /** Drag-move: relative shift in page space — the engine reads its own
   *  current geometry and writes it back shifted (see ModifyAnnotationRequest) */
  translate?: { dx: number; dy: number }
}

/** Mutable identity for an annotation across undo/redo and document reloads */
export interface AnnotHandle {
  pageNumber: number
  localId: string
  fileId: number | null
}

export type UndoEntry =
  | { kind: 'create'; handle: AnnotHandle; snapshot: PageAnnotation }
  | { kind: 'delete'; handle: AnnotHandle; snapshot: PageAnnotation }
  | { kind: 'change'; handle: AnnotHandle; before: AnnotPatch; after: AnnotPatch }
  /** One user action that moved several annotations at once ("clear all"), so
   *  Ctrl+Z takes them all back together rather than one per keypress. The
   *  entries hold the SAME handle objects the writes used: engineCreate stamps a
   *  new object number onto the handle it is given, and reusing them is what
   *  keeps a second undo/redo cycle pointing at the right objects. */
  | { kind: 'batch'; entries: UndoEntry[] }

interface NavPosition {
  page: number
  offset: number
}

interface NoteDraft {
  x: number
  y: number
  /** Markup rect (viewport coords) to open clear of, so it stays readable */
  avoid?: { top: number; bottom: number; left: number } | null
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
  /** The top chrome is being reached for — the toolbar is pinned, or it is
   *  tucked and the pointer is peeking it back. The app shell brings the TAB
   *  STRIP back with it in fullscreen: the strip sits directly above the
   *  toolbar, so sliding them down as one block is one gesture and one mental
   *  model («the chrome comes back when I reach for it») rather than two
   *  affordances a hair apart. */
  onChromeVisible(visible: boolean): void
  /** Unsaved-changes state (save model) — App needs it for close prompts */
  onDirtyChange(dirty: boolean): void
  /** «Save a copy» wrote the current document (edits included) to `path` —
   *  App switches this tab over to the copy so work continues there */
  onSavedAs(path: string): void
  /** Save/Ctrl+S found the file changed outside the app since editing began.
   *  App runs the same save-copy/discard/cancel menu as re-opening a stale
   *  path and, unless cancelled, reloads this tab with the fresh bytes —
   *  the caller only needs the verdict to decide whether it still owns a
   *  save to perform (it never does; 'cancel' means "stay dirty, do nothing"
   *  and the other two verdicts leave nothing left to save in place). */
  onExternalSaveConflict(path: string, name: string): Promise<'save' | 'discard' | 'cancel'>
  /** CLOSE this document — the tab goes away. Reached from the error screen,
   *  where the tab holds a file that would not open and is worth nothing. */
  onClose(): void
  /** GO TO THE LIBRARY, closing nothing. These two were the same function
   *  until 2026-08-09, which is what made «back to the library» close a
   *  document instead of going anywhere. */
  onLeaveDocument(): void
  /** Browser/extension only: open another file (the shell handles the picker).
   *  When supplied, the toolbar shows a left-most file button that surfaces the
   *  current file's path and this action. Desktop leaves it undefined — the tab
   *  bar already carries the file identity. */
  onOpenFile?(): void
}

/** Load a PDF blob in an offscreen frame and ask it to print.
 *
 *  Returns false — having cleaned up after itself — whenever the frame cannot
 *  be driven: a cross-origin viewer document (Chromium's built-in PDF viewer
 *  is an extension origin), a frame that never fires load, or a print() that
 *  throws. The caller then opens a tab, which is the behaviour this replaced
 *  and is still the honest fallback rather than a silent no-op.
 *
 *  The frame is left in the DOM for a while on success: removing it while the
 *  print dialog is still open cancels the job in Chromium. */
async function printViaHiddenFrame(url: string): Promise<boolean> {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:0'
  frame.src = url
  document.body.appendChild(frame)
  const drop = (): void => frame.remove()
  const loaded = await new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => resolve(false), 4000)
    frame.onload = () => {
      window.clearTimeout(timer)
      resolve(true)
    }
    frame.onerror = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
  })
  if (!loaded) {
    drop()
    return false
  }
  try {
    const win = frame.contentWindow
    if (!win) {
      drop()
      return false
    }
    win.focus()
    win.print()
    window.setTimeout(drop, 60_000)
    return true
  } catch {
    // SecurityError: the viewer document is not ours to drive.
    drop()
    return false
  }
}

export default function PdfViewer({
  payload,
  initialPosition,
  active,
  settings,
  resolvedTheme,
  onSettingsChange,
  onPresentationChange,
  onChromeVisible,
  onDirtyChange,
  onSavedAs,
  onExternalSaveConflict,
  onClose,
  onLeaveDocument,
  onOpenFile
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
  /** Spread sub-option: page 1 alone, pairs 2-3, 4-5 … so facing pages align
   *  as printed. Persisted with the position like spread itself. */
  const [coverPage, setCoverPage] = useState(initialPosition?.coverPage ?? false)
  const coverPageRef = useRef(coverPage)
  coverPageRef.current = coverPage
  const [containerWidth, setContainerWidth] = useState(0)
  const [range, setRange] = useState<[number, number]>([1, 1])
  const [currentPage, setCurrentPage] = useState(initialPosition?.page ?? 1)
  // The keyboard handler is assigned per render but reads through refs, so the
  // bookmark shortcut needs the live page rather than a captured one.
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  /** Read by stable callbacks (annotation author) without re-creating them */
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [error, setError] = useState<string | null>(null)
  /** Edge-style toolbar auto-hide. Pinned (default) = always visible; unpinned
   *  = tucks away and reveals on top-edge hover. Persisted across sessions. */
  const [toolbarPinned, setToolbarPinned] = useState(loadToolbarPinned)
  const [toolbarPeek, setToolbarPeek] = useState(false)
  /** Margin view: notes + annotation comments as always-visible cards in a
   *  column beside each page (both panes). The gutter it needs is reserved
   *  in every layout/fit computation below via `marginGutter`. */
  const [marginView, setMarginView] = useState(loadMarginView)
  const patchMarginView = useCallback((patch: Partial<MarginViewState>) => {
    setMarginView((v) => {
      const next = { ...v, ...patch }
      saveMarginView(next)
      return next
    })
  }, [])
  const toggleMarginNotes = useCallback(() => {
    setMarginView((v) => {
      const next = { ...v, on: !v.on }
      saveMarginView(next)
      return next
    })
  }, [])
  const marginNotes = marginView.on
  /** What PdfPage needs, or null when the view is off — memoised so the
   *  object identity is stable for the memoised pages */
  const marginViewConfig = useMemo<MarginViewConfig | null>(
    () => (marginView.on ? { side: marginView.side } : null),
    [marginView]
  )
  const setMarginSide = useCallback(
    (side: 'left' | 'right') => patchMarginView({ side }),
    [patchMarginView]
  )
  const marginViewRef = useRef(marginView)
  marginViewRef.current = marginView
  /** Right-click on the margin strip: a small menu at the cursor OFFERING to
   *  hide the view — a choice, never an immediate close (Emil, 2026-09-02).
   *  Esc/outside-click dismissal via useDismissable, per the standing rule. */
  const [marginMenu, setMarginMenu] = useState<{ x: number; y: number } | null>(null)
  const marginMenuRef = useRef<HTMLDivElement>(null)
  const onMarginMenu = useCallback((x: number, y: number) => setMarginMenu({ x, y }), [])
  const closeMarginMenu = useCallback(() => setMarginMenu(null), [])
  useDismissable(marginMenuRef, marginMenu !== null, closeMarginMenu)
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
    /** Markup rect (viewport coords) to open clear of, so it stays readable */
    avoid?: { top: number; bottom: number; left: number } | null
    pageNumber: number
    localId: string
    /** Land keyboard focus in the comment field on open (comment action) */
    focusText?: boolean
  } | null>(null)
  /** Drag-resized size of a specific annotation's comment bubble, keyed by its
   *  local id. Per document session and deliberately NOT persisted: a brand-new
   *  note or text bubble must always open at the default shape (so the default
   *  is never lost), while re-opening THIS comment brings back the size it was
   *  last read at. */
  const [bubbleSizes, setBubbleSizes] = useState<ReadonlyMap<string, BoxSize>>(new Map())
  const setBubbleSize = useCallback((localId: string, size: BoxSize | null) => {
    setBubbleSizes((prev) => {
      const next = new Map(prev)
      if (size) next.set(localId, size)
      else next.delete(localId)
      return next
    })
  }, [])
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
  /** Split view: a second pages column beside the first — same document, same
   *  tools, own page and own zoom. See PagesPane.tsx for why it is not a second
   *  PdfViewer (one pdf.js document, one annotation map, one save model). */
  const [splitOpen, setSplitOpen] = useState(false)
  const splitOpenRef = useRef(splitOpen)
  splitOpenRef.current = splitOpen
  /** Each column's scroll API (see pane-handle.ts). Declared here so every
   *  go-to action below can address a column without knowing which one it is;
   *  filled in further down once both columns exist. */
  const paneBHandleRef = useRef<PaneHandle | null>(null)
  const handleForRef = useRef<(pane: PaneId) => PaneHandle | null>(() => null)
  const followLinkFromRef = useRef<(from: PaneId, dest: unknown, toOther: boolean) => void>(
    () => {}
  )
  const toggleSplitRef = useRef<() => void>(() => {})
  const whenPaneReadyRef = useRef<(pane: PaneId, fn: () => void) => void>(() => {})
  const schedulePositionSaveRef = useRef<() => void>(() => {})
  /** The pane the user last touched. Two jobs: the toolbar's page/zoom controls
   *  edit THIS pane (and the switcher in the toolbar's centre names it), and any
   *  annotation action started without an element to inspect — a stroke
   *  completing, a text box opening — lands here. Every such action is preceded
   *  by a pointerdown in a pane, so "last pointer" is exactly "the pane being
   *  worked in"; the switcher is the same state, reachable without one. */
  const [activePane, setActivePane] = useState<PaneId>('a')
  const activePaneRef = useRef(activePane)
  activePaneRef.current = activePane
  /**
   * Which column to pulse, briefly. The persistent "this is the active column"
   * signal lives in the TOOLBAR (the column switcher) — chrome, where it can't
   * intrude on the page. On the page itself a permanent frame around
   * whichever half you are reading is exactly the kind of thing that wears you
   * down over an hour, so the page only ever gets a ~700 ms pulse: when focus
   * moves between the columns, and when a followed link lands in the other one.
   */
  const [paneFlash, setPaneFlash] = useState<PaneId | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const flashPane = useCallback((pane: PaneId) => {
    if (!splitOpenRef.current) return
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    // Clear first so a repeat pulse on the same column restarts the animation
    setPaneFlash(null)
    window.requestAnimationFrame(() => setPaneFlash(pane))
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null
      setPaneFlash(null)
    }, 700)
  }, [])
  const flashPaneRef = useRef(flashPane)
  flashPaneRef.current = flashPane
  useEffect(
    () => () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    },
    []
  )
  /** Move the toolbar to a column from the toolbar itself (the switcher), with
   *  the same pulse a pointer-down in the column gives — clicking a number in
   *  chrome has to be answered on the page, or nothing tells you which half you
   *  just took control of. Compared at the top level, never inside a setState
   *  updater: React may run an updater twice, and flashPane sets state itself. */
  const activatePane = useCallback((pane: PaneId) => {
    if (activePaneRef.current === pane) return
    setActivePane(pane)
    flashPaneRef.current(pane)
  }, [])

  /** Pane B's page + zoom. Held HERE, not inside PagesPane, because the
   *  toolbar's second centre cluster drives them — exactly the same controls
   *  pane A gets, which is the whole point of the symmetry. */
  const [paneBScale, setPaneBScale] = useState(0)
  const [paneBFit, setPaneBFit] = useState<'width' | 'page' | 'custom'>('width')
  const [paneBPage, setPaneBPage] = useState(1)
  /** …and its own orientation. Rotation per column has a concrete research use:
   *  holding a landscape-printed table upright in one column while reading the
   *  prose that discusses it in the other. Spread is per column for the same
   *  reason — if the option exists at all it has to mean "this column". */
  const [paneBRotation, setPaneBRotation] = useState<ViewRotation>(0)
  const [paneBSpread, setPaneBSpread] = useState(false)
  const [paneBCover, setPaneBCover] = useState(false)
  const paneBRotationRef = useRef(paneBRotation)
  paneBRotationRef.current = paneBRotation
  const paneBSpreadRef = useRef(paneBSpread)
  paneBSpreadRef.current = paneBSpread
  const paneBCoverRef = useRef(paneBCover)
  paneBCoverRef.current = paneBCover
  const paneBFitRef = useRef(paneBFit)
  paneBFitRef.current = paneBFit
  const paneBScaleRef = useRef(paneBScale)
  paneBScaleRef.current = paneBScale
  const paneBZoom = useCallback((next: number, mode: 'width' | 'page' | 'custom') => {
    setPaneBScale(next)
    setPaneBFit(mode)
  }, [])
  /** Pane B's page field. Goes through the same PaneHandle every other go-to
   *  action uses — there is exactly one way to scroll a column. */
  const goToPaneBPage = useCallback((page: number) => {
    goToPaneBPageRef.current(page)
  }, [])
  const goToPaneBPageRef = useRef<(page: number) => void>(() => {})
  /** Which fit the second column's toggle offers next. Derived from the mode
   *  rather than by comparing scales (as pane A does): PdfViewer does not know
   *  the pane's width, and a mode-derived target is the more predictable of the
   *  two anyway. */
  const paneBFitTarget: 'width' | 'page' = paneBFit === 'width' ? 'page' : 'width'

  /** What the second column was showing when it was last closed, so S brings it
   *  back rather than a fresh copy of the left column. The case this exists for:
   *  a figure parked on the right that you glance at, close, and want again —
   *  reopening on "the page you are reading" would throw it away every time.
   *  Session-scoped and per document (this component is one tab's viewer), and
   *  deliberately not persisted: reopening a file tomorrow should start on the
   *  reading position, not resurrect half a split you have forgotten about. */
  const paneBMemoryRef = useRef<{
    page: number
    /** fraction into the page, so it survives a different zoom on reopen */
    offset: number
    scale: number
    fit: 'width' | 'page' | 'custom'
    rotation: ViewRotation
    spread: boolean
    cover: boolean
    /** the divider's share too — a figure you gave 60 % of the width to comes
     *  back at 60 %, not squeezed back to half */
    share: number
  } | null>(null)

  const rememberPaneB = useCallback(() => {
    const pos = handleForRef.current('b')?.position()
    if (!pos) return
    paneBMemoryRef.current = {
      page: pos.page,
      offset: pos.offset,
      scale: paneBScaleRef.current,
      fit: paneBFitRef.current,
      rotation: paneBRotationRef.current,
      spread: paneBSpreadRef.current,
      cover: paneBCoverRef.current,
      share: panelWRef.current.pane
    }
  }, [])

  /** Opening the split restores the second column where you left it, or — the
   *  first time — starts it on the page you are reading at a fresh fit (scale 0
   *  makes PagesPane pick fit-width for its width). Closing it remembers that
   *  column and hands focus back to the remaining one, so the toolbar's centre
   *  never points at a pane that is gone. */
  // Everything here runs at the TOP LEVEL, never inside a setState updater:
  // React may call an updater more than once and does not support nested state
  // updates from inside one. Doing that dropped the symmetric-width update, so
  // the split opened lopsided (398/1199 instead of 799/799).
  const toggleSplit = useCallback(() => {
    if (splitOpenRef.current) {
      rememberPaneB()
      setSplitOpen(false)
      setActivePane('a')
      return
    }
    const memory = paneBMemoryRef.current
    const page = memory?.page ?? currentPage
    // Reopening: back to the share the divider had. First time: an even split of
    // the space the one column had, both columns on the page you are reading,
    // both at a fresh fit for their new width. Nothing distinguishes them.
    const share = memory?.share ?? 0.5
    setPanelW((p) => (p.pane === share ? p : { ...p, pane: share }))
    window.setTimeout(persistPanelWidths, 0)
    setPaneBPage(page)
    // Restore the exact scale even for a fit mode: PagesPane only auto-fits a
    // column whose scale is still 0, and re-fits any fit mode for its actual
    // width anyway — so this lands right whether or not the width changed.
    setPaneBScale(memory && memory.scale > 0 ? memory.scale : 0)
    setPaneBFit(memory?.fit ?? 'width')
    // Mirror the orientation you were already reading in, so the two columns
    // are indistinguishable at the moment a FRESH split opens
    setPaneBRotation(memory?.rotation ?? rotationRef.current)
    setPaneBSpread(memory?.spread ?? spreadRef.current)
    setPaneBCover(memory?.cover ?? coverPageRef.current)
    setFitMode('width')
    setSplitOpen(true)
    // Land the column once it can be scrolled — on the remembered spot within
    // the page, not just its top, so a figure comes back framed as you left it
    whenPaneReadyRef.current('b', () =>
      handleForRef.current('b')?.scrollToPage(page, memory?.offset ?? 0)
    )
  }, [currentPage, rememberPaneB])
  toggleSplitRef.current = toggleSplit

  /**
   * Close ONE named column and keep the other's content — "lukk det panelet man
   * vil". Closing the right one is trivial. Closing the LEFT one has to be a
   * trick: the first column is the architecturally permanent one (it owns the
   * persisted reading position), so instead of removing it we move the right
   * column's view INTO it — page, orientation, spread, and a hand-set zoom —
   * and then close the right one. What the reader sees is the half they wanted
   * to keep, now filling the window.
   */
  const closePane = useCallback((pane: PaneId) => {
    if (pane === 'b') {
      // Same gesture as toggling the split off, so it remembers the same way
      rememberPaneB()
      setSplitOpen(false)
      setActivePane('a')
      return
    }
    const bPage = handleForRef.current('b')?.position()?.page ?? paneBPage
    // The right column's view is about to BECOME the left one — remembering it
    // would reopen a duplicate of what you are already looking at.
    paneBMemoryRef.current = null
    setRotation(paneBRotationRef.current)
    setSpread(paneBSpreadRef.current)
    setCoverPage(paneBCoverRef.current)
    // A fit mode is better recomputed for the full width than copied; an exact
    // hand-set zoom is the reader's number and is carried over verbatim.
    const bFit = paneBFitRef.current
    fitModeRef.current = bFit
    setFitMode(bFit)
    if (bFit === 'custom' && paneBScaleRef.current > 0) setScale(paneBScaleRef.current)
    setSplitOpen(false)
    setActivePane('a')
    whenPaneReadyRef.current('a', () => {
      handleForRef.current('a')?.scrollToPage(bPage)
      schedulePositionSaveRef.current()
    })
  }, [paneBPage, rememberPaneB])
  /** Navigation history PER COLUMN — see the pushBack/navStep block below */
  const [navStacks, setNavStacks] = useState<
    Record<PaneId, { back: NavPosition[]; forward: NavPosition[] }>
  >({ a: { back: [], forward: [] }, b: { back: [], forward: [] } })
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
  // Tool look-and-feel (colour, width, opacity per drawing tool; colour +
  // opacity per markup type; eraser scope) — loaded from and written back to
  // localStorage so a dialled-in tusj survives a restart. See tool-prefs.ts.
  const [prefs, setPrefs] = useState(loadToolPrefs)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  useEffect(() => {
    saveToolPrefs(prefs)
  }, [prefs])
  const toolPrefs = prefs.tools
  const markupPrefs = prefs.markup

  const patchToolPref = useCallback((tool: DrawPrefKey, patch: Partial<ToolPref>) => {
    setPrefs((p) => ({ ...p, tools: { ...p.tools, [tool]: { ...p.tools[tool], ...patch } } }))
  }, [])
  const resetToolPref = useCallback((tool: DrawPrefKey) => {
    setPrefs((p) => ({
      ...p,
      tools: { ...p.tools, [tool]: { ...DEFAULT_TOOL_PREFS.tools[tool] } }
    }))
  }, [])
  const patchMarkupPref = useCallback((type: MarkupToolType, patch: Partial<MarkupPref>) => {
    setPrefs((p) => ({ ...p, markup: { ...p.markup, [type]: { ...p.markup[type], ...patch } } }))
  }, [])
  const resetMarkupPref = useCallback((type: MarkupToolType) => {
    setPrefs((p) => ({
      ...p,
      markup: { ...p.markup, [type]: { ...DEFAULT_TOOL_PREFS.markup[type] } }
    }))
  }, [])
  const setEraserScope = useCallback((eraserScope: EraserScope) => {
    setPrefs((p) => ({ ...p, eraserScope }))
  }, [])
  const setFingerDraws = useCallback((fingerDraws: boolean) => {
    setPrefs((p) => ({ ...p, input: { ...p.input, fingerDraws } }))
  }, [])
  const setPenPressure = useCallback((penPressure: boolean) => {
    setPrefs((p) => ({ ...p, input: { ...p.input, penPressure } }))
  }, [])
  // Pen proximity → html.pen-near. touch-action cannot tell a pen from a
  // finger (both are direct-manipulation pointers on Windows), so the draw
  // layer allows finger panning by default and this class flips it to `none`
  // while a pen is in hover range — the pen draws, the finger scrolls, and a
  // palm landing next to a hovering pen can neither draw nor scroll. Also the
  // one-time penSeen flip: the first pen this machine ever sees turns finger
  // drawing off (the tablet-app convention; the tool menus can turn it back).
  useEffect(() => {
    let timer = 0
    const el = document.documentElement
    const onPen = (e: PointerEvent): void => {
      if (e.pointerType !== 'pen') return
      notePenEvent()
      el.classList.add('pen-near')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => el.classList.remove('pen-near'), PEN_NEAR_MS)
      setPrefs((p) =>
        p.input.penSeen ? p : { ...p, input: { ...p.input, fingerDraws: false, penSeen: true } }
      )
    }
    window.addEventListener('pointermove', onPen, { capture: true, passive: true })
    window.addEventListener('pointerdown', onPen, { capture: true, passive: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', onPen, { capture: true })
      window.removeEventListener('pointerdown', onPen, { capture: true })
      el.classList.remove('pen-near')
    }
  }, [])
  // The finger-draw routing rides on <html> so the CSS reaches every pane (and
  // the extension viewer) without threading a class through the tree.
  useEffect(() => {
    document.documentElement.classList.toggle('finger-draw', prefs.input.fingerDraws)
    return () => document.documentElement.classList.remove('finger-draw')
  }, [prefs.input.fingerDraws])
  const textPref = prefs.text
  const patchTextPref = useCallback((patch: Partial<TextPref>) => {
    setPrefs((p) => ({ ...p, text: { ...p.text, ...patch } }))
  }, [])
  const resetTextPref = useCallback(() => {
    setPrefs((p) => ({ ...p, text: { ...DEFAULT_TOOL_PREFS.text } }))
  }, [])
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
    /** Set when editing an existing box, so the editor shows ITS colour/size
     *  rather than the tool preference (a re-opened red 18 pt box must not
     *  preview in the tool's current black 12 pt). New drafts leave these
     *  unset and follow the live tool preference instead. */
    color?: [number, number, number]
    fontSize?: number
    /** Editing an existing box: ITS face, so the editor shows the letters the
     *  commit will write. Unset on a new draft, which follows the tool. */
    font?: PdfStandardFont | undefined
    /** The editor is positioned inside this pane's page layout, at its zoom */
    pane: PaneId
  } | null>(null)

  const drawTool = useMemo<DrawTool | null>(() => {
    if (!activeTool) return null
    if (activeTool === 'eraser') return { type: 'eraser', color: [0, 0, 0], width: 0, opacity: 0 }
    if (activeTool === 'text') {
      return { type: 'text', color: prefs.text.color, width: 0, opacity: 1 }
    }
    if (activeTool === 'pen' || activeTool === 'marker') {
      const p = toolPrefs[activeTool]
      return { type: activeTool, color: p.color, width: p.width, opacity: p.opacity }
    }
    return {
      type: activeTool,
      color: toolPrefs.shape.color,
      width: toolPrefs.shape.width,
      opacity: toolPrefs.shape.opacity
    }
  }, [activeTool, toolPrefs, prefs.text])
  const drawToolRef = useRef(drawTool)
  drawToolRef.current = drawTool
  const [pillEditing, setPillEditing] = useState(false)
  const [pillInput, setPillInput] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Bumped on every openSearch so the bar refocuses+selects even when it is
  // already open (Ctrl+F with a new selection while searching)
  const [searchFocusToken, setSearchFocusToken] = useState(0)
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
    /** Bumped each citation jump so the flash rects remount and the CSS fade
     *  animation replays even when a repeat/same-page click reuses the nodes */
    flashId?: number
  } | null>(null)
  /** Highlight-all: every match on the pages that are currently mounted.
   *
   *  A SEPARATE channel from searchHits on purpose. That one carries the current
   *  hit and is also written by read-aloud (the spoken sentence) and by citation
   *  jumps (the 7 s flash) — one highlight for the page, so those three can never
   *  fight over it. Widening it into a map would drag both of them along.
   *
   *  Scoped to one column and one rotation, both recorded here: the rects are
   *  measured off the rotated text layer's client rects, so they are only valid
   *  in the column and rotation they were measured in. Search drives the active
   *  column, so that is the one that gets them. */
  const [searchAllHits, setSearchAllHits] = useState<{
    pane: PaneId
    rotation: ViewRotation
    byPage: Map<number, PageRect[]>
  } | null>(null)
  // Semantic (AI) search mode alongside exact text search
  const [searchMode, setSearchMode] = useState<'text' | 'ai'>('text')
  const [semantic, setSemantic] = useState<{
    status: 'idle' | 'running' | 'done' | 'noKey' | 'noText' | 'error'
    hits: { label: string; citation: AiCitation; pageNumber: number | null }[]
    index: number
    note: string | null
  }>({ status: 'idle', hits: [], index: -1, note: null })
  const semanticReqRef = useRef<number | null>(null)
  // The AI search must SAY which model answers (transparency rule). Refreshed
  // every time the bar opens or flips to AI mode — the model can have been
  // switched in the assistant panel in between.
  const [semanticModelName, setSemanticModelName] = useState('')
  useEffect(() => {
    if (!searchOpen || searchMode !== 'ai') return
    void bridge.aiGetConfig().then((c) => {
      const model = c.provider === 'azure' ? c.azure.deployment : (c.models[c.provider] ?? '')
      setSemanticModelName(prettyModelName(c.provider, model))
    })
  }, [searchOpen, searchMode, searchFocusToken])
  const [aiPinned, setAiPinned] = useState(false)
  const aiPinnedRef = useRef(aiPinned)
  aiPinnedRef.current = aiPinned
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null)
  const [aiQuick, setAiQuick] = useState<AiQuickState | null>(null)
  /** Snip-to-explain: armed from toolbar/menu ('quick' → popover) or from
   *  the chat composer ('chat' → the region lands as a chat attachment) */
  const [snip, setSnip] = useState<null | { target: 'quick' | 'chat' }>(null)
  /** A snipped region on its way into the chat composer (consumed by AiPanel) */
  const [chatSnip, setChatSnip] = useState<{ id: number; image: AiImage } | null>(null)
  const chatSnipSeqRef = useRef(0)
  /** Whole pages rendered for the assistant to read (scanned documents), on their
   *  way into the composer as staged attachments — never sent on their own. */
  const [chatPages, setChatPages] = useState<{
    id: number
    pages: number[]
    images: AiImage[]
  } | null>(null)
  const chatPagesSeqRef = useRef(0)
  const [chatPagesBusy, setChatPagesBusy] = useState(false)
  /** Note placement armed from the toolbar: next page click drops a note */
  const [notePlacing, setNotePlacing] = useState(false)
  /** Late-bound handle to runSemanticSearch (declared below) so the menu
   *  action handler (declared above it) can fire it without a TDZ hit */
  const runSemanticSearchRef = useRef<((queryOverride?: string) => Promise<void>) | null>(null)
  /** Bumped to make the AI panel fire the "ask my annotations" question */
  const [annotsAskId, setAnnotsAskId] = useState(0)
  /** Bumped to open the AI panel showing its key settings (gear menu, search) */
  const [aiSettingsAskId, setAiSettingsAskId] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** The first column's host (the flex child, not its scroller) — the split
   *  divider measures the pages area from it. */
  const pagesHostRef = useRef<HTMLDivElement>(null)
  /** The viewer root — used to reveal the unpinned toolbar from the whole top
   *  strip (tab bar included), so the pointer only has to reach the top edge. */
  const viewerRootRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  // ---------- Panel resizing (sidebar / AI panel dividers) ----------
  // Called here rather than with the other panel state further up: the split
  // divider measures the pages area from `pagesHostRef` (just above), and
  // `panelW.pane` has to exist before the resize observer below reads it.
  const {
    panelW,
    setPanelW,
    panelWRef,
    resizingPanel,
    beginPanelResize,
    resetPanelWidth,
    persistPanelWidths
  } = usePanelWidths(pagesHostRef)

  // ---------- Pane-agnostic geometry ----------
  // Split view puts a SECOND pages column on screen at its own zoom. Every
  // pointer handler below (markup, hit-testing, drag-move, snip, note
  // placement) used to read the one `scaleRef`, which silently gave wrong page
  // coordinates in the other pane. Instead of threading a pane identity through
  // ~15 handlers, derive the scale from the page element itself: its rendered
  // width IS the page's view width × that pane's scale. No registry to keep in
  // sync, and it cannot go stale — the DOM is the source of truth.
  //
  // The columns can also be ROTATED independently (a landscape table held beside
  // the prose that discusses it), so the rotation used to map a pointer into page
  // space has to come from the same place: each `.pages` column publishes its own
  // on `data-rotation`.
  const rotationOfPageEl = (pageEl: HTMLElement): ViewRotation => {
    const host = pageEl.closest('.pages') as HTMLElement | null
    const raw = Number(host?.dataset.rotation)
    return raw === 90 || raw === 180 || raw === 270 ? raw : raw === 0 ? 0 : rotationRef.current
  }
  const rotationOfPageElRef = useRef(rotationOfPageEl)
  rotationOfPageElRef.current = rotationOfPageEl

  const scaleOfPageEl = (pageEl: HTMLElement): number => {
    const size = sizesRef.current[Number(pageEl.dataset.page) - 1]
    if (!size) return scaleRef.current
    const v = viewSize(size.w, size.h, rotationOfPageElRef.current(pageEl))
    const w = pageEl.getBoundingClientRect().width
    return v.w > 0 && w > 0 ? w / v.w : scaleRef.current
  }
  const scaleOfPageElRef = useRef(scaleOfPageEl)
  scaleOfPageElRef.current = scaleOfPageEl

  /** Every mounted page element, in BOTH panes. Handlers that hit-test a client
   *  point against the pages must see the whole viewer, not one column. */
  const allPageEls = (): HTMLElement[] => [
    ...(viewerRootRef.current?.querySelectorAll<HTMLElement>('.pages .pdf-page') ?? [])
  ]
  const allPageElsRef = useRef(allPageEls)
  allPageElsRef.current = allPageEls

  // Follow the pointer into whichever pane it lands in. Capture phase so it is
  // recorded before any handler that needs it, and pointerdown rather than
  // click/focus so it is set before a drag or a stroke begins.
  useEffect(() => {
    const root = viewerRootRef.current
    if (!root) return
    const onDown = (e: PointerEvent): void => {
      const host = (e.target as Element | null)?.closest?.('.pages') as HTMLElement | null
      if (!host) return
      const next = host.dataset.pane === 'b' ? 'b' : 'a'
      setActivePane((prev) => {
        // Pulse only on an actual switch — a pulse on every click in the column
        // you are already working in would be noise
        if (prev !== next) flashPaneRef.current(next)
        return next
      })
    }
    root.addEventListener('pointerdown', onDown, true)
    return () => root.removeEventListener('pointerdown', onDown, true)
  }, [])

  const restoreRef = useRef<ReadingPosition | null>(initialPosition)
  /** Page-anchored focal point consumed by the post-zoom commit effect */
  const pendingAnchorRef = useRef<{
    pageIndex: number
    pageX: number
    pageY: number
    fx: number
    fy: number
  } | null>(null)
  /** Page index a page turn should land on once its re-fit relayout is in —
   *  the tops move with the new scale, so the scroll must wait for them. */
  const flipLandRef = useRef<number | null>(null)
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
  /** Generation guard for the highlight-all resolve pass, which awaits text
   *  layers and can therefore land after the search that replaced it. */
  const allHitsSeqRef = useRef(0)
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

  /** Read the file again, once it has stopped changing. null when there is
   *  nothing to re-read from — a document handed to us as bytes by a file input
   *  has no path behind it. */
  const rereadSettled = useCallback(async (): Promise<Uint8Array | null> => {
    const result = await bridge.readFile(payload.path, { awaitSettled: true })
    return 'error' in result ? null : result.data
  }, [payload.path])

  /** Bumped by the error screen's "try again": a retry starts by reading the
   *  file, since the bytes already in hand are the ones that failed. */
  const [loadAttempt, setLoadAttempt] = useState(0)

  /** The password this document was unlocked with, for every RE-open that
   *  follows: the engine rewrites the file after each annotation and the copy is
   *  encrypted the same way, so reloadDocument would otherwise be locked out of
   *  the document the user is looking at. */
  const docPasswordRef = useRef<string | undefined>(undefined)

  /** Set while the unlock prompt is up; the promise resolves with what the user
   *  typed, or null if they closed it. Same shape as the external-update prompt
   *  in ExtensionApp. */
  const [passwordAsk, setPasswordAsk] = useState<{
    retry: boolean
    resolve: (password: string | null) => void
  } | null>(null)

  useEffect(() => {
    let destroyed = false
    /** Register the bytes with the engines that need them, then hand pdf.js its
     *  own copy. In the browser the annotation engine edits an in-memory twin of
     *  the document (desktop edits a draft file instead), so the registration
     *  must follow whatever bytes pdf.js actually parsed — otherwise a retry
     *  would annotate a different version than the one on screen. */
    const openWith = (
      bytes: Uint8Array,
      password?: string
    ): { bytes: Uint8Array; resources: DocResources } => {
      // The browser twin annotates these same bytes and needs the same secret
      if (!isElectron) registerBrowserDoc(payload.path, bytes, password)
      // Spike: when the PDFium raster flag is on, the same bytes also feed the
      // render engine (no-op otherwise — the register call guards on the flag)
      registerPdfiumDoc(payload.path, bytes)
      // pdf.js transfers the underlying buffer to its worker, so hand it a copy
      const resources = openDocument(bytes.slice(), password)
      docResourcesRef.current = resources
      return { bytes, resources }
    }
    /** Ask the user, once, for this document's password. */
    const askPassword = (retry: boolean): Promise<string | null> =>
      new Promise<string | null>((resolve) => setPasswordAsk({ retry, resolve }))
    ;(async () => {
      const initial = loadAttempt === 0 ? payload.data : ((await rereadSettled()) ?? payload.data)
      if (destroyed) return
      let attempt = openWith(initial)
      let doc: PDFDocumentProxy
      try {
        doc = await attempt.resources.task.promise
      } catch (err) {
        if (destroyed) return
        if (isPasswordException(err)) {
          // Encrypted, not broken: ask until it opens or the user gives up.
          // Re-reading the file (below) would be pointless — the bytes are fine.
          let retry = false
          for (;;) {
            const entered = await askPassword(retry)
            setPasswordAsk(null)
            if (destroyed) return
            if (entered === null) throw new Error(t('password.cancelled'))
            attempt.resources.task.destroy()
            attempt.resources.port.terminate()
            attempt = openWith(attempt.bytes, entered)
            try {
              doc = await attempt.resources.task.promise
            } catch (locked) {
              if (destroyed) return
              if (isPasswordException(locked)) {
                retry = true
                continue
              }
              throw loadFailure(locked, attempt.bytes)
            }
            docPasswordRef.current = entered
            // Desktop's write engine lives in main and opens the draft itself,
            // which carries the same encryption. Browser targets no-op here.
            await bridge.docUnlock(payload.path, entered)
            break
          }
        } else {
          // We are a PDF handler: the program that asked us to open this file is
          // often the one still writing it, and a half-written file parses as a
          // broken one. Wait for it to settle, read again, and only then believe
          // the failure.
          const fresh = await rereadSettled()
          if (destroyed) return
          if (!fresh) throw loadFailure(err, attempt.bytes)
          attempt.resources.task.destroy()
          attempt.resources.port.terminate()
          attempt = openWith(fresh)
          try {
            doc = await attempt.resources.task.promise
          } catch (again) {
            throw loadFailure(again, attempt.bytes)
          }
        }
      }
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
      // Unmounting with the prompt up (tab closed mid-unlock) must settle the
      // promise, or the load loop above never returns and the effect leaks.
      setPasswordAsk((ask) => {
        ask?.resolve(null)
        return null
      })
      if (!isElectron) void releaseBrowserDoc(payload.path)
      void releasePdfiumDoc(payload.path)
      // Destroy whatever is CURRENT (a reload may have swapped resources)
      docResourcesRef.current?.task.destroy()
      docResourcesRef.current?.port.terminate()
      docResourcesRef.current = null
    }
  }, [payload, loadAttempt, rereadSettled])

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
    // The engine's rewrite preserved the encryption, so re-opening needs the
    // same password the user gave when the document was first unlocked.
    const resources = openDocument(data.slice(), docPasswordRef.current)
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
    // `splitOpen` belongs here for the same reason as the two panels: opening
    // the second column takes half the width out of this one in a single
    // commit. `panelW.pane` is here too — unlike the side panels, dragging the
    // split divider must re-fit BOTH columns continuously, because the other
    // column re-fits from its own per-render measurement and a one-frame lag on
    // only this side would read as the two halves disagreeing.
  }, [tocPinned, aiPinned, splitOpen, panelW.pane])

  // View-space reference dimensions (page units) that fit-width/fit-page zoom
  // against: the first page under the current rotation, widened to a pair when
  // spread is on.
  const fitDenom = useCallback((forPage?: number): { w: number; h: number } => {
    if (sizes.length === 0) return { w: 1, h: 1 }
    // Fit against the page currently in view, not always page 1 — so a document
    // that mixes portrait and landscape pages fits the page you are actually
    // reading (fit-width on a wide page fills the width, not overflows it).
    // A page turn passes the page it is about to land on instead.
    const cur = clamp((forPage ?? currentPage) - 1, 0, sizes.length - 1)
    const row = spread ? spreadRow(cur, sizes.length, coverPage) : [cur]
    const v0 = viewSize(sizes[row[0]].w, sizes[row[0]].h, rotation)
    if (row.length > 1) {
      const v1 = viewSize(sizes[row[1]].w, sizes[row[1]].h, rotation)
      return { w: v0.w + v1.w + SPREAD_GAP, h: Math.max(v0.h, v1.h) }
    }
    return { w: v0.w, h: v0.h }
  }, [sizes, rotation, spread, coverPage, currentPage])

  // Margin view reserves its card column the same way SIDE_PAD reserves its
  // edges: subtracted from the width every layout/fit computation sees, so the
  // page centres in what is left and the cards own the difference.
  const marginGutter = marginNotes ? MARGIN_NOTES_W : 0
  const marginGutterRef = useRef(marginGutter)
  marginGutterRef.current = marginGutter

  // Pick an initial zoom if none was restored: Acrobat-style "Automatic" —
  // fit-width capped at 100% (actual size). Normal pages open readable at
  // actual size; oversized pages (posters, drawings) still scale down to fit
  // the width. At the cap the mode is 'custom' so the 100% holds exactly when
  // panels toggle or the window resizes, same as a hand-picked zoom.
  useEffect(() => {
    if (scale > 0 || sizes.length === 0 || containerWidth === 0) return
    const fitW = (containerWidth - SIDE_PAD - marginGutter) / fitDenom().w
    if (fitW < 1) {
      setFitMode('width')
      setScale(clamp(fitW, ZOOM_MIN, ZOOM_MAX))
    } else {
      setFitMode('custom')
      setScale(1)
    }
  }, [sizes, scale, containerWidth, fitDenom, marginGutter])

  // ---------- Layout ----------

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
    // A left-hand margin means the gutter sits BEFORE the pages: shift every
    // page right by the reserved width so the column has its space.
    return shiftLayoutX(lay, marginView.side === 'left' ? marginGutter : 0)
  }, [sizes, scale, containerWidth, rotation, spread, coverPage, marginGutter, marginView.side])
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
  const updateRangeRef = useRef(updateRange)
  updateRangeRef.current = updateRange

  // The first column's scroll API, built from the same refs its own code uses.
  // Both columns hand out an identical interface, so `handleFor` below is the
  // only place that has to know there are two of them at all.
  const flipARef = useRef<(dir: -1 | 1) => void>(() => {})
  const paneAHandle = useMemo(
    () =>
      makePaneHandle({
        el: () => containerRef.current,
        layout: () => layoutRef.current,
        scale: () => scaleRef.current,
        rotation: () => rotationRef.current,
        sizes: () => sizesRef.current,
        afterScroll: () => updateRangeRef.current(),
        flipPage: (dir) => flipARef.current(dir)
      }),
    []
  )
  handleForRef.current = (pane: PaneId) => (pane === 'b' ? paneBHandleRef.current : paneAHandle)

  const schedulePositionSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const current = computeCurrent()
      if (current) {
        bridge.setPosition(payload.path, {
          ...current,
          zoom: scaleRef.current,
          rotation: rotationRef.current,
          spread: spreadRef.current,
          coverPage: coverPageRef.current
        })
      }
    }, 600)
  }, [computeCurrent, payload.path])
  schedulePositionSaveRef.current = schedulePositionSave

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
    if (flipLandRef.current !== null) {
      const i = clamp(flipLandRef.current, 0, layout.tops.length - 1)
      flipLandRef.current = null
      el.scrollTop = Math.max(0, layout.tops[i] - 8)
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

  /** Pane B scrolling: the same floating-bubble hygiene as pane A (a popover
   *  anchored to a screen point must not stay behind while the page moves under
   *  it), minus the reading-position save — the position persisted per file is
   *  the main column's, which is what re-opening the document restores. */
  const onPaneBScroll = useCallback(() => {
    setMenu((m) => (m ? null : m))
    setAnnotPopover((p) => (p ? null : p))
    if (immersiveRef.current) wakeHudRef.current()
  }, [])

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
    zoomTo((containerWidth - SIDE_PAD - marginGutter) / fitDenom().w)
  }, [sizes, containerWidth, zoomTo, fitDenom, marginGutter])

  /** Whole page visible (Edge-style toggle companion to fit-width) */
  const fitPage = useCallback(() => {
    const el = containerRef.current
    if (!el || sizes.length === 0 || el.clientWidth === 0) return
    setFitMode('page')
    const denom = fitDenom()
    const fitW = (el.clientWidth - SIDE_PAD - marginGutterRef.current) / denom.w
    const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h
    zoomTo(Math.min(fitW, fitH))
  }, [sizes, zoomTo, fitDenom])

  /** Book-style page turn (←/→): the previous/next row's top lands at the
   *  viewport top — a whole spread at a time in two-page view, so the
   *  left/right pairing never changes. In a fit mode the zoom re-fits against
   *  the LANDING row first (only here — never while scrolling — so a mixed
   *  portrait/landscape document keeps the fit's promise on every turn). */
  const flipA = useCallback(
    (dir: -1 | 1) => {
      const el = containerRef.current
      const lay = layoutRef.current
      const cur = computeCurrent()
      if (!el || !lay || !cur) return
      const target = flipTarget(
        cur.page - 1,
        dir,
        sizesRef.current.length,
        spreadRef.current,
        coverPageRef.current
      )
      if (target === null) return
      const mode = fitModeRef.current
      if (mode !== 'custom') {
        const denom = fitDenom(target + 1)
        const fitW = (el.clientWidth - SIDE_PAD - marginGutterRef.current) / denom.w
        const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h
        const next = clamp(mode === 'width' ? fitW : Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX)
        const prev = scaleRef.current
        if (prev > 0 && Math.abs(next - prev) / prev >= 0.002) {
          // Land after the relayout, not before — the tops move with the scale.
          pendingAnchorRef.current = null
          flipLandRef.current = target
          setScale(next)
          schedulePositionSave()
          return
        }
      }
      el.scrollTop = Math.max(0, lay.tops[target] - 8)
      updateRangeRef.current()
      schedulePositionSave()
    },
    [computeCurrent, fitDenom, schedulePositionSave]
  )
  flipARef.current = flipA

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
    const fitW = (cw - SIDE_PAD - marginGutterRef.current) / denom.w
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

  // Toggling the margin column changes the usable width exactly like a side
  // panel does, so it re-fits through the same path.
  useEffect(() => {
    refitRef.current()
  }, [containerWidth, marginGutter])

  /** Which fit the toggle button should offer next: 'page' when we are at
   *  (or near) fit-width, otherwise 'width' */
  const fitTarget: 'width' | 'page' = useMemo(() => {
    if (sizes.length === 0 || containerWidth === 0) return 'page'
    const fitW = (containerWidth - SIDE_PAD - marginGutter) / fitDenom().w
    return Math.abs(scale - fitW) / fitW < 0.02 ? 'page' : 'width'
  }, [scale, sizes, containerWidth, fitDenom, marginGutter])

  /** Snap a pinch-commit scale to fit-width/fit-height/fit-page when close.
   *  Tight threshold: the snap adjusts the committed scale away from what the
   *  gesture showed on screen, so anything above ~2.5% reads as a jump.
   *  The candidates come from fitDenom() — the same view-space denominator
   *  fit-width/fit-page zoom to — so a rotated column or a two-page spread
   *  snaps to the fit the buttons would give, not to a raw-page phantom. */
  const snapScale = useCallback(
    (raw: number): number => {
      const el = containerRef.current
      if (!el || sizes.length === 0 || el.clientWidth === 0) return raw
      const denom = fitDenom()
      const fitW = (el.clientWidth - SIDE_PAD - marginGutterRef.current) / denom.w
      const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / denom.h
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
    [sizes, fitDenom]
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
              moved: false,
              scale: scaleOfPageElRef.current(pageEl),
              rotation: rotationOfPageElRef.current(pageEl),
              pane: paneOfEl(pageEl)
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
  const computeFitScale = useCallback(
    (rot: ViewRotation, spr: boolean, cov: boolean): number | null => {
      const el = containerRef.current
      const s = sizesRef.current
      if (!el || fitModeRef.current === 'custom' || s.length === 0 || el.clientWidth === 0)
        return null
      // Reference row: the first PAIR the layout will show — with the cover
      // alone that is pages 2-3, not the lone cover, or fit-width computed
      // against the narrow cover row would overflow on every pair.
      const row = spr ? spreadRow(cov && s.length > 1 ? 1 : 0, s.length, cov) : [0]
      const v0 = viewSize(s[row[0]].w, s[row[0]].h, rot)
      let dw = v0.w
      let dh = v0.h
      if (row.length > 1) {
        const v1 = viewSize(s[row[1]].w, s[row[1]].h, rot)
        dw = v0.w + v1.w + SPREAD_GAP
        dh = Math.max(v0.h, v1.h)
      }
      const fitW = (el.clientWidth - SIDE_PAD) / dw
      const fitH = (el.clientHeight - PAD_TOP - PAD_BOTTOM) / dh
      return clamp(fitModeRef.current === 'width' ? fitW : Math.min(fitW, fitH), ZOOM_MIN, ZOOM_MAX)
    },
    []
  )

  /** Re-anchor the reading position across a rotation/spread relayout: capture
   *  the current page + fractional offset into restoreRef so the same spot is
   *  scrolled back after the layout rebuilds (batched with the state change so
   *  it happens in one relayout — pinch anchor stays cleared, no jump). */
  const reanchorFor = useCallback(
    (rot: ViewRotation, spr: boolean, cov: boolean): void => {
      const cur = computeCurrent()
      pendingAnchorRef.current = null
      const nextScale = computeFitScale(rot, spr, cov)
      if (nextScale !== null) setScale(nextScale)
      if (cur) {
        restoreRef.current = {
          page: cur.page,
          offset: cur.offset,
          zoom: nextScale ?? scaleRef.current,
          rotation: rot,
          spread: spr,
          coverPage: cov
        }
      }
    },
    [computeCurrent, computeFitScale]
  )

  /** Rotate the column being worked in. Per column, because the point of the
   *  split is often exactly this: hold a landscape-printed table upright on one
   *  side while the prose stays readable on the other. The second column keeps
   *  its own orientation in session state; the first column's is the one
   *  persisted with the reading position. */
  const rotateView = useCallback(
    (dir: 1 | -1) => {
      const pane = activePaneRef.current
      const from = pane === 'b' ? paneBRotationRef.current : rotationRef.current
      const next = ((((from + dir * 90) % 360) + 360) % 360) as ViewRotation
      // Draw tools assume an un-rotated page. PdfPage refuses to mount a draw
      // layer on a rotated column anyway, so only disarm when the column you are
      // actually drawing in is the one going crooked.
      if (next !== 0 && pane === activePaneRef.current) {
        setActiveTool((tool) => {
          if (tool) showToast(t('viewer.rotatedToolsOff'))
          return null
        })
        setFreeTextDraft(null)
      }
      if (pane === 'b') {
        setPaneBRotation(next)
        return
      }
      reanchorFor(next, spreadRef.current, coverPageRef.current)
      setRotation(next)
      schedulePositionSave()
    },
    [reanchorFor, showToast, schedulePositionSave]
  )

  const toggleSpread = useCallback(() => {
    const pane = activePaneRef.current
    if (pane === 'b') {
      setPaneBSpread((s) => {
        // Same rule as the first column: coming from a hand-set zoom, switch to
        // fit-page so BOTH pages of the pair actually become visible.
        if (!s) setPaneBFit((f) => (f === 'custom' ? 'page' : f))
        return !s
      })
      return
    }
    const next = !spreadRef.current
    // Entering two-page view from a custom (manual) zoom: switch to fit-page so
    // BOTH pages become visible. Without this the single-page zoom is kept and
    // the spread overflows the viewport, showing only part of it. (An existing
    // fit-width/fit-page mode already re-fits itself for the pair below.)
    if (next && fitModeRef.current === 'custom') {
      fitModeRef.current = 'page'
      setFitMode('page')
    }
    reanchorFor(rotationRef.current, next, coverPageRef.current)
    setSpread(next)
    schedulePositionSave()
  }, [reanchorFor, schedulePositionSave])

  /** The spread's cover sub-option (page 1 alone). Per column like spread
   *  itself; only meaningful while the column's spread is on, which is why the
   *  toolbar disables the toggle otherwise. */
  const toggleCoverPage = useCallback(() => {
    if (activePaneRef.current === 'b') {
      setPaneBCover((c) => !c)
      return
    }
    const next = !coverPageRef.current
    reanchorFor(rotationRef.current, spreadRef.current, next)
    setCoverPage(next)
    schedulePositionSave()
  }, [reanchorFor, schedulePositionSave])

  /** Tool selection guarded by rotation — draw tools are off while the column
   *  you would draw in is rotated (each column has its own orientation). */
  const selectTool = useCallback(
    (tool: DrawToolType | null) => {
      const rot =
        activePaneRef.current === 'b' ? paneBRotationRef.current : rotationRef.current
      if (tool && rot !== 0) {
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

  // «Behold bildefarger» resolved against the theme actually showing: the
  // setting is night-only by meaning, so day/sepia render nothing extra even
  // while the preference stays saved for the next night session
  const keepImageColors =
    settings.nightKeepImages && (resolvedTheme === 'night' || resolvedTheme === 'nightHc')

  // ---------- Save model (dirty = unsaved draft exists) ----------

  const [dirty, setDirty] = useState(false)
  const markDirtyRef = useRef<() => void>(() => {})
  markDirtyRef.current = () => setDirty(true)

  /** This viewer's identity on the intra-window doc bus — its own writes must
   *  never bounce back as a reload (mirrors how main only notifies OTHER
   *  windows). See local-doc-events.ts. */
  const docEventSenderRef = useRef<symbol>(Symbol('pdf-viewer'))
  const emitDocChanged = useCallback(
    () => emitLocalDocEvent(payload.path, 'changed', docEventSenderRef.current),
    [payload.path]
  )

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

  // ---------- Page bookmarks ----------
  //
  // A view-layer list per file, kept next to the reading position and never
  // written into the PDF. Held in page order so the sidebar and the B key agree
  // on what "the next one" is without either sorting.
  const [bookmarks, setBookmarks] = useState<DocBookmark[]>([])
  const bookmarksRef = useRef(bookmarks)
  bookmarksRef.current = bookmarks

  useEffect(() => {
    let stale = false
    void bridge.getBookmarks(payload.path).then((list) => {
      if (!stale) setBookmarks([...list].sort((a, b) => a.page - b.page))
    })
    return () => {
      stale = true
    }
  }, [payload.path])

  /** Write through immediately: the list is a handful of small objects, so a
   *  debounce would only add a window in which a crash loses the last click. */
  const persistBookmarks = useCallback(
    (next: DocBookmark[]) => {
      setBookmarks(next)
      bridge.setBookmarks(payload.path, next)
    },
    [payload.path]
  )

  const toggleBookmark = useCallback(
    (page: number) => {
      const existing = bookmarksRef.current.find((b) => b.page === page)
      if (existing) {
        persistBookmarks(bookmarksRef.current.filter((b) => b.page !== page))
        showToast(t('viewer.bookmarkRemoved', { page }))
        return
      }
      persistBookmarks(
        [...bookmarksRef.current, { page, label: '', createdAt: Date.now() }].sort(
          (a, b) => a.page - b.page
        )
      )
      showToast(t('viewer.bookmarkAdded', { page }))
    },
    [persistBookmarks, showToast]
  )

  const renameBookmark = useCallback(
    (page: number, label: string) => {
      persistBookmarks(bookmarksRef.current.map((b) => (b.page === page ? { ...b, label } : b)))
    },
    [persistBookmarks]
  )

  const saveDocument = useCallback(async () => {
    // The file may have changed outside the app since editing began — an
    // in-place save would silently clobber that external update. Ask first;
    // App runs the same menu as re-opening a stale path and (unless
    // cancelled) reloads this tab with the fresh bytes, so there is nothing
    // left for this call to save either way.
    if (await bridge.docWasModifiedExternally(payload.path)) {
      await onExternalSaveConflict(payload.path, payload.name)
      return
    }
    // Electron writes annotation changes back to the file in place via the
    // in-process engine.
    if (isElectron) {
      const result = await bridge.docSave(payload.path)
      if (result && 'error' in result) {
        showToast(t('viewer.saveFailed', { error: errorText(result) }))
        return
      }
      setDirty(false)
      // The draft is retired — another viewer of this path in THIS window
      // (a split pane) must clear its dirty flag too, like another window would
      emitLocalDocEvent(payload.path, 'draft-ended', docEventSenderRef.current)
      showToast(t('viewer.saved'))
      return
    }
    // Browser/extension: the engine's live document already carries every
    // annotation edit (create/update/delete — session AND pre-existing file
    // annotations). Serialize it, then overwrite the local file if it was
    // opened from disk, or save-picker/download for a URL-opened PDF.
    const bytes = await browserCurrentBytes(payload.path)
    if (!bytes) {
      showToast(t('viewer.saveFailed', { error: t('viewer.docNotOpen') }))
      return
    }
    const result = await bridge.saveDocumentBytes(payload.path, payload.name, bytes)
    if (!result) return // user cancelled the location picker
    if ('error' in result) {
      showToast(t('viewer.saveFailed', { error: errorText(result) }))
      return
    }
    setDirty(false)
    emitLocalDocEvent(payload.path, 'draft-ended', docEventSenderRef.current)
    showToast(t('viewer.saved'))
  }, [payload.path, payload.name, payload.data, showToast, onExternalSaveConflict])

  // Save a copy to a user-chosen location. Electron pulls the current bytes
  // (draft-or-original) from `path`; the browser serializes its live document
  // so the copy carries annotation edits — parity with the desktop draft.
  // On desktop the copy is then ADOPTED: the tab switches to the new file at
  // the same reading position, because saving a copy almost always means
  // "keep the original untouched, continue working in the copy". The browser
  // cannot reopen a file it just downloaded, so it keeps the toast-only flow.
  /** «Eksporter med kommentarer i margen»: a copy where every page is widened
   *  and the margin view's cards are baked in as real annotations (see
   *  src/shared/margin-export.ts). Runs the wasm engine in the renderer on all
   *  platforms — an explicit export may pay the cost the annotate path avoids
   *  on desktop. The original document is untouched. */
  const exportMarginNotes = useCallback(async () => {
    const cards: MarginExportCard[] = []
    for (const [pageNumber, list] of annotsRef.current) {
      for (const a of marginCardAnnotations(list)) {
        const text = (a.contents ?? '').trim()
        if (!text) continue // an empty note has nothing to print
        const anchor = quadsUnion(a.quads)
        cards.push({ pageIndex: pageNumber - 1, anchorY: anchor.y, anchor, text, color: a.color })
      }
    }
    if (cards.length === 0) {
      showToast(t('margin.exportEmpty'))
      return
    }
    if (payload.data.byteLength > WASM_SAFE_LIMIT) {
      showToast(t(isElectron ? 'engine.doc-too-large' : 'engine.doc-too-large-browser'))
      return
    }
    // Current bytes, draft included: main resolves the draft behind readFile
    // on desktop; browser/extension serialize the live in-memory doc.
    let bytes: Uint8Array | null
    if (isElectron) {
      const res = await bridge.readFile(payload.path)
      bytes = 'error' in res ? null : res.data
    } else {
      bytes = (await browserCurrentBytes(payload.path)) ?? payload.data.slice()
    }
    if (!bytes) {
      showToast(t('viewer.saveFailed', { error: t('margin.exportReadFailed') }))
      return
    }
    const { native, wrapped } = await getEngineWithRaw()
    // The copy's margin lands on the side the margin VIEW uses — one setting,
    // one mental model, chosen in the same menu as the export itself.
    const out = await buildMarginCopy(
      native,
      wrapped,
      bytes,
      cards,
      undefined,
      marginViewRef.current.side,
      settingsRef.current.annotAuthor.trim() || undefined,
      // The bytes above are the CURRENT document — still encrypted, because both
      // the draft and the engine's own rewrite keep the encryption.
      docPasswordRef.current
    )
    if (!(out instanceof Uint8Array)) {
      showToast(t('viewer.saveFailed', { error: errorText(out) }))
      return
    }
    const base = payload.name.replace(/\.pdf$/i, '')
    const result = await bridge.saveFileAs(`${base}${t('margin.exportSuffix')}.pdf`, out)
    if (!result) return // user cancelled the dialog
    if ('error' in result) {
      showToast(t('viewer.saveFailed', { error: errorText(result) }))
      return
    }
    showToast(t('margin.exportDone'))
  }, [payload.name, payload.path, payload.data, showToast])

  const saveDocumentAs = useCallback(async () => {
    const bytes = isElectron ? payload.data.slice() : ((await browserCurrentBytes(payload.path)) ?? payload.data.slice())
    const result = await bridge.saveFileAs(payload.name, bytes, payload.path)
    if (!result) return // user cancelled the dialog
    if ('error' in result) {
      showToast(t('viewer.saveFailed', { error: errorText(result) }))
      return
    }
    if (isElectron) {
      // Seed the copy's reading position so the swapped-in viewer opens at
      // the exact spot the user is looking at now
      const current = computeCurrent()
      if (current)
        bridge.setPosition(result.path, {
          ...current,
          zoom: scaleRef.current,
          rotation: rotationRef.current,
          spread: spreadRef.current,
          coverPage: coverPageRef.current
        })
      onSavedAs(result.path)
      return
    }
    showToast(t('viewer.savedCopy'))
  }, [payload.name, payload.data, payload.path, showToast, computeCurrent, onSavedAs])

  /** Annotation writes awaiting their IPC round trip. A cross-window reload
   *  must not land while one is open — see the sync effect below. */
  const pendingWritesRef = useRef(0)

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

  /** A rejected write and an {error} result mean the same thing to the user:
   *  the mark never reached the file. The three engine* helpers below normalise
   *  rejections into {error} so every caller stays on one path — most of them
   *  only `void` these calls, so an escaping rejection would leave the
   *  optimistic mark on screen with nothing said and no rollback. */
  const asWriteError = useCallback(
    (err: unknown): FileError => ({ error: err instanceof Error ? err.message : String(err) }),
    []
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
      pendingWritesRef.current += 1
      const result = await bridge
        .annotate({
          path: payload.path,
          pageIndex: handle.pageNumber - 1,
          type: snapshot.type,
          quads: snapshot.quads,
          color: snapshot.color,
          opacity: snapshot.opacity,
          contents: snapshot.contents,
          author: snapshot.author,
          strokes: snapshot.strokes,
          pressures: snapshot.pressures,
          width: snapshot.width,
          fontSize: snapshot.fontSize,
          font: snapshot.font,
          blend: snapshot.blend,
          // A stamp's picture goes to the engine as raw PNG bytes; the record
          // keeps the data URL, which is what the overlay can paint.
          image: snapshot.imageUrl ? dataUrlToBytes(snapshot.imageUrl) : undefined
        })
        .catch(asWriteError)
        .finally(() => {
          pendingWritesRef.current -= 1
        })
      if ('error' in result) {
        showToast(t('viewer.annotSaveFailed', { error: errorText(result) }))
        mutatePage(handle.pageNumber, (list) => list.filter((r) => r.id !== handle.localId))
      } else {
        handle.fileId = result.id
        markDirtyRef.current()
        emitDocChanged()
        mutatePage(handle.pageNumber, (list) =>
          list.map((r) => (r.id === handle.localId ? { ...r, fileId: result.id } : r))
        )
      }
    },
    [payload.path, mutatePage, showToast, asWriteError, emitDocChanged]
  )

  /** The delete write itself, with no opinion about how to report it. Split out
   *  of engineDelete because one mark and a whole documentful differ only in
   *  that: deleting one reloads and toasts immediately, while "clear all" does
   *  each ONCE at the end — a hundred marks must not mean a hundred reloads. */
  const deleteOneAnnotation = useCallback(
    async (handle: AnnotHandle): Promise<{ failed: FileError | null; wasFilePainted: boolean }> => {
      const wasFilePainted = findRecord(handle)?.source === 'file'
      mutatePage(handle.pageNumber, (list) => list.filter((r) => !matchesHandle(r, handle)))
      // Never written to the file, so there is nothing to delete and nothing to
      // dirty — the optimistic removal above was the whole operation.
      if (handle.fileId === null) return { failed: null, wasFilePainted: false }
      pendingWritesRef.current += 1
      const result = await bridge
        .deleteAnnotation({
          path: payload.path,
          pageIndex: handle.pageNumber - 1,
          id: handle.fileId
        })
        .catch(asWriteError)
        .finally(() => {
          pendingWritesRef.current -= 1
        })
      if ('error' in result) return { failed: result, wasFilePainted: false }
      markDirtyRef.current()
      emitDocChanged()
      return { failed: null, wasFilePainted }
    },
    [payload.path, mutatePage, matchesHandle, findRecord, asWriteError, emitDocChanged]
  )

  const engineDelete = useCallback(
    async (handle: AnnotHandle) => {
      const { failed, wasFilePainted } = await deleteOneAnnotation(handle)
      if (failed) showToast(t('viewer.annotDeleteFailed', { error: errorText(failed) }))
      else if (wasFilePainted) void reloadDocument()
    },
    [deleteOneAnnotation, showToast, reloadDocument]
  )

  const engineChange = useCallback(
    async (handle: AnnotHandle, patch: AnnotPatch) => {
      const record = findRecord(handle)
      const wasFilePainted = record?.source === 'file'
      mutatePage(handle.pageNumber, (list) =>
        list.map((r) => (matchesHandle(r, handle) ? { ...r, ...patch } : r))
      )
      if (handle.fileId === null) {
        showToast(t('viewer.annotStillSaving'))
        return
      }
      // How a reshape's geometry travels is per-subtype (mirrors updateOn):
      // text markup sends the whole quad list (→ /QuadPoints); ink/line/arrow
      // send strokes (→ /InkList, /L); box types send quads[0] as the new rect.
      // A translate sends only the delta — the engine shifts its own geometry.
      const markup = record ? isTextMarkup(record) : false
      const reshapeQuads = patch.translate ? undefined : patch.quads
      const reshapeStrokes = patch.translate ? undefined : patch.strokes
      pendingWritesRef.current += 1
      const result = await bridge
        .updateAnnotation({
          path: payload.path,
          pageIndex: handle.pageNumber - 1,
          id: handle.fileId,
          color: patch.color,
          contents: patch.contents,
          font: patch.font,
          rect: markup ? undefined : reshapeQuads?.[0],
          quads: markup ? reshapeQuads : undefined,
          strokes: reshapeStrokes,
          translate: patch.translate
        })
        .catch(asWriteError)
        .finally(() => {
          pendingWritesRef.current -= 1
        })
      if ('error' in result) showToast(t('viewer.annotChangeFailed', { error: errorText(result) }))
      else {
        markDirtyRef.current()
        emitDocChanged()
        // 'file' annots are painted by pdf.js from the file — refresh the canvas
        if (wasFilePainted && (patch.color || patch.quads || patch.strokes || patch.translate)) {
          void reloadDocument()
        }
      }
    },
    [payload.path, mutatePage, matchesHandle, findRecord, showToast, reloadDocument, asWriteError, emitDocChanged]
  )

  // Another window annotated the same file. Both windows write into the ONE
  // draft main keeps per path, so the draft — not a replayed patch — is the
  // truth: re-open the document from it and the two views converge exactly on
  // what a Save from either window would produce. reloadDocument keeps the old
  // canvases up until the new ones are ready, so this is visually quiet.
  //
  // Debounced because a burst of strokes in the other window would otherwise
  // ask for a reload per stroke. The window also becomes dirty: a draft now
  // exists, and closing must offer to save it whichever window you close.
  const remoteReloadRef = useRef<number | null>(null)
  useEffect(() => {
    const arm = (): void => {
      if (remoteReloadRef.current) window.clearTimeout(remoteReloadRef.current)
      remoteReloadRef.current = window.setTimeout(() => {
        remoteReloadRef.current = null
        // Never reload on top of our OWN in-flight write: engineCreate adds the
        // record to state first and patches its file id in after the round trip,
        // so a reload landing in between would drop a mark the user just made
        // (it may not be in the file yet either). Wait for the write to settle.
        if (pendingWritesRef.current > 0) {
          arm()
          return
        }
        void reloadDocument()
      }, 250)
    }
    const offChanged = bridge.onAnnotationsChangedElsewhere((path) => {
      if (path !== payload.path) return
      setDirty(true)
      arm()
    })
    // The other window ended the shared draft. On a Save the work is on disk, on
    // a discard it is gone — either way THIS window has nothing left to save, and
    // saying otherwise would offer to save nothing (and, after a discard, keep
    // showing marks the document no longer has). Re-read the file for both: it
    // is the same bytes after a save and the reverted original after a discard.
    const offEnded = bridge.onDraftEndedElsewhere((path) => {
      if (path !== payload.path) return
      setDirty(false)
      arm()
    })
    // The intra-window sibling of the two above: the same document changed in
    // THIS window (another tab's split pane, or an app-level discard). Same
    // handling — the draft in main is the truth, re-read it — and own events
    // are ignored so a write never reloads the viewer that made it.
    const offLocal = onLocalDocEvent((path, kind, sender) => {
      if (path !== payload.path || sender === docEventSenderRef.current) return
      setDirty(kind === 'changed')
      arm()
    })
    return () => {
      offChanged()
      offEnded()
      offLocal()
    }
  }, [payload.path, reloadDocument])
  useEffect(
    () => () => {
      if (remoteReloadRef.current) window.clearTimeout(remoteReloadRef.current)
    },
    []
  )

  // ---------- Undo / redo ----------

  const { pushUndo, performUndoRedo, undoDepths } = useUndoStack(
    engineCreate,
    engineDelete,
    engineChange
  )

  // ---------- User-facing annotation actions ----------

  const persistAnnotation = useCallback(
    (
      pageNumber: number,
      type: AnnotationType,
      quads: PageRect[],
      color: [number, number, number],
      opacity: number,
      contents?: string,
      // Spread into a FRESH snapshot below, so present-and-undefined is
      // indistinguishable from absent — see the note on PageAnnotation.
      extras?: {
        strokes?: [number, number][][] | undefined
        pressures?: number[][] | undefined
        width?: number | undefined
        fontSize?: number | undefined
        /** freetext: the Standard-14 face it is set in */
        font?: PdfStandardFont | undefined
        blend?: 'multiply' | undefined
        imageUrl?: string | undefined
      }
    ): AnnotHandle => {
      const handle: AnnotHandle = { pageNumber, localId: nextAnnotationId(), fileId: null }
      // Author = the user's own name from settings; empty writes no /T at all
      // (the app has no accounts, so a made-up default would just be noise in
      // other readers and in the exports)
      const author = settingsRef.current.annotAuthor.trim() || undefined
      const snapshot: PageAnnotation = {
        id: handle.localId,
        fileId: null,
        source: 'session',
        type,
        quads,
        color,
        opacity,
        contents,
        author,
        strokes: extras?.strokes,
        pressures: extras?.pressures,
        width: extras?.width,
        fontSize: extras?.fontSize,
        font: extras?.font,
        blend: extras?.blend,
        imageUrl: extras?.imageUrl
      }
      pushUndo({ kind: 'create', handle, snapshot })
      // engineCreate puts the record in state synchronously and persists in
      // the background — returning the handle lets callers reference the new
      // annotation (e.g. open its popover) without waiting for the write.
      void engineCreate(handle, snapshot)
      return handle
    },
    [pushUndo, engineCreate]
  )

  const changeAnnotation = useCallback(
    (pageNumber: number, record: PageAnnotation, patch: AnnotPatch) => {
      const handle: AnnotHandle = { pageNumber, localId: record.id, fileId: record.fileId }
      const before: AnnotPatch = {}
      if (patch.color) before.color = record.color
      if (patch.contents !== undefined) before.contents = record.contents ?? ''
      // A box read back from a FILE carries no font (pdf.js paints those from
      // the appearance stream), so the undo value falls back to the same default
      // buildAnnotation uses — otherwise undoing a font change on such a box
      // would omit the key and leave the new face in place.
      if (patch.font !== undefined) before.font = record.font ?? TEXT_FONT_DEFAULT
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

  /** Delete every annotation in the document as ONE undoable action.
   *
   *  Sequential rather than parallel on purpose: the engine serialises writes
   *  per path anyway, and a burst of concurrent deletes would only queue in a
   *  place where failures are harder to count. The reload — needed because
   *  pdf.js painted the marks that came from the file — waits until the end, as
   *  does the single summary toast; a document with fifty marks would otherwise
   *  reload fifty times and show fifty toasts of which the user sees the last. */
  const removeAllAnnotations = useCallback(async () => {
    const entries: UndoEntry[] = []
    const handles: AnnotHandle[] = []
    for (const [pageNumber, list] of annotsRef.current) {
      for (const record of list) {
        const handle: AnnotHandle = { pageNumber, localId: record.id, fileId: record.fileId }
        handles.push(handle)
        entries.push({ kind: 'delete', handle, snapshot: { ...record } })
      }
    }
    if (entries.length === 0) return
    pushUndo({ kind: 'batch', entries })
    setAnnotPopover(null)
    setSelected(null)
    let failed = 0
    let needsReload = false
    for (const handle of handles) {
      const outcome = await deleteOneAnnotation(handle)
      if (outcome.failed) failed += 1
      if (outcome.wasFilePainted) needsReload = true
    }
    // The toast names the undo key, which the reader may have rebound (or
    // unbound — then a variant says the same thing without naming a key)
    const undoKeys = shortcutLabel('edit.undo')
    showToast(
      failed !== 0
        ? t('viewer.annotsClearedPartly', { failed, total: handles.length })
        : undoKeys
          ? t('viewer.annotsCleared', { count: handles.length, keys: undoKeys })
          : t('viewer.annotsClearedNoKey', { count: handles.length })
    )
    if (needsReload) void reloadDocument()
  }, [pushUndo, deleteOneAnnotation, showToast, reloadDocument])

  // ---------- Freehand drawing ----------

  const completeStroke = useCallback(
    (pageNumber: number, points: [number, number][], pressures?: number[]) => {
      const tool = drawToolRef.current
      if (!tool || tool.type === 'eraser') return
      const quads = [inkQuad([points], tool.width)]
      void persistAnnotation(pageNumber, 'ink', quads, tool.color, tool.opacity, undefined, {
        strokes: [points],
        // Pen pressures (captured only for a real pen with the pen tool) ride
        // the whole way into the file — the engine bakes the varying width as
        // the appearance stream, or refuses rather than save it uniform.
        pressures: pressures && tool.type === 'pen' ? [pressures] : undefined,
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
      // Ink strokes first (path-precise hit), then the wider bbox pass. Scope
      // decides what the second pass may touch: 'draw' keeps the eraser to
      // marks made by hand (ink + shapes), which is what its tooltip has always
      // promised; 'all' extends it to highlights, notes and text boxes so a
      // wrongly-placed markup can be wiped instead of clicked and deleted.
      for (let i = list.length - 1; i >= 0; i--) {
        const record = list[i]
        if (record.type !== 'ink') continue
        if (inkHitTest(record, x, y, 4)) {
          removeAnnotation(pageNumber, record)
          return
        }
      }
      const erasable =
        prefsRef.current.eraserScope === 'all'
          ? list
          : list.filter((a) => ERASER_DRAWN_TYPES.has(a.type))
      const hit = annotationAtPoint(erasable, x, y)
      if (hit) removeAnnotation(pageNumber, hit)
    },
    [removeAnnotation]
  )

  const completeShape = useCallback(
    (pageNumber: number, type: ShapeToolType, a: [number, number], b: [number, number]) => {
      const tool = drawToolRef.current
      if (!tool) return
      const isLine = type === 'line' || type === 'arrow'
      const quads = [
        isLine
          ? lineQuad(a, b, tool.width)
          : {
              x: Math.min(a[0], b[0]),
              y: Math.min(a[1], b[1]),
              w: Math.abs(b[0] - a[0]),
              h: Math.abs(b[1] - a[1])
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
      // A handwritten note stores its text wrapped; the editor should show the
      // sentence the user wrote, not the line breaks the box happened to need.
      text: record.contents ?? '',
      color: record.color,
      fontSize: record.fontSize ?? FREETEXT_SIZE,
      font: record.font,
      pane: activePaneRef.current
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
      setFreeTextDraft({
        pageNumber,
        x,
        y,
        clientX,
        clientY,
        w: 200,
        h: 48,
        pane: activePaneRef.current
      })
    },
    [openFreeTextEditor]
  )

  // Commit the editor. `wPt`/`hPt` are the editor's drag-resized box in page
  // points; editing an existing box resizes/edits it in place, otherwise a new
  // FreeText is created at the drawn box size.
  const saveFreeText = useCallback(
    async (text: string, wPt?: number, hPt?: number) => {
      if (!freeTextDraft) return
      const wDrag = wPt && wPt > 24 ? wPt : freeTextDraft.w
      const hDrag = hPt && hPt > 14 ? hPt : freeTextDraft.h
      // The editor can be drag-shrunk below its own text — commit a box that
      // shows every letter instead (same floor the resize handles enforce)
      const fontSize = freeTextDraft.editingId
        ? freeTextDraft.fontSize ?? FREETEXT_SIZE
        : prefsRef.current.text.fontSize
      // Measured in the box's OWN face: Courier is far wider than Helvetica at
      // the same size, so measuring every box in one font would let a
      // monospaced one commit narrower than its own words.
      const font = freeTextDraft.editingId ? freeTextDraft.font : prefsRef.current.text.font
      const min = freetextMinSize(text, fontSize, wDrag, font)
      const w = Math.max(wDrag, min.w)
      const h = Math.max(hDrag, min.h)
      const rect = { x: freeTextDraft.x, y: freeTextDraft.y, w, h }
      if (freeTextDraft.editingId) {
        // A re-opened box keeps its OWN face and size; the tool's current ones
        // belong to the next box, not to this one.
        const record = (annotsRef.current.get(freeTextDraft.pageNumber) ?? []).find(
          (r) => r.id === freeTextDraft.editingId
        )
        if (record) {
          changeAnnotation(freeTextDraft.pageNumber, record, { quads: [rect], contents: text })
        }
        setFreeTextDraft(null)
        return
      }
      const pref = prefsRef.current.text
      const handle = persistAnnotation(freeTextDraft.pageNumber, 'freetext', [rect], pref.color, 1, text, {
        fontSize: pref.fontSize,
        font: pref.font
      })
      setFreeTextDraft(null)
      // Text boxes are one-shot: unlike pen strokes, nobody places several in
      // a row, and a lingering armed tool blocks selecting/moving the new box
      setActiveTool((tool) => (tool === 'text' ? null : tool))
      // Select the fresh box so the frame + corner handles appear at once —
      // the affordance that says "this can be moved and resized" (Fredrik
      // never discovered it when the box just sat there as flat text)
      setSelected({ pageNumber: freeTextDraft.pageNumber, localId: handle.localId })
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
    (pageNumber: number, points: [number, number][], pressures?: number[]) =>
      drawActionsRef.current.stroke(pageNumber, points, pressures),
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

  // Margin-view card actions — same stable-identity pattern as the draw
  // actions above (PdfPage is memoised; churn re-renders page canvases).
  const marginActionsRef = useRef({ change: changeAnnotation, remove: removeAnnotation })
  marginActionsRef.current = { change: changeAnnotation, remove: removeAnnotation }
  const onMarginCommit = useCallback((pageNumber: number, localId: string, text: string) => {
    const record = (annotsRef.current.get(pageNumber) ?? []).find((r) => r.id === localId)
    if (record) marginActionsRef.current.change(pageNumber, record, { contents: text })
  }, [])
  const onMarginSelect = useCallback((pageNumber: number, localId: string) => {
    setAnnotPopover(null)
    setSelected({ pageNumber, localId })
  }, [])
  const onMarginDelete = useCallback((pageNumber: number, localId: string) => {
    const record = (annotsRef.current.get(pageNumber) ?? []).find((r) => r.id === localId)
    if (record) marginActionsRef.current.remove(pageNumber, record)
  }, [])

  /** Selection rects per page, for every rendered page the selection touches.
   *  Walks BOTH panes — a selection lives in whichever pane the user dragged in,
   *  and each pane divides by its own scale. */
  const collectSelectionRects = useCallback((): { pageNumber: number; rects: PageRect[] }[] => {
    const sel = window.getSelection()
    const out: { pageNumber: number; rects: PageRect[] }[] = []
    if (!sel || sel.isCollapsed) return out
    for (const pageEl of allPageElsRef.current()) {
      // selectionRectsForPage divides client offsets by scale → VIEW-space
      // rects (the on-screen rotated frame). Convert to PAGE space before they
      // become annotation quads written to the file.
      const viewRects = selectionRectsForPage(sel, pageEl, scaleOfPageElRef.current(pageEl))
      if (!viewRects) continue
      const pageNumber = Number(pageEl.dataset.page)
      const size = sizesRef.current[pageNumber - 1]
      const rot = rotationOfPageElRef.current(pageEl)
      const rects =
        size && rot !== 0
          ? viewRects.map((r) => viewRectToPage(r, size.w, size.h, rot))
          : viewRects
      // Safety net for the two-pane case: a DOM selection lives in exactly one
      // pane, and the panes never overlap on screen, so clipping against the
      // other pane's copy of the same page yields nothing. If that ever stops
      // holding, one page must still produce ONE markup, not two.
      if (out.some((o) => o.pageNumber === pageNumber)) continue
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
      // The user's opacity for this markup type — so a mark made from the
      // right-click menu and one made with the armed toolbar tool are the same
      // annotation, not two different-looking ones.
      const opacity = prefsRef.current.markup[type].opacity
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
        case 'comment': {
          // Highlight the selection and open the regular annotation popover
          // right away, focused on the comment field — identical to marking
          // and then clicking the mark, minus the second click. The comment
          // lives in the highlight itself; nothing extra floats on the page.
          if (!menu || menu.mode !== 'selection') break
          const { x, y } = menu
          // Capture the selection's on-screen box BEFORE clearing it, so the
          // comment bubble can open clear of the marked text (still readable
          // while composing).
          const domSel = window.getSelection()
          const selRect = domSel && domSel.rangeCount ? domSel.getRangeAt(0).getBoundingClientRect() : null
          const avoid = selRect ? { top: selRect.top, bottom: selRect.bottom, left: selRect.left } : null
          const perPage = collectSelectionRects()
          setMenu(null)
          if (perPage.length === 0) break
          const { color, opacity } = prefsRef.current.markup.highlight
          let lastHandle: AnnotHandle | null = null
          for (const { pageNumber, rects } of perPage) {
            lastHandle = persistAnnotation(pageNumber, 'highlight', rects, color, opacity)
          }
          if (lastHandle) {
            setSelected({ pageNumber: lastHandle.pageNumber, localId: lastHandle.localId })
            setAnnotPopover({
              x,
              y,
              avoid,
              pageNumber: lastHandle.pageNumber,
              localId: lastHandle.localId,
              focusText: true
            })
          }
          window.getSelection()?.removeAllRanges()
          break
        }
        case 'note': {
          if (!menu) break
          if (menu.mode === 'selection') {
            const domSel = window.getSelection()
            const selRect = domSel && domSel.rangeCount ? domSel.getRangeAt(0).getBoundingClientRect() : null
            const avoid = selRect ? { top: selRect.top, bottom: selRect.bottom, left: selRect.left } : null
            const perPage = collectSelectionRects()
            const last = perPage.at(-1)
            if (last) {
              const r = last.rects[last.rects.length - 1]
              setNoteDraft({
                x: menu.x,
                y: menu.y,
                avoid,
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
        case 'snip': {
          setMenu(null)
          setSnip({ target: 'quick' })
          break
        }
        case 'reference':
        case 'critique':
        case 'ask': {
          if (!selText || !menu || !pdf) {
            setMenu(null)
            break
          }
          const { x, y, pageNumber } = menu
          const mode = action.kind
          setMenu(null)
          window.getSelection()?.removeAllRanges()
          // Attach the whole document so the model can draw on the full paper
          // (bibliography entry / free-form question); also grab local
          // context around the selection.
          void (async () => {
            let pageContext = ''
            let document: { title: string; pages: PageText[]; doc: AiDocument } | null = null
            try {
              // Build the document inline (buildAiDocument is a module fn) —
              // ensureAiDocument is declared later in the component, so
              // depending on it here would hit the const TDZ.
              const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
              const doc = buildAiDocument(pages)
              document = { title: payload.name, pages, doc }
              const pageText = pages[pageNumber - 1]?.text ?? ''
              const at = pageText.indexOf(selText.slice(0, 80))
              pageContext =
                at === -1
                  ? pageText.slice(0, 1500)
                  : pageText.slice(Math.max(0, at - 800), at + selText.length + 800)
            } catch {
              /* context is best-effort */
            }
            setAiQuick({ x, y, mode, selection: selText, pageNumber, pageContext, document })
          })()
          break
        }
      }
    },
    [menu, pdf, payload.name, applyMarkup, collectSelectionRects]
  )

  /** Snip-to-explain: locate the page under the dragged box, re-render that
   *  region offscreen at a readable resolution (the on-screen canvas may be
   *  low-res at fit-width), then either open the quick popover in figure
   *  mode ('quick') or stage the region as a chat attachment ('chat'). */
  const onSnipDone = useCallback(
    (snipRect: { x: number; y: number; w: number; h: number }) => {
      const target = snip?.target ?? 'quick'
      setSnip(null)
      if (!pdf) return
      // Pick the page with the largest overlap; clamp the box to it. Both panes
      // are candidates — a figure is snipped wherever it is on screen.
      const pages = allPageElsRef.current()
      let best: { el: HTMLElement; area: number } | null = null
      for (const el of pages) {
        const r = el.getBoundingClientRect()
        const w = Math.min(snipRect.x + snipRect.w, r.right) - Math.max(snipRect.x, r.left)
        const h = Math.min(snipRect.y + snipRect.h, r.bottom) - Math.max(snipRect.y, r.top)
        if (w > 0 && h > 0 && (!best || w * h > best.area)) best = { el, area: w * h }
      }
      if (!best) return
      const pageEl = best.el
      const pageNumber = Number(pageEl.dataset.page)
      const pr = pageEl.getBoundingClientRect()
      const cx = Math.max(snipRect.x, pr.left) - pr.left
      const cy = Math.max(snipRect.y, pr.top) - pr.top
      const cw = Math.min(snipRect.x + snipRect.w, pr.right) - Math.max(snipRect.x, pr.left)
      const ch = Math.min(snipRect.y + snipRect.h, pr.bottom) - Math.max(snipRect.y, pr.top)
      if (cw < 12 || ch < 12) return
      void (async () => {
        try {
          const page = await pdf.getPage(pageNumber)
          // The scale of the pane the box was drawn in, not the main pane's
          const cur = scaleOfPageElRef.current(pageEl)
          // Aim for ~900px crop width so axis labels stay legible, capped so
          // tiny boxes don't explode and the canvas stays within safe limits
          const targetScale = Math.min(
            Math.max((900 / cw) * cur, cur),
            4,
            (4000 / cw) * cur,
            (4000 / ch) * cur
          )
          const k = targetScale / cur
          const viewport = page.getViewport({
            scale: targetScale,
            // The rotation of the column the box was drawn in
            rotation: (page.rotate + rotationOfPageElRef.current(pageEl)) % 360
          })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(cw * k)
          canvas.height = Math.floor(ch * k)
          const task = page.render({
            canvas,
            viewport,
            transform: [1, 0, 0, 1, -cx * k, -cy * k]
          })
          await task.promise
          const dataUrl = canvas.toDataURL('image/png')
          const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          const image = { mediaType: 'image/png', dataBase64 }
          if (target === 'chat') {
            setChatSnip({ id: ++chatSnipSeqRef.current, image })
            setAiPinned(true)
            return
          }
          let pageContext = ''
          try {
            const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
            pageContext = texts[pageNumber - 1]?.text.slice(0, 2500) ?? ''
          } catch {
            /* context is best-effort */
          }
          setAiQuick({
            x: snipRect.x,
            y: snipRect.y + snipRect.h,
            mode: 'figure',
            selection: '',
            pageNumber,
            pageContext,
            image
          })
        } catch {
          /* a cancelled/failed render just drops the snip */
        }
      })()
    },
    [pdf, snip]
  )

  /** Whole pages as images for the assistant to READ (scanned documents) —
   *  the shared renderer in ai-page-images.ts, bound to this viewer's pdf. */
  const renderPagesAsImages = useCallback(
    (from: number, count: number): Promise<{ pages: number[]; images: AiImage[] }> =>
      pdf ? renderAiPageImages(pdf, from, count) : Promise.resolve({ pages: [], images: [] }),
    [pdf]
  )

  /** The panel asked for pages; render them and hand them over to be staged. */
  const onRequestPageImages = useCallback(
    (from: number, count: number) => {
      setChatPagesBusy(true)
      void renderPagesAsImages(from, count)
        .then(({ pages, images }) => {
          if (images.length > 0) setChatPages({ id: ++chatPagesSeqRef.current, pages, images })
        })
        .finally(() => setChatPagesBusy(false))
    },
    [renderPagesAsImages]
  )

  // ---------- Digital signatures already in the document ----------

  /** Read once per document. Empty for the overwhelming majority of files, and
   *  the indicator only exists when it is not — a permanently visible badge for
   *  something that is almost never there is clutter. */
  const [docSignatures, setDocSignatures] = useState<DocSignature[]>([])
  const [signatureInfoOpen, setSignatureInfoOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDocSignatures([])
    setSignatureInfoOpen(false)
    if (!pdf) return
    void (async () => {
      try {
        // CHEAP GATE FIRST. Reading the signatures themselves means opening the
        // document a second time in the WASM engine — on desktop that happens in
        // main, and paying it on every open, for a badge that stays hidden for
        // all but a handful of documents, is exactly the kind of cost that is
        // invisible until it is not (it was: it blocked main long enough to
        // stall input). pdf.js already has the document parsed, and its form
        // field list answers "is there a signature field at all" for free.
        const fields = (await pdf.getFieldObjects()) as Record<
          string,
          { type?: string }[]
        > | null
        const hasSignatureField = fields
          ? Object.values(fields).some((group) =>
              group.some((f) => f?.type === 'signature')
            )
          : false
        if (!hasSignatureField || cancelled) return
        const res = await bridge.docSignatures(payload.path)
        if (!cancelled && Array.isArray(res)) setDocSignatures(res)
      } catch {
        // A document we cannot ask about is reported as unsigned rather than as
        // an error: this is an informational badge, not something the user
        // asked for, and a toast about it would be noise.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [payload.path, pdf])

  // ---------- Signature stamps ----------

  const [signatures, setSignatures] = useState<SavedSignature[]>(() => loadSignatures())
  /** The signature armed for placement, if any — the next click on a page
   *  stamps it. Held as the id so a deletion can disarm cleanly. */
  const [armedSignature, setArmedSignature] = useState<string | null>(null)
  const [signaturePadOpen, setSignaturePadOpen] = useState(false)

  const armedSignatureRef = useRef<string | null>(null)
  armedSignatureRef.current = armedSignature
  const signaturesRef = useRef<SavedSignature[]>(signatures)
  signaturesRef.current = signatures

  /** Toolbar's main signature button: do the obvious thing. Nothing saved yet →
   *  open the pad. Exactly one → arm it. Several → let the menu decide. */
  const onSignaturePrimary = useCallback(() => {
    if (armedSignatureRef.current) {
      setArmedSignature(null)
      return
    }
    const list = signaturesRef.current
    if (list.length === 0) setSignaturePadOpen(true)
    else if (list.length === 1) setArmedSignature(list[0].id)
    else setArmedSignature(list[0].id) // newest first — the menu picks another
  }, [])

  const onSignatureSaved = useCallback((sig: Omit<SavedSignature, 'id'>) => {
    const saved: SavedSignature = { ...sig, id: `sig-${Date.now().toString(36)}` }
    setSignatures((list) => addSignature(list, saved))
    setSignaturePadOpen(false)
    // Straight into placement: drawing one is always a prelude to using it.
    setArmedSignature(saved.id)
  }, [])

  const onSignatureDelete = useCallback((id: string) => {
    setSignatures((list) => removeSignature(list, id))
    setArmedSignature((cur) => (cur === id ? null : cur))
  }, [])

  /** Place the armed signature at a page point, centred on the click. */
  const placeSignatureAt = useCallback(
    (clientX: number, clientY: number) => {
      const sig = signaturesRef.current.find((s) => s.id === armedSignatureRef.current)
      if (!sig) return
      for (const el of allPageElsRef.current()) {
        const r = el.getBoundingClientRect()
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue
        const [px, py] = pagePointFromClientRef.current?.(clientX, clientY, el) ?? [0, 0]
        const rect = stampRectAt(sig, px, py)
        persistAnnotation(
          Number(el.dataset.page),
          'stamp',
          [rect],
          // A stamp has no colour of its own — the image carries it. Black at
          // full opacity keeps the record shape uniform with every other type.
          [0, 0, 0],
          1,
          undefined,
          { imageUrl: sig.dataUrl }
        )
        setArmedSignature(null)
        return
      }
    },
    [persistAnnotation]
  )

  // Esc disarms the signature, like the note tool
  useEffect(() => {
    if (!armedSignature) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setArmedSignature(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armedSignature])

  /** Toolbar note tool: click a page point, open the note draft there */
  const placeNoteAt = useCallback(
    (clientX: number, clientY: number) => {
      setNotePlacing(false)
      const pages = allPageElsRef.current()
      for (const el of pages) {
        const r = el.getBoundingClientRect()
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
          const [px, py] = pagePointFromClientRef.current?.(clientX, clientY, el) ?? [0, 0]
          setNoteDraft({
            x: clientX,
            y: clientY,
            pageNumber: Number(el.dataset.page),
            anchor: { x: px, y: py, w: 20, h: 20 }
          })
          return
        }
      }
    },
    []
  )

  // Esc disarms the note tool (capture: the keypress only cancels placement)
  useEffect(() => {
    if (!notePlacing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setNotePlacing(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [notePlacing])

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
      const s = scaleOfPageElRef.current(pageEl)
      const vx = (clientX - rect.left) / s
      const vy = (clientY - rect.top) / s
      const pageNumber = Number(pageEl.dataset.page)
      const size = sizesRef.current[pageNumber - 1]
      if (!size) return [vx, vy]
      return viewPointToPage(vx, vy, size.w, size.h, rotationOfPageElRef.current(pageEl))
    },
    []
  )
  pagePointFromClientRef.current = pagePointFromClient

  /** Screen box of an annotation, padded, for the properties popover to open
   *  CLEAR of — the popover is 248 px wide and lands where you clicked, which is
   *  on top of the very handles that let you resize the thing (measured with
   *  elementFromPoint: a corner grip's topmost element was the popover's colour
   *  row). The bubble stays draggable, so this only decides where it starts. */
  const annotAvoidRect = useCallback(
    (pageNumber: number, record: PageAnnotation): { top: number; bottom: number; left: number } | null => {
      if (record.quads.length === 0) return null
      const el = allPageElsRef.current().find((p) => Number(p.dataset.page) === pageNumber)
      const size = sizes[pageNumber - 1]
      if (!el || !size) return null
      const scale = scaleOfPageElRef.current(el)
      const v = pageRectToView(quadsUnion(record.quads), size.w, size.h, rotationOfPageElRef.current(el))
      const r = el.getBoundingClientRect()
      const PAD = 16 // the handles sit ~10 px outside the frame
      return {
        top: r.top + v.y * scale - PAD,
        bottom: r.top + (v.y + v.h) * scale + PAD,
        left: r.left + v.x * scale
      }
    },
    [sizes]
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
      const pageNumber = Number(pageEl.dataset.page)
      const [px, py] = pagePointFromClient(clientX, clientY, pageEl)
      // An annotation under the cursor takes precedence over the point menu
      const hit = annotsHiddenRef.current
        ? null
        : annotationHitTest(annotsRef.current.get(pageNumber) ?? [], px, py)
      if (hit) {
        setMenu(null)
        setSelected({ pageNumber, localId: hit.id })
        setAnnotPopover({
          x: clientX,
          y: clientY,
          avoid: annotAvoidRect(pageNumber, hit),
          pageNumber,
          localId: hit.id
        })
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

  // The menu pops up right after finishing a text selection;
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
            applyMarkup(mt, prefsRef.current.markup[mt].color)
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
          // Single click SELECTS a text box (frame +
          // drag-to-move); double-click opens the text editor.
          setSelected({ pageNumber, localId: hit.id })
          setAnnotPopover({
            x: clientX,
            y: clientY,
            avoid: annotAvoidRect(pageNumber, hit),
            pageNumber,
            localId: hit.id
          })
        } else {
          setSelected(null)
        }
      }, 0)
    },
    [openMenuAt, pagePointFromClient, applyMarkup, annotAvoidRect]
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
    // A resize handle already took this gesture. Its pointerdown fires first and
    // stops there, but the compat mousedown still arrives here — without this the
    // same press would arm a MOVE as well, and the two would fight.
    if (annotResizeRef.current || markupEditRef.current) return
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
        moved: false,
        scale: scaleOfPageElRef.current(pageEl),
        rotation: rotationOfPageElRef.current(pageEl),
        pane: paneOfEl(pageEl)
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
    /** Scale and rotation of the pane the drag STARTED in, captured once: the
     *  cursor delta is divided by the scale and rotated into page space, and the
     *  two columns zoom AND rotate independently. */
    scale: number
    rotation: ViewRotation
    /** Which pane draws the drag ghost (it lives inside that pane's layout) */
    pane: PaneId
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
    /** Drawn inside this pane's page layout */
    pane: PaneId
  } | null>(null)

  /** Where the dragged annotation lands for a given cursor position (page space, clamped) */
  const dragTarget = useCallback(
    (drag: NonNullable<typeof annotDragRef.current>, clientX: number, clientY: number) => {
      const q = drag.record.quads[0]
      const size = sizes[drag.pageNumber - 1]
      const scale = drag.scale
      // The cursor delta is a VIEW-space vector; rotate it into page space so
      // the annotation follows the pointer under any rotation.
      const view = viewDeltaToPage(
        (clientX - drag.startClientX) / scale,
        (clientY - drag.startClientY) / scale,
        drag.rotation
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
        kind: drag.record.type === 'note' ? 'bubble' : 'outline',
        pane: drag.pane
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
              avoid: annotAvoidRect(drag.pageNumber, drag.record),
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
  }, [active, dragTarget, changeAnnotation, openFreeTextEditor, annotAvoidRect])

  // ---------- Annotation resizing (corner handles + line endpoints) ----------
  //
  // The twin of dragging: same pointer listeners, same ghost, same undo — the
  // difference is that a move sends a delta and this sends the NEW geometry
  // (engine support landed with ModifyAnnotationRequest.quads/strokes). Only
  // offered unrotated, like the draw tools, because the maths below treats the
  // cursor delta as page space.

  const annotResizeRef = useRef<{
    pageNumber: number
    record: PageAnnotation
    handle: ResizeHandle
    startClientX: number
    startClientY: number
    moved: boolean
    /** Scale of the pane the grab started in (the columns zoom apart) */
    scale: number
    pane: PaneId
  } | null>(null)
  const [resizeGhost, setResizeGhost] = useState<{
    pageNumber: number
    rect: PageRect
    /** Set for a line/arrow: the ghost draws the line itself, since the box
     *  around a diagonal says nothing about where the end will land. */
    line: [[number, number], [number, number]] | null
    pane: PaneId
  } | null>(null)

  /** The geometry a resize would commit for this cursor position: page space,
   *  clamped to the page, never below MIN_SHAPE_SIZE. */
  const resizeTarget = useCallback(
    (
      rs: NonNullable<typeof annotResizeRef.current>,
      clientX: number,
      clientY: number
    ): { rect: PageRect; strokes?: [number, number][][] } => {
      const size = sizes[rs.pageNumber - 1]
      const maxW = size?.w ?? Infinity
      const maxH = size?.h ?? Infinity
      const dx = (clientX - rs.startClientX) / rs.scale
      const dy = (clientY - rs.startClientY) / rs.scale
      const box = quadsUnion(rs.record.quads)

      if (rs.handle === 'p0' || rs.handle === 'p1') {
        const pts = rs.record.strokes?.[0]
        const a0 = pts?.[0]
        const b0 = pts?.[1]
        if (!a0 || !b0) return { rect: box }
        const grabbed = rs.handle === 'p0' ? a0 : b0
        const moved: [number, number] = [
          clamp(grabbed[0] + dx, 0, maxW),
          clamp(grabbed[1] + dy, 0, maxH)
        ]
        const a = rs.handle === 'p0' ? moved : a0
        const b = rs.handle === 'p0' ? b0 : moved
        return { rect: lineQuad(a, b, rs.record.width ?? 2), strokes: [[a, b]] }
      }

      // The corner opposite the grabbed one is the anchor: it stays exactly put
      // while the grabbed corner follows the cursor.
      const left = rs.handle === 'tl' || rs.handle === 'bl'
      const top = rs.handle === 'tl' || rs.handle === 'tr'
      const anchorX = left ? box.x + box.w : box.x
      const anchorY = top ? box.y + box.h : box.y
      const movedX = clamp((left ? box.x : box.x + box.w) + dx, 0, maxW)
      const movedY = clamp((top ? box.y : box.y + box.h) + dy, 0, maxH)
      let w = Math.max(MIN_SHAPE_SIZE, Math.abs(movedX - anchorX))
      let h = Math.max(MIN_SHAPE_SIZE, Math.abs(movedY - anchorY))
      if (rs.record.type === 'freetext') {
        // A text box may never shrink below its own letters: the widest word
        // sets the width floor, the wrap at the candidate width sets the
        // height floor. The ghost simply stops following the cursor there.
        const min = freetextMinSize(
          rs.record.contents ?? '',
          rs.record.fontSize ?? FREETEXT_SIZE,
          w,
          rs.record.font
        )
        w = Math.max(w, min.w)
        h = Math.max(h, min.h)
      }
      // The box grows away from the anchored corner when a minimum kicks in,
      // so that corner stays exactly put; the upper clamp keeps a box that
      // hit the page edge from sticking out.
      const rect: PageRect = {
        x: clamp(movedX < anchorX ? anchorX - w : anchorX, 0, Math.max(0, maxW - w)),
        y: clamp(movedY < anchorY ? anchorY - h : anchorY, 0, Math.max(0, maxH - h)),
        w,
        h
      }
      if (rs.record.type !== 'ink' || !rs.record.strokes) return { rect }
      // Ink scales with its box. Both the factors and the anchor come from the
      // STROKE's own box, not the record's: the record's is inset by the stroke
      // width, and scaling about that corner drifts the drawing by pad × (s − 1)
      // — measured at ~2 pt, enough to see the anchored corner creep.
      const pad = inkPad(rs.record.width ?? 2)
      const src = strokesBox(rs.record.strokes)
      const sx = src.w > 0.01 ? Math.max(1, rect.w - 2 * pad) / src.w : 1
      const sy = src.h > 0.01 ? Math.max(1, rect.h - 2 * pad) / src.h : 1
      const ax = left ? src.x + src.w : src.x
      const ay = top ? src.y + src.h : src.y
      const strokes = rs.record.strokes.map((s) =>
        s.map(([px, py]) => [ax + (px - ax) * sx, ay + (py - ay) * sy] as [number, number])
      )
      // Recompute the box from the scaled strokes so it matches what drawing the
      // same shape by hand would have produced (stroke-width padding included).
      return { rect: inkQuad(strokes, rs.record.width ?? 2), strokes }
    },
    [sizes]
  )

  const onResizeStart = useCallback(
    (pageNumber: number, record: PageAnnotation, handle: ResizeHandle, e: React.PointerEvent) => {
      const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
      if (!pageEl) return
      annotResizeRef.current = {
        pageNumber,
        record,
        handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        scale: scaleOfPageElRef.current(pageEl),
        pane: paneOfEl(pageEl)
      }
    },
    []
  )

  useEffect(() => {
    if (!active) return
    const onMove = (e: PointerEvent): void => {
      const rs = annotResizeRef.current
      if (!rs) return
      if (!rs.moved && Math.hypot(e.clientX - rs.startClientX, e.clientY - rs.startClientY) < 3) {
        return
      }
      rs.moved = true
      const next = resizeTarget(rs, e.clientX, e.clientY)
      setResizeGhost({
        pageNumber: rs.pageNumber,
        rect: next.rect,
        line: next.strokes?.[0]?.length === 2 ? [next.strokes[0][0], next.strokes[0][1]] : null,
        pane: rs.pane
      })
    }
    const onUp = (e: PointerEvent): void => {
      const rs = annotResizeRef.current
      annotResizeRef.current = null
      if (!rs) return
      setResizeGhost(null)
      if (!rs.moved) return
      // Suppress the click that would otherwise reopen the properties popover
      dragEndAtRef.current = performance.now()
      const next = resizeTarget(rs, e.clientX, e.clientY)
      const before = quadsUnion(rs.record.quads)
      const same =
        Math.abs(next.rect.x - before.x) < 0.01 &&
        Math.abs(next.rect.y - before.y) < 0.01 &&
        Math.abs(next.rect.w - before.w) < 0.01 &&
        Math.abs(next.rect.h - before.h) < 0.01
      if (same) return
      setSelected({ pageNumber: rs.pageNumber, localId: rs.record.id })
      const patch: AnnotPatch = { quads: [next.rect] }
      if (next.strokes) patch.strokes = next.strokes
      changeAnnotation(rs.pageNumber, rs.record, patch)
    }
    const onCancel = (): void => {
      if (!annotResizeRef.current) return
      annotResizeRef.current = null
      setResizeGhost(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [active, resizeTarget, changeAnnotation])

  /** ONE page's text, for the interactive path. The whole-document pass is far
   *  too slow to sit inside a gesture — a 15-page paper takes over a second, and
   *  the end of a highlight has to start moving now. Cached per page; the
   *  full-document texts are preferred when they happen to exist already. */
  const onePageTextRef = useRef(new Map<number, PageText>())
  const onePageTextPendingRef = useRef(new Map<number, Promise<PageText>>())
  const pageTextFor = useCallback(
    (pageNumber: number): PageText | undefined =>
      pageTextsRef.current?.[pageNumber - 1] ?? onePageTextRef.current.get(pageNumber),
    []
  )
  const ensureOnePageText = useCallback(
    (pageNumber: number): void => {
      if (!pdf || pageTextFor(pageNumber)) return
      if (onePageTextPendingRef.current.has(pageNumber)) return
      const p = buildPageText(pdf, pageNumber)
      onePageTextPendingRef.current.set(pageNumber, p)
      void p
        .then((text) => onePageTextRef.current.set(pageNumber, text))
        .finally(() => onePageTextPendingRef.current.delete(pageNumber))
    },
    [pdf, pageTextFor]
  )

  // ---------- Dragging the ends of a text markup ----------
  //
  // A highlight one line too short used to mean erase and mark again: nothing in
  // the file says which words a Highlight covers — it is a list of rectangles,
  // and the text under them is only knowable through the rendered text layer.
  // So the ends are edited in TEXT terms: read the covered range back off the
  // page (text-range.ts), move one end to the offset under the cursor, snap to
  // whole words, and re-measure the rects the way search measures a match.
  //
  // Unrotated only: the rects come out of the text layer in view space, and the
  // view→page inverse for a rotated page is not worth building for this.

  const markupEditRef = useRef<{
    pageNumber: number
    record: PageAnnotation
    end: 'start' | 'end'
    /** The range the mark covered when the drag began — resolved on FIRST USE,
     *  not at pointerdown. Reading it needs the page's extracted text, and on a
     *  15-page paper building that takes over a second: arming the drag only
     *  once it arrived meant the gesture was already over, so pressing a knob
     *  and dragging did nothing at all until the text happened to be cached. */
    from: CharRange | null
    pageEl: HTMLElement
    scale: number
    pane: PaneId
    moved: boolean
    /** Last range resolved, so the commit does not re-measure */
    latest: { range: CharRange; rects: PageRect[] } | null
  } | null>(null)
  const [markupPreview, setMarkupPreview] = useState<{
    pane: PaneId
    byPage: ReadonlyMap<number, PageRect[]>
  } | null>(null)

  // Selecting a mark is the move before reaching for its end, so extract the
  // text now: the drag needs it, and starting the pass on pointerdown loses a
  // race against the hand on any document of a serious size.
  useEffect(() => {
    if (!selected) return
    const record = annotsRef.current.get(selected.pageNumber)?.find((r) => r.id === selected.localId)
    if (record && isTextMarkup(record)) ensureOnePageText(selected.pageNumber)
  }, [selected, ensureOnePageText])

  const onMarkupEndStart = useCallback(
    (pageNumber: number, record: PageAnnotation, end: 'start' | 'end', e: React.PointerEvent) => {
      const pageEl = (e.target as HTMLElement | null)?.closest?.('.pdf-page') as HTMLElement | null
      if (!pageEl || !pdf) return
      // The properties popover opens right under the mark it belongs to, which is
      // exactly where the text you are extending onto lives. Get it out of the
      // way for the duration of the drag (measured: it swallowed the pointer).
      setAnnotPopover(null)
      // Arm SYNCHRONOUSLY. The range this mark covers is read from the page's
      // extracted text, which may still be building — resolve() picks it up the
      // moment it lands, so a drag started too early begins working mid-gesture
      // instead of being dropped on the floor.
      markupEditRef.current = {
        pageNumber,
        record,
        end,
        from: null,
        pageEl,
        scale: scaleOfPageElRef.current(pageEl),
        pane: paneOfEl(pageEl),
        moved: false,
        latest: null
      }
      ensureOnePageText(pageNumber)
    },
    [ensureOnePageText]
  )

  useEffect(() => {
    if (!active) return
    /** The range and rects this cursor position would commit */
    const resolve = (
      edit: NonNullable<typeof markupEditRef.current>,
      clientX: number,
      clientY: number
    ): { range: CharRange; rects: PageRect[] } | null => {
      const pageText = pageTextFor(edit.pageNumber)
      if (!pageText) return null // still extracting; the next move will find it
      // Where the mark started, read off the page the first time it is needed.
      const from = (edit.from ??= rangeOfQuads(
        edit.pageEl,
        pageText,
        edit.record.quads,
        edit.scale
      ))
      if (!from) return null
      const at = offsetAtPoint(edit.pageEl, pageText, clientX, clientY)
      if (at === null) return null
      // The end being dragged moves; the other one is the anchor. They may not
      // cross: a mark has to keep covering at least one character.
      const raw =
        edit.end === 'start'
          ? { start: Math.min(at, from.end - 1), end: from.end }
          : { start: from.start, end: Math.max(at, from.start + 1) }
      const range = snapToWords(pageText.text, raw)
      const rects = resolveMatchRects(edit.pageEl, pageText, range, edit.scale)
      return rects && rects.length > 0 ? { range, rects } : null
    }
    const onMove = (e: PointerEvent): void => {
      const edit = markupEditRef.current
      if (!edit) return
      const next = resolve(edit, e.clientX, e.clientY)
      if (!next) return
      // Same words as last frame: nothing to redraw (word snapping means most
      // pointer moves resolve to the range already shown).
      if (
        edit.latest &&
        edit.latest.range.start === next.range.start &&
        edit.latest.range.end === next.range.end
      ) {
        return
      }
      edit.moved = true
      edit.latest = next
      setMarkupPreview({ pane: edit.pane, byPage: new Map([[edit.pageNumber, next.rects]]) })
    }
    const onUp = (): void => {
      const edit = markupEditRef.current
      markupEditRef.current = null
      if (!edit) return
      setMarkupPreview(null)
      const next = edit.latest
      if (!edit.moved || !next) return
      if (next.range.start === edit.from?.start && next.range.end === edit.from?.end) return
      dragEndAtRef.current = performance.now()
      setSelected({ pageNumber: edit.pageNumber, localId: edit.record.id })
      changeAnnotation(edit.pageNumber, edit.record, { quads: next.rects })
    }
    const onCancel = (): void => {
      if (!markupEditRef.current) return
      markupEditRef.current = null
      setMarkupPreview(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [active, changeAnnotation, pageTextFor])

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

  // …and only the active tab's chrome. An inactive tab-view is display:none,
  // so its reveal zone can never be hovered anyway — but a tab SWITCH would
  // otherwise leave the shell holding the old tab's answer.
  useEffect(() => {
    if (active) onChromeVisible(toolbarPinned || toolbarPeek)
  }, [active, toolbarPinned, toolbarPeek, onChromeVisible])

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

  /** Gear menu → "Nullstill til standard" (behind a confirmation).
   *
   *  Scope: every PREFERENCE the app remembers — theme, language, keep-awake,
   *  tool colours/widths/opacities, eraser scope, remembered custom colours,
   *  recent search queries, panel widths, toolbar auto-hide — plus this
   *  document's view state.
   *
   *  Deliberately NOT touched: stored API keys (losing those is a real cost and
   *  has nothing to do with "the UI looks wrong"), the recents library, reading
   *  positions, and — obviously — any annotation in any file. The confirm
   *  dialog's detail line says so, so the user knows before pressing it. */
  const resetPreferences = useCallback(() => {
    // Spread, not a literal: this argument is a Partial<Settings>, so a new
    // preference listed here by hand would compile clean and silently stop
    // being reset.
    onSettingsChange({ ...DEFAULT_SETTINGS })
    clearToolPrefs()
    setPrefs(structuredClone(DEFAULT_TOOL_PREFS))
    clearCustomColors()
    clearSearchHistory()
    // The assistant re-reads this when the panel next opens
    clearAiTextScale()
    setPanelW({ ...PANEL_DEFAULTS })
    try {
      localStorage.removeItem(PANEL_LS_KEY)
    } catch {
      /* best-effort */
    }
    saveToolbarPinned(true)
    setToolbarPinned(true)
    setToolbarPeek(false)
    // Document view state too: a reader who resets because "everything looks
    // wrong" means the rotated, spread-out, oddly-zoomed page as well.
    setAnnotsHidden(false)
    setActiveTool(null)
    setMarkupTool(null)
    reanchorFor(0, false, false)
    setRotation(0)
    setSpread(false)
    setCoverPage(false)
    setBubbleSizes(new Map())
    fitModeRef.current = 'page'
    setFitMode('page')
    refitRef.current()
    showToast(t('reset.done'))
  }, [onSettingsChange, reanchorFor, showToast])

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

  // In the browser/extension the first Esc is consumed by the browser itself
  // (it exits HTML fullscreen without delivering the keydown), which used to
  // leave the presentation overlay behind for a second Esc. Losing fullscreen
  // while presenting therefore exits the presentation too — one Esc does both.
  useEffect(() => {
    if (!presentation) return
    return bridge.onFullScreen((fs) => {
      if (!fs) exitPresentation()
    })
  }, [presentation, exitPresentation])

  // ---------- Navigation history ----------
  //
  // One stack PER COLUMN. Once a link followed in one column lands in the other,
  // a single shared history would be incoherent: "back" has to mean "back in the
  // column that moved". The pills and Alt+←/→ act on the active column.

  /** A NEW jump clears that column's forward stack (like browser history) */
  const pushBack = useCallback((pane: PaneId) => {
    const current = handleForRef.current(pane)?.position()
    if (!current) return
    setNavStacks((prev) => ({
      ...prev,
      [pane]: { back: [...prev[pane].back.slice(-49), current], forward: [] }
    }))
  }, [])

  /** Jump with a breadcrumb so the reader can return (sidebar, links, go-to) */
  const jumpToPageIn = useCallback(
    (pane: PaneId, page: number) => {
      const handle = handleForRef.current(pane)
      if (!handle?.ready()) return
      pushBack(pane)
      handle.scrollToPage(page)
    },
    [pushBack]
  )
  /** Sidebar/thumbnail jumps go to the column being worked in */
  const jumpToPage = useCallback(
    (page: number) => jumpToPageIn(activePaneRef.current, page),
    [jumpToPageIn]
  )
  goToPaneBPageRef.current = (page: number) => jumpToPageIn('b', page)

  const navStep = useCallback((direction: 'back' | 'forward') => {
    const pane = activePaneRef.current
    const handle = handleForRef.current(pane)
    if (!handle?.ready()) return
    setNavStacks((prev) => {
      const stack = prev[pane]
      const from = direction === 'back' ? stack.back : stack.forward
      const target = from[from.length - 1]
      if (!target) return prev
      const current = handle.position()
      handle.scrollToPage(target.page, target.offset)
      return {
        ...prev,
        [pane]:
          direction === 'back'
            ? {
                back: stack.back.slice(0, -1),
                forward: current ? [...stack.forward, current] : stack.forward
              }
            : {
                back: current ? [...stack.back, current] : stack.back,
                forward: stack.forward.slice(0, -1)
              }
      }
    })
  }, [])
  const goBack = useCallback(() => navStep('back'), [navStep])
  const goForward = useCallback(() => navStep('forward'), [navStep])

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

  /** The active column's history — what the pills and Alt+←/→ act on */
  const activeNav = navStacks[activePane]

  useEffect(() => {
    if (activeNav.back.length === 0 && activeNav.forward.length === 0) return
    revealPills()
    schedulePillsFade()
  }, [activeNav, revealPills, schedulePillsFade])

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
      const [content, name]: [string | Uint8Array, string] =
        format === 'markdown'
          ? [toMarkdown(rows, meta), `${base} - ${suffix}.md`]
          : format === 'html'
            ? [toHtml(rows, meta), `${base} - ${suffix}.html`]
            : format === 'docx'
              ? [toDocx(rows, meta), `${base} - ${suffix}.docx`]
              : [toPlainText(rows, meta), `${base} - ${suffix}.txt`]
      const result = await bridge.saveTextFile(name, content)
      if (result && 'error' in result) showToast(t('viewer.saveFailed', { error: errorText(result) }))
      else if (result) showToast(t('viewer.exported', { path: result.path }))
    },
    [pdf, payload.name, showToast]
  )

  const jumpToAnnotIn = useCallback((pane: PaneId, pageNumber: number, record: PageAnnotation) => {
    const handle = handleForRef.current(pane)
    const el = handle?.el()
    if (!handle?.ready() || !el) return
    pushBack(pane)
    const q = record.quads[0]
    // A third of the way down, so the mark has its context above it
    handle.scrollToPageY(pageNumber, q?.y ?? 0, el.clientHeight * 0.3)
  }, [pushBack])
  /** Select an annotation and bring it into view in the given column — the
   *  navigation behind the Merknader tab's cards and the margin's arrows. */
  const jumpSelectAnnotIn = useCallback(
    (pane: PaneId, pageNumber: number, record: PageAnnotation) => {
      setAnnotPopover(null)
      setSelected({ pageNumber, localId: record.id })
      jumpToAnnotIn(pane, pageNumber, record)
    },
    [jumpToAnnotIn]
  )
  /** The tab serves whichever column is being worked in */
  const jumpSelectAnnot = useCallback(
    (pageNumber: number, record: PageAnnotation) =>
      jumpSelectAnnotIn(activePaneRef.current, pageNumber, record),
    [jumpSelectAnnotIn]
  )

  /** Resolve a pdf.js destination and scroll the given column to it. */
  const jumpToDestIn = useCallback(
    async (pane: PaneId, dest: unknown) => {
      const handle = handleForRef.current(pane)
      if (!pdf || !handle?.ready()) return
      try {
        const explicit =
          typeof dest === 'string' ? await pdf.getDestination(dest) : (dest as unknown[] | null)
        if (!Array.isArray(explicit) || explicit.length === 0) return
        const ref = explicit[0]
        const pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as never)
        if (pageIndex < 0 || pageIndex >= sizesRef.current.length) return
        pushBack(pane)
        // XYZ destinations carry a precise y in PDF user space (bottom-up)
        const destName = (explicit[1] as { name?: string } | undefined)?.name
        if (destName === 'XYZ' && typeof explicit[3] === 'number') {
          const size = sizesRef.current[pageIndex]
          handle.scrollToPageY(pageIndex + 1, clamp(size.h - explicit[3], 0, size.h), 8)
        } else {
          handle.scrollToPage(pageIndex + 1)
        }
      } catch (err) {
        console.error('pdfx: klarte ikke å følge lenken', err)
      }
    },
    [pdf, pushBack]
  )
  /** Outline entries in the sidebar move the column being worked in */
  const jumpToDest = useCallback(
    (dest: unknown) => jumpToDestIn(activePaneRef.current, dest),
    [jumpToDestIn]
  )

  /**
   * A hyperlink followed in `from`. With the split open it lands in the OTHER
   * column and leaves `from` exactly where it is — following a cross-reference
   * should never cost you the sentence you were reading. The column that moved
   * gets the breadcrumb, so "back" there returns from the excursion. With one
   * column there is nowhere else to go, so it navigates in place as always.
   */
  /** Run `fn` once a column can actually be scrolled. A column that has just
   *  been mounted has no layout for a beat, and "open the split, then jump the
   *  new column" has to survive that gap. */
  const whenPaneReady = useCallback((pane: PaneId, fn: () => void) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (handleForRef.current(pane)?.ready()) {
        fn()
        return
      }
      if (Date.now() - t0 > 2500) return // the column never came up; drop it
      window.setTimeout(tick, 60)
    }
    tick()
  }, [])
  whenPaneReadyRef.current = whenPaneReady

  /**
   * A hyperlink followed in column `from`.
   *
   * Plain click navigates in place, as it always has. Ctrl/Cmd+click means "show
   * it over there": it lands in the OTHER column and leaves `from` exactly where
   * it is, so a cross-reference never costs you the sentence you were reading —
   * and it OPENS the split if it is not open yet, which makes the gesture a
   * one-step "open this reference beside what I'm reading".
   *
   * Only in-document destinations get here. An external URL always hands off to
   * the system browser (see the link handler in PdfPage): there is nothing in
   * this document for a second column to show, so the modifier is a no-op there
   * and the browser applies its own new-tab conventions.
   */
  const followLinkFrom = useCallback(
    (from: PaneId, dest: unknown, toOtherPane: boolean) => {
      if (!toOtherPane) {
        void jumpToDestIn(from, dest)
        return
      }
      const target: PaneId = from === 'a' ? 'b' : 'a'
      if (!splitOpenRef.current) {
        // Opening the split re-fits both columns; jump once the new one exists.
        toggleSplitRef.current()
        whenPaneReady(target, () => {
          void jumpToDestIn(target, dest)
          flashPaneRef.current(target)
        })
        return
      }
      void jumpToDestIn(target, dest)
      // A brief pulse on the column that moved, rather than a toast: you need to
      // know WHERE the reference landed, and you need to know it once.
      flashPaneRef.current(target)
    },
    [jumpToDestIn, whenPaneReady]
  )
  followLinkFromRef.current = followLinkFrom

  // Stable identities for PdfPage — new callbacks would re-render page canvases
  const linkActionsRef = useRef({
    internal: (_d: unknown, _toOther: boolean): void => {},
    external: (_u: string): void => {}
  })
  linkActionsRef.current = {
    internal: (d: unknown, toOther: boolean) => followLinkFrom('a', d, toOther),
    external: (u: string) => bridge.openExternal(u)
  }
  const onInternalLink = useCallback(
    (d: unknown, toOther: boolean) => linkActionsRef.current.internal(d, toOther),
    []
  )
  const onExternalLink = useCallback((u: string) => linkActionsRef.current.external(u), [])
  const onPaneBInternalLink = useCallback(
    (d: unknown, toOther: boolean) => followLinkFromRef.current('b', d, toOther),
    []
  )

  // ---------- Search ----------

  /** Poll until the page's text layer exists (it renders asynchronously) */
  const waitForTextLayer = useCallback(
    (pane: PaneId, pageNumber: number, timeoutMs = 4000): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        const t0 = Date.now()
        const tick = (): void => {
          const pageEl = handleForRef.current(pane)?.el()?.querySelector<HTMLElement>(
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
      const texts = pageTextsRef.current
      if (!texts || matches.length === 0) return
      // Search moves the column being worked in — the active one — so a hit
      // never yanks the column you were using as a reference.
      const pane = activePaneRef.current
      const handle = handleForRef.current(pane)
      const el = handle?.el()
      if (!handle?.ready() || !el) return
      const match = matches[i]
      setSearchIndex(i)
      if (recordBack) pushBack(pane)
      const seq = ++gotoSeqRef.current
      // Bring the page into view so its text layer renders, then refine
      handle.scrollToPage(match.pageNumber)
      const pageEl = await waitForTextLayer(pane, match.pageNumber)
      if (seq !== gotoSeqRef.current || !pageEl) return
      const rects = resolveMatchRects(pageEl, texts[match.pageNumber - 1], match, handle.scale())
      if (!rects) {
        setSearchHits(null)
        return
      }
      setSearchHits({ pageNumber: match.pageNumber, rects })
      handle.scrollToPageY(match.pageNumber, rects[0].y, el.clientHeight * 0.35)
      if (pane === 'a') schedulePositionSave()
    },
    [pushBack, waitForTextLayer, schedulePositionSave]
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

  // Highlight-all: resolve every match on the pages that are mounted right now.
  //
  // Only mounted pages can be measured at all — a page more than RENDER_MARGIN
  // from the viewport has no text layer (PdfPage clears it), so this re-runs as
  // the mounted set changes: `range` for column A, `paneBPage` for column B.
  // Deliberately NOT hung off onScroll, which fires unthrottled; the mounted
  // range is a coalesced state transition and is the only thing that matters.
  useEffect(() => {
    if (!searchOpen || searchMode === 'ai' || searchMatches.length === 0) {
      setSearchAllHits(null)
      return
    }
    const pane = activePaneRef.current
    const paneRotation = pane === 'b' ? paneBRotationRef.current : rotationRef.current
    // Rects measured in another rotation (or column) are simply wrong, not
    // stale-but-close, so drop them before the async work rather than after.
    setSearchAllHits((prev) =>
      prev && (prev.pane !== pane || prev.rotation !== paneRotation) ? null : prev
    )
    const texts = pageTextsRef.current
    const handle = handleForRef.current(pane)
    const host = handle?.el()
    if (!texts || !handle || !host) return
    const byPageMatches = new Map<number, SearchMatch[]>()
    for (const match of searchMatches) {
      const list = byPageMatches.get(match.pageNumber)
      if (list) list.push(match)
      else byPageMatches.set(match.pageNumber, [match])
    }
    const seq = ++allHitsSeqRef.current
    let cancelled = false
    void (async () => {
      const byPage = new Map<number, PageRect[]>()
      for (const [pageNumber, list] of byPageMatches) {
        if (!host.querySelector(`.pdf-page[data-page="${pageNumber}"]`)) continue
        // Mounted, but the text layer renders asynchronously after mount — wait
        // for it rather than losing the page's highlights until the next scroll.
        const pageEl = await waitForTextLayer(pane, pageNumber, 2000)
        if (cancelled || seq !== allHitsSeqRef.current) return
        if (!pageEl) continue
        const rects = resolveAllMatchRects(pageEl, texts[pageNumber - 1], list, handle.scale())
        if (rects && rects.length > 0) byPage.set(pageNumber, rects)
      }
      if (cancelled || seq !== allHitsSeqRef.current) return
      setSearchAllHits(byPage.size > 0 ? { pane, rotation: paneRotation, byPage } : null)
    })()
    return () => {
      cancelled = true
    }
  }, [
    searchOpen,
    searchMode,
    searchMatches,
    // activePane, not just the ref: search drives whichever column is active, so
    // switching columns has to move the highlights over with it. Reading the ref
    // alone left them painted in the column you had just left.
    activePane,
    range,
    paneBPage,
    rotation,
    paneBRotation,
    scale,
    paneBScale,
    splitOpen,
    waitForTextLayer
  ])

  const openSearch = useCallback(() => {
    // Seed the query with the current text selection: select a word, Ctrl+F,
    // and it is already in the field (selected, so typing replaces it).
    // Collapse whitespace — cross-span selections stringify with newlines.
    const selection = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
    if (selection) setSearchQuery(selection.slice(0, 200))
    searchJumpedRef.current = false
    setSearchOpen(true)
    setSearchFocusToken((n) => n + 1)
  }, [])

  const closeSearch = useCallback(() => {
    // Remember the query on the way out, and only if it found something. That
    // covers the common flow — Ctrl+F, type, read the highlighted hits, Escape —
    // which never presses Enter, while keeping the half-typed prefixes the live
    // search runs on out of the list.
    if (searchMatches.length > 0) addSearchHistory(searchQuery)
    setSearchOpen(false)
    setSearchHits(null)
    setSearchAllHits(null)
    if (semanticReqRef.current !== null) {
      bridge.aiAbort(semanticReqRef.current)
      semanticReqRef.current = null
    }
    setSemantic({ status: 'idle', hits: [], index: -1, note: null })
  }, [searchQuery, searchMatches.length])

  // ---------- Semantic (AI) search ----------

  const runSemanticSearch = useCallback(async (queryOverride?: string) => {
    if (!pdf) return
    const query = (queryOverride ?? searchQuery).trim()
    if (!query) return
    const config = await bridge.aiGetConfig()
    if (!config.hasKey[config.provider]) {
      setSemantic({ status: 'noKey', hits: [], index: -1, note: null })
      return
    }
    const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
    // No text layer, nothing to search semantically either — say so instead of
    // paying for a request against a document made of page markers.
    if (!hasExtractableText(pages)) {
      setSemantic({ status: 'noText', hits: [], index: -1, note: null })
      return
    }
    setSemantic({ status: 'running', hits: [], index: -1, note: null })
    const doc = buildAiDocument(pages)
    // Above the model's context window the search runs over a BM25 excerpt
    // keyed on the query (ai-retrieval.ts); a note under the results says so.
    const prep = prepareDocumentForRequest(
      { pages, doc },
      config.provider,
      config.models[config.provider],
      query
    )
    const requestId = nextAiRequestId()
    semanticReqRef.current = requestId
    // System + document block are byte-identical to the chat panel so the
    // Anthropic prompt cache is shared; the search instruction is in the user
    // message only.
    const result = await bridge.aiChat({
      requestId,
      system: chatSystem() + (prep.excerpt ? excerptSystemNote() : ''),
      messages: [{ role: 'user', text: semanticSearchPrompt(query) }],
      document: { title: payload.name, text: prep.doc.text },
      purpose: 'search'
    })
    if (semanticReqRef.current !== requestId) return // superseded/aborted
    semanticReqRef.current = null
    if ('error' in result) {
      setSemantic({ status: 'error', hits: [], index: -1, note: errorText(result) })
      return
    }
    // Char citations point into the excerpt this request attached — resolve
    // them to real pages now, while that exact text is known
    const parts = prep.excerpt ? charCitationsToQuotes(result.parts, prep.doc) : result.parts
    const hits: { label: string; citation: AiCitation; pageNumber: number | null }[] = []
    for (const part of parts) {
      const label = part.text.replace(/^\s*\d+[.)]\s*/, '').trim()
      for (const c of part.citations) {
        if (c.kind === 'web') continue // semantic hits must live in the document
        const fallback = c.kind === 'char' ? c.citedText : c.quote
        hits.push({ label: label || fallback.slice(0, 80), citation: c, pageNumber: citationPage(c, prep.doc) })
      }
    }
    setSemantic({
      status: 'done',
      hits,
      index: -1,
      note:
        hits.length === 0
          ? parts.map((p) => p.text).join(' ').trim()
          : prep.excerpt
            ? t('ai.excerptSearchNote')
            : null
    })
  }, [pdf, searchQuery, payload.name])
  runSemanticSearchRef.current = runSemanticSearch

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

  const {
    readAloud,
    readRate,
    setReadRate,
    readVoice,
    setReadVoice,
    voices,
    voiceManualRef,
    startReadAloud,
    stopReadAloud,
    toggleReadPause
  } = useReadAloud({
    pdf,
    active,
    currentPage,
    containerRef,
    layoutRef,
    pageTextsRef,
    scaleRef,
    updateRange,
    waitForTextLayer,
    setSearchHits
  })

  // ---------- AI ----------

  const ensureAiDocument = useCallback(async (): Promise<EnsuredDocument | null> => {
    if (!pdf) return null
    const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
    // hasText travels with the document because a scanned PDF yields a document
    // that is nothing but page markers, and the panel has to say so rather than
    // spend a request on it and show whatever the model makes of the emptiness.
    return { pages, doc: buildAiDocument(pages), hasText: hasExtractableText(pages) }
  }, [pdf])

  /** Citation chip clicked: jump to the cited passage and highlight it,
   *  reusing the search-hit overlay and the text-layer rect machinery */
  const jumpToAiCitation = useCallback(
    async (resolved: ResolvedCitation) => {
      const texts = pageTextsRef.current
      if (!texts) return
      // Like search: the cited passage opens in the column being worked in
      const pane = activePaneRef.current
      const handle = handleForRef.current(pane)
      const el = handle?.el()
      if (!handle?.ready() || !el) return
      pushBack(pane)
      const seq = ++gotoSeqRef.current
      handle.scrollToPage(resolved.pageNumber)
      const pageEl = await waitForTextLayer(pane, resolved.pageNumber)
      if (seq !== gotoSeqRef.current || !pageEl) return
      const rects = resolveMatchRects(
        pageEl,
        texts[resolved.pageNumber - 1],
        { start: resolved.start, end: resolved.end },
        handle.scale()
      )
      if (!rects || rects.length === 0) return
      setSearchHits({ pageNumber: resolved.pageNumber, rects, flash: true, flashId: seq })
      // The citation highlight releases by itself after a moment (or on the
      // next click in the document) — it's a pointer, not a selection
      if (aiHitTimerRef.current) window.clearTimeout(aiHitTimerRef.current)
      aiHitTimerRef.current = window.setTimeout(() => {
        if (!searchOpenRef.current) setSearchHits(null)
      }, 7000)
      handle.scrollToPageY(resolved.pageNumber, rects[0].y, el.clientHeight * 0.35)
      if (pane === 'a') schedulePositionSave()
    },
    [pushBack, waitForTextLayer, schedulePositionSave]
  )

  const consumeAiSeed = useCallback(() => setAiSeed(null), [])

  // A DETACHED assistant clicked a citation in this document: show it here.
  // ensureAiDocument first — a viewer that never opened its own panel has no
  // page texts yet, and the jump needs them to resolve rects. Returning true
  // is the ack that some window showed it (BroadcastChannel targets outside
  // Electron; main already routed to this window on desktop).
  useEffect(
    () =>
      bridge.onAssistantJumpRequest((path, target) => {
        if (path !== payload.path) return false
        void ensureAiDocument().then(() => jumpToAiCitation(target))
        return true
      }),
    [payload.path, ensureAiDocument, jumpToAiCitation]
  )

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

  /** Print the document as it stands. Browser parity: print the LIVE document
   *  (annotation edits included) via a blob in Chromium's viewer — the desktop
   *  prints the draft file the same way through a hidden window. */
  const printDocument = useCallback(() => {
    void (async () => {
      if (!isElectron) {
        const bytes = await browserCurrentBytes(payload.path)
        if (bytes) {
          const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: 'application/pdf' })
          )
          // We render the page onto a canvas, and that canvas is NOT the
          // document — printing it would print our screen rendering, at our
          // resolution and through our theme filter. So the real bytes (with
          // the annotation edits baked in) go to something that can print a
          // PDF properly. On the desktop that is a hidden Electron window;
          // here it is the browser's own PDF viewer.
          //
          // Try to reach its print dialog directly through a hidden frame, so
          // "Print" prints instead of merely offering a preview to print from
          // (Emil, 2026-08-09). Chromium hands a PDF to its bundled viewer,
          // which may sit on another origin — then contentWindow.print()
          // throws and we fall back to the tab, which is what this always did.
          const printed = await printViaHiddenFrame(url)
          if (!printed) window.open(url, '_blank', 'noopener')
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
          return
        }
      }
      const result = await bridge.printFile(payload.path)
      if (result && 'error' in result)
        showToast(t('viewer.printFailed', { error: errorText(result) }))
    })()
  }, [payload.path, showToast])

  // The two window-level input handlers below read ~35 pieces of state
  // between them. As a dependency array that meant detaching and re-attaching
  // both listeners on every search step, annotation click and first mark. They
  // are mirrored in refs instead — reassigned each render, called through a
  // stable wrapper — which is the pattern the rest of this file already uses
  // for state that event handlers must see fresh. The listeners now attach
  // once per tab activation.
  const onKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {})
  const onMouseNavRef = useRef<(e: MouseEvent) => void>(() => {})

  onKeyDownRef.current = (e: KeyboardEvent): void => {
    // The shortcuts dialog is recording a chord — every key belongs to it, or
    // binding 'T' would also toggle the panel behind the dialog
    if (isKeyboardCaptured()) return
    const tag = (e.target as HTMLElement | null)?.tagName
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA'
    // The presentation overlay owns the keyboard while it is open
    if (presentationRef.current) return

    // Escape is deliberately NOT a rebindable command: it is the way out of
    // every state the viewer can be in, and this order IS the nesting order —
    // innermost thing first. Only bare Escape, so a chord like Ctrl+Escape can
    // still be bound to something below.
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
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
      return
    }

    const command = commandForEvent(e, isTyping)
    if (!command) return
    // Every case below preventDefaults: reaching here means the keypress WAS a
    // bound command, and letting the browser also act on it (Ctrl+S offering to
    // save the viewer page, Ctrl+F opening its own find bar) is never wanted.
    // The two exceptions return early instead, before consuming the key.
    switch (command) {
      case 'view.fullscreen':
        e.preventDefault()
        toggleFullscreen()
        break
      case 'edit.undo':
        e.preventDefault()
        void performUndoRedo('undo')
        break
      case 'edit.redo':
        e.preventDefault()
        void performUndoRedo('redo')
        break
      case 'nav.back':
        e.preventDefault()
        goBack()
        break
      case 'nav.forward':
        e.preventDefault()
        goForward()
        break
      case 'nav.prevPage':
      case 'nav.nextPage': {
        // Menus, dialogs and native selects own their arrow keys — a page
        // turning under an open menu is never what the keypress meant.
        const target = e.target instanceof HTMLElement ? e.target : null
        if (
          target &&
          (target.tagName === 'SELECT' ||
            target.closest('[role="menu"],[role="dialog"],[role="listbox"]'))
        )
          return
        e.preventDefault()
        handleForRef.current(activePaneRef.current)?.flipPage(
          command === 'nav.nextPage' ? 1 : -1
        )
        break
      }
      case 'file.save':
        e.preventDefault()
        // Save over the current file when there is something to save. Desktop
        // and the extension both write in place (the extension via a retained
        // File System Access handle — its first save may prompt once for write
        // access); the plain-web fallback bakes annotations and downloads.
        //
        // With nothing to save, an unchanged LOCAL file is already on disk in the
        // state on screen — Ctrl+S does nothing, same as the desktop app. A PDF
        // fetched from the web has no local copy at all, so there the key means
        // "get this file", and since we swallow the browser's own Ctrl+S (which
        // would offer to save the viewer PAGE, never the PDF) it has to: it does
        // exactly what the Save-a-copy button does — one Save dialog, or a
        // download where pickers are missing. Edge's built-in viewer sets that bar.
        if (dirty || (!isElectron && !isExtension)) void saveDocument()
        else if (isExtension && isRemoteSource(payload.path)) void saveDocumentAs()
        break
      case 'file.saveAs':
        e.preventDefault()
        void saveDocumentAs()
        break
      case 'file.print':
        e.preventDefault()
        printDocument()
        break
      case 'annot.delete': {
        // With nothing selected the key is not ours — Backspace must stay
        // whatever the browser makes of it.
        const target = selected ?? annotPopover
        if (!target) return
        e.preventDefault()
        const record = (annotsRef.current.get(target.pageNumber) ?? []).find(
          (r) => r.id === target.localId
        )
        if (record) removeAnnotation(target.pageNumber, record)
        break
      }
      case 'search.open':
        e.preventDefault()
        openSearch()
        break
      case 'search.next':
        e.preventDefault()
        searchStep(1)
        break
      case 'search.prev':
        e.preventDefault()
        searchStep(-1)
        break
      // The zoom family follows the ACTIVE column, like rotate/spread/page-turn
      // above — 'w' with the right column active used to re-fit the left one
      // (feedback, 2026-09-02). Same routing the toolbar's centre cluster uses.
      case 'zoom.in':
        e.preventDefault()
        if (activePaneRef.current === 'b')
          paneBZoom(clamp(paneBScaleRef.current * 1.15, ZOOM_MIN, ZOOM_MAX), 'custom')
        else manualZoom(scaleRef.current * 1.15)
        break
      case 'zoom.out':
        e.preventDefault()
        if (activePaneRef.current === 'b')
          paneBZoom(clamp(paneBScaleRef.current / 1.15, ZOOM_MIN, ZOOM_MAX), 'custom')
        else manualZoom(scaleRef.current / 1.15)
        break
      case 'zoom.actual':
        // Actual size (100%), matching standard PDF-reader convention
        e.preventDefault()
        if (activePaneRef.current === 'b') paneBZoom(1, 'custom')
        else manualZoom(1)
        break
      case 'zoom.fitToggle':
        e.preventDefault()
        if (activePaneRef.current === 'b') setPaneBFit(paneBFitRef.current === 'width' ? 'page' : 'width')
        else if (fitTarget === 'page') fitPage()
        else fitWidth()
        break
      case 'zoom.fitWidth':
        e.preventDefault()
        if (activePaneRef.current === 'b') setPaneBFit('width')
        else fitWidth()
        break
      case 'zoom.fitPage':
        e.preventDefault()
        if (activePaneRef.current === 'b') setPaneBFit('page')
        else fitPage()
        break
      case 'view.rotateRight':
        e.preventDefault()
        rotateView(1)
        break
      case 'view.rotateLeft':
        e.preventDefault()
        rotateView(-1)
        break
      case 'view.spread':
        e.preventDefault()
        toggleSpread()
        break
      case 'view.coverPage':
        e.preventDefault()
        toggleCoverPage()
        break
      case 'view.present':
        e.preventDefault()
        enterPresentation()
        break
      case 'view.split':
        e.preventDefault()
        toggleSplit()
        break
      case 'view.marginNotes':
        e.preventDefault()
        toggleMarginNotes()
        break
      case 'view.togglePin':
        e.preventDefault()
        togglePin()
        break
      case 'view.readAloud':
        if (!READ_ALOUD) return
        e.preventDefault()
        if (readAloud === 'closed') void startReadAloud()
        else stopReadAloud()
        break
      case 'panel.toc':
        e.preventDefault()
        setTocPinned((o) => !o)
        break
      case 'panel.ai':
        e.preventDefault()
        setAiPinned((o) => !o)
        break
      case 'annot.toggleHidden':
        e.preventDefault()
        setAnnotsHidden((h) => !h)
        break
      case 'doc.bookmark':
        // Bokmerke / bookmark the page you are reading. Also reachable from the
        // sidebar tab, which is where the shortcut is advertised.
        e.preventDefault()
        toggleBookmark(currentPageRef.current)
        break
      // Tools toggle: the bound key arms the tool, and pressing it again puts it
      // down — the same thing clicking its toolbar button twice does.
      case 'tool.pen':
      case 'tool.marker':
      case 'tool.eraser':
      case 'tool.text':
      case 'tool.square':
      case 'tool.circle':
      case 'tool.line':
      case 'tool.arrow': {
        e.preventDefault()
        const tool = command.slice('tool.'.length) as DrawToolType
        selectTool(activeTool === tool ? null : tool)
        break
      }
      case 'tool.highlight':
      case 'tool.underline':
      case 'tool.strikeout':
      case 'tool.squiggly': {
        e.preventDefault()
        const tool = command.slice('tool.'.length) as MarkupToolType
        selectMarkupTool(markupTool === tool ? null : tool)
        break
      }
      case 'tool.note':
        e.preventDefault()
        setNotePlacing((v) => !v)
        break
      case 'tool.signature':
        e.preventDefault()
        // The same one-click behaviour the toolbar button has: arm the
        // signature you have, open the pad if you have none, disarm if it is
        // already armed. A keyboard route that only ever opened the pad would
        // be a different feature wearing the same name.
        onSignaturePrimary()
        break
      case 'tool.snip':
        e.preventDefault()
        setSnip((s) => (s ? null : { target: 'quick' }))
        break
      default:
        // A shell command (tabs, windows, opening a file) — App owns those
        break
    }
  }

  // Logitech-style side buttons mirror Alt+←/→ (button 3 = back, 4 = forward).
  // preventDefault stops Chromium from also walking its own (empty) history.
  onMouseNavRef.current = (e: MouseEvent): void => {
    if (presentationRef.current) return
    if (e.button === 3) {
      e.preventDefault()
      goBack()
    } else if (e.button === 4) {
      e.preventDefault()
      goForward()
    }
  }

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => onKeyDownRef.current(e)
    const onMouseNav = (e: MouseEvent): void => onMouseNavRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mouseup', onMouseNav)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mouseup', onMouseNav)
    }
  }, [active])

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
        spread: spreadRef.current,
        coverPage: coverPageRef.current
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
      if (touchToolbarTimerRef.current) window.clearTimeout(touchToolbarTimerRef.current)
      if (fullscreen) bridge.setFullscreen(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // ---------- Render ----------

  // Before the error screen: a locked document is not a failed one, and the
  // prompt has to be reachable while the load is still suspended waiting on it.
  if (passwordAsk) {
    return (
      <PasswordPrompt
        name={payload.name}
        retry={passwordAsk.retry}
        active={active}
        onSubmit={(password) => passwordAsk.resolve(password)}
        onCancel={() => passwordAsk.resolve(null)}
      />
    )
  }

  if (error) {
    return (
      <div className="viewer-error">
        <p>{t('viewer.errorTitle')}</p>
        <p className="viewer-error-detail">{error}</p>
        <div className="viewer-error-actions">
          {/* Retry first: the file being written while we read it is the most
              common reason a document that is fine fails to open. */}
          <button
            className="btn-primary"
            onClick={() => {
              setError(null)
              setLoadAttempt((n) => n + 1)
            }}
          >
            {t('viewer.errorRetry')}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t('app.back')}
          </button>
        </div>
      </div>
    )
  }

  const toolbarVisible = toolbarPinned || toolbarPeek
  const tocVisible = tocPinned || tocPeek
  const aiVisible = aiPinned || aiPeek

  /** The face the open editor should type in: a re-opened box's own, or — for
   *  a fresh draft — the tool's current one, which is what the commit will
   *  use. Typing in one face and committing in another is not a preview. */
  const editorFont = freeTextDraft?.editingId ? freeTextDraft.font : textPref.font

  /** Pane-local chrome: the floating text-box editor and the drag ghost. Both
   *  are positioned in PAGE-LAYOUT coordinates, which differ per column (each
   *  has its own zoom), so the same JSX is rendered inside whichever column the
   *  interaction belongs to — identical behaviour in both, one implementation. */
  const paneOverlay = (
    pane: PaneId,
    lay: RowLayout,
    paneScale: number,
    paneRotation: ViewRotation
  ): React.JSX.Element | null => (
    <>
      {freeTextDraft && freeTextDraft.pane === pane && (
        <textarea
          className="freetext-editor"
          autoFocus
          spellCheck={false}
          defaultValue={freeTextDraft.text ?? ''}
          style={{
            left: lay.lefts[freeTextDraft.pageNumber - 1] + freeTextDraft.x * paneScale,
            top: lay.tops[freeTextDraft.pageNumber - 1] + freeTextDraft.y * paneScale,
            width: freeTextDraft.w * paneScale,
            height: freeTextDraft.h * paneScale,
            // An edited box previews in ITS stored look; a new draft follows
            // the tool preference live, so what you type is what commits
            color: rgbCss(freeTextDraft.color ?? textPref.color, 1),
            fontSize: (freeTextDraft.fontSize ?? textPref.fontSize) * paneScale,
            // …and that includes the TYPEFACE. Typing in one face and watching
            // it change on commit is not a preview, and it is not only
            // cosmetic: the commit's minimum box is measured in the committed
            // face, so an editor set in another one wraps somewhere else than
            // the mark ends up wrapping (Emil, 2026-08-08).
            ...textFontCss(editorFont),
            ...(freeTextDraft.editingId ? { background: 'rgba(255, 255, 255, 0.96)' } : {})
          }}
          onKeyDown={(e) => {
            // App shortcuts bubble to the window handler (find steals focus and
            // the onBlur below commits, or discards, an empty draft)
            if (bubblesWhileTyping(e)) return
            e.stopPropagation()
            if (e.key === 'Escape') setFreeTextDraft(null)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              const el = e.target as HTMLTextAreaElement
              const value = el.value.trim()
              if (value) saveFreeText(value, el.offsetWidth / paneScale, el.offsetHeight / paneScale)
              else setFreeTextDraft(null)
            }
          }}
          onBlur={(e) => {
            const el = e.target
            const value = el.value.trim()
            if (value) saveFreeText(value, el.offsetWidth / paneScale, el.offsetHeight / paneScale)
            else setFreeTextDraft(null)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
      {dragGhost &&
        dragGhost.pane === pane &&
        (() => {
          // The ghost is stored in page space; rotate it to view space so it
          // tracks the pointer under rotation.
          const size = sizes[dragGhost.pageNumber - 1]
          const gv = size
            ? pageRectToView(
                { x: dragGhost.x, y: dragGhost.y, w: dragGhost.w, h: dragGhost.h },
                size.w,
                size.h,
                paneRotation
              )
            : { x: dragGhost.x, y: dragGhost.y, w: dragGhost.w, h: dragGhost.h }
          const style = {
            left: lay.lefts[dragGhost.pageNumber - 1] + gv.x * paneScale,
            top: lay.tops[dragGhost.pageNumber - 1] + gv.y * paneScale,
            width: gv.w * paneScale,
            height: gv.h * paneScale,
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
      {resizeGhost &&
        resizeGhost.pane === pane &&
        (() => {
          // Resize handles only exist unrotated, so page space IS view space here
          // and the ghost needs no rotation transform.
          const r = resizeGhost.rect
          const left = lay.lefts[resizeGhost.pageNumber - 1] + r.x * paneScale
          const top = lay.tops[resizeGhost.pageNumber - 1] + r.y * paneScale
          const style = { left, top, width: r.w * paneScale, height: r.h * paneScale }
          // For a line the box is meaningless; draw the line the release will
          // commit, inside a viewBox in page units so no coordinate is scaled twice.
          if (resizeGhost.line) {
            const [a, b] = resizeGhost.line
            return (
              <svg className="annot-resize-ghost-line" style={style} viewBox={`0 0 ${r.w} ${r.h}`} preserveAspectRatio="none">
                <line x1={a[0] - r.x} y1={a[1] - r.y} x2={b[0] - r.x} y2={b[1] - r.y} />
              </svg>
            )
          }
          return <div className="annot-drag-ghost" style={style} />
        })()}
    </>
  )
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
          canNavBack={activeNav.back.length > 0}
          canNavForward={activeNav.forward.length > 0}
          onNavBack={goBack}
          onNavForward={goForward}
          activeTool={activeTool}
          toolPrefs={toolPrefs}
          onToolSelect={selectTool}
          activeMarkup={markupTool}
          markupPrefs={markupPrefs}
          onMarkupSelect={selectMarkupTool}
          onMarkupPrefChange={patchMarkupPref}
          onMarkupPrefReset={resetMarkupPref}
          eraserScope={prefs.eraserScope}
          onEraserScopeChange={setEraserScope}
          fingerDraws={prefs.input.fingerDraws}
          onFingerDrawsChange={setFingerDraws}
          penSeen={prefs.input.penSeen}
          penPressure={prefs.input.penPressure}
          onPenPressureChange={setPenPressure}
          spread={splitOpen && activePane === 'b' ? paneBSpread : spread}
          coverPage={splitOpen && activePane === 'b' ? paneBCover : coverPage}
          onRotate={rotateView}
          onToggleSpread={toggleSpread}
          onToggleCoverPage={toggleCoverPage}
          onToolPrefChange={patchToolPref}
          onToolPrefReset={resetToolPref}
          textPref={textPref}
          onTextPrefChange={patchTextPref}
          onTextPrefReset={resetTextPref}
          onToggleSidebar={() => setTocPinned((o) => !o)}
          onLeaveDocument={onLeaveDocument}
          onGoToPage={jumpToPage}
          onZoomIn={() => manualZoom(scaleRef.current * 1.15)}
          onZoomOut={() => manualZoom(scaleRef.current / 1.15)}
          onZoomTo={(percent) => manualZoom(percent / 100)}
          onFitWidth={fitWidth}
          onFitPage={fitPage}
          fitMode={fitMode}
          fitTarget={fitTarget}
          onSettingsChange={onSettingsChange}
          onToggleSearch={() => (searchOpen ? closeSearch() : openSearch())}
          filePath={payload.path}
          dirty={dirty}
          onSave={() => void saveDocument()}
          onSaveAs={() => void saveDocumentAs()}
          canSaveInPlace={isElectron || isExtension}
          annotsHidden={annotsHidden}
          onToggleAnnots={() => setAnnotsHidden((h) => !h)}
          canUndo={undoDepths.undo > 0}
          canRedo={undoDepths.redo > 0}
          onUndo={() => void performUndoRedo('undo')}
          onRedo={() => void performUndoRedo('redo')}
          onPrint={printDocument}
          readAloudOpen={readAloud !== 'closed'}
          onToggleReadAloud={() => {
            if (readAloud === 'closed') void startReadAloud()
            else stopReadAloud()
          }}
          aiOpen={aiPinned}
          onToggleAi={() => setAiPinned((o) => !o)}
          noteActive={notePlacing}
          onToggleNote={() => setNotePlacing((v) => !v)}
          signatureActive={armedSignature !== null}
          signatures={signatures}
          onSignaturePrimary={onSignaturePrimary}
          onSignaturePick={setArmedSignature}
          onSignatureDraw={() => setSignaturePadOpen(true)}
          onSignatureDelete={onSignatureDelete}
          signatureInfo={
            <SignatureInfo
              signatures={docSignatures}
              open={signatureInfoOpen}
              onToggle={() => setSignatureInfoOpen((v) => !v)}
              onClose={() => setSignatureInfoOpen(false)}
              locale={locale()}
            />
          }
          onOpenAiSettings={() => {
            setAiPinned(true)
            setAiSettingsAskId((n) => n + 1)
          }}
          toolbarPinned={toolbarPinned}
          onTogglePin={togglePin}
          onPresent={enterPresentation}
          onToggleFullscreen={toggleFullscreen}
          splitOpen={splitOpen}
          onToggleSplit={toggleSplit}
          onClosePane={closePane}
          activePane={activePane}
          onActivatePane={activatePane}
          panePage={paneBPage}
          paneZoomPercent={paneBScale > 0 ? Math.round(paneBScale * 100) : 100}
          paneFitMode={paneBFit}
          paneFitTarget={paneBFitTarget}
          onPaneGoToPage={goToPaneBPage}
          onPaneZoomTo={(percent) => paneBZoom(clamp(percent / 100, ZOOM_MIN, ZOOM_MAX), 'custom')}
          onPaneZoomIn={() => paneBZoom(clamp(paneBScale * 1.15, ZOOM_MIN, ZOOM_MAX), 'custom')}
          onPaneZoomOut={() => paneBZoom(clamp(paneBScale / 1.15, ZOOM_MIN, ZOOM_MAX), 'custom')}
          onPaneFitWidth={() => setPaneBFit('width')}
          onPaneFitPage={() => setPaneBFit('page')}
          onResetApp={resetPreferences}
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
        style={
          {
            '--sidebar-w': `${panelW.sidebar}px`,
            '--ai-w': `${panelW.ai}px`,
            // Grow factors, not widths: the two columns divide whatever the side
            // panels leave over in this ratio, so both shrink together. The two
            // sum to exactly 1, which is what makes flexbox hand out ALL the
            // free space — a lone column must therefore be a full 1, or it
            // would grow to only its share of the width and leave the rest bare.
            '--pane-a-grow': `${splitOpen && pdf ? 1 - panelW.pane : 1}`,
            '--pane-b-grow': `${panelW.pane}`
          } as React.CSSProperties
        }
      >
        <Sidebar
          open={tocVisible}
          pdf={pdf}
          sizes={sizes}
          currentPage={currentPage}
          annotations={annots}
          excerpts={excerpts}
          onJumpToPage={jumpToPage}
          onJumpToDest={jumpToDest}
          onJumpToAnnot={jumpSelectAnnot}
          onDeleteAnnot={removeAnnotation}
          onDeleteAllAnnots={() => void removeAllAnnotations()}
          selectedAnnotId={selected?.localId ?? null}
          onCommentChange={onMarginCommit}
          marginOn={marginNotes}
          marginSide={marginView.side}
          onToggleMargin={toggleMarginNotes}
          onMarginSideChange={setMarginSide}
          onExportMargin={() => void exportMarginNotes()}
          bookmarks={bookmarks}
          onToggleBookmark={toggleBookmark}
          onRenameBookmark={renameBookmark}
          onExport={exportAnnotations}
          onAskAi={askAnnotations}
          docName={payload.name}
          docPath={payload.path}
          onOpenFile={onOpenFile}
        />
        {tocPinned && (
          <div
            className={`panel-resizer${resizingPanel === 'sidebar' ? ' active' : ''}`}
            title={t('viewer.resizerTip')}
            onPointerDown={(e) => beginPanelResize('sidebar', e)}
            onDoubleClick={() => resetPanelWidth('sidebar')}
          />
        )}

        <div
          className={`pages-host${paneFlash === 'a' ? ' pane-flash' : ''}`}
          ref={pagesHostRef}
        >
        <div
          className={`pages${drawTool ? ' drawing' : ''}`}
          data-pane="a"
          data-dockey={payload.path}
          data-rotation={rotation}
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
              style={{ height: layout.total, width: layout.contentWidth + marginGutter }}
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
                    keepImageColors={keepImageColors}
                    selectedId={selected?.pageNumber === pageNumber ? selected.localId : null}
                    searchRects={
                      searchHits?.pageNumber === pageNumber ? searchHits.rects : EMPTY_RECTS
                    }
                    searchAllRects={
                      (searchAllHits?.pane === 'a' && searchAllHits.byPage.get(pageNumber)) ||
                      EMPTY_RECTS
                    }
                    searchFlash={!!searchHits?.flash && searchHits.pageNumber === pageNumber}
                    searchFlashId={
                      searchHits?.flash && searchHits.pageNumber === pageNumber
                        ? searchHits.flashId
                        : undefined
                    }
                    drawTool={drawTool}
                    fingerDraws={prefs.input.fingerDraws}
                    penPressure={prefs.input.penPressure}
                    onInternalLink={onInternalLink}
                    onExternalLink={onExternalLink}
                    onStrokeComplete={onStrokeComplete}
                    onErase={onEraseAt}
                    onShapeComplete={onShapeComplete}
                    onPlaceText={onPlaceText}
                    onResizeStart={onResizeStart}
                    onMarkupEndStart={onMarkupEndStart}
                    markupPreview={
                      (markupPreview?.pane === 'a' && markupPreview.byPage.get(pageNumber)) ||
                      EMPTY_RECTS
                    }
                    marginView={marginViewConfig}
                    onMarginCommit={onMarginCommit}
                    onMarginSelect={onMarginSelect}
                    onMarginDelete={onMarginDelete}
                    onMarginMenu={onMarginMenu}
                  />
                )
              })}
              {paneOverlay('a', layout, scale, rotation)}
            </div>
          ) : (
            <div className="viewer-loading">
              <div className="spinner" />
              <span>{t('viewer.opening', { name: payload.name })}</span>
            </div>
          )}
        </div>
        {/* Margin on + nothing in sight: quiet arrows to the nearest comment */}
        {marginViewConfig && !annotsHidden && (
          <MarginJumpArrows
            scrollRef={containerRef}
            layout={layout}
            annots={annots}
            sizes={sizes}
            scale={scale}
            rotation={rotation}
            side={marginViewConfig.side}
            onJump={(p, r) => jumpSelectAnnotIn('a', p, r)}
          />
        )}
        {/* The margin strip's right-click menu (fixed at the cursor; the strip
            itself reported viewport coordinates). One choice, not an action —
            hiding the view on the raw right-click was tried and felt like the
            app snatching the margin away. */}
        {marginMenu && (
          <div
            ref={marginMenuRef}
            className="tab-menu"
            style={{
              left: Math.min(marginMenu.x, window.innerWidth - 220),
              top: Math.min(marginMenu.y, window.innerHeight - 48)
            }}
          >
            <button
              className="menu-item"
              onClick={() => {
                setMarginMenu(null)
                patchMarginView({ on: false })
              }}
            >
              {t('margin.hide')}
            </button>
          </div>
        )}
        <OverlayScrollbars
          scrollRef={containerRef}
          layoutKey={layout ? `${layout.total}:${layout.contentWidth}` : 'none'}
        />
        </div>

        {/* Split view: a full second column, mounted only while open so closing
            it frees every page canvas. Same tools, same annotation map, same
            save — only page and zoom are its own. */}
        {splitOpen && pdf && (
          <>
            <div
              className={`panel-resizer${resizingPanel === 'pane' ? ' active' : ''}`}
              title={t('viewer.resizerTip')}
              onPointerDown={(e) => beginPanelResize('pane', e)}
              onDoubleClick={() => resetPanelWidth('pane')}
            />
            <PagesPane
              pdf={pdf}
              docKey={payload.path}
              sizes={sizes}
              annots={annots}
              annotsHidden={annotsHidden}
              keepImageColors={keepImageColors}
              rotation={paneBRotation}
              spread={paneBSpread}
              coverPage={paneBCover}
              scale={paneBScale}
              fitMode={paneBFit}
              onZoom={paneBZoom}
              onPageChange={setPaneBPage}
              flash={paneFlash === 'b'}
              drawTool={drawTool}
              fingerDraws={prefs.input.fingerDraws}
              penPressure={prefs.input.penPressure}
              selected={selected}
              searchHits={searchHits}
              searchAllHits={searchAllHits?.pane === 'b' ? searchAllHits.byPage : null}
              onContextMenu={onContextMenu}
              onMouseUp={onMouseUp}
              onMouseDown={onMouseDown}
              onDoubleClick={onPagesDoubleClick}
              onMouseMove={onPagesMouseMove}
              onMouseLeave={() => setHoverTip(null)}
              onScroll={onPaneBScroll}
              onStrokeComplete={onStrokeComplete}
              onErase={onEraseAt}
              onShapeComplete={onShapeComplete}
              onPlaceText={onPlaceText}
              marginView={marginViewConfig}
              onMarginCommit={onMarginCommit}
              onMarginSelect={onMarginSelect}
              onMarginDelete={onMarginDelete}
              onMarginMenu={onMarginMenu}
              onMarginJump={(p, r) => jumpSelectAnnotIn('b', p, r)}
              onResizeStart={onResizeStart}
              onMarkupEndStart={onMarkupEndStart}
              markupPreview={markupPreview?.pane === 'b' ? markupPreview.byPage : null}
              onExternalLink={onExternalLink}
              onInternalLink={onPaneBInternalLink}
              onHandle={(h) => {
                paneBHandleRef.current = h
              }}
              overlay={({ layout: lay, scale: s }) => paneOverlay('b', lay, s, paneBRotation)}
            />
          </>
        )}

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
                openSettingsAskId={aiSettingsAskId}
                onCitationClick={(resolved) => void jumpToAiCitation(resolved)}
                onClose={() => {
                  setAiPeek(false)
                  setAiPinned(false)
                }}
                chatSnip={chatSnip}
                onChatSnipConsumed={() => setChatSnip(null)}
                onRequestSnip={() => setSnip({ target: 'chat' })}
                onDetach={() => {
                  // The chat moves out; the docked panel closes behind it.
                  // Reopening it (A) is allowed — both write the same stored
                  // history, and the panel refreshes on the storage event.
                  bridge.openAssistant(payload.path)
                  setAiPeek(false)
                  setAiPinned(false)
                }}
                chatPages={chatPages}
                onChatPagesConsumed={() => setChatPages(null)}
                onRequestPageImages={onRequestPageImages}
                pagesBusy={chatPagesBusy}
                currentPage={currentPage}
                pageCount={sizes.length}
              />
            </div>
          </div>
        </div>
      </div>

      {(activeNav.back.length > 0 || activeNav.forward.length > 0) && layout && (
        <div
          className={`nav-pills${pillsFaded ? ' faded' : ''}`}
          onMouseEnter={revealPills}
          onMouseLeave={() => schedulePillsFade(1400)}
        >
          {activeNav.back.length > 0 && (
            <button className="back-pill" onClick={goBack} title="Alt+←">
              {t('viewer.backToPage', { page: activeNav.back[activeNav.back.length - 1].page })}
            </button>
          )}
          {activeNav.forward.length > 0 && (
            <button className="back-pill" onClick={goForward} title="Alt+→">
              {t('viewer.forwardToPage', { page: activeNav.forward[activeNav.forward.length - 1].page })}
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
          focusToken={searchFocusToken}
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
          aiModelName={semanticModelName}
          onAiSearch={() => void runSemanticSearch()}
          onAiPick={pickSemanticHit}
          onOpenAiSettings={() => {
            closeSearch()
            setAiPinned(true)
            setAiSettingsAskId((n) => n + 1)
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
      {snip && <SnipOverlay onDone={onSnipDone} onCancel={() => setSnip(null)} />}
      {/* Armed text tool: the same pill the note tool shows, and it says out
          loud that the box stays movable/resizable — the part of the tool
          nobody discovered on their own */}
      {activeTool === 'text' && !freeTextDraft && (
        <div className="snip-hint tool-arm-hint">{t('text.hint')}</div>
      )}
      {notePlacing && (
        <div
          className="note-place-overlay"
          onPointerDown={(e) => {
            if (palmResting(e)) return
            e.preventDefault()
            placeNoteAt(e.clientX, e.clientY)
          }}
        >
          <div className="snip-hint">{t('note.hint')}</div>
        </div>
      )}
      {/* Armed signature: same click-to-place overlay as the note tool, with a
          preview riding the cursor so the drop point is never a guess. */}
      {armedSignature && (
        <div
          className="note-place-overlay"
          onPointerDown={(e) => {
            if (palmResting(e)) return
            e.preventDefault()
            placeSignatureAt(e.clientX, e.clientY)
          }}
        >
          <div className="snip-hint">{t('sig.armed')}</div>
        </div>
      )}
      {signaturePadOpen && (
        <SignaturePad onSave={onSignatureSaved} onCancel={() => setSignaturePadOpen(false)} />
      )}
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
              avoid={annotPopover.avoid}
              focusText={annotPopover.focusText}
              annotation={record}
              onColor={(color) => changeAnnotation(annotPopover.pageNumber, record, { color })}
              onFont={(font) => {
                // Re-measure in the NEW face before sending: Courier is far
                // wider than Helvetica at the same size, so keeping the old box
                // would wrap the words somewhere else than they were written —
                // or clip them, which reads as data loss. The box only ever
                // GROWS here: shrinking a box the user had widened on purpose
                // would undo a deliberate choice, so the floor is the minimum
                // and the current width wins when it is already wider.
                const q = record.quads[0]
                if (!q) return
                const min = freetextMinSize(record.contents ?? '', record.fontSize ?? 12, q.w, font)
                const w = Math.max(q.w, min.w)
                const h = Math.max(q.h, min.h)
                changeAnnotation(annotPopover.pageNumber, record, {
                  font,
                  ...(w !== q.w || h !== q.h ? { quads: [{ ...q, w, h }] } : {})
                })
              }}
              onContents={(contents) =>
                changeAnnotation(annotPopover.pageNumber, record, { contents })
              }
              onDelete={() => removeAnnotation(annotPopover.pageNumber, record)}
              onClose={() => setAnnotPopover(null)}
              size={bubbleSizes.get(annotPopover.localId) ?? null}
              onResize={(size) => setBubbleSize(annotPopover.localId, size)}
            />
          )
        })()}
      {noteDraft && (
        <NotePopover
          x={noteDraft.x}
          y={noteDraft.y}
          avoid={noteDraft.avoid}
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
            paneAHandle.scrollToPage(page)
          }}
          onExit={exitPresentation}
        />
      )}
    </div>
  )
}

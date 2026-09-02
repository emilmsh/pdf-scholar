import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CustomTone,
  FileError,
  LanguagePreference,
  Settings,
  ThemeName,
  ThemePreference,
  UpdateCheckOutcome,
  UpdateUnsupportedReason,
  ZoteroInfo
} from '../../../shared/types'
import { zoteroKeyFromPath } from '../../../shared/zotero'
import { applyPageTune, CUSTOM_TONE_ORDER, customToneCss, TUNE_RANGE } from '../theme-tune'
import { bridge, isElectron } from '../bridge'
import {
  annotTypeLabel,
  colorLabel,
  FREETEXT_COLORS,
  HIGHLIGHT_COLORS,
  MARKUP_TOOL_TYPES,
  PEN_COLORS,
  SHAPE_TOOL_TYPES,
  TEXT_FONT_FAMILIES,
  textFontCss,
  textFontOf,
  textFontParts,
  UNDERLINE_COLORS
} from '../annotations'
import type { DrawToolType, MarkupToolType, ShapeToolType } from '../annotations'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  markupPrefIsDefault,
  OPACITY_MAX,
  OPACITY_MIN,
  OPACITY_STEP,
  textPrefIsDefault,
  TOOL_WIDTH_MAX,
  TOOL_WIDTH_MIN,
  TOOL_WIDTH_STEP,
  toolPrefIsDefault
} from '../tool-prefs'
import type { DrawPrefKey, EraserScope, MarkupPref, TextPref, ToolPref } from '../tool-prefs'
import { errorText, t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import type { SavedSignature } from '../signatures'
import { READ_ALOUD } from '../flags'
import { useDismissable } from '../useDismissable'
import { updateOutcomeText } from './Welcome'
import ShortcutsDialog from './ShortcutsDialog'
import {
  bubblesWhileTyping,
  commandForEvent,
  isKeyboardCaptured,
  shortcutLabel,
  withShortcut,
  withShortcuts
} from '../keymap'
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconChevronDown,
  IconCopy,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconFitPage,
  IconFitWidth,
  IconFullscreen,
  IconGear,
  IconComment,
  IconHeart,
  IconKeyboard,
  IconMarker,
  IconMarkupHighlight,
  IconMarkupSquiggly,
  IconMarkupStrikeout,
  IconMarkupUnderline,
  IconMinus,
  IconMore,
  IconPen,
  IconPin,
  IconPinOff,
  IconPlus,
  IconPresent,
  IconPrint,
  IconRedo,
  IconReload,
  IconReset,
  IconSaveAs,
  IconRotateCcw,
  IconRotateCw,
  IconSave,
  IconUndo,
  IconSearch,
  IconSpeaker,
  IconCoverPage,
  IconSpread,
  IconTextMarkup,
  IconShapeArrow,
  IconShapeCircle,
  IconShapeLine,
  IconShapeSquare,
  IconShapes,
  IconChevronLeft,
  IconSidebar,
  IconSignature,
  IconSparkle,
  IconSplit,
  IconNote,
  IconText,
  IconTrash,
  IconTextSettings,
  IconView
} from './icons'

export type ToolName = DrawToolType

/** «Halseth & Wu (2026) — Title», from whatever fields the Zotero item actually
 *  has; falls back to the formatted citation for a bare item. */
function zoteroLine(info: ZoteroInfo): string {
  const names =
    info.creators.length > 2
      ? `${info.creators[0]} ${t('zotero.etAl')}`
      : info.creators.join(' & ')
  const head = [names, info.year ? `(${info.year})` : ''].filter(Boolean).join(' ')
  return [head, info.title].filter(Boolean).join(' — ') || info.citation
}

const SHAPE_ICONS: Record<ShapeToolType, (p: { size?: number }) => React.JSX.Element> = {
  square: IconShapeSquare,
  circle: IconShapeCircle,
  line: IconShapeLine,
  arrow: IconShapeArrow
}

const MARKUP_ICONS: Record<MarkupToolType, (p: { size?: number }) => React.JSX.Element> = {
  highlight: IconMarkupHighlight,
  underline: IconMarkupUnderline,
  strikeout: IconMarkupStrikeout,
  squiggly: IconMarkupSquiggly
}

const SHAPE_LABEL_KEYS: Record<ShapeToolType, MsgKey> = {
  square: 'shape.square',
  circle: 'shape.circle',
  line: 'shape.line',
  arrow: 'shape.arrow'
}

/** Zoom steps offered in the Visning menu. 100 % is in the row rather than
 *  only as a separate "actual size" action — the two are the same thing, and
 *  Ctrl+0 plus the typed zoom field already cover it. */
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 400] as const

/** Any touch digitizer at all — gates the finger-routing option so it never
 *  shows on a plain desktop. maxTouchPoints, not (pointer: coarse): a Surface
 *  with its keyboard attached has a fine primary pointer AND a touch screen. */
const HAS_TOUCH = navigator.maxTouchPoints > 0

interface Props {
  page: number
  pageCount: number
  zoomPercent: number
  settings: Settings
  /** What 'auto' resolves to right now — the tune slider follows the theme the
   *  reader actually SEES, not the stored preference. */
  resolvedTheme: ThemeName
  sidebarOpen: boolean
  canNavBack: boolean
  canNavForward: boolean
  activeTool: ToolName | null
  toolPrefs: Record<DrawPrefKey, ToolPref>
  onToolSelect(tool: ToolName | null): void
  /** Text-anchored markup tool (highlight/underline/strikeout/squiggly) — a
   *  persistent tool that marks up the text selection, distinct from freehand */
  activeMarkup: MarkupToolType | null
  markupPrefs: Record<MarkupToolType, MarkupPref>
  onMarkupSelect(type: MarkupToolType | null): void
  onMarkupPrefChange(type: MarkupToolType, patch: Partial<MarkupPref>): void
  onMarkupPrefReset(type: MarkupToolType): void
  /** What the eraser removes: hand-drawn marks only, or every annotation */
  eraserScope: EraserScope
  onEraserScopeChange(scope: EraserScope): void
  /** Touch routing while a tool is armed: finger draws vs finger navigates
   *  (pen-only drawing). Offered only on devices that have touch at all. */
  fingerDraws: boolean
  onFingerDrawsChange(fingerDraws: boolean): void
  /** Pen tool: pressure-sensitive vs fixed width — offered once a pen exists */
  penSeen: boolean
  penPressure: boolean
  onPenPressureChange(penPressure: boolean): void
  /** View rotation + two-page spread (live in the Visning menu) */
  spread: boolean
  /** Spread sub-option: page 1 alone, pairs 2-3, 4-5 … (only while spread is on) */
  coverPage: boolean
  onRotate(dir: 1 | -1): void
  onToggleSpread(): void
  onToggleCoverPage(): void
  onToolPrefChange(tool: DrawPrefKey, patch: Partial<ToolPref>): void
  onToolPrefReset(tool: DrawPrefKey): void
  /** FreeText tool look (text colour + font size) */
  textPref: TextPref
  onTextPrefChange(patch: Partial<TextPref>): void
  onTextPrefReset(): void
  onNavBack(): void
  onNavForward(): void
  onToggleSidebar(): void
  /** Go to the library. Closes nothing — the documents stay open behind it,
   *  in the tab strip, and this one is exactly where you left it when you come
   *  back to it. */
  onLeaveDocument(): void
  onGoToPage(page: number): void
  onZoomIn(): void
  onZoomOut(): void
  onZoomTo(percent: number): void
  onFitWidth(): void
  onFitPage(): void
  /** Current fit mode, so the fit control can be highlighted */
  fitMode: 'width' | 'page' | 'custom'
  /** Which fit the single inline fit button switches to next (mirrors the W
   *  shortcut) — the toolbar shows ONE fit toggle instead of two buttons */
  fitTarget: 'width' | 'page'
  onSettingsChange(patch: Partial<Settings>): void
  onToggleSearch(): void
  /** Absolute path/URL of the open document. Feeds the save menu's Zotero
   *  section, whose existence is a pure path check (shared/zotero.ts) — no
   *  IPC or network unless the menu opens over a detected file. */
  filePath: string
  /** Unsaved annotation changes exist (enables the save button) */
  dirty: boolean
  onSave(): void
  /** Save a copy of the document to a user-chosen location */
  onSaveAs(): void
  /** Platform can write annotation changes back to the file in place (Electron).
   *  When false the in-place Save button is hidden — Save-to-disk is the save. */
  canSaveInPlace: boolean
  /** All annotations temporarily hidden (clean reading view) */
  annotsHidden: boolean
  onToggleAnnots(): void
  /* No marginNotes here: the margin view is toggled from the Merknader tab,
     the one home for everything comment-related, and the toolbar's duplicate
     toggle came out on 2026-08-09. */
  /** Annotation undo/redo (mirrors Ctrl+Z/Y — needed for pen/touch use) */
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  /** Print — reached from the Save button's chevron menu, not an icon of its own */
  onPrint(): void
  readAloudOpen: boolean
  onToggleReadAloud(): void
  aiOpen: boolean
  onToggleAi(): void
  /* No snipActive/onToggleSnip: snip-to-explain is armed from the assistant
     composer and from right-click on the page, not from the toolbar. */
  /** Note placement: armed = click-to-place overlay is up */
  noteActive: boolean
  onToggleNote(): void
  /** A signature is armed and waiting for a click on the page */
  signatureActive: boolean
  /** Saved signatures, newest first — the menu lists them as pictures */
  signatures: SavedSignature[]
  /** Main button: arm the only signature, or open the pad when there are none */
  onSignaturePrimary(): void
  /** Arm this saved signature for placement (null disarms) */
  onSignaturePick(id: string | null): void
  onSignatureDraw(): void
  onSignatureDelete(id: string): void
  /** The «Signert»-indicator, when the document carries digital signatures.
   *  Passed in rather than built here: it is about the DOCUMENT, and the
   *  toolbar has no business reading the file. */
  signatureInfo?: React.ReactNode
  /** Open the assistant panel showing its key settings (gear-menu shortcut) */
  onOpenAiSettings(): void
  /** Toolbar auto-hide: pinned = always shown, unpinned = reveals on hover */
  toolbarPinned: boolean
  onTogglePin(): void
  onPresent(): void
  onToggleFullscreen(): void
  /** Split view: a second pages column, equal in every way except that page and
   *  zoom are its own — so the toolbar's centre gains a column switcher, and its
   *  one cluster drives whichever column that switcher points at. */
  splitOpen: boolean
  onToggleSplit(): void
  activePane: 'a' | 'b'
  onActivatePane(pane: 'a' | 'b'): void
  /** Close one named column, keeping the other's content */
  onClosePane(pane: 'a' | 'b'): void
  panePage: number
  paneZoomPercent: number
  paneFitMode: 'width' | 'page' | 'custom'
  paneFitTarget: 'width' | 'page'
  onPaneGoToPage(page: number): void
  onPaneZoomTo(percent: number): void
  onPaneZoomIn(): void
  onPaneZoomOut(): void
  onPaneFitWidth(): void
  onPaneFitPage(): void
  /** Restore every preference to its shipped default (gear menu, confirmed) */
  onResetApp(): void
}

const THEMES: { id: ThemePreference; labelKey: MsgKey }[] = [
  { id: 'day', labelKey: 'tb.themeDay' },
  { id: 'sepia', labelKey: 'tb.themeSepia' },
  { id: 'night', labelKey: 'tb.themeNight' },
  { id: 'nightHc', labelKey: 'tb.themeNightHc' },
  { id: 'custom', labelKey: 'tb.themeCustom' },
  { id: 'auto', labelKey: 'tb.themeAuto' }
]

const TONE_LABELS: Record<CustomTone, MsgKey> = {
  gray: 'tb.toneGray',
  green: 'tb.toneGreen',
  blue: 'tb.toneBlue',
  sand: 'tb.toneSand'
}

const LANGUAGES: { id: LanguagePreference; label: string }[] = [
  // Language names stay in their own language — standard for language pickers
  { id: 'nb', label: 'Norsk' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Auto' }
]

/** Percent readout for the opacity sliders (0.45 → «45 %») */
const pct = (v: number): string => `${Math.round(v * 100)} %`

/** The fit button's tooltip. The «W veksler …» clause is not appended with
 *  withShortcut because it is a sentence about the key rather than a suffix —
 *  and it has to vanish entirely if the reader unbound the toggle. */
const fitTip = (whole: boolean): string => {
  const base = t(whole ? 'tb.fitPageTip' : 'tb.fitWidthTip')
  const keys = shortcutLabel('zoom.fitToggle')
  return keys ? `${base} (${t('tb.fitToggleHint', { keys })})` : base
}

/** The one shared shape of an option popover's reset affordance: a quiet text
 *  link that only exists while there is something to undo, so an untouched tool
 *  shows no extra chrome at all. */
function ResetLink({ hidden, onClick }: { hidden: boolean; onClick(): void }): React.JSX.Element | null {
  if (hidden) return null
  return (
    <button className="tool-reset" onClick={onClick} title={t('tb.resetToolTip')}>
      <IconReset size={12} />
      {t('tb.resetTool')}
    </button>
  )
}

/** Every toolbar menu opts out of useDismissable's own Escape: the consolidated
 *  keydown effect below owns Escape for all of them, because it has to close the
 *  reset confirmation before the menu that contains it. */
const NO_ESCAPE = { escape: false } as const

export default function Toolbar({
  page,
  pageCount,
  zoomPercent,
  settings,
  resolvedTheme,
  sidebarOpen,
  canNavBack,
  canNavForward,
  activeTool,
  toolPrefs,
  onToolSelect,
  activeMarkup,
  markupPrefs,
  onMarkupSelect,
  onMarkupPrefChange,
  onMarkupPrefReset,
  eraserScope,
  onEraserScopeChange,
  fingerDraws,
  onFingerDrawsChange,
  penSeen,
  penPressure,
  onPenPressureChange,
  spread,
  coverPage,
  onRotate,
  onToggleSpread,
  onToggleCoverPage,
  onToolPrefChange,
  onToolPrefReset,
  textPref,
  onTextPrefChange,
  onTextPrefReset,
  onNavBack,
  onNavForward,
  onToggleSidebar,
  onLeaveDocument,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFitWidth,
  onFitPage,
  fitMode,
  fitTarget,
  onSettingsChange,
  onToggleSearch,
  filePath,
  dirty,
  onSave,
  onSaveAs,
  canSaveInPlace,
  annotsHidden,
  onToggleAnnots,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrint,
  readAloudOpen,
  onToggleReadAloud,
  aiOpen,
  onToggleAi,
  noteActive,
  onToggleNote,
  signatureActive,
  signatures,
  onSignaturePrimary,
  onSignaturePick,
  onSignatureDraw,
  onSignatureDelete,
  signatureInfo,
  onOpenAiSettings,
  toolbarPinned,
  onTogglePin,
  onPresent,
  onToggleFullscreen,
  splitOpen,
  onToggleSplit,
  activePane,
  onActivatePane,
  onClosePane,
  panePage,
  paneZoomPercent,
  paneFitMode,
  paneFitTarget,
  onPaneGoToPage,
  onPaneZoomTo,
  onPaneZoomIn,
  onPaneZoomOut,
  onPaneFitWidth,
  onPaneFitPage,
  onResetApp
}: Props): React.JSX.Element {
  useLang()
  const [pageInput, setPageInput] = useState(String(page))
  const [panePageInput, setPanePageInput] = useState(String(panePage))
  /** Which column's zoom readout is being typed into (null = neither) */
  const [zoomEditing, setZoomEditing] = useState<'a' | 'b' | null>(null)
  const [zoomInput, setZoomInput] = useState('')
  // Reading-mode menu (themes) and the Visning menu (zoom, page layout,
  // screen, windows) are separate surfaces: one is about how the PAPER looks,
  // the other about how it is laid out in the window.
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  /** Intensity slider mid-drag: previewed live via applyPageTune, but only
   *  COMMITTED to settings on release — settings:set is a synchronous file
   *  write per call, and a drag emits dozens of ticks. null = not dragging. */
  const [tuneDraft, setTuneDraft] = useState<number | null>(null)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  // Save is a split button: the frequent action (write changes back to the
  // file) stays one click, the rare one (save a copy) moves behind the
  // chevron — one glyph less in a row of three disk-like icons.
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  // The Zotero section of that menu. Whether it exists at all is a pure path
  // check; the localhost fetch runs only while the menu is OPEN over a detected
  // file — never on document open. Every open re-asks: successes are cached
  // platform-side (instant), failures retry naturally (the user may have
  // started Zotero since last time).
  const zoteroKey = zoteroKeyFromPath(filePath)
  const [zoteroFetch, setZoteroFetch] = useState<{
    loading: boolean
    result: ZoteroInfo | FileError | null
  }>({ loading: false, result: null })
  const [zoteroCopied, setZoteroCopied] = useState<'citation' | 'bib' | null>(null)
  useEffect(() => {
    if (!saveMenuOpen || !zoteroKey) return undefined
    let stale = false
    setZoteroFetch({ loading: true, result: null })
    setZoteroCopied(null)
    void bridge.zoteroInfo(filePath).then((result) => {
      if (!stale) setZoteroFetch({ loading: false, result })
    })
    return () => {
      stale = true
    }
  }, [saveMenuOpen, zoteroKey, filePath])
  const zoteroCopy = (kind: 'citation' | 'bib', text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setZoteroCopied(kind)
      window.setTimeout(() => setZoteroCopied((c) => (c === kind ? null : c)), 1500)
    })
  }
  // The gear menu: the app's technical surface (language, annotation
  // visibility, AI setup, update check, reset, version/about)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [resetAsk, setResetAsk] = useState(false)
  /** The keyboard map, opened from the gear menu */
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updChecking, setUpdChecking] = useState(false)
  const [updOutcome, setUpdOutcome] = useState<UpdateCheckOutcome | null>(null)
  // undefined until probed; 'store' hides the check (Store owns updates there)
  const [updSupport, setUpdSupport] = useState<UpdateUnsupportedReason | null | undefined>(undefined)
  // Outside-click closers listen for pointerdown in the capture phase:
  // pointerdown always fires (page overlays may suppress the compat
  // mousedown via preventDefault) and capture beats stopPropagation.
  /** Which tool has its option menu open. Named, because the overflow rows
   *  refer to it too now — a folded tool opens the same menu its inline
   *  chevron would. */
  type ToolMenuKey = DrawPrefKey | 'markup' | 'eraser' | 'text' | 'signature'
  const [toolMenu, setToolMenu] = useState<ToolMenuKey | null>(null)
  // Last markup type the user activated, so the split button's main click
  // re-arms that type rather than always defaulting to highlight
  const [markupType, setMarkupType] = useState<MarkupToolType>('highlight')
  const themeMenuRef = useRef<HTMLDivElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const saveMenuRef = useRef<HTMLDivElement>(null)
  const toolMenuRef = useRef<HTMLDivElement>(null)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  /** The page field, so the Gå-til-side command can focus it. Only ever one is
   *  rendered — the single cluster drives whichever column is active. */
  const pageInputRef = useRef<HTMLInputElement>(null)
  // Responsive overflow: secondary buttons fold into a "…" menu (left of the
  // protected Assistant button) when the toolbar is too narrow for them all.
  const toolbarRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const overflowMenuRef = useRef<HTMLDivElement>(null)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false)

  // Stable closers so the shared hook does not re-bind its listeners each render
  const closeToolMenu = useCallback(() => setToolMenu(null), [])
  const closeThemeMenu = useCallback(() => setThemeMenuOpen(false), [])
  const closeViewMenu = useCallback(() => setViewMenuOpen(false), [])
  const closeSaveMenu = useCallback(() => setSaveMenuOpen(false), [])
  const closeSettingsMenu = useCallback(() => setSettingsMenuOpen(false), [])
  const closeOverflowMenu = useCallback(() => setOverflowMenuOpen(false), [])

  // Escape for all five toolbar menus is owned by the consolidated handler
  // below, which has to close the reset confirmation first — hence escape: false.
  useDismissable(toolMenuRef, toolMenu !== null, closeToolMenu, NO_ESCAPE)

  // 'shape' is not a draw tool of its own (the four shapes are) — its options
  // popover is opened straight from the Former button, not through here.
  const selectTool = (tool: 'pen' | 'marker' | 'eraser'): void => {
    if (activeTool === tool) {
      if (tool === 'eraser') {
        // The eraser is toggled off far more often than it is reconfigured —
        // its options live behind the chevron, not behind a second click.
        onToolSelect(null)
      } else {
        // Second click on the active tool opens its options; third closes tool
        if (toolMenu === tool) {
          setToolMenu(null)
          onToolSelect(null)
        } else {
          setToolMenu(tool)
        }
      }
    } else {
      onToolSelect(tool)
      setToolMenu(null)
    }
  }

  const shapeActive = (SHAPE_TOOL_TYPES as readonly string[]).includes(activeTool ?? '')

  useEffect(() => {
    setPageInput(String(page))
  }, [page])

  useEffect(() => {
    setPanePageInput(String(panePage))
  }, [panePage])

  useDismissable(themeMenuRef, themeMenuOpen, closeThemeMenu, NO_ESCAPE)

  useDismissable(viewMenuRef, viewMenuOpen, closeViewMenu, NO_ESCAPE)

  useDismissable(saveMenuRef, saveMenuOpen, closeSaveMenu, NO_ESCAPE)

  useDismissable(settingsMenuRef, settingsMenuOpen, closeSettingsMenu, NO_ESCAPE)

  // Esc closes any open toolbar menu (and the reset confirmation) before the
  // viewer's own Esc chain gets a look in — a menu must never trap the user.
  useEffect(() => {
    if (
      !themeMenuOpen &&
      !viewMenuOpen &&
      !saveMenuOpen &&
      !settingsMenuOpen &&
      !overflowMenuOpen &&
      !toolMenu &&
      !resetAsk
    )
      return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (resetAsk) {
        setResetAsk(false)
        return
      }
      setThemeMenuOpen(false)
      setViewMenuOpen(false)
      setSaveMenuOpen(false)
      setSettingsMenuOpen(false)
      setOverflowMenuOpen(false)
      setToolMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [themeMenuOpen, viewMenuOpen, saveMenuOpen, settingsMenuOpen, overflowMenuOpen, toolMenu, resetAsk])

  // «Gå til side» is the toolbar's own shortcut: the command focuses the page
  // field, which lives here, so the listener does too rather than routing a
  // callback down from the viewer for one keypress. Capture phase + a swallowed
  // event so the browser's own Ctrl+G (find-again in the web target) stays shut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isKeyboardCaptured()) return
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (commandForEvent(e, typing) !== 'nav.gotoPage') return
      const el = pageInputRef.current
      if (!el) return // the cluster is folded away — nothing to focus
      e.preventDefault()
      e.stopPropagation()
      el.focus()
      // …and select explicitly. The field's own onFocus does this for a CLICK,
      // but a programmatic focus lets the caret land at the end instead, and
      // then typing 5 on page 1 asks for page 15.
      el.select()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Version + update capability are static — fetch once, the first time the
  // gear menu opens.
  useEffect(() => {
    if (settingsMenuOpen && !appVersion) void bridge.getVersion().then(setAppVersion)
    if (settingsMenuOpen && updSupport === undefined) void bridge.updateSupport().then(setUpdSupport)
  }, [settingsMenuOpen, appVersion, updSupport])

  const checkForUpdates = (): void => {
    if (updChecking) return
    setUpdChecking(true)
    setUpdOutcome(null)
    void bridge
      .updateCheck()
      .then(setUpdOutcome)
      .catch(() => setUpdOutcome({ status: 'error', current: '' }))
      .finally(() => setUpdChecking(false))
  }

  const commitPage = (): void => {
    const n = parseInt(pageInput, 10)
    if (!Number.isNaN(n)) onGoToPage(n)
    else setPageInput(String(page))
  }

  const commitPanePage = (): void => {
    const n = parseInt(panePageInput, 10)
    if (!Number.isNaN(n)) onPaneGoToPage(n)
    else setPanePageInput(String(panePage))
  }

  /** Zoom actions reachable from OUTSIDE a cluster (the Vis menu, the "…"
   *  overflow, the W shortcut's twin) act on the column the user is working
   *  in — which the column switcher makes visible. */
  const inPaneB = splitOpen && activePane === 'b'
  const activeZoom = {
    percent: inPaneB ? paneZoomPercent : zoomPercent,
    fitMode: inPaneB ? paneFitMode : fitMode,
    fitTarget: inPaneB ? paneFitTarget : fitTarget,
    zoomTo: inPaneB ? onPaneZoomTo : onZoomTo,
    fitWidth: inPaneB ? onPaneFitWidth : onFitWidth,
    fitPage: inPaneB ? onPaneFitPage : onFitPage
  }

  const toggleFit = (): void => {
    if (activeZoom.fitTarget === 'page') activeZoom.fitPage()
    else activeZoom.fitWidth()
  }

  /** The column switcher, left of the cluster in split view. It does three jobs
   *  in the width one icon used to take: it says which column the cluster is
   *  driving, it shows the OTHER column's page (the one thing a single cluster
   *  would otherwise hide), and it is the only pointer-free way to change
   *  columns — until now you had to click into the page itself, which is no
   *  help on a touch screen when the column you want is scrolled to a figure. */
  const paneSwitch = (
    <div className="pane-switch">
      {(['a', 'b'] as const).map((p) => (
        <button
          key={p}
          className={`pane-switch-btn${activePane === p ? ' is-active' : ''}`}
          title={t(p === 'b' ? 'tb.paneRight' : 'tb.paneLeft')}
          aria-label={t(p === 'b' ? 'tb.paneRight' : 'tb.paneLeft')}
          aria-pressed={activePane === p}
          onClick={() => onActivatePane(p)}
        >
          {p === 'b' ? panePage : page}
        </button>
      ))}
    </div>
  )

  /** One page+zoom cluster. In split view it drives the ACTIVE column, exactly
   *  like everything else in the toolbar already does (the Vis menu's zoom
   *  steps, the "…" overflow's fit, the keyboard shortcuts) — two clusters were
   *  the odd one out, and they cost ~127 px of centre, which on a 14" laptop is
   *  two buttons folded into "…". Which column it is driving is said by the
   *  switcher above and, on the page itself, by the pulse when focus moves. */
  const centerCluster = (pane: 'a' | 'b'): React.JSX.Element => {
    const isB = pane === 'b'
    const value = isB ? panePageInput : pageInput
    const setValue = isB ? setPanePageInput : setPageInput
    const commit = isB ? commitPanePage : commitPage
    const percent = isB ? paneZoomPercent : zoomPercent
    const mode = isB ? paneFitMode : fitMode
    const target = isB ? paneFitTarget : fitTarget
    return (
      <div className={`center-cluster${splitOpen ? ' is-split' : ''}`}>
        <div className="page-indicator">
          <input
            ref={pageInputRef}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              // App shortcuts still reach the window handler from in here — a
              // caret parked in the page field must not disable Ctrl+S
              if (bubblesWhileTyping(e)) return
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label={t('tb.goToPage')}
            title={withShortcut(t('tb.goToPage'), 'nav.gotoPage')}
          />
          <span>/ {pageCount || '–'}</span>
        </div>

        <div className="toolbar-sep" />

        <button
          className="tb-btn"
          onClick={() => (isB ? onPaneZoomOut() : onZoomOut())}
          title={withShortcut(t('tb.zoomOutTip'), 'zoom.out')}
        >
          <IconMinus />
        </button>
        {zoomEditing === pane ? (
          <input
            className="zoom-input"
            autoFocus
            value={zoomInput}
            onChange={(e) => setZoomInput(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setZoomEditing(null)}
            onKeyDown={(e) => {
              // Ctrl+0 / Ctrl+± mean the same thing while typing a zoom value
              if (bubblesWhileTyping(e)) return
              e.stopPropagation()
              if (e.key === 'Enter') {
                const n = parseInt(zoomInput, 10)
                if (!Number.isNaN(n)) (isB ? onPaneZoomTo : onZoomTo)(n)
                setZoomEditing(null)
              }
              if (e.key === 'Escape') setZoomEditing(null)
            }}
            aria-label={t('tb.zoomExactTip')}
          />
        ) : (
          <button
            className="zoom-label"
            title={t('tb.zoomExactTip')}
            onClick={() => {
              setZoomInput(String(percent))
              setZoomEditing(pane)
            }}
          >
            {percent}%
          </button>
        )}
        <button
          className="tb-btn"
          onClick={() => (isB ? onPaneZoomIn() : onZoomIn())}
          title={withShortcut(t('tb.zoomInTip'), 'zoom.in')}
        >
          <IconPlus />
        </button>
        {inline('fit') && (
          <>
            <div className="toolbar-sep" />
            {/* ONE fit control instead of two: it shows (and does) whichever
                fit this column is not already in, like the W shortcut. */}
            <button
              className={`tb-btn${mode !== 'custom' ? ' is-active' : ''}`}
              onClick={() => (isB ? (target === 'page' ? onPaneFitPage() : onPaneFitWidth()) : target === 'page' ? onFitPage() : onFitWidth())}
              title={fitTip(target === 'page')}
            >
              {target === 'page' ? <IconFitPage /> : <IconFitWidth />}
            </button>
          </>
        )}
        {/* Closes the column the cluster is driving — the same rule as every
            other control here, and the tooltip names it outright. The other
            column keeps its content and takes the full width. */}
        {splitOpen && (
          <button
            className="cluster-close"
            title={t(isB ? 'tb.closePaneRight' : 'tb.closePaneLeft')}
            aria-label={t(isB ? 'tb.closePaneRight' : 'tb.closePaneLeft')}
            onClick={() => onClosePane(pane)}
          >
            ✕
          </button>
        )}
      </div>
    )
  }

  // --- Responsive overflow ("…" menu) ---
  // One priority-ordered list of EVERY collapsible button: index 0 folds away
  // FIRST (least important), so a shrinking window keeps stacking icons into the
  // "…" menu — down to the Assistant last — instead of clipping buttons off the
  // edge. Only the genuinely-complex controls (the annotation-tool cluster with
  // its option popovers, the page/zoom inputs, the three menus, Save, and the
  // sidebar toggle) stay inline as the irreducible core. Anything that has a
  // permanent home in the zoom/layout or gear menu is NOT listed here — folding
  // a duplicate into "…" would only pad the menu.
  //
  // The order was inverted until 2026-08-09: presentation and fullscreen sat at
  // indices 0 and 2, so they were the FIRST things to disappear — and at the
  // shoot's 1440 px they always had. Emil's call: those two change how the
  // content is displayed, dynamically, mid-work, and nobody wants to open a menu
  // to do that. They now fold near-last, after the marking tools. Marking tools
  // folding first is not a demotion either — the selection menu is the primary
  // way to mark a passage (MESSAGING pillar 3), and the toolbar copies exist for
  // marking several in a row, which a narrow window is the worst case for. The
  // first three out are the ones that are pointless or duplicated when narrow:
  // split (two columns in a narrow window), pin, and fit (also in the Vis menu,
  // and on W).
  const overflowActions: {
    key: string
    icon: React.JSX.Element
    label: string
    onClick(): void
    active?: boolean
    disabled?: boolean
    /** Tool-menu key this row's chevron opens, for a tool that has options */
    opts?: ToolMenuKey
  }[] = [
    ...(READ_ALOUD
      ? [
          {
            key: 'readaloud',
            icon: <IconSpeaker size={15} />,
            label: t('tb.readAloud'),
            onClick: onToggleReadAloud,
            active: readAloudOpen
          }
        ]
      : []),
    { key: 'split', icon: <IconSplit size={15} />, label: t('tb.split'), onClick: onToggleSplit, active: splitOpen },
    {
      key: 'pin',
      icon: toolbarPinned ? <IconPin size={15} /> : <IconPinOff size={15} />,
      label: toolbarPinned ? t('tb.unpin') : t('tb.pin'),
      onClick: onTogglePin,
      active: !toolbarPinned
    },
    {
      key: 'fit',
      icon: activeZoom.fitTarget === 'page' ? <IconFitPage size={15} /> : <IconFitWidth size={15} />,
      label: activeZoom.fitTarget === 'page' ? t('tb.fitPage') : t('tb.fitWidth'),
      onClick: toggleFit,
      active: activeZoom.fitMode !== 'custom'
    },
    // Annotation tools keep their options when they fold. `opts` names the
    // tool-menu key the row should open — the same menu the inline chevron
    // opens — and the row grows a chevron of its own to match. A row without
    // `opts` is a plain toggle, exactly as its inline button is.
    //
    // «Figurer» is the one that was actively wrong rather than merely reduced:
    // its inline button IS its menu (there is no separate shape tool), so the
    // folded row calling onToolSelect('square') drew a rectangle while the
    // label still said Shapes, and circle, line and arrow became unreachable.
    // It opens the picker now, like the button does.
    { key: 'signature', icon: <IconSignature size={15} />, label: t('tb.signature'), onClick: onSignaturePrimary, active: signatureActive, opts: 'signature' },
    { key: 'note', icon: <IconNote size={15} />, label: t('tb.note'), onClick: onToggleNote, active: noteActive },
    { key: 'shapes', icon: <IconShapes size={15} />, label: t('tb.shapes'), onClick: () => setToolMenu((m) => (m === 'shape' ? null : 'shape')), active: shapeActive, opts: 'shape' },
    { key: 'text', icon: <IconText size={15} />, label: t('tb.textTool'), onClick: () => onToolSelect(activeTool === 'text' ? null : 'text'), active: activeTool === 'text', opts: 'text' },
    { key: 'eraser', icon: <IconEraser size={15} />, label: t('tb.eraser'), onClick: () => onToolSelect('eraser'), active: activeTool === 'eraser', opts: 'eraser' },
    { key: 'markup', icon: <IconTextMarkup size={15} />, label: t('tb.markup'), onClick: () => onMarkupSelect(activeMarkup ? null : markupType), active: !!activeMarkup, opts: 'markup' },
    { key: 'marker', icon: <IconMarker size={15} />, label: t('tb.marker'), onClick: () => onToolSelect(activeTool === 'marker' ? null : 'marker'), active: activeTool === 'marker', opts: 'marker' },
    { key: 'pen', icon: <IconPen size={15} />, label: t('tb.pen'), onClick: () => onToolSelect(activeTool === 'pen' ? null : 'pen'), active: activeTool === 'pen', opts: 'pen' },
    { key: 'present', icon: <IconPresent size={15} />, label: t('tb.present'), onClick: onPresent },
    { key: 'fullscreen', icon: <IconFullscreen size={15} />, label: t('tb.fullscreen'), onClick: onToggleFullscreen },
    { key: 'redo', icon: <IconRedo size={15} />, label: t('tb.redo'), onClick: onRedo, disabled: !canRedo },
    { key: 'undo', icon: <IconUndo size={15} />, label: t('tb.undo'), onClick: onUndo, disabled: !canUndo },
    { key: 'forward', icon: <IconArrowRight size={15} />, label: t('tb.forward'), onClick: onNavForward, disabled: !canNavForward },
    { key: 'back', icon: <IconArrowLeft size={15} />, label: t('tb.back'), onClick: onNavBack, disabled: !canNavBack },
    { key: 'search', icon: <IconSearch size={15} />, label: t('tb.search'), onClick: onToggleSearch },
    { key: 'ai', icon: <IconSparkle size={15} />, label: t('ai.assistant'), onClick: onToggleAi, active: aiOpen }
  ]
  const maxHidden = overflowActions.length
  const hiddenKeys = new Set(overflowActions.slice(0, Math.min(hiddenCount, maxHidden)).map((a) => a.key))
  const inline = (key: string): boolean => !hiddenKeys.has(key)
  const hiddenActions = overflowActions.filter((a) => hiddenKeys.has(a.key))

  // Fold one more secondary button away when the toolbar overflows; bring one
  // back when the flex spacer has grown enough that it would fit (>46px slack =
  // hysteresis so it can't oscillate). Chromium-only app, so scrollWidth vs
  // clientWidth is a reliable overflow signal.
  const measureOverflow = (): void => {
    const el = toolbarRef.current
    if (!el) return
    if (el.scrollWidth > el.clientWidth + 1) {
      setHiddenCount((h) => Math.min(h + 1, maxHidden))
    } else if ((spacerRef.current?.offsetWidth ?? 0) > 46) {
      setHiddenCount((h) => Math.max(h - 1, 0))
    }
  }
  const measureRef = useRef(measureOverflow)
  measureRef.current = measureOverflow

  // Runs after EVERY render: the toolbar's own width doesn't change when its
  // CONTENT does (document loads → page count appears, zoom text, tool state),
  // so a ResizeObserver alone never fires for those — this catches them and
  // converges (each pass folds/unfolds at most one button, then no-ops).
  useLayoutEffect(() => {
    measureRef.current()
  })

  // Available-width changes (window resize, side panels opening/closing) don't
  // necessarily re-render the toolbar, so observe its box directly too.
  useEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureRef.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (hiddenActions.length === 0) setOverflowMenuOpen(false)
  }, [hiddenActions.length])

  useDismissable(overflowMenuRef, overflowMenuOpen, closeOverflowMenu, NO_ESCAPE)

  /** Touch routing while a tool is armed — «fingeren tegner» vs «fingeren
   *  blar». One global setting, offered in every tool menu (the decision is
   *  about the hand, not the tool) and only on devices that have touch. */
  const fingerRow = !HAS_TOUCH ? null : (
    <>
      <div className="theme-menu-label">{t('tb.finger')}</div>
      <div className="scope-options">
        {([true, false] as const).map((draws) => (
          <button
            key={String(draws)}
            className={`scope-option${fingerDraws === draws ? ' selected' : ''}`}
            onClick={() => onFingerDrawsChange(draws)}
          >
            <strong>{t(draws ? 'tb.fingerDraws' : 'tb.fingerNavigates')}</strong>
            <span>{t(draws ? 'tb.fingerDrawsHint' : 'tb.fingerNavigatesHint')}</span>
          </button>
        ))}
      </div>
    </>
  )

  /** Colour + width + opacity for pen/marker/shape, with a quiet reset */
  const drawToolMenu = (tool: DrawPrefKey): React.JSX.Element => {
    const pref = toolPrefs[tool]
    return (
      <div className="tool-menu">
        <div className="theme-menu-label">
          {tool === 'pen' ? t('tb.pen') : tool === 'marker' ? t('tb.marker') : t('tb.shapes')}
        </div>
        {tool === 'shape' && (
          <div className="shape-row">
            {SHAPE_TOOL_TYPES.map((shape) => {
              const Icon = SHAPE_ICONS[shape]
              return (
                <button
                  key={shape}
                  className={`tb-btn shape-pick${activeTool === shape ? ' is-active' : ''}`}
                  title={t(SHAPE_LABEL_KEYS[shape])}
                  onClick={() => onToolSelect(activeTool === shape ? null : shape)}
                >
                  <Icon />
                </button>
              )
            })}
          </div>
        )}
        {/* Pen and shapes draw THIN opaque lines, where the highlighter pastels
            wash out; the marker IS a highlighter and keeps them. PEN_COLORS is
            the pen case — black, red, green, yellow, blue — and not the markup
            palette these borrowed until v0.36.0, which had no black in it. */}
        <div className="color-row">
          {(tool === 'marker' ? HIGHLIGHT_COLORS : PEN_COLORS).map((c) => (
            <button
              key={c.hex}
              className={`color-dot${pref.color.join() === c.rgb.join() ? ' selected' : ''}`}
              style={{ background: c.hex }}
              title={colorLabel(c)}
              onClick={() => onToolPrefChange(tool, { color: c.rgb })}
            />
          ))}
        </div>
        <div className="theme-menu-label slider-label">
          {t('tb.width')}
          <output>{pref.width.toFixed(1)} pt</output>
        </div>
        <input
          type="range"
          min={TOOL_WIDTH_MIN}
          max={TOOL_WIDTH_MAX[tool]}
          step={TOOL_WIDTH_STEP}
          value={pref.width}
          onChange={(e) => onToolPrefChange(tool, { width: Number(e.target.value) })}
          aria-label={t('tb.strokeWidth')}
        />
        <div className="theme-menu-label slider-label">
          {t('tb.opacity')}
          <output>{pct(pref.opacity)}</output>
        </div>
        <input
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          value={pref.opacity}
          onChange={(e) => onToolPrefChange(tool, { opacity: Number(e.target.value) })}
          aria-label={t('tb.opacity')}
        />
        {/* SPEC's two pen presets — fixed width and pressure-sensitive. Only
            offered once a pen has actually been seen on this machine. */}
        {tool === 'pen' && penSeen && (
          <>
            <div className="theme-menu-label">{t('tb.penPressureLabel')}</div>
            <div className="scope-options">
              {([true, false] as const).map((sensitive) => (
                <button
                  key={String(sensitive)}
                  className={`scope-option${penPressure === sensitive ? ' selected' : ''}`}
                  onClick={() => onPenPressureChange(sensitive)}
                >
                  <strong>{t(sensitive ? 'tb.penPressureOn' : 'tb.penPressureOff')}</strong>
                  <span>{t(sensitive ? 'tb.penPressureOnHint' : 'tb.penPressureOffHint')}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {fingerRow}
        <ResetLink
          hidden={toolPrefIsDefault(tool, pref)}
          onClick={() => onToolPrefReset(tool)}
        />
      </div>
    )
  }

  /** The signature menu: the saved signatures as pictures (you recognise your
   *  own handwriting far faster than any label), plus a way to draw another. */
  const signatureMenu = (
    <div className="tool-menu signature-menu">
      {signatures.length === 0 ? (
        <p className="signature-menu-empty">{t('sig.none')}</p>
      ) : (
        <div className="signature-list">
          {signatures.map((s) => (
            <div key={s.id} className="signature-row">
              <button
                className="signature-choice"
                onClick={() => {
                  onSignaturePick(s.id)
                  setToolMenu(null)
                }}
                title={t('sig.place')}
              >
                <img src={s.dataUrl} alt={t('sig.saved')} />
              </button>
              <button
                className="signature-delete"
                onClick={() => onSignatureDelete(s.id)}
                title={t('sig.delete')}
                aria-label={t('sig.delete')}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        className="signature-draw"
        onClick={() => {
          onSignatureDraw()
          setToolMenu(null)
        }}
      >
        {t('sig.drawNew')}
      </button>
    </div>
  )

  /** The option popover for whichever tool has its menu open — colour, width,
   *  the shape picker, the eraser's scope, the text face, the signature list.
   *
   *  Lifted out of the tool row so it can be rendered in EITHER anchor. A tool
   *  that has folded into the "…" menu has no inline button for this to hang
   *  under, and until now that meant its options were simply gone until you
   *  widened the window — with «Figurer» the worst of it, since that button IS
   *  its menu and the folded row silently drew a rectangle instead. */
  const toolPopover =toolMenu === 'signature' ? (
            signatureMenu
          ) : toolMenu === 'markup' ? (
            <div className="tool-menu">
              <div className="theme-menu-label">{t('tb.markup')}</div>
              <div className="markup-grid">
                {MARKUP_TOOL_TYPES.map((m) => {
                  const Icon = MARKUP_ICONS[m]
                  return (
                    <button
                      key={m}
                      className={`markup-option${activeMarkup === m ? ' selected' : ''}`}
                      onClick={() => {
                        setMarkupType(m)
                        onMarkupSelect(m)
                      }}
                    >
                      <Icon size={16} />
                      <span>{annotTypeLabel(m)}</span>
                    </button>
                  )
                })}
              </div>
              <div className="color-row">
                {(markupType === 'highlight' ? HIGHLIGHT_COLORS : UNDERLINE_COLORS).map((c) =>
                  markupType === 'highlight' ? (
                    <button
                      key={c.hex}
                      className={`color-dot${markupPrefs[markupType].color.join() === c.rgb.join() ? ' selected' : ''}`}
                      style={{ background: c.hex }}
                      title={colorLabel(c)}
                      onClick={() => onMarkupPrefChange(markupType, { color: c.rgb })}
                    />
                  ) : (
                    <button
                      key={c.hex}
                      className={`color-bar${markupPrefs[markupType].color.join() === c.rgb.join() ? ' selected' : ''}`}
                      title={colorLabel(c)}
                      onClick={() => onMarkupPrefChange(markupType, { color: c.rgb })}
                    >
                      <span style={{ background: c.hex }} />
                    </button>
                  )
                )}
              </div>
              <div className="theme-menu-label slider-label">
                {t('tb.opacity')}
                <output>{pct(markupPrefs[markupType].opacity)}</output>
              </div>
              <input
                type="range"
                min={OPACITY_MIN}
                max={OPACITY_MAX}
                step={OPACITY_STEP}
                value={markupPrefs[markupType].opacity}
                onChange={(e) => onMarkupPrefChange(markupType, { opacity: Number(e.target.value) })}
                aria-label={t('tb.opacity')}
              />
              <ResetLink
                hidden={markupPrefIsDefault(markupType, markupPrefs[markupType])}
                onClick={() => onMarkupPrefReset(markupType)}
              />
            </div>
          ) : toolMenu === 'text' ? (
            <div className="tool-menu">
              <div className="theme-menu-label">{t('tb.textTool')}</div>
              <div className="color-row">
                {FREETEXT_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    className={`color-dot${textPref.color.join() === c.rgb.join() ? ' selected' : ''}`}
                    style={{ background: c.hex }}
                    title={colorLabel(c)}
                    onClick={() => onTextPrefChange({ color: c.rgb })}
                  />
                ))}
              </div>
              <div className="theme-menu-label slider-label">
                {t('tb.fontSize')}
                <output>{textPref.fontSize} pt</output>
              </div>
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                value={textPref.fontSize}
                onChange={(e) => onTextPrefChange({ fontSize: Number(e.target.value) })}
                aria-label={t('tb.fontSize')}
              />
              {/* A real typeface choice, and only the PDF's own Standard 14 —
                  those need no embedding, so the words stay searchable text in
                  the file and look the same in every reader. Each chip is set
                  IN its own face: the sample is the label. */}
              <div className="theme-menu-label">{t('tb.textFont')}</div>
              <div className="font-row">
                {TEXT_FONT_FAMILIES.map((family) => {
                  const parts = textFontParts(textPref.font)
                  const face = textFontOf(family, parts.bold, parts.italic)
                  return (
                    <button
                      key={family}
                      className={`font-chip${parts.family === family ? ' selected' : ''}`}
                      style={textFontCss(face)}
                      onClick={() => onTextPrefChange({ font: face })}
                    >
                      {family}
                    </button>
                  )
                })}
              </div>
              <div className="font-style-row">
                {([
                  ['bold', 'tb.textBold'],
                  ['italic', 'tb.textItalic']
                ] as const).map(([which, tip]) => {
                  const parts = textFontParts(textPref.font)
                  const on = which === 'bold' ? parts.bold : parts.italic
                  return (
                    <button
                      key={which}
                      className={`font-style font-style-${which}${on ? ' selected' : ''}`}
                      title={t(tip)}
                      aria-pressed={on}
                      onClick={() =>
                        onTextPrefChange({
                          font: textFontOf(
                            parts.family,
                            which === 'bold' ? !parts.bold : parts.bold,
                            which === 'italic' ? !parts.italic : parts.italic
                          )
                        })
                      }
                    >
                      A
                    </button>
                  )
                })}
              </div>
              <div className="menu-hint">{t('tb.textMoveHint')}</div>
              <ResetLink hidden={textPrefIsDefault(textPref)} onClick={onTextPrefReset} />
            </div>
          ) : toolMenu === 'eraser' ? (
            <div className="tool-menu">
              <div className="theme-menu-label">{t('tb.eraser')}</div>
              <div className="scope-options">
                {(['draw', 'all'] as const).map((scope) => (
                  <button
                    key={scope}
                    className={`scope-option${eraserScope === scope ? ' selected' : ''}`}
                    onClick={() => onEraserScopeChange(scope)}
                  >
                    <strong>{t(scope === 'draw' ? 'tb.eraserScopeDraw' : 'tb.eraserScopeAll')}</strong>
                    <span>
                      {t(scope === 'draw' ? 'tb.eraserScopeDrawHint' : 'tb.eraserScopeAllHint')}
                    </span>
                  </button>
                ))}
              </div>
              {fingerRow}
              <ResetLink
                hidden={eraserScope === 'draw'}
                onClick={() => onEraserScopeChange('draw')}
              />
            </div>
          ) : toolMenu ? (
            drawToolMenu(toolMenu)
          ) : null

  return (
    <div className="toolbar" ref={toolbarRef}>
      <div className="toolbar-group">
        {/* Back to the library. It moved here from the tab strip (Emil,
            2026-08-09) so the strip holds nothing but tabs — and so it is
            reachable in fullscreen, where the strip is tucked but the toolbar
            comes back on hover.
            The tooltip is unconditional again, because the button finally does
            one thing. It used to be wired to «close this tab», so with several
            documents open it closed one and dropped you in the next — never in
            the library — and the label switched to «Close this document» to
            stop lying about it. The library is a PLACE now (App.tsx), so going
            there closes nothing and the one label is true in every case. */}
        <button className="tb-btn" onClick={onLeaveDocument} title={t('tb.libraryTip')}>
          <IconChevronLeft size={17} />
        </button>
        {/* «Innhold» lost its label: the panel holds thumbnails, contents,
            bookmarks AND notes, so the word described a quarter of it (Emil's
            observation). The left edge rail is already an icon for the same
            panel, which made the label doubly redundant. */}
        <button
          className={`tb-btn${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title={withShortcut(t('tb.sidebarTip'), 'panel.toc')}
        >
          <IconSidebar />
        </button>
        <div className="toolbar-sep" />
        {inline('back') && (
          <button className="tb-btn" onClick={onNavBack} disabled={!canNavBack} title={withShortcut(t('tb.navBackTip'), 'nav.back')}>
            <IconArrowLeft />
          </button>
        )}
        {inline('forward') && (
          <button
            className="tb-btn"
            onClick={onNavForward}
            disabled={!canNavForward}
            title={withShortcut(t('tb.navForwardTip'), 'nav.forward')}
          >
            <IconArrowRight />
          </button>
        )}

        <div className="toolbar-sep" />

        <div className="tool-group" ref={toolMenuRef}>
          {(['pen', 'marker'] as const)
            .filter((tool) => inline(tool))
            .map((tool) => (
            <span className="tb-split" key={tool}>
              <button
                className={`tb-btn${activeTool === tool ? ' is-active' : ''}`}
                onClick={() => selectTool(tool)}
                title={tool === 'pen' ? t('tb.penTip') : t('tb.markerTip')}
              >
                {tool === 'pen' ? <IconPen /> : <IconMarker />}
              </button>
              <button
                className={`tb-chevron${toolMenu === tool ? ' is-active' : ''}`}
                title={t('tb.toolOptionsTip')}
                onClick={() => {
                  if (activeTool !== tool) onToolSelect(tool)
                  setToolMenu((m) => (m === tool ? null : tool))
                }}
              >
                <IconChevronDown size={11} />
              </button>
            </span>
          ))}
          {inline('markup') && (
            <span className="tb-split">
              <button
                className={`tb-btn${activeMarkup ? ' is-active' : ''}`}
                onClick={() => onMarkupSelect(activeMarkup ? null : markupType)}
                title={t('tb.markupTip')}
              >
                <IconTextMarkup />
              </button>
              <button
                className={`tb-chevron${toolMenu === 'markup' ? ' is-active' : ''}`}
                title={t('tb.markupOptionsTip')}
                onClick={() => {
                  if (!activeMarkup) onMarkupSelect(markupType)
                  setToolMenu((m) => (m === 'markup' ? null : 'markup'))
                }}
              >
                <IconChevronDown size={11} />
              </button>
            </span>
          )}
          {inline('shapes') && (
            <button
              className={`tb-btn${shapeActive ? ' is-active' : ''}`}
              onClick={() => setToolMenu((m) => (m === 'shape' ? null : 'shape'))}
              title={t('tb.shapesTip')}
            >
              <IconShapes />
            </button>
          )}
          {inline('text') && (
            <span className="tb-split">
              <button
                className={`tb-btn${activeTool === 'text' ? ' is-active' : ''}`}
                onClick={() => onToolSelect(activeTool === 'text' ? null : 'text')}
                title={t('tb.textTip')}
              >
                <IconText />
              </button>
              <button
                className={`tb-chevron${toolMenu === 'text' ? ' is-active' : ''}`}
                title={t('tb.textOptionsTip')}
                onClick={() => {
                  if (activeTool !== 'text') onToolSelect('text')
                  setToolMenu((m) => (m === 'text' ? null : 'text'))
                }}
              >
                <IconChevronDown size={11} />
              </button>
            </span>
          )}
          {inline('note') && (
            <button
              className={`tb-btn${noteActive ? ' is-active' : ''}`}
              onClick={onToggleNote}
              title={withShortcut(t('tb.noteTip'), 'tool.note')}
            >
              <IconNote />
            </button>
          )}
          {inline('signature') && (
            <span className="tb-split">
              {/* One click does the obvious thing: arm the signature you have,
                  or open the pad if you have none yet. The chevron is for
                  choosing between several, and for drawing another. */}
              <button
                className={`tb-btn${signatureActive ? ' is-active' : ''}`}
                onClick={onSignaturePrimary}
                title={withShortcut(t('tb.signatureTip'), 'tool.signature')}
              >
                <IconSignature />
              </button>
              <button
                className={`tb-chevron${toolMenu === 'signature' ? ' is-active' : ''}`}
                title={t('tb.signatureOptionsTip')}
                onClick={() => setToolMenu((m) => (m === 'signature' ? null : 'signature'))}
              >
                <IconChevronDown size={11} />
              </button>
            </span>
          )}

          {/* Eraser + undo/redo share one section: all three are "take that
              mark back again", so they belong between the same dividers. */}
          <div className="toolbar-sep" />

          {inline('eraser') && (
            <span className="tb-split">
              <button
                className={`tb-btn${activeTool === 'eraser' ? ' is-active' : ''}`}
                onClick={() => selectTool('eraser')}
                title={eraserScope === 'all' ? t('tb.eraserAllTip') : t('tb.eraserTip')}
              >
                <IconEraser />
              </button>
              <button
                className={`tb-chevron${toolMenu === 'eraser' ? ' is-active' : ''}`}
                title={t('tb.eraserOptionsTip')}
                onClick={() => setToolMenu((m) => (m === 'eraser' ? null : 'eraser'))}
              >
                <IconChevronDown size={11} />
              </button>
            </span>
          )}
          {inline('undo') && (
            <button className="tb-btn" onClick={onUndo} disabled={!canUndo} title={withShortcut(t('tb.undoTip'), 'edit.undo')}>
              <IconUndo />
            </button>
          )}
          {inline('redo') && (
            <button className="tb-btn" onClick={onRedo} disabled={!canRedo} title={withShortcut(t('tb.redoTip'), 'edit.redo')}>
              <IconRedo />
            </button>
          )}

          {toolMenu && inline(toolMenu === 'shape' ? 'shapes' : toolMenu) ? toolPopover : null}
        </div>
      </div>

      {/* Only rendered for the rare document that IS signed — see
          SignatureInfo. Sits before the spacer so it reads as a property of the
          document rather than one more tool. */}
      {signatureInfo}

      {/* Centre (freed by moving the file name to the tab strip) holds the
          reading controls: page number + zoom, flanked by flex spacers */}
      <div className="toolbar-spacer" ref={spacerRef} />

      <div className={`toolbar-group toolbar-center${splitOpen ? ' is-split' : ''}`}>
        {splitOpen && paneSwitch}
        {centerCluster(splitOpen ? activePane : 'a')}

        {/* Zoom steps + page layout, docked right beside the zoom controls they
            belong to. Zoom applies to the active column, like the cluster;
            rotation and spread are document-wide (they are persisted with the
            reading position). */}
        <div className="theme-menu-anchor" ref={viewMenuRef}>
          <button
            className={`tb-btn${viewMenuOpen ? ' is-active' : ''}`}
            onClick={() => setViewMenuOpen((o) => !o)}
            title={t('tb.viewTip')}
          >
            <IconView />
          </button>
          {viewMenuOpen && (
            <div className="theme-menu view-menu">
              {/* Everything in this menu — zoom, rotation, spread — applies to
                  the active column, so the scope is stated once, up top. */}
              {splitOpen && (
                <div className="menu-hint menu-hint-top">
                  {t(activePane === 'b' ? 'tb.zoomAppliesRight' : 'tb.zoomAppliesLeft')}
                </div>
              )}
              <div className="theme-menu-label">{t('tb.zoom')}</div>
              {/* 100 % IS "actual size" — one chip, not a chip plus a
                  separate row saying the same thing in words. */}
              <div className="zoom-preset-row">
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={`zoom-preset${activeZoom.fitMode === 'custom' && activeZoom.percent === preset ? ' selected' : ''}`}
                    title={preset === 100 ? withShortcut(t('tb.actualSizeTip'), 'zoom.actual') : undefined}
                    onClick={() => activeZoom.zoomTo(preset)}
                  >
                    {preset} %
                  </button>
                ))}
              </div>
              <button
                className={`menu-action${activeZoom.fitMode === 'width' ? ' is-active' : ''}`}
                onClick={activeZoom.fitWidth}
              >
                <IconFitWidth size={15} />
                {t('tb.fitWidth')}
              </button>
              <button
                className={`menu-action${activeZoom.fitMode === 'page' ? ' is-active' : ''}`}
                onClick={activeZoom.fitPage}
              >
                <IconFitPage size={15} />
                {t('tb.fitPage')}
              </button>

              <div className="theme-menu-sep" />

              <div className="theme-menu-label">{t('tb.pageLayout')}</div>
              <div className="theme-auto-row">
                <span className="view-row-label">{t('tb.rotate')}</span>
                <span className="view-row-controls">
                  <button className="tb-btn" onClick={() => onRotate(-1)} title={withShortcut(t('tb.rotateCcwTip'), 'view.rotateLeft')}>
                    <IconRotateCcw />
                  </button>
                  <button className="tb-btn" onClick={() => onRotate(1)} title={withShortcuts(t('tb.rotateCwTip'), 'view.rotateRight')}>
                    <IconRotateCw />
                  </button>
                </span>
              </div>
              <label className="theme-menu-toggle view-row-toggle">
                <input type="checkbox" checked={spread} onChange={onToggleSpread} />
                <IconSpread size={15} />
                {t('tb.spread')}
              </label>
              {/* Sub-option, meaningless on its own — greyed out rather than
                  hidden so the layout choice stays discoverable */}
              <label
                className={`theme-menu-toggle view-row-toggle view-row-sub${spread ? '' : ' is-disabled'}`}
              >
                <input
                  type="checkbox"
                  checked={coverPage}
                  disabled={!spread}
                  onChange={onToggleCoverPage}
                />
                <IconCoverPage size={15} />
                {t('tb.coverPage')}
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        {inline('search') && (
          <button className="tb-btn" onClick={onToggleSearch} title={withShortcut(t('tb.searchTip'), 'search.open')}>
            <IconSearch />
          </button>
        )}

        {READ_ALOUD && inline('readaloud') && (
          <button
            className={`tb-btn${readAloudOpen ? ' is-active' : ''}`}
            onClick={onToggleReadAloud}
            title={t('tb.readAloudTip')}
          >
            <IconSpeaker />
          </button>
        )}

        <div className="toolbar-sep" />

        {/* Everything that sends the document OUT of the app lives under this
            one button: save, save a copy, print — and, for a file living in a
            Zotero library, the Zotero section (reveal the item, copy its
            citation): a citation headed for a manuscript and a hand-off to the
            Zotero client qualify the same way print does. Print used to be its own icon
            and was one of the first three to fold into "…" at any normal window
            width — a top-five action, in a menu, by accident (Emil, 2026-08-09).
            It costs a click here, which a thing nobody does twice a minute can
            afford, and Ctrl+P is untouched. The browser branch gets the same
            split button rather than a lone Save, or print would exist on one
            platform and not the other. */}
        {(() => {
          const printRow = (
            <button
              className="menu-action"
              onClick={() => {
                setSaveMenuOpen(false)
                onPrint()
              }}
              title={withShortcut(t('tb.printTip'), 'file.print')}
            >
              <IconPrint size={15} />
              {t('tb.print')}
            </button>
          )
          // Zotero rows, only for a file living in Zotero's storage layout.
          // They belong in this menu because it is the document's out-of-the-app
          // surface (save a copy, print) — a citation headed for a manuscript
          // and a hand-off to the Zotero client both qualify. The section is on
          // the canSaveInPlace branch alone: dev:web paths are basenames/URLs,
          // so the detection can never match there anyway.
          const zInfo =
            zoteroFetch.result && !('error' in zoteroFetch.result) ? zoteroFetch.result : null
          const zErr =
            zoteroFetch.result && 'error' in zoteroFetch.result ? zoteroFetch.result : null
          const zoteroSection = zoteroKey ? (
            <>
              <div className="theme-menu-sep" />
              <div className="theme-menu-label">Zotero</div>
              {(zoteroFetch.loading || zInfo || zErr) && (
                <div className="menu-hint">
                  {zoteroFetch.loading
                    ? t('zotero.loading')
                    : zErr
                      ? errorText(zErr)
                      : zInfo
                        ? zoteroLine(zInfo)
                        : ''}
                </div>
              )}
              <button
                className="menu-action"
                onClick={() => {
                  void bridge.zoteroSelect(filePath).then((r) => {
                    if (r && 'error' in r) setZoteroFetch({ loading: false, result: r })
                    else setSaveMenuOpen(false)
                  })
                }}
              >
                <IconBook size={15} />
                {t('zotero.show')}
              </button>
              <button
                className="menu-action"
                disabled={!zInfo?.citation}
                onClick={() => zInfo && zoteroCopy('citation', zInfo.citation)}
              >
                <IconCopy size={15} />
                {zoteroCopied === 'citation' ? t('doc.copied') : t('zotero.copyCitation')}
              </button>
              <button
                className="menu-action"
                disabled={!zInfo?.bib}
                onClick={() => zInfo && zoteroCopy('bib', zInfo.bib)}
              >
                <IconCopy size={15} />
                {zoteroCopied === 'bib' ? t('doc.copied') : t('zotero.copyReference')}
              </button>
            </>
          ) : null
          const chevron = (
            <button
              className={`tb-chevron${saveMenuOpen ? ' is-active' : ''}`}
              title={t('tb.saveOptionsTip')}
              aria-label={t('tb.saveOptionsTip')}
              onClick={() => setSaveMenuOpen((o) => !o)}
            >
              <IconChevronDown size={11} />
            </button>
          )
          return canSaveInPlace ? (
            /* Desktop + extension: write changes back to the file in place, plus
               save-a-copy. The extension's first in-place save may prompt once
               for write access, then stays silent (see extension-api.ts).
               Saving a copy of an UNCHANGED file is legitimate, so the chevron
               stays live even while the primary button is disabled. */
            <span className="tb-split theme-menu-anchor" ref={saveMenuRef}>
              <button
                className={`tb-btn tb-save${dirty ? ' has-changes' : ''}`}
                onClick={onSave}
                disabled={!dirty}
                title={withShortcut(t('tb.saveTip'), 'file.save')}
              >
                <IconSave />
              </button>
              {chevron}
              {/* Quiet marker: this document lives in a Zotero library, and the
                  menu behind the chevron carries its Zotero actions */}
              {zoteroKey && (
                <span className="tb-zotero-badge" aria-hidden="true">
                  Z
                </span>
              )}
              {saveMenuOpen && (
                <div className="theme-menu save-menu">
                  <button
                    className="menu-action"
                    onClick={() => {
                      setSaveMenuOpen(false)
                      onSaveAs()
                    }}
                    title={withShortcut(t(isElectron ? 'tb.saveAsTip' : 'tb.saveCopyTip'), 'file.saveAs')}
                  >
                    <IconSaveAs size={15} />
                    {isElectron ? t('tb.saveAs') : t('tb.saveCopy')}
                  </button>
                  {printRow}
                  {zoteroSection}
                </div>
              )}
            </span>
          ) : (
            // The PLAIN-WEB preview only (npm run dev:web). Not the extension:
            // canSaveInPlace is `isElectron || isExtension`, so the extension
            // takes the branch above and does offer «save a copy» — this
            // comment claimed otherwise until Emil opened the menu in a real
            // browser and saw both rows (2026-08-09).
            // One Save that bakes annotations in, then overwrites the local
            // file (opened from disk) or downloads (URL). Nothing to copy to,
            // so the menu holds print alone.
            <span className="tb-split theme-menu-anchor" ref={saveMenuRef}>
              <button
                className={`tb-btn tb-save${dirty ? ' has-changes' : ''}`}
                onClick={onSave}
                title={withShortcut(t('tb.saveToDiskTip'), 'file.save')}
              >
                <IconSaveAs />
              </button>
              {chevron}
              {saveMenuOpen && <div className="theme-menu save-menu">{printRow}</div>}
            </span>
          )
        })()}

        <div className="toolbar-sep" />

        {/* Reading mode: how the PAPER looks (theme + page recolouring) */}
        <div className="theme-menu-anchor" ref={themeMenuRef}>
          <button
            className={`tb-btn${themeMenuOpen ? ' is-active' : ''}`}
            onClick={() => setThemeMenuOpen((o) => !o)}
            title={t('tb.readingModeTip')}
          >
            <IconTextSettings />
          </button>
          {themeMenuOpen && (
            <div className="theme-menu">
              <div className="theme-menu-label">{t('tb.readingMode')}</div>
              <div className="theme-options">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    className={`theme-option theme-${theme.id}${settings.theme === theme.id ? ' selected' : ''}`}
                    onClick={() => onSettingsChange({ theme: theme.id })}
                  >
                    Aa
                    <span>{t(theme.labelKey)}</span>
                  </button>
                ))}
              </div>

              {settings.theme === 'auto' && (
                <div className="theme-auto-prefs">
                  <div className="theme-auto-row">
                    <span className="theme-auto-label">{t('tb.autoLight')}</span>
                    <div className="theme-auto-choices">
                      {(['day', 'sepia'] as const).map((id) => (
                        <button
                          key={id}
                          className={`theme-chip theme-${id}${settings.autoLight === id ? ' selected' : ''}`}
                          onClick={() => onSettingsChange({ autoLight: id })}
                        >
                          {t(id === 'day' ? 'tb.themeDay' : 'tb.themeSepia')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="theme-auto-row">
                    <span className="theme-auto-label">{t('tb.autoDark')}</span>
                    <div className="theme-auto-choices">
                      {(['night', 'nightHc'] as const).map((id) => (
                        <button
                          key={id}
                          className={`theme-chip theme-${id}${settings.autoDark === id ? ' selected' : ''}`}
                          onClick={() => onSettingsChange({ autoDark: id })}
                        >
                          {t(id === 'night' ? 'tb.themeNight' : 'tb.themeNightHc')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="theme-auto-hint">{t('tb.autoHint')}</div>
                </div>
              )}

              {/* Paper tone — only while the custom theme is the chosen one */}
              {settings.theme === 'custom' && (
                <div className="theme-auto-prefs">
                  <div className="theme-auto-row">
                    <span className="theme-auto-label">{t('tb.customTone')}</span>
                    <div className="theme-auto-choices">
                      {CUSTOM_TONE_ORDER.map((tone) => (
                        <button
                          key={tone}
                          className={`tone-chip${settings.customTone === tone ? ' selected' : ''}`}
                          style={{ background: customToneCss(tone, 1).bg }}
                          onClick={() => onSettingsChange({ customTone: tone })}
                        >
                          {t(TONE_LABELS[tone])}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Intensity — only the themes with an axis worth dialling
                  (sepia: paper warmth, night: brightness, custom: tone
                  strength). Follows the RESOLVED theme so auto-sepia is
                  tunable too. 100 % = the shipped look, exactly. */}
              {(resolvedTheme === 'sepia' ||
                resolvedTheme === 'night' ||
                resolvedTheme === 'custom') &&
                (() => {
                  const key = resolvedTheme
                  const range = TUNE_RANGE[key]
                  const stored = settings.themeTune[key]
                  const value = tuneDraft ?? (Number.isFinite(stored) ? stored : 1)
                  const commit = (v: number): void => {
                    setTuneDraft(null)
                    if (v !== stored) onSettingsChange({ themeTune: { ...settings.themeTune, [key]: v } })
                  }
                  return (
                    <div className="theme-tune">
                      <div className="slider-label">
                        <span title={t('tb.intensityTip')}>{t('tb.intensity')}</span>
                        <output>{pct(value)}</output>
                      </div>
                      <input
                        type="range"
                        min={range.min}
                        max={range.max}
                        step={0.05}
                        value={value}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          setTuneDraft(v)
                          applyPageTune(
                            resolvedTheme,
                            { ...settings.themeTune, [key]: v },
                            settings.customTone
                          )
                        }}
                        onPointerUp={() => tuneDraft != null && commit(tuneDraft)}
                        onKeyUp={() => tuneDraft != null && commit(tuneDraft)}
                        onBlur={() => tuneDraft != null && commit(tuneDraft)}
                      />
                      <ResetLink hidden={value === 1} onClick={() => commit(1)} />
                    </div>
                  )
                })()}

              <div className="theme-menu-sep" />

              {/* Both of these shape the READING experience rather than the
                  app's plumbing, so they sit with the themes and leave the gear
                  menu to the technical things. */}
              <label
                className="theme-menu-toggle"
                title={annotsHidden ? t('tb.showAnnotsTip') : t('tb.hideAnnotsTip')}
              >
                <input type="checkbox" checked={annotsHidden} onChange={onToggleAnnots} />
                {annotsHidden ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                {t('tb.hideAnnots')}
              </label>
              {/* Night themes invert the whole page raster — this repaints the
                  picture regions in their original colours. Only offered while
                  a night theme is what the reader sees: in day/sepia nothing
                  is inverted, so the toggle would be a no-op checkbox. */}
              {(resolvedTheme === 'night' || resolvedTheme === 'nightHc') && (
                <label className="theme-menu-toggle" title={t('tb.keepImageColorsTip')}>
                  <input
                    type="checkbox"
                    checked={settings.nightKeepImages}
                    onChange={(e) => onSettingsChange({ nightKeepImages: e.target.checked })}
                  />
                  {t('tb.keepImageColors')}
                </label>
              )}
              <label className="theme-menu-toggle">
                <input
                  type="checkbox"
                  checked={settings.keepAwake}
                  onChange={(e) => onSettingsChange({ keepAwake: e.target.checked })}
                />
                {t('tb.keepAwake')}
              </label>
            </div>
          )}
        </div>

        {/* No margin-comments toggle here (Emil, 2026-08-09). The switch — and
            the left/right choice that belongs with it — already live in the
            notes tab, which is the one home for everything comment-related; this
            was a second copy of a control that was never in the wrong place. */}
        {inline('split') && (
          <button
            className={`tb-btn${splitOpen ? ' is-active' : ''}`}
            onClick={onToggleSplit}
            title={withShortcut(t('tb.splitTip'), 'view.split')}
          >
            <IconSplit />
          </button>
        )}
        {inline('present') && (
          <button className="tb-btn" onClick={onPresent} title={withShortcut(t('tb.presentTip'), 'view.present')}>
            <IconPresent />
          </button>
        )}
        {inline('pin') && (
          <button
            className={`tb-btn${toolbarPinned ? '' : ' is-active'}`}
            onClick={onTogglePin}
            title={withShortcut(t(toolbarPinned ? 'tb.unpinTip' : 'tb.pinTip'), 'view.togglePin')}
          >
            {toolbarPinned ? <IconPin /> : <IconPinOff />}
          </button>
        )}
        {inline('fullscreen') && (
          <button className="tb-btn" onClick={onToggleFullscreen} title={withShortcuts(t('tb.fullscreenTip'), 'view.fullscreen')}>
            <IconFullscreen />
          </button>
        )}

        <div className="toolbar-sep" />

        <div className="theme-menu-anchor" ref={settingsMenuRef}>
          <button
            className={`tb-btn${settingsMenuOpen ? ' is-active' : ''}`}
            onClick={() => setSettingsMenuOpen((o) => !o)}
            title={t('tb.settingsTip')}
          >
            <IconGear />
          </button>
          {settingsMenuOpen && (
            <div className="theme-menu settings-menu">
              <div className="theme-menu-label">{t('tb.language')}</div>
              <div className="lang-options">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    className={`lang-option${settings.language === lang.id ? ' selected' : ''}`}
                    onClick={() => onSettingsChange({ language: lang.id })}
                  >
                    {lang.id === 'auto' ? t('tb.langAuto') : lang.label}
                  </button>
                ))}
              </div>

              <div className="theme-menu-sep" />

              {/* Author (/T) written into new annotations — the standard PDF
                  field other readers show as the commenter. No accounts, so
                  the name is simply typed once; empty = unsigned. The detail
                  lives in the hover title, not a permanent paragraph — the
                  label + placeholder carry enough on their own (standing
                  hover-hints preference). */}
              <div className="theme-menu-label" title={t('settings.annotAuthorHint')}>
                {t('settings.annotAuthor')}
              </div>
              <input
                className="annot-author-input"
                defaultValue={settings.annotAuthor}
                placeholder={t('settings.annotAuthorPlaceholder')}
                title={t('settings.annotAuthorHint')}
                spellCheck={false}
                onKeyDown={(e) => {
                  // Even in a menu: Ctrl+S from here should still save
                  if (bubblesWhileTyping(e)) return
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                }}
                onBlur={(e) => {
                  const name = e.target.value.trim()
                  if (name !== settings.annotAuthor) onSettingsChange({ annotAuthor: name })
                }}
              />

              <div className="theme-menu-sep" />

              <button
                className="menu-action"
                onClick={() => {
                  setSettingsMenuOpen(false)
                  onOpenAiSettings()
                }}
              >
                <IconSparkle size={15} />
                {t('ai.keysTitle')}
              </button>
              <button
                className="menu-action"
                title={t('keys.openTip')}
                onClick={() => {
                  setSettingsMenuOpen(false)
                  setShortcutsOpen(true)
                }}
              >
                <IconKeyboard size={15} />
                {t('keys.open')}
              </button>
              {isElectron && updSupport !== undefined && updSupport !== 'store' && (
                <button className="menu-action" onClick={checkForUpdates} disabled={updChecking}>
                  <IconReload size={15} />
                  {updChecking ? t('update.checking') : t('update.check')}
                </button>
              )}
              {updOutcome && <div className="menu-hint">{updateOutcomeText(updOutcome)}</div>}

              {/* No «choose the default PDF app» entry here. It shipped in
                  v0.36.0 as a deep link to ms-settings:defaultapps and came
                  straight back out (Emil, 2026-08-08): which app opens a PDF
                  is the user's business, and a reader that raises the question
                  unprompted is already halfway to nagging. The installer's
                  «Open with» association is as far as we go. */}

              <div className="theme-menu-sep" />

              <button
                className="menu-action"
                onClick={() => {
                  setSettingsMenuOpen(false)
                  setResetAsk(true)
                }}
                title={t('reset.tip')}
              >
                <IconReset size={15} />
                {t('reset.action')}
              </button>

              <div className="theme-menu-sep" />

              {/* Bug reports and feature requests: GitHub Issues is the only
                  place they can be answered, so link straight there rather than
                  inventing an in-app form with nowhere to send it. The body is
                  prefilled with the version, which is the one thing a report
                  needs and the one thing users never think to include. */}
              <button
                className="menu-action"
                onClick={() =>
                  bridge.openExternal(
                    'https://github.com/emilmsh/pdf-scholar/issues/new?body=' +
                      encodeURIComponent(`\n\n---\nPDF Scholar ${appVersion}`)
                  )
                }
                title={t('app.feedbackTip')}
              >
                <IconComment size={15} />
                {t('app.feedback')}
              </button>

              <button
                className="menu-action"
                onClick={() => bridge.openExternal('https://github.com/sponsors/emilmsh')}
                title={t('app.sponsorTip')}
              >
                <IconHeart size={15} />
                {t('app.sponsor')}
              </button>

              <div className="theme-menu-sep" />

              <div className="menu-about">
                <span>{t('settings.about', { version: appVersion })}</span>
                <button
                  className="menu-link"
                  onClick={() => bridge.openExternal('https://github.com/emilmsh/pdf-scholar')}
                >
                  GitHub
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="toolbar-sep" />

        {/* No snip button here (Emil, 2026-08-09). "Explain a region" had THREE
            entry points: this icon, the composer button in the assistant panel,
            and right-click on the page. The composer button is the one that
            belongs — it sits where the result lands, and it is the one that can
            say why it is unavailable when the chosen model cannot read images.
            The discoverability rule is satisfied by that button, so the icon
            went rather than the bar staying a pixel wider. */}

        {/* Overflow: secondary buttons that didn't fit, folded to the LEFT of
            the (protected) Assistant button. */}
        {hiddenActions.length > 0 && (
          <div className="theme-menu-anchor" ref={overflowMenuRef}>
            <button
              className={`tb-btn${overflowMenuOpen ? ' is-active' : ''}`}
              onClick={() => setOverflowMenuOpen((o) => !o)}
              title={t('tb.more')}
              aria-label={t('tb.more')}
            >
              <IconMore />
            </button>
            {overflowMenuOpen && (
              <div className="theme-menu overflow-menu">
                {hiddenActions.map((a) => (
                  /* A row does what its inline button does. With options, that
                     means the same split: the body activates, the chevron opens
                     the menu — and the menu renders below, inside this anchor,
                     because the button it would normally hang under is exactly
                     what folded away. Picking an option keeps the "…" menu open
                     for the same reason the inline popover keeps the toolbar. */
                  <span className={`menu-action-split${a.opts ? '' : ' is-plain'}`} key={a.key}>
                    <button
                      className={`menu-action${a.active ? ' is-active' : ''}`}
                      disabled={a.disabled}
                      onClick={() => {
                        if (!a.opts) setOverflowMenuOpen(false)
                        a.onClick()
                      }}
                    >
                      {a.icon}
                      {a.label}
                    </button>
                    {a.opts && (
                      <button
                        className={`tb-chevron${toolMenu === a.opts ? ' is-active' : ''}`}
                        title={t('tb.toolOptionsTip')}
                        aria-label={t('tb.toolOptionsTip')}
                        onClick={() => setToolMenu((m) => (m === a.opts ? null : a.opts!))}
                      >
                        <IconChevronDown size={11} />
                      </button>
                    )}
                  </span>
                ))}
                {toolMenu && !inline(toolMenu === 'shape' ? 'shapes' : toolMenu) ? toolPopover : null}
              </div>
            )}
          </div>
        )}

        {inline('ai') && (
          <button
            className={`tb-btn tb-labeled${aiOpen ? ' is-active' : ''}`}
            onClick={onToggleAi}
            title={withShortcut(t('tb.aiTip'), 'panel.ai')}
          >
            <IconSparkle />
            <span className="tb-label">{t('ai.assistant')}</span>
          </button>
        )}
      </div>

      {/* Reset-to-defaults is destructive enough to deserve the same modal
          treatment as an unsaved-changes prompt — and the detail line spells
          out exactly what survives it (API keys, library, annotations). */}
      {/* The keyboard map. It owns the keyboard while recording a chord, so it
          renders as a modal over everything — see ShortcutsDialog. */}
      {shortcutsOpen && (
        <ShortcutsDialog
          onChange={(keymap) => onSettingsChange({ keymap })}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {resetAsk && (
        <div className="confirm-overlay" onMouseDown={(e) => e.stopPropagation()}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true">
            <p className="confirm-message">{t('reset.confirmMessage')}</p>
            <p className="confirm-detail">{t('reset.confirmDetail')}</p>
            <div className="confirm-actions">
              <button className="btn-secondary" onClick={() => setResetAsk(false)}>
                {t('app.cancel')}
              </button>
              <button
                className="btn-primary"
                autoFocus
                onClick={() => {
                  setResetAsk(false)
                  onResetApp()
                }}
              >
                {t('reset.confirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

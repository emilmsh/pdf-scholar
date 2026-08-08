import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  LanguagePreference,
  Settings,
  ThemePreference,
  UpdateCheckOutcome,
  UpdateUnsupportedReason
} from '../../../shared/types'
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
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import type { SavedSignature } from '../signatures'
import { READ_ALOUD } from '../flags'
import { useDismissable } from '../useDismissable'
import { updateOutcomeText } from './Welcome'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconFitPage,
  IconFitWidth,
  IconFullscreen,
  IconGear,
  IconComment,
  IconHeart,
  IconMarginNotes,
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
  IconSnip,
  IconSparkle,
  IconSplit,
  IconNote,
  IconText,
  IconTrash,
  IconTextSettings,
  IconView
} from './icons'

export type ToolName = DrawToolType

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
  onRotate(dir: 1 | -1): void
  onToggleSpread(): void
  onToolPrefChange(tool: DrawPrefKey, patch: Partial<ToolPref>): void
  onToolPrefReset(tool: DrawPrefKey): void
  /** FreeText tool look (text colour + font size) */
  textPref: TextPref
  onTextPrefChange(patch: Partial<TextPref>): void
  onTextPrefReset(): void
  onNavBack(): void
  onNavForward(): void
  onToggleSidebar(): void
  /** Leave this document. With other tabs open the next one takes over; with
   *  none, the library is what is left — which is why the tooltip says which. */
  onLeaveDocument(): void
  /** How many documents this window holds, for that tooltip */
  tabCount: number
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
  /** Margin view: notes + comments as visible cards beside the page. The
   *  toolbar only toggles it — side + PDF export live in the Merknader tab,
   *  the one home for everything comment-related. */
  marginNotes: boolean
  onToggleMarginNotes(): void
  /** Annotation undo/redo (mirrors Ctrl+Z/Y — needed for pen/touch use) */
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  onPrint(): void
  readAloudOpen: boolean
  onToggleReadAloud(): void
  aiOpen: boolean
  onToggleAi(): void
  /** Snip-to-explain: armed = the crosshair overlay is up */
  snipActive: boolean
  onToggleSnip(): void
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
  { id: 'auto', labelKey: 'tb.themeAuto' }
]

const LANGUAGES: { id: LanguagePreference; label: string }[] = [
  // Language names stay in their own language — standard for language pickers
  { id: 'nb', label: 'Norsk' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Auto' }
]

/** Percent readout for the opacity sliders (0.45 → «45 %») */
const pct = (v: number): string => `${Math.round(v * 100)} %`

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
  onRotate,
  onToggleSpread,
  onToolPrefChange,
  onToolPrefReset,
  textPref,
  onTextPrefChange,
  onTextPrefReset,
  onNavBack,
  onNavForward,
  onToggleSidebar,
  onLeaveDocument,
  tabCount,
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
  dirty,
  onSave,
  onSaveAs,
  canSaveInPlace,
  annotsHidden,
  onToggleAnnots,
  marginNotes,
  onToggleMarginNotes,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrint,
  readAloudOpen,
  onToggleReadAloud,
  aiOpen,
  onToggleAi,
  snipActive,
  onToggleSnip,
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
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  // Save is a split button: the frequent action (write changes back to the
  // file) stays one click, the rare one (save a copy) moves behind the
  // chevron — one glyph less in a row of three disk-like icons.
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  // The gear menu: the app's technical surface (language, annotation
  // visibility, AI setup, update check, reset, version/about)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [resetAsk, setResetAsk] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updChecking, setUpdChecking] = useState(false)
  const [updOutcome, setUpdOutcome] = useState<UpdateCheckOutcome | null>(null)
  // undefined until probed; 'store' hides the check (Store owns updates there)
  const [updSupport, setUpdSupport] = useState<UpdateUnsupportedReason | null | undefined>(undefined)
  // Outside-click closers listen for pointerdown in the capture phase:
  // pointerdown always fires (page overlays may suppress the compat
  // mousedown via preventDefault) and capture beats stopPropagation.
  const [toolMenu, setToolMenu] = useState<
    DrawPrefKey | 'markup' | 'eraser' | 'text' | 'signature' | null
  >(null)
  // Last markup type the user activated, so the split button's main click
  // re-arms that type rather than always defaulting to highlight
  const [markupType, setMarkupType] = useState<MarkupToolType>('highlight')
  const themeMenuRef = useRef<HTMLDivElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const saveMenuRef = useRef<HTMLDivElement>(null)
  const toolMenuRef = useRef<HTMLDivElement>(null)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
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
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label={t('tb.goToPage')}
          />
          <span>/ {pageCount || '–'}</span>
        </div>

        <div className="toolbar-sep" />

        <button
          className="tb-btn"
          onClick={() => (isB ? onPaneZoomOut() : onZoomOut())}
          title={t('tb.zoomOutTip')}
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
          title={t('tb.zoomInTip')}
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
              title={target === 'page' ? t('tb.fitPageTip') : t('tb.fitWidthTip')}
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
  const overflowActions: {
    key: string
    icon: React.JSX.Element
    label: string
    onClick(): void
    active?: boolean
    disabled?: boolean
  }[] = [
    { key: 'present', icon: <IconPresent size={15} />, label: t('tb.present'), onClick: onPresent },
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
    { key: 'print', icon: <IconPrint size={15} />, label: t('tb.print'), onClick: onPrint },
    { key: 'fullscreen', icon: <IconFullscreen size={15} />, label: t('tb.fullscreen'), onClick: onToggleFullscreen },
    {
      key: 'pin',
      icon: toolbarPinned ? <IconPin size={15} /> : <IconPinOff size={15} />,
      label: toolbarPinned ? t('tb.unpin') : t('tb.pin'),
      onClick: onTogglePin,
      active: !toolbarPinned
    },
    { key: 'split', icon: <IconSplit size={15} />, label: t('tb.split'), onClick: onToggleSplit, active: splitOpen },
    { key: 'margin', icon: <IconMarginNotes size={15} />, label: t('tb.marginNotes'), onClick: onToggleMarginNotes, active: marginNotes },
    { key: 'snip', icon: <IconSnip size={15} />, label: t('tb.snip'), onClick: onToggleSnip, active: snipActive },
    // Annotation tools fold as single activation rows (their colour/width
    // popovers aren't in the menu — reachable again by widening the window).
    { key: 'eraser', icon: <IconEraser size={15} />, label: t('tb.eraser'), onClick: () => onToolSelect('eraser'), active: activeTool === 'eraser' },
    { key: 'shapes', icon: <IconShapes size={15} />, label: t('tb.shapes'), onClick: () => onToolSelect('square'), active: shapeActive },
    { key: 'note', icon: <IconNote size={15} />, label: t('tb.note'), onClick: onToggleNote, active: noteActive },
    { key: 'signature', icon: <IconSignature size={15} />, label: t('tb.signature'), onClick: onSignaturePrimary, active: signatureActive },
    { key: 'text', icon: <IconText size={15} />, label: t('tb.textTool'), onClick: () => onToolSelect(activeTool === 'text' ? null : 'text'), active: activeTool === 'text' },
    { key: 'markup', icon: <IconTextMarkup size={15} />, label: t('tb.markup'), onClick: () => onMarkupSelect(activeMarkup ? null : markupType), active: !!activeMarkup },
    { key: 'marker', icon: <IconMarker size={15} />, label: t('tb.marker'), onClick: () => onToolSelect(activeTool === 'marker' ? null : 'marker'), active: activeTool === 'marker' },
    { key: 'pen', icon: <IconPen size={15} />, label: t('tb.pen'), onClick: () => onToolSelect(activeTool === 'pen' ? null : 'pen'), active: activeTool === 'pen' },
    {
      key: 'fit',
      icon: activeZoom.fitTarget === 'page' ? <IconFitPage size={15} /> : <IconFitWidth size={15} />,
      label: activeZoom.fitTarget === 'page' ? t('tb.fitPage') : t('tb.fitWidth'),
      onClick: toggleFit,
      active: activeZoom.fitMode !== 'custom'
    },
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

  return (
    <div className="toolbar" ref={toolbarRef}>
      <div className="toolbar-group">
        {/* Back to the library. It moved here from the tab strip (Emil,
            2026-08-09) so the strip holds nothing but tabs — and so it is
            reachable in fullscreen, where the strip is tucked but the toolbar
            comes back on hover. Icon-only with a tooltip that says what it
            actually does: with other tabs open this closes ONE document and
            lands you in the next, and calling that "back to the library" was
            the label's old lie. */}
        <button
          className="tb-btn"
          onClick={onLeaveDocument}
          title={t(tabCount > 1 ? 'tb.leaveDocTip' : 'tb.libraryTip')}
        >
          <IconChevronLeft size={17} />
        </button>
        {/* «Innhold» lost its label: the panel holds thumbnails, contents,
            bookmarks AND notes, so the word described a quarter of it (Emil's
            observation). The left edge rail is already an icon for the same
            panel, which made the label doubly redundant. */}
        <button
          className={`tb-btn${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title={t('tb.sidebarTip')}
        >
          <IconSidebar />
        </button>
        <div className="toolbar-sep" />
        {inline('back') && (
          <button className="tb-btn" onClick={onNavBack} disabled={!canNavBack} title={t('tb.navBackTip')}>
            <IconArrowLeft />
          </button>
        )}
        {inline('forward') && (
          <button
            className="tb-btn"
            onClick={onNavForward}
            disabled={!canNavForward}
            title={t('tb.navForwardTip')}
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
              title={t('tb.noteTip')}
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
                title={t('tb.signatureTip')}
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
            <button className="tb-btn" onClick={onUndo} disabled={!canUndo} title={t('tb.undoTip')}>
              <IconUndo />
            </button>
          )}
          {inline('redo') && (
            <button className="tb-btn" onClick={onRedo} disabled={!canRedo} title={t('tb.redoTip')}>
              <IconRedo />
            </button>
          )}

          {toolMenu === 'signature' ? (
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
          ) : null}
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
                    title={preset === 100 ? t('tb.actualSizeTip') : undefined}
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
                  <button className="tb-btn" onClick={() => onRotate(-1)} title={t('tb.rotateCcwTip')}>
                    <IconRotateCcw />
                  </button>
                  <button className="tb-btn" onClick={() => onRotate(1)} title={t('tb.rotateCwTip')}>
                    <IconRotateCw />
                  </button>
                </span>
              </div>
              <label className="theme-menu-toggle view-row-toggle">
                <input type="checkbox" checked={spread} onChange={onToggleSpread} />
                <IconSpread size={15} />
                {t('tb.spread')}
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        {inline('search') && (
          <button className="tb-btn" onClick={onToggleSearch} title={t('tb.searchTip')}>
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

        {inline('print') && (
          <button className="tb-btn" onClick={onPrint} title={t('tb.printTip')}>
            <IconPrint />
          </button>
        )}

        {canSaveInPlace ? (
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
              title={t('tb.saveTip')}
            >
              <IconSave />
            </button>
            <button
              className={`tb-chevron${saveMenuOpen ? ' is-active' : ''}`}
              title={t('tb.saveOptionsTip')}
              aria-label={t('tb.saveOptionsTip')}
              onClick={() => setSaveMenuOpen((o) => !o)}
            >
              <IconChevronDown size={11} />
            </button>
            {saveMenuOpen && (
              <div className="theme-menu save-menu">
                <button
                  className="menu-action"
                  onClick={() => {
                    setSaveMenuOpen(false)
                    onSaveAs()
                  }}
                  title={isElectron ? t('tb.saveAsTip') : t('tb.saveCopyTip')}
                >
                  <IconSaveAs size={15} />
                  {isElectron ? t('tb.saveAs') : t('tb.saveCopy')}
                </button>
              </div>
            )}
          </span>
        ) : (
          // Browser/extension: one Save that bakes annotations in, then
          // overwrites the local file (opened from disk) or downloads (URL).
          <button
            className={`tb-btn tb-save${dirty ? ' has-changes' : ''}`}
            onClick={onSave}
            title={t('tb.saveToDiskTip')}
          >
            <IconSaveAs />
          </button>
        )}

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

        {inline('margin') && (
          <button
            className={`tb-btn${marginNotes ? ' is-active' : ''}`}
            onClick={onToggleMarginNotes}
            title={t('tb.marginNotesTip')}
          >
            <IconMarginNotes />
          </button>
        )}
        {inline('split') && (
          <button
            className={`tb-btn${splitOpen ? ' is-active' : ''}`}
            onClick={onToggleSplit}
            title={t('tb.splitTip')}
          >
            <IconSplit />
          </button>
        )}
        {inline('present') && (
          <button className="tb-btn" onClick={onPresent} title={t('tb.presentTip')}>
            <IconPresent />
          </button>
        )}
        {inline('pin') && (
          <button
            className={`tb-btn${toolbarPinned ? '' : ' is-active'}`}
            onClick={onTogglePin}
            title={toolbarPinned ? t('tb.unpinTip') : t('tb.pinTip')}
          >
            {toolbarPinned ? <IconPin /> : <IconPinOff />}
          </button>
        )}
        {inline('fullscreen') && (
          <button className="tb-btn" onClick={onToggleFullscreen} title={t('tb.fullscreenTip')}>
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

        {inline('snip') && (
          <button
            className={`tb-btn${snipActive ? ' is-active' : ''}`}
            onClick={onToggleSnip}
            title={t('tb.snipTip')}
          >
            <IconSnip />
          </button>
        )}

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
                  <button
                    key={a.key}
                    className={`menu-action${a.active ? ' is-active' : ''}`}
                    disabled={a.disabled}
                    onClick={() => {
                      setOverflowMenuOpen(false)
                      a.onClick()
                    }}
                  >
                    {a.icon}
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {inline('ai') && (
          <button
            className={`tb-btn tb-labeled${aiOpen ? ' is-active' : ''}`}
            onClick={onToggleAi}
            title={t('tb.aiTip')}
          >
            <IconSparkle />
            <span className="tb-label">{t('ai.assistant')}</span>
          </button>
        )}
      </div>

      {/* Reset-to-defaults is destructive enough to deserve the same modal
          treatment as an unsaved-changes prompt — and the detail line spells
          out exactly what survives it (API keys, library, annotations). */}
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

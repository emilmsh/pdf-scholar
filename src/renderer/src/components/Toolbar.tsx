import { useEffect, useRef, useState } from 'react'
import type {
  LanguagePreference,
  Settings,
  ThemeName,
  ThemePreference
} from '../../../shared/types'
import {
  annotTypeLabel,
  colorLabel,
  HIGHLIGHT_COLORS,
  MARKUP_TOOL_TYPES,
  SHAPE_TOOL_TYPES,
  UNDERLINE_COLORS
} from '../annotations'
import type { DrawToolType, MarkupToolType, ShapeToolType } from '../annotations'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconActualSize,
  IconFitPage,
  IconFitWidth,
  IconFullscreen,
  IconMarker,
  IconMarkupHighlight,
  IconMarkupSquiggly,
  IconMarkupStrikeout,
  IconMarkupUnderline,
  IconMinus,
  IconPen,
  IconPin,
  IconPinOff,
  IconPlus,
  IconPresent,
  IconPrint,
  IconSaveAs,
  IconRotateCw,
  IconSave,
  IconSearch,
  IconSpeaker,
  IconSpread,
  IconTextMarkup,
  IconShapeArrow,
  IconShapeCircle,
  IconShapeLine,
  IconShapeSquare,
  IconShapes,
  IconSidebar,
  IconSparkle,
  IconText,
  IconTextSettings
} from './icons'

export type ToolName = DrawToolType

export interface ToolPref {
  color: [number, number, number]
  width: number
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

interface Props {
  page: number
  pageCount: number
  zoomPercent: number
  settings: Settings
  resolvedTheme: ThemeName
  sidebarOpen: boolean
  canNavBack: boolean
  canNavForward: boolean
  activeTool: ToolName | null
  toolPrefs: Record<'pen' | 'marker' | 'shape', ToolPref>
  onToolSelect(tool: ToolName | null): void
  /** Text-anchored markup tool (highlight/underline/strikeout/squiggly) — a
   *  persistent tool that marks up the text selection, distinct from freehand */
  activeMarkup: MarkupToolType | null
  markupColor: [number, number, number]
  onMarkupSelect(type: MarkupToolType | null): void
  onMarkupColorChange(color: [number, number, number]): void
  /** View rotation + two-page spread (reading controls next to zoom) */
  spread: boolean
  onRotate(dir: 1 | -1): void
  onToggleSpread(): void
  onToolPrefChange(tool: 'pen' | 'marker' | 'shape', patch: Partial<ToolPref>): void
  onNavBack(): void
  onNavForward(): void
  onToggleSidebar(): void
  onGoToPage(page: number): void
  onZoomIn(): void
  onZoomOut(): void
  onZoomTo(percent: number): void
  onFitWidth(): void
  onFitPage(): void
  /** Current fit mode, so the active fit button can be highlighted */
  fitMode: 'width' | 'page' | 'custom'
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
  onPrint(): void
  readAloudOpen: boolean
  onToggleReadAloud(): void
  aiOpen: boolean
  onToggleAi(): void
  /** Toolbar auto-hide: pinned = always shown, unpinned = reveals on hover */
  toolbarPinned: boolean
  onTogglePin(): void
  onPresent(): void
  onToggleFullscreen(): void
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
  markupColor,
  onMarkupSelect,
  onMarkupColorChange,
  spread,
  onRotate,
  onToggleSpread,
  onToolPrefChange,
  onNavBack,
  onNavForward,
  onToggleSidebar,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFitWidth,
  onFitPage,
  fitMode,
  onSettingsChange,
  onToggleSearch,
  dirty,
  onSave,
  onSaveAs,
  canSaveInPlace,
  annotsHidden,
  onToggleAnnots,
  onPrint,
  readAloudOpen,
  onToggleReadAloud,
  aiOpen,
  onToggleAi,
  toolbarPinned,
  onTogglePin,
  onPresent,
  onToggleFullscreen
}: Props): React.JSX.Element {
  useLang()
  const [pageInput, setPageInput] = useState(String(page))
  const [zoomEditing, setZoomEditing] = useState(false)
  const [zoomInput, setZoomInput] = useState('')
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  // Outside-click closers listen for pointerdown in the capture phase:
  // pointerdown always fires (page overlays may suppress the compat
  // mousedown via preventDefault) and capture beats stopPropagation.
  const [toolMenu, setToolMenu] = useState<'pen' | 'marker' | 'shape' | 'markup' | null>(null)
  // Last markup type the user activated, so the split button's main click
  // re-arms that type rather than always defaulting to highlight
  const [markupType, setMarkupType] = useState<MarkupToolType>('highlight')
  const menuRef = useRef<HTMLDivElement>(null)
  const toolMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toolMenu) return
    const close = (e: Event): void => {
      if (toolMenuRef.current && !toolMenuRef.current.contains(e.target as Node)) setToolMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [toolMenu])

  const selectTool = (tool: 'pen' | 'marker' | 'eraser'): void => {
    if (activeTool === tool) {
      if (tool === 'eraser') {
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
    if (!viewMenuOpen) return
    const close = (e: Event): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setViewMenuOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [viewMenuOpen])

  const commitPage = (): void => {
    const n = parseInt(pageInput, 10)
    if (!Number.isNaN(n)) onGoToPage(n)
    else setPageInput(String(page))
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          className={`tb-btn tb-labeled${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title={t('tb.sidebarTip')}
        >
          <IconSidebar />
          <span className="tb-label">{t('side.contents')}</span>
        </button>
        <div className="toolbar-sep" />
        <button className="tb-btn" onClick={onNavBack} disabled={!canNavBack} title={t('tb.navBackTip')}>
          <IconArrowLeft />
        </button>
        <button
          className="tb-btn"
          onClick={onNavForward}
          disabled={!canNavForward}
          title={t('tb.navForwardTip')}
        >
          <IconArrowRight />
        </button>

        <div className="toolbar-sep" />

        <div className="tool-group" ref={toolMenuRef}>
          {(['pen', 'marker'] as const).map((tool) => (
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
          <button
            className={`tb-btn${shapeActive ? ' is-active' : ''}`}
            onClick={() => setToolMenu((m) => (m === 'shape' ? null : 'shape'))}
            title={t('tb.shapesTip')}
          >
            <IconShapes />
          </button>
          <button
            className={`tb-btn${activeTool === 'text' ? ' is-active' : ''}`}
            onClick={() => onToolSelect(activeTool === 'text' ? null : 'text')}
            title={t('tb.textTip')}
          >
            <IconText />
          </button>
          <div className="toolbar-sep" />
          <button
            className={`tb-btn${activeTool === 'eraser' ? ' is-active' : ''}`}
            onClick={() => selectTool('eraser')}
            title={t('tb.eraserTip')}
          >
            <IconEraser />
          </button>
          <button
            className={`tb-btn${annotsHidden ? ' is-active' : ''}`}
            onClick={onToggleAnnots}
            title={annotsHidden ? t('tb.showAnnotsTip') : t('tb.hideAnnotsTip')}
          >
            {annotsHidden ? <IconEyeOff /> : <IconEye />}
          </button>

          {toolMenu === 'markup' ? (
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
                      className={`color-dot${markupColor.join() === c.rgb.join() ? ' selected' : ''}`}
                      style={{ background: c.hex }}
                      title={colorLabel(c)}
                      onClick={() => onMarkupColorChange(c.rgb)}
                    />
                  ) : (
                    <button
                      key={c.hex}
                      className={`color-bar${markupColor.join() === c.rgb.join() ? ' selected' : ''}`}
                      title={colorLabel(c)}
                      onClick={() => onMarkupColorChange(c.rgb)}
                    >
                      <span style={{ background: c.hex }} />
                    </button>
                  )
                )}
              </div>
            </div>
          ) : toolMenu ? (
            <div className="tool-menu">
              <div className="theme-menu-label">
                {toolMenu === 'pen' ? t('tb.pen') : toolMenu === 'marker' ? t('tb.marker') : t('tb.shapes')}
              </div>
              {toolMenu === 'shape' && (
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
              <div className="color-row">
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    className="color-dot"
                    style={{ background: c.hex }}
                    title={colorLabel(c)}
                    onClick={() => onToolPrefChange(toolMenu, { color: c.rgb })}
                  />
                ))}
              </div>
              <div className="theme-menu-label slider-label">
                {t('tb.width')}
                <output>{toolPrefs[toolMenu].width.toFixed(1)} pt</output>
              </div>
              <input
                type="range"
                min="1"
                max="16"
                step="0.5"
                value={toolPrefs[toolMenu].width}
                onChange={(e) => onToolPrefChange(toolMenu, { width: Number(e.target.value) })}
                aria-label={t('tb.strokeWidth')}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* Centre (freed by moving the file name to the tab strip) holds the
          reading controls: page number + zoom, flanked by flex spacers */}
      <div className="toolbar-spacer" />

      <div className="toolbar-group toolbar-center">
        <div className="page-indicator">
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label={t('tb.goToPage')}
          />
          <span>/ {pageCount || '–'}</span>
        </div>

        <div className="toolbar-sep" />

        <button className="tb-btn" onClick={onZoomOut} title={t('tb.zoomOutTip')}>
          <IconMinus />
        </button>
        {zoomEditing ? (
          <input
            className="zoom-input"
            autoFocus
            value={zoomInput}
            onChange={(e) => setZoomInput(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setZoomEditing(false)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                const n = parseInt(zoomInput, 10)
                if (!Number.isNaN(n)) onZoomTo(n)
                setZoomEditing(false)
              }
              if (e.key === 'Escape') setZoomEditing(false)
            }}
            aria-label={t('tb.zoomExactTip')}
          />
        ) : (
          <button
            className="zoom-label"
            title={t('tb.zoomExactTip')}
            onClick={() => {
              setZoomInput(String(zoomPercent))
              setZoomEditing(true)
            }}
          >
            {zoomPercent}%
          </button>
        )}
        <button className="tb-btn" onClick={onZoomIn} title={t('tb.zoomInTip')}>
          <IconPlus />
        </button>
        <div className="toolbar-sep" />
        <button
          className={`tb-btn${fitMode === 'custom' && zoomPercent === 100 ? ' is-active' : ''}`}
          onClick={() => onZoomTo(100)}
          title={t('tb.actualSizeTip')}
        >
          <IconActualSize />
        </button>
        <button
          className={`tb-btn${fitMode === 'page' ? ' is-active' : ''}`}
          onClick={onFitPage}
          title={t('tb.fitPageTip')}
        >
          <IconFitPage />
        </button>
        <button
          className={`tb-btn${fitMode === 'width' ? ' is-active' : ''}`}
          onClick={onFitWidth}
          title={t('tb.fitWidthTip')}
        >
          <IconFitWidth />
        </button>
        <div className="toolbar-sep" />
        <button className="tb-btn" onClick={() => onRotate(1)} title={t('tb.rotateCw')}>
          <IconRotateCw />
        </button>
        <button
          className={`tb-btn${spread ? ' is-active' : ''}`}
          onClick={onToggleSpread}
          title={t('tb.spread')}
        >
          <IconSpread />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <button className="tb-btn" onClick={onToggleSearch} title={t('tb.searchTip')}>
          <IconSearch />
        </button>

        <button
          className={`tb-btn${readAloudOpen ? ' is-active' : ''}`}
          onClick={onToggleReadAloud}
          title={t('tb.readAloudTip')}
        >
          <IconSpeaker />
        </button>

        <button className="tb-btn" onClick={onPrint} title={t('tb.printTip')}>
          <IconPrint />
        </button>

        {canSaveInPlace ? (
          <>
            {/* Desktop: write changes back to the file in place, plus save-a-copy */}
            <button
              className={`tb-btn tb-save${dirty ? ' has-changes' : ''}`}
              onClick={onSave}
              disabled={!dirty}
              title={t('tb.saveTip')}
            >
              <IconSave />
            </button>
            <button className="tb-btn" onClick={onSaveAs} title={t('tb.saveAsTip')}>
              <IconSaveAs />
            </button>
          </>
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

        <div className="theme-menu-anchor" ref={menuRef}>
          <button
            className={`tb-btn${viewMenuOpen ? ' is-active' : ''}`}
            onClick={() => setViewMenuOpen((o) => !o)}
            title={t('tb.viewTip')}
          >
            <IconTextSettings />
          </button>
          {viewMenuOpen && (
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

        <button className="tb-btn" onClick={onPresent} title={t('tb.presentTip')}>
          <IconPresent />
        </button>
        <button
          className={`tb-btn${toolbarPinned ? '' : ' is-active'}`}
          onClick={onTogglePin}
          title={toolbarPinned ? t('tb.unpinTip') : t('tb.pinTip')}
        >
          {toolbarPinned ? <IconPin /> : <IconPinOff />}
        </button>
        <button className="tb-btn" onClick={onToggleFullscreen} title={t('tb.fullscreenTip')}>
          <IconFullscreen />
        </button>

        <div className="toolbar-sep" />

        <button
          className={`tb-btn tb-labeled${aiOpen ? ' is-active' : ''}`}
          onClick={onToggleAi}
          title={t('tb.aiTip')}
        >
          <IconSparkle />
          <span className="tb-label">{t('ai.assistant')}</span>
        </button>
      </div>
    </div>
  )
}

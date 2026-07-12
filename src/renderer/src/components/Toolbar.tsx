import { useEffect, useRef, useState } from 'react'
import type { LanguagePreference, Settings, ThemeName, ThemePreference } from '../../../shared/types'
import { colorLabel, HIGHLIGHT_COLORS, SHAPE_TOOL_TYPES } from '../annotations'
import type { DrawToolType, ShapeToolType } from '../annotations'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronLeft,
  IconEraser,
  IconExpand,
  IconFitPage,
  IconFitWidth,
  IconFullscreen,
  IconMarker,
  IconMinus,
  IconPen,
  IconPlus,
  IconSearch,
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

const SHAPE_LABEL_KEYS: Record<ShapeToolType, MsgKey> = {
  square: 'shape.square',
  circle: 'shape.circle',
  line: 'shape.line',
  arrow: 'shape.arrow'
}

interface Props {
  fileName: string
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
  onToolPrefChange(tool: 'pen' | 'marker' | 'shape', patch: Partial<ToolPref>): void
  onNavBack(): void
  onNavForward(): void
  onToggleSidebar(): void
  onBack(): void
  onGoToPage(page: number): void
  onZoomIn(): void
  onZoomOut(): void
  onFitWidth(): void
  onFitPage(): void
  /** What the fit toggle offers next (Edge-style width↔page toggle) */
  fitTarget: 'width' | 'page'
  onSettingsChange(patch: Partial<Settings>): void
  onToggleSearch(): void
  aiOpen: boolean
  onToggleAi(): void
  onToggleChrome(): void
  onToggleFullscreen(): void
}

const THEMES: { id: ThemePreference; labelKey: MsgKey }[] = [
  { id: 'day', labelKey: 'tb.themeDay' },
  { id: 'sepia', labelKey: 'tb.themeSepia' },
  { id: 'night', labelKey: 'tb.themeNight' },
  { id: 'auto', labelKey: 'tb.themeAuto' }
]

const LANGUAGES: { id: LanguagePreference; label: string }[] = [
  // Language names stay in their own language — standard for language pickers
  { id: 'nb', label: 'Norsk' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Auto' }
]

export default function Toolbar({
  fileName,
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
  onToolPrefChange,
  onNavBack,
  onNavForward,
  onToggleSidebar,
  onBack,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onFitPage,
  fitTarget,
  onSettingsChange,
  onToggleSearch,
  aiOpen,
  onToggleAi,
  onToggleChrome,
  onToggleFullscreen
}: Props): React.JSX.Element {
  useLang()
  const [pageInput, setPageInput] = useState(String(page))
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [toolMenu, setToolMenu] = useState<'pen' | 'marker' | 'shape' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toolMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toolMenu) return
    const close = (e: MouseEvent): void => {
      if (toolMenuRef.current && !toolMenuRef.current.contains(e.target as Node)) setToolMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
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
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setViewMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [viewMenuOpen])

  const commitPage = (): void => {
    const n = parseInt(pageInput, 10)
    if (!Number.isNaN(n)) onGoToPage(n)
    else setPageInput(String(page))
  }

  const adjust = settings.themeAdjust[resolvedTheme]
  const setAdjust = (key: 'contrast' | 'brightness', value: number): void => {
    onSettingsChange({
      themeAdjust: { ...settings.themeAdjust, [resolvedTheme]: { ...adjust, [key]: value } }
    })
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="tb-btn tb-back" onClick={onBack} title={t('tb.libraryTip')}>
          <IconChevronLeft />
          <span>{t('tb.library')}</span>
        </button>
        <button
          className={`tb-btn${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title={t('tb.sidebarTip')}
        >
          <IconSidebar />
        </button>
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
          <button
            className={`tb-btn${activeTool === 'pen' ? ' is-active' : ''}`}
            onClick={() => selectTool('pen')}
            title={t('tb.penTip')}
          >
            <IconPen />
          </button>
          <button
            className={`tb-btn${activeTool === 'marker' ? ' is-active' : ''}`}
            onClick={() => selectTool('marker')}
            title={t('tb.markerTip')}
          >
            <IconMarker />
          </button>
          <button
            className={`tb-btn${activeTool === 'eraser' ? ' is-active' : ''}`}
            onClick={() => selectTool('eraser')}
            title={t('tb.eraserTip')}
          >
            <IconEraser />
          </button>
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

          {toolMenu && (
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
          )}
        </div>
      </div>

      <div className="toolbar-title" title={fileName}>
        {fileName}
      </div>

      <div className="toolbar-group">
        <div className="page-indicator">
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
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
        <span className="zoom-label">{zoomPercent}%</span>
        <button className="tb-btn" onClick={onZoomIn} title={t('tb.zoomInTip')}>
          <IconPlus />
        </button>
        <button
          className="tb-btn"
          onClick={fitTarget === 'page' ? onFitPage : onFitWidth}
          title={fitTarget === 'page' ? t('tb.fitPageTip') : t('tb.fitWidthTip')}
        >
          {fitTarget === 'page' ? <IconFitPage /> : <IconFitWidth />}
        </button>

        <div className="toolbar-sep" />

        <button className="tb-btn" onClick={onToggleSearch} title={t('tb.searchTip')}>
          <IconSearch />
        </button>

        <button
          className={`tb-btn${aiOpen ? ' is-active' : ''}`}
          onClick={onToggleAi}
          title={t('tb.aiTip')}
        >
          <IconSparkle />
        </button>

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

              <div className="theme-menu-label slider-label">
                {t('tb.contrast')}
                <output>{Math.round(adjust.contrast * 100)}%</output>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.02"
                value={adjust.contrast}
                onChange={(e) => setAdjust('contrast', Number(e.target.value))}
                aria-label={t('tb.contrast')}
              />

              <div className="theme-menu-label slider-label">
                {t('tb.brightness')}
                <output>{Math.round(adjust.brightness * 100)}%</output>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.02"
                value={adjust.brightness}
                onChange={(e) => setAdjust('brightness', Number(e.target.value))}
                aria-label={t('tb.brightness')}
              />

              <div className="theme-menu-row">
                <button
                  className="menu-reset"
                  onClick={() =>
                    onSettingsChange({
                      themeAdjust: {
                        ...settings.themeAdjust,
                        [resolvedTheme]: { contrast: 1, brightness: 1 }
                      }
                    })
                  }
                >
                  {t('tb.reset')}
                </button>
              </div>

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

        <button className="tb-btn" onClick={onToggleChrome} title={t('tb.distractionTip')}>
          <IconExpand />
        </button>
        <button className="tb-btn" onClick={onToggleFullscreen} title={t('tb.fullscreenTip')}>
          <IconFullscreen />
        </button>
      </div>
    </div>
  )
}

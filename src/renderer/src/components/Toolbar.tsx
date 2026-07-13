import { useEffect, useRef, useState } from 'react'
import type { LanguagePreference, Settings, ThemeName, ThemePreference } from '../../../shared/types'
import { colorLabel, HIGHLIGHT_COLORS, SHAPE_TOOL_TYPES } from '../annotations'
import type { DrawToolType, ShapeToolType } from '../annotations'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronLeft,
  IconEraser,
  IconExpand,
  IconEye,
  IconEyeOff,
  IconFitPage,
  IconFitWidth,
  IconFullscreen,
  IconMarker,
  IconMinus,
  IconPen,
  IconPlus,
  IconPrint,
  IconSave,
  IconSearch,
  IconSpeaker,
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

interface DocInfo {
  id: string
  name: string
  path: string
  dirty: boolean
  active: boolean
}

interface Props {
  fileName: string
  filePath: string
  /** Open documents in this window — shown in the title dropdown */
  docs: DocInfo[]
  onSelectDoc(id: string): void
  onCloseDoc(id: string): void
  onOpenDialog(): void
  onNewWindow(path?: string): void
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
  onZoomTo(percent: number): void
  onFitWidth(): void
  onFitPage(): void
  /** What the fit toggle offers next (Edge-style width↔page toggle) */
  fitTarget: 'width' | 'page'
  onSettingsChange(patch: Partial<Settings>): void
  onToggleSearch(): void
  /** Unsaved annotation changes exist (enables the save button) */
  dirty: boolean
  onSave(): void
  /** All annotations temporarily hidden (clean reading view) */
  annotsHidden: boolean
  onToggleAnnots(): void
  onPrint(): void
  readAloudOpen: boolean
  onToggleReadAloud(): void
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
  filePath,
  docs,
  onSelectDoc,
  onCloseDoc,
  onOpenDialog,
  onNewWindow,
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
  onZoomTo,
  onFitWidth,
  onFitPage,
  fitTarget,
  onSettingsChange,
  onToggleSearch,
  dirty,
  onSave,
  annotsHidden,
  onToggleAnnots,
  onPrint,
  readAloudOpen,
  onToggleReadAloud,
  aiOpen,
  onToggleAi,
  onToggleChrome,
  onToggleFullscreen
}: Props): React.JSX.Element {
  useLang()
  const [pageInput, setPageInput] = useState(String(page))
  const [zoomEditing, setZoomEditing] = useState(false)
  const [zoomInput, setZoomInput] = useState('')
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [docMenuOpen, setDocMenuOpen] = useState(false)
  const docMenuRef = useRef<HTMLDivElement>(null)

  // Outside-click closers listen for pointerdown in the capture phase:
  // pointerdown always fires (page overlays may suppress the compat
  // mousedown via preventDefault) and capture beats stopPropagation.
  useEffect(() => {
    if (!docMenuOpen) return
    const close = (e: Event): void => {
      if (docMenuRef.current && !docMenuRef.current.contains(e.target as Node)) setDocMenuOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [docMenuOpen])
  const [toolMenu, setToolMenu] = useState<'pen' | 'marker' | 'shape' | null>(null)
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
          <button
            className={`tb-btn${annotsHidden ? ' is-active' : ''}`}
            onClick={onToggleAnnots}
            title={annotsHidden ? t('tb.showAnnotsTip') : t('tb.hideAnnotsTip')}
          >
            {annotsHidden ? <IconEyeOff /> : <IconEye />}
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

      <div className="toolbar-title-anchor" ref={docMenuRef}>
        <button
          className={`toolbar-title${docMenuOpen ? ' is-active' : ''}`}
          title={t('tb.docMenuTip')}
          onClick={() => setDocMenuOpen((o) => !o)}
        >
          <span className="toolbar-title-text">{fileName}</span>
          <IconChevronDown size={11} />
        </button>
        {docMenuOpen && (
          <div className="doc-menu">
            {docs.map((doc) => (
              <div key={doc.id} className={`doc-menu-row${doc.active ? ' active' : ''}`}>
                <button
                  className="doc-menu-name"
                  onClick={() => {
                    onSelectDoc(doc.id)
                    setDocMenuOpen(false)
                  }}
                >
                  {doc.dirty && <span className="tab-dirty-dot">•</span>}
                  {doc.name}
                </button>
                <button
                  className="doc-menu-close"
                  aria-label={t('tabs.close')}
                  onClick={() => onCloseDoc(doc.id)}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                onOpenDialog()
                setDocMenuOpen(false)
              }}
            >
              {t('tabs.new')}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                onNewWindow(filePath)
                setDocMenuOpen(false)
              }}
            >
              {t('tabs.openInNewWindow')}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                onNewWindow()
                setDocMenuOpen(false)
              }}
            >
              {t('tabs.newWindow')}
            </button>
          </div>
        )}
      </div>

      <div className="toolbar-group">
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
            aria-label="Zoom %"
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
          className={`tb-btn${readAloudOpen ? ' is-active' : ''}`}
          onClick={onToggleReadAloud}
          title={t('tb.readAloudTip')}
        >
          <IconSpeaker />
        </button>

        <button
          className={`tb-btn tb-save${dirty ? ' has-changes' : ''}`}
          onClick={onSave}
          disabled={!dirty}
          title={t('tb.saveTip')}
        >
          <IconSave />
        </button>

        <button className="tb-btn" onClick={onPrint} title={t('tb.printTip')}>
          <IconPrint />
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
                  checked={settings.showTabBar}
                  onChange={(e) => onSettingsChange({ showTabBar: e.target.checked })}
                />
                {t('tb.showTabBar')}
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

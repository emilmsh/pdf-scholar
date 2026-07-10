import { useEffect, useRef, useState } from 'react'
import type { Settings, ThemeName, ThemePreference } from '../../../shared/types'
import { HIGHLIGHT_COLORS, SHAPE_TOOL_TYPES } from '../annotations'
import type { DrawToolType, ShapeToolType } from '../annotations'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronLeft,
  IconEraser,
  IconExpand,
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

const SHAPE_LABELS: Record<ShapeToolType, string> = {
  square: 'Rektangel',
  circle: 'Ellipse',
  line: 'Linje',
  arrow: 'Pil'
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
  onSettingsChange(patch: Partial<Settings>): void
  onToggleSearch(): void
  aiOpen: boolean
  onToggleAi(): void
  onToggleChrome(): void
  onToggleFullscreen(): void
}

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'day', label: 'Dag' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'night', label: 'Natt' },
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
  onSettingsChange,
  onToggleSearch,
  aiOpen,
  onToggleAi,
  onToggleChrome,
  onToggleFullscreen
}: Props): React.JSX.Element {
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
        <button className="tb-btn tb-back" onClick={onBack} title="Tilbake til biblioteket">
          <IconChevronLeft />
          <span>Bibliotek</span>
        </button>
        <button
          className={`tb-btn${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title="Sidepanel (miniatyrer og innhold)"
        >
          <IconSidebar />
        </button>
        <button className="tb-btn" onClick={onNavBack} disabled={!canNavBack} title="Tilbake (Alt+←)">
          <IconArrowLeft />
        </button>
        <button
          className="tb-btn"
          onClick={onNavForward}
          disabled={!canNavForward}
          title="Frem (Alt+→)"
        >
          <IconArrowRight />
        </button>

        <div className="toolbar-sep" />

        <div className="tool-group" ref={toolMenuRef}>
          <button
            className={`tb-btn${activeTool === 'pen' ? ' is-active' : ''}`}
            onClick={() => selectTool('pen')}
            title="Penn (klikk igjen for valg, Esc avslutter)"
          >
            <IconPen />
          </button>
          <button
            className={`tb-btn${activeTool === 'marker' ? ' is-active' : ''}`}
            onClick={() => selectTool('marker')}
            title="Tusj (klikk igjen for valg, Esc avslutter)"
          >
            <IconMarker />
          </button>
          <button
            className={`tb-btn${activeTool === 'eraser' ? ' is-active' : ''}`}
            onClick={() => selectTool('eraser')}
            title="Viskelær — sletter pennestrøk (Esc avslutter)"
          >
            <IconEraser />
          </button>
          <button
            className={`tb-btn${shapeActive ? ' is-active' : ''}`}
            onClick={() => setToolMenu((m) => (m === 'shape' ? null : 'shape'))}
            title="Former: rektangel, ellipse, linje, pil"
          >
            <IconShapes />
          </button>
          <button
            className={`tb-btn${activeTool === 'text' ? ' is-active' : ''}`}
            onClick={() => onToolSelect(activeTool === 'text' ? null : 'text')}
            title="Tekst på siden — klikk der teksten skal stå (Esc avslutter)"
          >
            <IconText />
          </button>

          {toolMenu && (
            <div className="tool-menu">
              <div className="theme-menu-label">
                {toolMenu === 'pen' ? 'Penn' : toolMenu === 'marker' ? 'Tusj' : 'Former'}
              </div>
              {toolMenu === 'shape' && (
                <div className="shape-row">
                  {SHAPE_TOOL_TYPES.map((shape) => {
                    const Icon = SHAPE_ICONS[shape]
                    return (
                      <button
                        key={shape}
                        className={`tb-btn shape-pick${activeTool === shape ? ' is-active' : ''}`}
                        title={SHAPE_LABELS[shape]}
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
                    title={c.name}
                    onClick={() => onToolPrefChange(toolMenu, { color: c.rgb })}
                  />
                ))}
              </div>
              <div className="theme-menu-label slider-label">
                Bredde
                <output>{toolPrefs[toolMenu].width.toFixed(1)} pt</output>
              </div>
              <input
                type="range"
                min="1"
                max="16"
                step="0.5"
                value={toolPrefs[toolMenu].width}
                onChange={(e) => onToolPrefChange(toolMenu, { width: Number(e.target.value) })}
                aria-label="Strekbredde"
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
            aria-label="Gå til side"
          />
          <span>/ {pageCount || '–'}</span>
        </div>

        <div className="toolbar-sep" />

        <button className="tb-btn" onClick={onZoomOut} title="Zoom ut (Ctrl+-)">
          <IconMinus />
        </button>
        <span className="zoom-label">{zoomPercent}%</span>
        <button className="tb-btn" onClick={onZoomIn} title="Zoom inn (Ctrl++)">
          <IconPlus />
        </button>
        <button className="tb-btn" onClick={onFitWidth} title="Tilpass bredde (Ctrl+0)">
          <IconFitWidth />
        </button>

        <div className="toolbar-sep" />

        <button className="tb-btn" onClick={onToggleSearch} title="Søk i dokumentet (Ctrl+F)">
          <IconSearch />
        </button>

        <button
          className={`tb-btn${aiOpen ? ' is-active' : ''}`}
          onClick={onToggleAi}
          title="Assistent — spør om dokumentet"
        >
          <IconSparkle />
        </button>

        <div className="theme-menu-anchor" ref={menuRef}>
          <button
            className={`tb-btn${viewMenuOpen ? ' is-active' : ''}`}
            onClick={() => setViewMenuOpen((o) => !o)}
            title="Visningsinnstillinger"
          >
            <IconTextSettings />
          </button>
          {viewMenuOpen && (
            <div className="theme-menu">
              <div className="theme-menu-label">Lesemodus</div>
              <div className="theme-options">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-option theme-${t.id}${settings.theme === t.id ? ' selected' : ''}`}
                    onClick={() => onSettingsChange({ theme: t.id })}
                  >
                    Aa
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>

              <div className="theme-menu-label slider-label">
                Kontrast
                <output>{Math.round(adjust.contrast * 100)}%</output>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.02"
                value={adjust.contrast}
                onChange={(e) => setAdjust('contrast', Number(e.target.value))}
                aria-label="Kontrast"
              />

              <div className="theme-menu-label slider-label">
                Lysstyrke
                <output>{Math.round(adjust.brightness * 100)}%</output>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.02"
                value={adjust.brightness}
                onChange={(e) => setAdjust('brightness', Number(e.target.value))}
                aria-label="Lysstyrke"
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
                  Nullstill
                </button>
              </div>

              <div className="theme-menu-sep" />

              <label className="theme-menu-toggle">
                <input
                  type="checkbox"
                  checked={settings.keepAwake}
                  onChange={(e) => onSettingsChange({ keepAwake: e.target.checked })}
                />
                Hold skjermen våken
              </label>
            </div>
          )}
        </div>

        <button className="tb-btn" onClick={onToggleChrome} title="Distraksjonsfri lesing (Esc avslutter)">
          <IconExpand />
        </button>
        <button className="tb-btn" onClick={onToggleFullscreen} title="Fullskjerm (F11)">
          <IconFullscreen />
        </button>
      </div>
    </div>
  )
}

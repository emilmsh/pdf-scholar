import { useEffect, useRef, useState } from 'react'
import type { Settings, ThemeName, ThemePreference } from '../../../shared/types'
import {
  IconChevronLeft,
  IconExpand,
  IconFitWidth,
  IconFullscreen,
  IconMinus,
  IconPlus,
  IconSidebar,
  IconTextSettings
} from './icons'

interface Props {
  fileName: string
  page: number
  pageCount: number
  zoomPercent: number
  settings: Settings
  resolvedTheme: ThemeName
  sidebarOpen: boolean
  onToggleSidebar(): void
  onBack(): void
  onGoToPage(page: number): void
  onZoomIn(): void
  onZoomOut(): void
  onFitWidth(): void
  onSettingsChange(patch: Partial<Settings>): void
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
  onToggleSidebar,
  onBack,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onSettingsChange,
  onToggleChrome,
  onToggleFullscreen
}: Props): React.JSX.Element {
  const [pageInput, setPageInput] = useState(String(page))
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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

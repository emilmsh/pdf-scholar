import { useEffect, useRef, useState } from 'react'
import type { ThemeName } from '../../../shared/types'
import {
  IconChevronLeft,
  IconExpand,
  IconFitWidth,
  IconFullscreen,
  IconMinus,
  IconPlus,
  IconTextSettings
} from './icons'

interface Props {
  fileName: string
  page: number
  pageCount: number
  zoomPercent: number
  theme: ThemeName
  onBack(): void
  onGoToPage(page: number): void
  onZoomIn(): void
  onZoomOut(): void
  onFitWidth(): void
  onThemeChange(theme: ThemeName): void
  onToggleChrome(): void
  onToggleFullscreen(): void
}

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'day', label: 'Dag' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'night', label: 'Natt' }
]

export default function Toolbar({
  fileName,
  page,
  pageCount,
  zoomPercent,
  theme,
  onBack,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onThemeChange,
  onToggleChrome,
  onToggleFullscreen
}: Props): React.JSX.Element {
  const [pageInput, setPageInput] = useState(String(page))
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPageInput(String(page))
  }, [page])

  useEffect(() => {
    if (!themeMenuOpen) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setThemeMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [themeMenuOpen])

  const commitPage = (): void => {
    const n = parseInt(pageInput, 10)
    if (!Number.isNaN(n)) onGoToPage(n)
    else setPageInput(String(page))
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="tb-btn tb-back" onClick={onBack} title="Tilbake til biblioteket">
          <IconChevronLeft />
          <span>Bibliotek</span>
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
            className={`tb-btn${themeMenuOpen ? ' is-active' : ''}`}
            onClick={() => setThemeMenuOpen((o) => !o)}
            title="Visningsinnstillinger"
          >
            <IconTextSettings />
          </button>
          {themeMenuOpen && (
            <div className="theme-menu">
              <div className="theme-menu-label">Lesemodus</div>
              <div className="theme-options">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-option theme-${t.id}${theme === t.id ? ' selected' : ''}`}
                    onClick={() => onThemeChange(t.id)}
                  >
                    Aa
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
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

import { useEffect, useState } from 'react'
import { t, useLang } from '../i18n'

export interface TabInfo {
  id: string
  name: string
  path: string
  /** Unsaved annotation changes (save model) */
  dirty?: boolean
}

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  /** Fullscreen or distraction-free: collapse the strip */
  hidden: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onNewTab(): void
  onNewWindow(): void
  onOpenInNewWindow(path: string): void
}

/** Tiny scroll glyph shown at the left of the titlebar (matches the app icon) */
const AppGlyph = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M7 4.5h11a2 2 0 0 1 2 2c0 1.1-.9 2-2 2h-1" />
    <path d="M7 4.5a2.5 2.5 0 0 0-2.5 2.5v10" />
    <path d="M17 8.5v9a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2c0-1.1.9-2 2-2H15" />
  </svg>
)

export default function TabBar({
  tabs,
  activeId,
  hidden,
  onSelect,
  onClose,
  onNewTab,
  onNewWindow,
  onOpenInNewWindow
}: Props): React.JSX.Element {
  useLang()
  const [menu, setMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  // The strip lives inside the frameless window's titlebar: the row is a
  // window-drag region, every interactive child opts out (CSS app-region),
  // and the content is inset to the OS-reported titlebar area so it never
  // slides under the native window controls.
  return (
    <div className={`tab-bar${hidden ? ' tucked' : ''}`}>
      <div className="tab-bar-inner">
      <span className="tab-app-glyph" aria-hidden="true">
        <AppGlyph />
      </span>
      {tabs.length === 0 && <span className="tab-app-name">PDF Scholar</span>}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeId ? ' active' : ''}`}
          title={tab.path}
          onAuxClick={(e) => {
            if (e.button === 1) onClose(tab.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, tab })
          }}
        >
          <button className="tab-label" onClick={() => onSelect(tab.id)}>
            {tab.dirty && <span className="tab-dirty-dot">•</span>}
            {tab.name}
          </button>
          <button className="tab-close" aria-label={t('tabs.close')} onClick={() => onClose(tab.id)}>
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNewTab} title={t('tabs.new')}>
        +
      </button>
      <button className="tab-new-window" onClick={onNewWindow} title={t('tabs.newWindow')}>
        ⧉
      </button>
      </div>

      {menu && (
        <div
          className="tab-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              onOpenInNewWindow(menu.tab.path)
              setMenu(null)
            }}
          >
            {t('tabs.openInNewWindow')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              onClose(menu.tab.id)
              setMenu(null)
            }}
          >
            {t('tabs.closeTab')}
          </button>
        </div>
      )}
    </div>
  )
}

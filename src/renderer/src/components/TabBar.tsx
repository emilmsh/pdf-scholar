import { useEffect, useState } from 'react'
import { t, useLang } from '../i18n'

export interface TabInfo {
  id: string
  name: string
  path: string
}

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  /** Distraction-free mode: collapse the bar (top-edge hover brings it back) */
  hidden: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onNewTab(): void
  onNewWindow(): void
  onOpenInNewWindow(path: string): void
}

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

  return (
    <div className={`tab-bar${hidden ? ' tucked' : ''}`}>
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

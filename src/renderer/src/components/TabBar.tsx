import { useEffect, useState } from 'react'
import { t, useLang } from '../i18n'
import { IconChevronLeft } from './icons'

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
  /** Fullscreen or presentation: collapse the strip */
  hidden: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onNewTab(): void
  onNewWindow(): void
  onOpenInNewWindow(path: string): void
  onShowInFolder(path: string): void
  /** A tab was dragged out and released — main decides where it lands */
  onTabDragOut(id: string, path: string): void
  /** Context-menu fallback: tear the tab off into a new window */
  onMoveToNewWindow(id: string, path: string): void
  /** Back to the library (closes the active document) */
  onLibrary(): void
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
  onOpenInNewWindow,
  onShowInFolder,
  onTabDragOut,
  onMoveToNewWindow,
  onLibrary
}: Props): React.JSX.Element {
  useLang()
  const [menu, setMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

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
      {tabs.length > 0 ? (
        <button className="tab-library" onClick={onLibrary} title={t('tb.libraryTip')}>
          <IconChevronLeft size={15} />
          <span>{t('tb.library')}</span>
        </button>
      ) : (
        <>
          <span className="tab-app-glyph" aria-hidden="true">
            <AppGlyph />
          </span>
          <span className="tab-app-name">PDF Scholar</span>
        </>
      )}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeId ? ' active' : ''}${tab.id === draggingId ? ' dragging' : ''}`}
          title={tab.path}
          draggable
          onDragStart={(e) => {
            // HTML5 drag can't cross OS windows; we only need dragend to fire so
            // main can hit-test the cursor. Setting data keeps some platforms
            // from cancelling the drag.
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', tab.path)
            setDraggingId(tab.id)
          }}
          onDragEnd={() => {
            setDraggingId(null)
            onTabDragOut(tab.id, tab.path)
          }}
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
              onMoveToNewWindow(menu.tab.id, menu.tab.path)
              setMenu(null)
            }}
          >
            {t('tabs.moveToNewWindow')}
          </button>
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
              onShowInFolder(menu.tab.path)
              setMenu(null)
            }}
          >
            {t('tabs.showInFolder')}
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

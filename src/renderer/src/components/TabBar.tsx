import { useEffect, useState } from 'react'
import { t, useLang } from '../i18n'
import { withShortcut } from '../keymap'
import { IconChevronDown } from './icons'

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
  /** A tab was dragged onto another position within this bar */
  onReorder(id: string, toIndex: number): void
  /** Close every tab in this list, one at a time (see closeTabs in App) */
  onCloseMany(ids: string[]): void
  /** Context-menu fallback: tear the tab off into a new window */
  onMoveToNewWindow(id: string, path: string): void
  /** Re-read the file from disk and remount the viewer (external updates) */
  onReload(id: string, path: string): void
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
  onReorder,
  onCloseMany,
  onMoveToNewWindow,
  onReload
}: Props): React.JSX.Element {
  useLang()
  const [menu, setMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  /** The "all tabs" list, opened from the chevron at the end of the strip */
  const [allOpen, setAllOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Where the right-clicked tab currently sits — the move/close-to-the-right
   *  items are all relative to it, and it moves while the menu is open. */
  const menuIndex = menu ? tabs.findIndex((x) => x.id === menu.tab.id) : null

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

  useEffect(() => {
    if (!allOpen) return
    const close = (): void => setAllOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAllOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [allOpen])

  // The strip lives inside the frameless window's titlebar: the row is a
  // window-drag region, every interactive child opts out (CSS app-region),
  // and the content is inset to the OS-reported titlebar area so it never
  // slides under the native window controls.
  return (
    <div className={`tab-bar${hidden ? ' tucked' : ''}`}>
      <div className="tab-bar-inner">
      {tabs.length > 0 ? null : (
        <>
          <span className="tab-app-glyph" aria-hidden="true">
            <AppGlyph />
          </span>
          <span className="tab-app-name">PDF Scholar</span>
        </>
      )}
      {tabs.map((tab, index) => (
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
          // Dragging ACROSS the bar reorders, live, the way browsers do. Dropping
          // outside it still tears the tab off: main answers 'same' when the
          // cursor is over this window, so the two gestures cannot collide.
          onDragOver={(e) => {
            if (!draggingId || draggingId === tab.id) return
            e.preventDefault()
            // Take the hovered tab's place. The dragged tab is spliced out before
            // it is inserted, so this reads the same dragging either way.
            onReorder(draggingId, index)
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
      <button className="tab-new" onClick={onNewTab} title={withShortcut(t('tabs.new'), 'file.open')}>
        +
      </button>
      <button className="tab-new-window" onClick={onNewWindow} title={withShortcut(t('tabs.newWindow'), 'window.new')}>
        ⧉
      </button>
      {/* Every open tab as a list. The strip compresses titles as it fills up,
          and past a handful they stop being readable — this is the browsers'
          answer to the same problem, in the same place. Only offered once the
          strip actually holds enough to be worth listing. */}
      {tabs.length > 2 && (
        <button
          className={`tab-all${allOpen ? ' is-open' : ''}`}
          title={t('tabs.allTip')}
          aria-expanded={allOpen}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setAllOpen((o) => !o)}
        >
          <IconChevronDown size={12} />
        </button>
      )}
      </div>

      {allOpen && (
        <div className="tab-all-menu" onMouseDown={(e) => e.stopPropagation()}>
          <div className="theme-menu-label">{t('tabs.allLabel')}</div>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`menu-item${tab.id === activeId ? ' is-active' : ''}`}
              title={tab.path}
              onClick={() => {
                onSelect(tab.id)
                setAllOpen(false)
              }}
            >
              {tab.dirty && <span className="tab-dirty-dot">•</span>}
              {tab.name}
            </button>
          ))}
        </div>
      )}

      {menu && menuIndex !== null && (
        <div
          className="tab-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              onReload(menu.tab.id, menu.tab.path)
              setMenu(null)
            }}
          >
            {t('tabs.reload')}
          </button>
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
          {/* Touch has no HTML5 drag, and a keyboard has no cursor: the same
              reorder lives here (long-press opens this menu) and on
              Ctrl+Shift+PageUp/PageDown. */}
          {tabs.length > 1 && (
            <>
              <button
                className="menu-item"
                disabled={menuIndex <= 0}
                onClick={() => {
                  onReorder(menu.tab.id, menuIndex - 1)
                  setMenu(null)
                }}
              >
                {t('tabs.moveLeft')}
              </button>
              <button
                className="menu-item"
                disabled={menuIndex === -1 || menuIndex >= tabs.length - 1}
                onClick={() => {
                  onReorder(menu.tab.id, menuIndex + 1)
                  setMenu(null)
                }}
              >
                {t('tabs.moveRight')}
              </button>
            </>
          )}
          <button
            className="menu-item"
            onClick={() => {
              onClose(menu.tab.id)
              setMenu(null)
            }}
          >
            {t('tabs.closeTab')}
          </button>
          {tabs.length > 1 && (
            <button
              className="menu-item"
              onClick={() => {
                onCloseMany(tabs.filter((x) => x.id !== menu.tab.id).map((x) => x.id))
                setMenu(null)
              }}
            >
              {t('tabs.closeOthers')}
            </button>
          )}
          {menuIndex !== -1 && menuIndex < tabs.length - 1 && (
            <button
              className="menu-item"
              onClick={() => {
                onCloseMany(tabs.slice(menuIndex + 1).map((x) => x.id))
                setMenu(null)
              }}
            >
              {t('tabs.closeToRight')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

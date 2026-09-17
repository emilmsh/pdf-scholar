import { useEffect, useRef, useState } from 'react'
import { zoteroKeyFromPath } from '../../../shared/zotero'
import { bridge, isElectron } from '../bridge'
import { TAB_DRAG_MIME } from '../drag-types'
import { t, useLang } from '../i18n'
import { isMac } from '../platform'
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
  /** Reveal the tab's document in the Zotero client. The row renders only for
   *  files in Zotero's storage layout (pure path check) — and it is the
   *  SECONDARY home for the action; the save menu's Zotero section is the
   *  visible one (no feature lives only in a context menu). */
  onShowInZotero(path: string): void
  /** A MOUSE drag of the tab began: run the native file drag of its document
   *  (desktop). Resolves when the drop is over; the source closes the tab if
   *  another window took it. */
  onTabDragFile(id: string, path: string): Promise<void>
  /** The in-window HTML5 drag ended (touch, pen, web preview) — main decides
   *  where the tab lands from the cursor position */
  onTabDragOut(id: string, path: string): void
  /** A tab was dragged onto another position within this bar */
  onReorder(id: string, toIndex: number): void
  /** Close every tab in this list, one at a time (see closeTabs in App) */
  onCloseMany(ids: string[]): void
  /** Context-menu fallback: tear the tab off into a new window */
  onMoveToNewWindow(id: string, path: string): void
  /** Re-read the file from disk and remount the viewer (external updates) */
  onReload(id: string, path: string): void
  /** Show this tab's file in the ACTIVE tab's second split column — the two-
   *  document split's main entry point; the tab itself stays open. On the
   *  active tab itself it means that document in both columns. */
  onOpenInSplit(path: string): void
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
  onShowInZotero,
  onTabDragFile,
  onTabDragOut,
  onReorder,
  onCloseMany,
  onMoveToNewWindow,
  onReload,
  onOpenInSplit
}: Props): React.JSX.Element {
  useLang()
  const [menu, setMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  // «Vis i Zotero» in that menu: instant for a storage-layout path, and for a
  // linked attachment the platform is asked (cached there after the first ask
  // the toolbar's badge already made) — so the row appears a beat late at
  // worst, and never for a file Zotero does not know.
  const [menuZotero, setMenuZotero] = useState(false)
  useEffect(() => {
    if (!menu) return undefined
    const path = menu.tab.path
    if (zoteroKeyFromPath(path) !== null) {
      setMenuZotero(true)
      return undefined
    }
    setMenuZotero(false)
    let stale = false
    void bridge.zoteroInfo(path).then((r) => {
      if (!stale) setMenuZotero(r !== null && !('error' in r))
    })
    return () => {
      stale = true
    }
  }, [menu])
  /** The "all tabs" list, opened from the chevron at the end of the strip */
  const [allOpen, setAllOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** How the pointer that is about to drag a tab touched it. The native file
   *  drag is for a MOUSE drag only (see PdfxApi.dragTabFile — the OS drag loop
   *  waits for a mouse button's release and never returns without one), and a
   *  DragEvent does not say what started it; the pointerdown before it does.
   *  A drag can only begin while that button is still down, so the pointerdown
   *  record alone proves the held button — the DragEvent's own `buttons` does
   *  NOT: Chromium reports 0 there, and gating on it sent every real mouse drag
   *  down the in-window path (Emil, 2026-09-17: «pastes a path and opens a new
   *  window at the same time»). The modifier is recorded here too, since one
   *  held at the press is the reliable form of one held at the drag. It is
   *  Ctrl (Cmd on macOS, where Ctrl+press is the context-menu click) and NOT
   *  Shift: Chromium never starts a drag from a Shift+mousedown on anything
   *  but a link or image — Shift+press means «extend the selection» to it —
   *  so a Shift-drag fired no dragstart and no dragend, and did nothing at
   *  all (Emil, 2026-09-17). Alt is out too: Alt+drag moves the window on
   *  several Linux desktops. */
  const dragPointer = useRef<{ type: string; buttons: number; mod: boolean } | null>(null)
  const modOf = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => (isMac ? e.metaKey : e.ctrlKey)
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
          onPointerDown={(e) => {
            dragPointer.current = { type: e.pointerType, buttons: e.buttons, mod: modOf(e) }
          }}
          onDragStart={(e) => {
            setDraggingId(tab.id)
            const started = dragPointer.current
            dragPointer.current = null
            // A real mouse drag with the left button down — the only drag the
            // OS drag loop can end (it waits for that button's release; touch
            // and pen have none, and a synthetic dragstart has no pointer at
            // all — see PdfxApi.dragTabFile for the freeze that guards against)
            const mouseDrag = started?.type === 'mouse' && (started.buttons & 1) === 1
            // Ctrl/Cmd + drag opts OUT of the file drag: the tab moves inside
            // the app as it used to — into another window, or torn off into a
            // new one on the desktop — the one thing the file drag cannot do,
            // since a drop outside our windows belongs to the OS then
            const mod = (started?.mod ?? false) || modOf(e)
            if (isElectron && mouseDrag && !mod) {
              // Desktop: cancel the HTML5 drag and run a NATIVE file drag of the
              // document instead (main's startDrag) — the drag Explorer starts,
              // so the tab drops wherever a file can: another PDF Scholar
              // window (its file-drop handler opens it — same hint, same column
              // targeting as a PDF from the OS), a browser's upload field, an
              // e-mail, a folder. Reorder keeps working: the OS drag still
              // fires dragover on the tabs here, and draggingId is state. No
              // dragend follows a cancelled dragstart, so the drag's end is the
              // promise settling.
              e.preventDefault()
              void onTabDragFile(tab.id, tab.path).finally(() => setDraggingId(null))
              return
            }
            // Ctrl-drag, touch, pen, web preview: a plain HTML5 drag inside
            // the window — reorder and drag-to-split here, and on the desktop
            // main places the tab from the cursor when it ends (another window,
            // or a new one). Our own type is the drag's data (some platforms
            // cancel a drag carrying none) and what a pages column reads as
            // «open this document beside mine». No text/plain: this drag can
            // end over another app, and the path pasted into a text field
            // there was the other half of Emil's double effect.
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(TAB_DRAG_MIME, tab.path)
          }}
          // Dragging ACROSS the bar reorders, live, the way browsers do. Dropping
          // outside the bar is the file drag's business (another window, another
          // app); a release over this window answers 'same', so the two
          // gestures cannot collide.
          onDragOver={(e) => {
            if (!draggingId || draggingId === tab.id) return
            e.preventDefault()
            // Take the hovered tab's place. The dragged tab is spliced out before
            // it is inserted, so this reads the same dragging either way.
            onReorder(draggingId, index)
          }}
          onDragEnd={() => {
            // HTML5 path only — the native drag's cancelled dragstart has no dragend
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
          {/* Two-document split: this file beside the ACTIVE tab's document
              (tabs are unique per path, so another tab is always another
              file). On the active tab itself: the document in both columns —
              the same-file split's home now that 's' reopens whatever the
              split held last. */}
          {activeId !== null && (
            <button
              className="menu-item"
              onClick={() => {
                onOpenInSplit(menu.tab.path)
                setMenu(null)
              }}
            >
              {t('tabs.openInSplit')}
            </button>
          )}
          <button
            className="menu-item"
            onClick={() => {
              onShowInFolder(menu.tab.path)
              setMenu(null)
            }}
          >
            {t('tabs.showInFolder')}
          </button>
          {menuZotero && (
            <button
              className="menu-item"
              onClick={() => {
                onShowInZotero(menu.tab.path)
                setMenu(null)
              }}
            >
              {t('zotero.show')}
            </button>
          )}
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

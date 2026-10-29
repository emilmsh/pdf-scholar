import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { folderOf, matchesTabQuery, tabLabels } from '../../../shared/tab-labels'
import {
  stripItems,
  tabRange,
  TAB_GROUP_COLORS,
  TAB_GROUP_NAME_MAX,
  type TabDropTarget
} from '../../../shared/tab-groups'
import type { TabGroup, TabGroupColor } from '../../../shared/types'
import { zoteroKeyFromPath } from '../../../shared/zotero'
import { bridge, isElectron } from '../bridge'
import { TAB_DRAG_MIME, TAB_GROUP_DRAG_MIME } from '../drag-types'
import { t, useLang } from '../i18n'
import { isMac } from '../platform'
import { withShortcut } from '../keymap'
import { IconChevronDown, IconPin } from './icons'
import { useTabHoverCard } from './TabHoverCard'

export interface TabInfo {
  id: string
  name: string
  path: string
  /** Unsaved annotation changes (save model) */
  dirty?: boolean
  /** Pinned (issue #29): first in the strip, no close cross */
  pinned?: boolean
  /** The tab group it belongs to (src/shared/tab-groups.ts) */
  groupId?: string | null
}

/** A group's colour as the CSS custom property its chip, line and swatch read */
const groupColorStyle = (color: TabGroupColor): React.CSSProperties =>
  ({ '--group-color': `var(--group-${color})` }) as React.CSSProperties

interface Props {
  tabs: TabInfo[]
  groups: TabGroup[]
  /** Bumped when a group is created: its chip's editor opens to name it */
  editGroupSignal: { id: string; n: number } | null
  /** These take the tabs the menu was opened on: one, or the Ctrl/Shift+click
   *  selection — so several tabs are grouped in one step */
  onGroupNew(tabIds: string[]): void
  onGroupAdd(tabIds: string[], groupId: string): void
  onGroupRemove(tabIds: string[]): void
  onGroupUpdate(groupId: string, patch: Partial<Pick<TabGroup, 'name' | 'color'>>): void
  /** Fold the group away, or open it */
  onGroupToggle(groupId: string): void
  onGroupUngroup(groupId: string): void
  /** Close every tab in the group (one at a time, as «Lukk andre faner») */
  onGroupClose(groupId: string): void
  /** The group's chip was dragged over this tab: the whole group moves past it */
  onReorderGroup(groupId: string, targetTabId: string): void
  activeId: string | null
  /** Bumped by Ctrl+Shift+A (tab.search): open «Alle faner», or close it */
  listSignal: number
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
  /** A tab dragged across this bar is over `target`: it moves there, into a
   *  group or out of one (placeTab in tab-groups.ts) */
  onPlaceTab(id: string, target: TabDropTarget): void
  /** Pin the tab, or let it go. Lives in the tab menu, the «Alle åpne faner»
   *  list and the shortcut map — never in the right-click menu alone. */
  onTogglePin(id: string, pinned: boolean): void
  /** Close every tab in this list, one at a time (see closeTabs in App) */
  onCloseMany(ids: string[]): void
  /** Context-menu fallback: tear the tab off into a new window */
  onMoveToNewWindow(id: string, path: string): void
  /** Re-read the file from disk and remount the viewer (external updates) */
  onReload(id: string, path: string): void
  /** «Dupliser fane» (issue #53): a second tab on this document, at the
   *  place the first one stands. Also Ctrl+Shift+K, Edge's chord for it. */
  onDuplicate(id: string): void
  /** Show this tab's file in the ACTIVE tab's second split column — the two-
   *  document split's main entry point; the tab itself stays open. On the
   *  active tab itself it means that document in both columns. */
  onOpenInSplit(path: string): void
}

/** How far the strip's edges fade when there is more to that side — also the
 *  room the active tab is scrolled clear of them by */
const FADE_PX = 28

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
  groups,
  editGroupSignal,
  onGroupNew,
  onGroupAdd,
  onGroupRemove,
  onGroupUpdate,
  onGroupToggle,
  onGroupUngroup,
  onGroupClose,
  onReorderGroup,
  activeId,
  listSignal,
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
  onPlaceTab,
  onTogglePin,
  onCloseMany,
  onMoveToNewWindow,
  onReload,
  onDuplicate,
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
  /** The list's search field, and the row Enter would open */
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Ctrl+Shift+A: the first bump opens the list, the next one closes it, as
  // the browsers' tab search does. The initial 0 is not a press.
  useEffect(() => {
    if (listSignal > 0) setAllOpen((o) => !o)
  }, [listSignal])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** The group whose chip is being dragged — the whole group moves (Emil,
   *  2026-10-29). Always the in-window HTML5 drag: a group is no file. */
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  /** Move the dragged group past `targetId` once the pointer is over the far
   *  half of it. The half matters: a folded group's chip is narrower than a
   *  tab, so after a move the pointer can still be over the same tab — on its
   *  near half now, which must not move the group straight back. */
  const overLeftHalf = (e: React.DragEvent): boolean => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2
  }
  /** Past the strip's last tab — over «+» and the rest of the row: last in
   *  the strip and ungrouped, which is how a tab leaves a group at the end */
  const dragOverRow = (e: React.DragEvent): void => {
    if (!draggingId || (e.target as Element).closest('.tab, .tab-group-chip')) return
    const lastEl = stripRef.current?.lastElementChild
    if (!lastEl || e.clientX < lastEl.getBoundingClientRect().right) return
    e.preventDefault()
    onPlaceTab(draggingId, { kind: 'end' })
  }
  const dragGroupOver = (e: React.DragEvent, targetId: string): void => {
    if (!draggingGroupId) return
    const runStart = tabs.findIndex((x) => x.groupId === draggingGroupId)
    const target = tabs.findIndex((x) => x.id === targetId)
    if (runStart === -1 || target === -1 || tabs[target].groupId === draggingGroupId) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const mid = r.left + r.width / 2
    if (runStart < target ? e.clientX > mid : e.clientX < mid) onReorderGroup(draggingGroupId, targetId)
  }
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
  const menuPinned = menu ? tabs.find((x) => x.id === menu.tab.id)?.pinned === true : false
  /** Tabs picked with Ctrl+click (toggle) and Shift+click (a range from the
   *  tab being read), so several are grouped in one step (Emil, 2026-10-29).
   *  The browsers' gesture, and nothing on the tabs says it is there: the
   *  strip stays clean. A plain click, Esc or another tab shown lets go. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const multi = selected.size > 1
  useEffect(() => {
    // The selection holds the tab being read; showing one outside it, or a
    // tab of it closing, ends it
    setSelected((cur) =>
      cur.size === 0 ||
      (activeId !== null && cur.has(activeId) && [...cur].every((id) => tabs.some((x) => x.id === id)))
        ? cur
        : new Set()
    )
  }, [activeId, tabs])
  useEffect(() => {
    if (!multi) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [multi])
  /** What the tab menu acts on: the selection when it was opened on one of
   *  its tabs, else that tab alone — in strip order */
  const menuIds = menu
    ? multi && selected.has(menu.tab.id)
      ? tabs.filter((x) => selected.has(x.id)).map((x) => x.id)
      : [menu.tab.id]
    : []
  const menuTabs = tabs.filter((x) => menuIds.includes(x.id))
  const menuGroupable = menuTabs.some((x) => !x.pinned)
  const menuN = menuIds.length
  /** The hover card (TabHoverCard.tsx) — none while a menu owns the strip */
  const hoverCard = useTabHoverCard(menu !== null || allOpen || draggingId !== null || draggingGroupId !== null)

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

  const labels = useMemo(() => tabLabels(tabs), [tabs])
  const items = useMemo(() => stripItems(tabs, groups), [tabs, groups])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  /** The group editor (name, colour, fold, ungroup, close), under its chip.
   *  Opened by a right-click on the chip — a long press on a touch screen —
   *  and by itself when a group is made, so it can be named at once. */
  const [groupEdit, setGroupEdit] = useState<{ id: string; x: number; y: number } | null>(null)
  const editedGroup = groupEdit ? (groupById.get(groupEdit.id) ?? null) : null
  const openGroupEdit = (id: string): void => {
    const chip = stripRef.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(id)}"]`)
    if (!chip) return
    const r = chip.getBoundingClientRect()
    setGroupEdit({ id, x: Math.max(8, Math.min(r.left, window.innerWidth - 248)), y: r.bottom + 4 })
  }
  useLayoutEffect(() => {
    if (editGroupSignal) openGroupEdit(editGroupSignal.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editGroupSignal])
  useEffect(() => {
    if (!groupEdit) return undefined
    const close = (): void => setGroupEdit(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [groupEdit])
  const matching = useMemo(
    () => tabs.map((tab, i) => ({ tab, label: labels[i] })).filter(({ tab }) => matchesTabQuery(tab, query)),
    [tabs, labels, query]
  )
  // Each opening starts with an empty field, the caret in it and the CURRENT
  // tab highlighted — so ↓ / ↑ step from where you are
  useLayoutEffect(() => {
    if (!allOpen) return
    setQuery('')
    setHighlight(Math.max(0, tabs.findIndex((x) => x.id === activeId)))
    searchRef.current?.focus()
    // Only on opening — a tab arriving while the list is open must not reset it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allOpen])
  useEffect(() => {
    listRef.current?.querySelector('.is-highlighted')?.scrollIntoView({ block: 'nearest' })
  }, [highlight, allOpen, query])
  const chooseFromList = (id: string): void => {
    onSelect(id)
    setAllOpen(false)
  }

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

  // The tabs scroll sideways once they are at their narrowest (Emil,
  // 2026-10-28: not Edge's row of ever-thinner icons — every tab here has the
  // same icon, so the name is all there is to read). No scrollbar in a strip
  // this tight: the edge that has more beyond it fades instead.
  const stripRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ start: false, end: false })
  const updateFade = (): void => {
    const el = stripRef.current
    if (!el) return
    const start = el.scrollLeft > 1
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }))
  }
  useLayoutEffect(updateFade)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(updateFade)
    observer.observe(el)
    el.addEventListener('scroll', updateFade, { passive: true })
    // A mouse wheel turns vertically; over the strip that means sideways. A
    // gesture that is ALREADY sideways — a touchpad's two-finger pan, a tilt
    // wheel, Shift+wheel — is left to the browser, which scrolls the strip
    // natively (and a finger on a touch screen pans it the same way). Wheel
    // notches glide to an accumulated target so a fast spin loses nothing;
    // a touchpad's small vertical steps move the strip directly.
    const wheel = { at: 0, target: 0 }
    const onWheel = (e: WheelEvent): void => {
      const room = el.scrollWidth - el.clientWidth
      if (room <= 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY
      const now = performance.now()
      const base = now - wheel.at < 300 ? wheel.target : el.scrollLeft
      wheel.target = Math.max(0, Math.min(room, base + px))
      wheel.at = now
      if (Math.abs(px) >= 40) el.scrollTo({ left: wheel.target, behavior: 'smooth' })
      else el.scrollLeft = wheel.target
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', updateFade)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])
  // The current tab is always in view, clear of the fades — clicked half-
  // hidden at an edge, reached by Ctrl+Tab, Ctrl+1–9 or the list
  const scrolledOnce = useRef(false)
  useLayoutEffect(() => {
    const strip = stripRef.current
    const el = activeId ? strip?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`) : null
    if (!strip || !el) return
    const behavior: ScrollBehavior = scrolledOnce.current ? 'smooth' : 'auto'
    scrolledOnce.current = true
    const left = el.offsetLeft - FADE_PX
    const right = el.offsetLeft + el.offsetWidth + FADE_PX
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior })
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior })
  }, [activeId, tabs.length])

  // The strip lives inside the frameless window's titlebar: the row is a
  // window-drag region, every interactive child opts out (CSS app-region),
  // and the content is inset to the OS-reported titlebar area so it never
  // slides under the native window controls.
  return (
    <div className={`tab-bar${hidden ? ' tucked' : ''}`}>
      <div className="tab-bar-inner" onDragOver={dragOverRow}>
      {tabs.length > 0 ? null : (
        <>
          <span className="tab-app-glyph" aria-hidden="true">
            <AppGlyph />
          </span>
          <span className="tab-app-name">PDF Scholar</span>
        </>
      )}
      <div
        ref={stripRef}
        className={`tab-strip${fade.start ? ' fade-start' : ''}${fade.end ? ' fade-end' : ''}`}
      >
      {items.map((item) => {
        if (item.kind === 'group') {
          const { group, members } = item
          // The group's chip, in front of its tabs: a click folds the group
          // away or opens it — the reason groups exist (Emil, 2026-10-29) —
          // and a right-click (a long press) opens its editor
          return (
            <button
              key={`group-${group.id}`}
              data-group-id={group.id}
              className={`tab-group-chip${group.collapsed ? ' collapsed' : ''}${group.name ? '' : ' unnamed'}${draggingGroupId === group.id ? ' dragging' : ''}`}
              style={groupColorStyle(group.color)}
              title={t('tabs.groupChipTip', { n: members.length })}
              aria-expanded={!group.collapsed}
              aria-label={group.name || t(`tabs.groupColor.${group.color}`)}
              onClick={() => onGroupToggle(group.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                openGroupEdit(group.id)
              }}
              // Dragging the chip moves the whole group, folded or open. Our
              // own type only: neither a document drop nor text for another app.
              draggable
              onDragStart={(e) => {
                setDraggingGroupId(group.id)
                setGroupEdit(null)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(TAB_GROUP_DRAG_MIME, group.id)
              }}
              onDragEnd={() => setDraggingGroupId(null)}
              // Another group's chip stands for that group's run
              onDragOver={(e) => {
                // A tab over the chip: before it is outside the group, after
                // an open group's chip its first member
                if (draggingId) {
                  e.preventDefault()
                  onPlaceTab(draggingId, { kind: overLeftHalf(e) ? 'chipBefore' : 'chipAfter', groupId: group.id })
                  return
                }
                if (draggingGroupId && draggingGroupId !== group.id) {
                  const runStart = tabs.findIndex((x) => x.groupId === draggingGroupId)
                  const first = tabs.findIndex((x) => x.groupId === group.id)
                  dragGroupOver(e, (runStart < first ? members[members.length - 1] : members[0]).id)
                }
              }}
            >
              <span className="tab-group-dot" aria-hidden="true" />
              {group.name && <span className="tab-group-name">{group.name}</span>}
              {group.collapsed && <span className="tab-group-count">{members.length}</span>}
            </button>
          )
        }
        const { tab, index, group, last } = item
        return (
        <div
          key={tab.id}
          data-tab-id={tab.id}
          className={`tab${tab.id === activeId ? ' active' : ''}${tab.id === draggingId || (draggingGroupId !== null && tab.groupId === draggingGroupId) ? ' dragging' : ''}${tab.pinned ? ' pinned' : ''}${group ? ' grouped' : ''}${last ? ' group-last' : ''}${multi && selected.has(tab.id) ? ' selected' : ''}`}
          style={group ? groupColorStyle(group.color) : undefined}
          draggable
          // The hover card says what the native title did (the path), and
          // more — two tooltips at once would be worse than either
          onPointerEnter={(e) => hoverCard.enter(e, tab)}
          onPointerLeave={hoverCard.leave}
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
            if (draggingGroupId) {
              dragGroupOver(e, tab.id)
              return
            }
            if (!draggingId || draggingId === tab.id) return
            e.preventDefault()
            // Before or after the hovered tab, by the half the pointer is
            // over — in the hovered tab's group either way, so a group is
            // entered at its first or last member as well as between two
            onPlaceTab(draggingId, { kind: overLeftHalf(e) ? 'before' : 'after', id: tab.id })
          }}
          onDragEnd={() => {
            // HTML5 path only — the native drag's cancelled dragstart has no dragend
            setDraggingId(null)
            onTabDragOut(tab.id, tab.path)
          }}
          onAuxClick={(e) => {
            // A pinned tab is one you asked to keep — a stray middle-click on
            // it is more likely a miss than a wish to close it (the menu and
            // Ctrl+W still do)
            if (e.button === 1 && !tab.pinned) onClose(tab.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!selected.has(tab.id)) setSelected(new Set())
            setMenu({ x: e.clientX, y: e.clientY, tab })
          }}
        >
          <button
            className="tab-label"
            onClick={(e) => {
              // Ctrl+click (Cmd on macOS) picks a tab or lets it go; Shift+click
              // picks the shown tabs from the one being read. Neither changes
              // which document is shown.
              if (activeId !== null && (modOf(e) || e.shiftKey)) {
                if (e.shiftKey) setSelected(new Set(tabRange(tabs, groups, activeId, tab.id)))
                else
                  setSelected((cur) => {
                    const next = new Set(cur.size > 0 ? cur : [activeId])
                    if (tab.id !== activeId && next.has(tab.id)) next.delete(tab.id)
                    else next.add(tab.id)
                    return next
                  })
                return
              }
              setSelected(new Set())
              onSelect(tab.id)
            }}
          >
            {tab.pinned && <IconPin size={12} className="tab-pin" />}
            {tab.dirty && <span className="tab-dirty-dot">•</span>}
            {/* Head + tail is the whole name; a name that only begins like a
                neighbour's gives way at the head, so what differs stays */}
            <span className="tab-name-head">{labels[index].head}</span>
            {labels[index].tail && <span className="tab-name-tail">{labels[index].tail}</span>}
            {labels[index].dir && <span className="tab-name-dir">{labels[index].dir}</span>}
          </button>
          {!tab.pinned && (
            <button className="tab-close" aria-label={t('tabs.close')} onClick={() => onClose(tab.id)}>
              ✕
            </button>
          )}
        </div>
        )
      })}
      </div>
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
          title={withShortcut(t('tabs.allTip'), 'tab.search')}
          aria-expanded={allOpen}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setAllOpen((o) => !o)}
        >
          <IconChevronDown size={12} />
        </button>
      )}
      </div>

      {hoverCard.card}

      {allOpen && (
        <div className="tab-all-menu" onMouseDown={(e) => e.stopPropagation()}>
          {/* Type a few letters of the name or the folder, ↑/↓, Enter — the
              way in once the strip holds more than can be read */}
          <input
            ref={searchRef}
            className="tab-all-search"
            type="search"
            value={query}
            placeholder={t('tabs.searchPlaceholder')}
            aria-label={t('tabs.searchPlaceholder')}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = matching.length
                if (n > 0) setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const row = matching[Math.min(highlight, matching.length - 1)]
                if (row) chooseFromList(row.tab.id)
              }
            }}
          />
          <div className="tab-all-list" ref={listRef}>
          {matching.length === 0 && <div className="tab-all-empty">{t('tabs.searchEmpty')}</div>}
          {matching.map(({ tab, label }, row) => (
            <div key={tab.id} className={`tab-all-row${row === highlight ? ' is-highlighted' : ''}`}>
              <button
                className={`menu-item${tab.id === activeId ? ' is-active' : ''}`}
                title={tab.path}
                onClick={() => chooseFromList(tab.id)}
              >
                <span className="tab-all-name">
                  {/* The group's colour, so a folded group's tabs are found
                      here too — choosing one unfolds its group */}
                  {tab.groupId && groupById.has(tab.groupId) && (
                    <span
                      className="tab-group-dot"
                      style={groupColorStyle(groupById.get(tab.groupId)!.color)}
                      title={groupById.get(tab.groupId)!.name || undefined}
                    />
                  )}
                  {tab.dirty && <span className="tab-dirty-dot">•</span>}
                  {tab.name}
                </span>
                {/* The folder on a line of its own — what tells two
                    identical names apart, and a second thing to search by */}
                {(label.dir ?? folderOf(tab.path)) && (
                  <span className="tab-all-dir">{label.dir ?? folderOf(tab.path)}</span>
                )}
              </button>
              {/* The pin's visible home besides the tab menu — this list is
                  where a strip too full to read gets sorted out */}
              <button
                className={`tab-all-pin${tab.pinned ? ' is-on' : ''}`}
                title={t(tab.pinned ? 'tabs.unpin' : 'tabs.pin')}
                aria-label={t(tab.pinned ? 'tabs.unpin' : 'tabs.pin')}
                aria-pressed={tab.pinned === true}
                onClick={() => onTogglePin(tab.id, !tab.pinned)}
              >
                {/* The upright tack, lit when pinned — the toolbar's own
                    convention, where the tack on its side means NOT pinned */}
                <IconPin size={13} />
              </button>
            </div>
          ))}
          </div>
        </div>
      )}

      {menu && (
        <div
          className="tab-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              onTogglePin(menu.tab.id, !menuPinned)
              setMenu(null)
            }}
          >
            {t(menuPinned ? 'tabs.unpin' : 'tabs.pin')}
          </button>
          {/* Groups: a pinned tab is never in one (the pinned run is the
              strip's start), so it is offered none */}
          {menuGroupable && (
            <>
              <button
                className="menu-item"
                onClick={() => {
                  onGroupNew(menuIds)
                  setSelected(new Set())
                  setMenu(null)
                }}
              >
                {menuN > 1 ? t('tabs.groupNewMany', { n: menuN }) : t('tabs.groupNew')}
              </button>
              {groups
                // A group every one of these tabs is in already has nothing to take
                .filter((g) => !menuTabs.every((x) => x.groupId === g.id))
                .map((g) => (
                  <button
                    key={g.id}
                    className="menu-item tab-menu-group"
                    style={groupColorStyle(g.color)}
                    onClick={() => {
                      onGroupAdd(menuIds, g.id)
                      setSelected(new Set())
                      setMenu(null)
                    }}
                  >
                    <span className="tab-group-dot" aria-hidden="true" />
                    {menuN > 1
                      ? g.name
                        ? t('tabs.groupAddToMany', { n: menuN, name: g.name })
                        : t('tabs.groupAddToUnnamedMany', { n: menuN })
                      : g.name
                        ? t('tabs.groupAddTo', { name: g.name })
                        : t('tabs.groupAddToUnnamed')}
                  </button>
                ))}
              {menuTabs.some((x) => x.groupId) && (
                <button
                  className="menu-item"
                  onClick={() => {
                    onGroupRemove(menuIds)
                    setSelected(new Set())
                    setMenu(null)
                  }}
                >
                  {menuN > 1 ? t('tabs.groupRemoveMany', { n: menuN }) : t('tabs.groupRemove')}
                </button>
              )}
              <div className="menu-sep" />
            </>
          )}
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
              onDuplicate(menu.tab.id)
              setMenu(null)
            }}
          >
            {t('tabs.duplicate')}
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
          {/* Two-document split: this file beside the ACTIVE tab's document.
              On the active tab itself — or a duplicate of it, which shares
              its path: the document in both columns, the same-file split's
              home now that 's' reopens whatever the split held last. */}
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
          {/* «Kopier sti» beside «Vis i Filutforsker» (Emil, 2026-10-28): the
              tab's path as it is on disk, for pasting into a chat, a mail or
              a reference manager. The same string the browser build's
              document button uses; the menu closes, so no «Kopiert» flash. */}
          <button
            className="menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.tab.path).catch(() => {})
              setMenu(null)
            }}
          >
            {t('doc.copyPath')}
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
          {/* «Flytt til venstre/høyre» and «Lukk faner til høyre» left this
              menu 2026-10-28 (Emil: tidiness) — a tab is reordered by drag,
              or by Ctrl+Shift+PageUp/PageDown from the keyboard. */}
          <button
            className="menu-item"
            onClick={() => {
              if (menuN > 1) onCloseMany(menuIds)
              else onClose(menu.tab.id)
              setSelected(new Set())
              setMenu(null)
            }}
          >
            {menuN > 1 ? t('tabs.closeMany', { n: menuN }) : t('tabs.closeTab')}
          </button>
          {/* The bulk closes leave pinned tabs standing — the browsers' rule,
              and the point of pinning one */}
          {tabs.some((x) => x.id !== menu.tab.id && !x.pinned) && (
            <button
              className="menu-item"
              onClick={() => {
                onCloseMany(tabs.filter((x) => x.id !== menu.tab.id && !x.pinned).map((x) => x.id))
                setMenu(null)
              }}
            >
              {t('tabs.closeOthers')}
            </button>
          )}
        </div>
      )}

      {editedGroup && groupEdit && (
        <div
          className="tab-group-editor"
          style={{ left: groupEdit.x, top: groupEdit.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            className="tab-group-name-input"
            value={editedGroup.name}
            placeholder={t('tabs.groupNamePlaceholder')}
            aria-label={t('tabs.groupNamePlaceholder')}
            maxLength={TAB_GROUP_NAME_MAX}
            spellCheck={false}
            autoFocus
            onChange={(e) => onGroupUpdate(editedGroup.id, { name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
                setGroupEdit(null)
              }
            }}
          />
          <div className="tab-group-colors" role="radiogroup">
            {TAB_GROUP_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={c === editedGroup.color}
                className={`tab-group-swatch${c === editedGroup.color ? ' is-on' : ''}`}
                style={groupColorStyle(c)}
                title={t(`tabs.groupColor.${c}`)}
                aria-label={t(`tabs.groupColor.${c}`)}
                onClick={() => onGroupUpdate(editedGroup.id, { color: c })}
              />
            ))}
          </div>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              onGroupToggle(editedGroup.id)
              setGroupEdit(null)
            }}
          >
            {t(editedGroup.collapsed ? 'tabs.groupExpand' : 'tabs.groupCollapse')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              onGroupUngroup(editedGroup.id)
              setGroupEdit(null)
            }}
          >
            {t('tabs.groupUngroup')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              onGroupClose(editedGroup.id)
              setGroupEdit(null)
            }}
          >
            {t('tabs.groupClose')}
          </button>
        </div>
      )}
    </div>
  )
}

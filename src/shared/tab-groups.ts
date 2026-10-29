// Tab groups (Emil, 2026-10-29): a named, coloured run of tabs that folds away
// to one chip, so the documents of a task not being worked on right now — the
// disputas, the trial lecture, the handbooks — leave the strip without being
// closed. Folding is the point; a group that could not fold would be colour
// alone, and its upkeep would cost more than it gives.
//
// The rules, held by test:tab-groups:
//
//  - A group's members are ONE unbroken run of the strip; the chip stands in
//    front of the run. The group's place is its members' place — there is no
//    separate group order to keep in step.
//  - A pinned tab is never in a group (the pinned run is the strip's start).
//  - A group with no members is gone.
//  - The tab being read is never hidden: folding its group moves the reader to
//    the nearest tab outside it, and showing a tab in a folded group unfolds it.
//  - Moving a tab by drag: dropped between two members it joins their group;
//    dropped beside its own group's members it stays; anywhere else it leaves.
//    By keyboard (Ctrl+Shift+PageUp/PageDown) one step at a time, as the
//    browsers do: a tab at its group's edge first steps OUT of the group where
//    it stands, a tab beside an open group first steps IN, a folded group is
//    stepped over whole. A group's chip drags the whole group, folded or not.
//  - A tab opened from a grouped tab (an attachment) joins that group; one
//    opened from outside — Explorer, the library — goes last, ungrouped.
//  - Grouping lives in the right-click menus only (Emil, 2026-10-29: the
//    strip stays clean — no extra buttons on the tabs or the chip).
//  - A stored group list is untrusted input (sanitizeGroups).
import type { TabGroup, TabGroupColor } from './types'

export const TAB_GROUP_COLORS: readonly TabGroupColor[] = ['blue', 'green', 'yellow', 'red', 'purple', 'grey']
export const TAB_GROUP_NAME_MAX = 60
/** More than a strip can show; few enough that a corrupt file cannot stall */
export const TAB_GROUPS_MAX = 50

export interface GroupableTab {
  id: string
  pinned?: boolean
  groupId?: string | null
}

const groupOf = (tab: GroupableTab | undefined): string | null => tab?.groupId ?? null

/** Mend whatever broke the rules above: a pinned tab, an unknown id or a
 *  member cut off from its run leaves its group (the FIRST run keeps it), a
 *  group without members goes. The same arrays come back when nothing broke,
 *  so a caller can compare by identity. */
export function normalizeGroups<T extends GroupableTab>(
  tabs: readonly T[],
  groups: readonly TabGroup[]
): { tabs: T[]; groups: TabGroup[] } {
  const known = new Set(groups.map((g) => g.id))
  const ended = new Set<string>()
  let prev: string | null = null
  let tabsChanged = false
  const nextTabs = tabs.map((tab) => {
    let g = groupOf(tab)
    if (g !== null && (tab.pinned || !known.has(g) || ended.has(g))) g = null
    if (prev !== null && prev !== g) ended.add(prev)
    prev = g
    if (g === groupOf(tab)) return tab
    tabsChanged = true
    return { ...tab, groupId: null }
  })
  const used = new Set(nextTabs.map(groupOf))
  const seen = new Set<string>()
  const nextGroups = groups.filter((g) => {
    if (!used.has(g.id) || seen.has(g.id)) return false
    seen.add(g.id)
    return true
  })
  return {
    tabs: tabsChanged ? nextTabs : (tabs as T[]),
    groups: nextGroups.length === groups.length ? (groups as TabGroup[]) : nextGroups
  }
}

export type StripItem<T> =
  | { kind: 'group'; group: TabGroup; members: T[] }
  | {
      kind: 'tab'
      tab: T
      /** Index into the full tab list (what a reorder addresses) */
      index: number
      group: TabGroup | null
      /** The last member of its group's run — where the group's line ends */
      last: boolean
    }

/** The strip as drawn: a chip in front of each group's run, the members of a
 *  folded group left out */
export function stripItems<T extends GroupableTab>(tabs: readonly T[], groups: readonly TabGroup[]): StripItem<T>[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const items: StripItem<T>[] = []
  tabs.forEach((tab, index) => {
    const id = groupOf(tab)
    const group = id === null ? null : (byId.get(id) ?? null)
    if (group && groupOf(tabs[index - 1]) !== group.id) {
      items.push({ kind: 'group', group, members: tabs.filter((t) => groupOf(t) === group.id) })
    }
    if (group?.collapsed) return
    items.push({ kind: 'tab', tab, index, group, last: group !== null && groupOf(tabs[index + 1]) !== group.id })
  })
  return items
}

function collapsedIds(groups: readonly TabGroup[]): Set<string> {
  return new Set(groups.filter((g) => g.collapsed).map((g) => g.id))
}

/** Whether a tab is folded away */
export function isHidden(tab: GroupableTab, groups: readonly TabGroup[]): boolean {
  const g = groupOf(tab)
  return g !== null && collapsedIds(groups).has(g)
}

/** The tabs the strip shows — what Ctrl+Tab walks and Ctrl+1–9 count */
export function visibleTabs<T extends GroupableTab>(tabs: readonly T[], groups: readonly TabGroup[]): T[] {
  const folded = collapsedIds(groups)
  return tabs.filter((t) => !folded.has(groupOf(t) ?? ''))
}

/** The first colour no group carries yet, else round the palette again */
export function nextGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  const used = new Set(groups.map((g) => g.color))
  return TAB_GROUP_COLORS.find((c) => !used.has(c)) ?? TAB_GROUP_COLORS[groups.length % TAB_GROUP_COLORS.length]
}

/** [first, last] index of a group's run, or null */
function runOf(tabs: readonly GroupableTab[], groupId: string): [number, number] | null {
  const first = tabs.findIndex((t) => groupOf(t) === groupId)
  if (first === -1) return null
  let last = first
  while (groupOf(tabs[last + 1]) === groupId) last++
  return [first, last]
}

/** Take a tab out of its group: it goes to just after the group's run, so
 *  the run stays unbroken */
function detach<T extends GroupableTab>(tabs: readonly T[], id: string): T[] {
  const at = tabs.findIndex((t) => t.id === id)
  if (at === -1) return [...tabs]
  const g = groupOf(tabs[at])
  if (g === null) return [...tabs]
  const run = runOf(tabs, g)!
  const next = [...tabs]
  const [tab] = next.splice(at, 1)
  next.splice(run[1], 0, { ...tab, groupId: null })
  return next
}

/** A new group holding this one tab (never a pinned one). A tab already in a
 *  group steps out of that run first. */
export function groupTab<T extends GroupableTab>(tabs: readonly T[], id: string, groupId: string): T[] {
  const tab = tabs.find((t) => t.id === id)
  if (!tab || tab.pinned) return [...tabs]
  return detach(tabs, id).map((t) => (t.id === id ? { ...t, groupId } : t))
}

/** Add a tab to an existing group: it joins the END of the group's run */
export function addToGroup<T extends GroupableTab>(tabs: readonly T[], id: string, groupId: string): T[] {
  const tab = tabs.find((t) => t.id === id)
  if (!tab || tab.pinned || groupOf(tab) === groupId) return [...tabs]
  const next = detach(tabs, id)
  const at = next.findIndex((t) => t.id === id)
  const [moved] = next.splice(at, 1)
  const run = runOf(next, groupId)
  if (!run) return tabs.map((t) => t)
  next.splice(run[1] + 1, 0, { ...moved, groupId })
  return next
}

export function removeFromGroup<T extends GroupableTab>(tabs: readonly T[], id: string): T[] {
  return detach(tabs, id)
}

/** Every member let go, in place */
export function ungroup<T extends GroupableTab>(tabs: readonly T[], groupId: string): T[] {
  return tabs.map((t) => (groupOf(t) === groupId ? { ...t, groupId: null } : t))
}

/** A drag: the tab takes `toIndex` (pinned and unpinned tabs each stay in
 *  their own run), and its group follows from where it lands */
export function moveTab<T extends GroupableTab>(tabs: readonly T[], id: string, toIndex: number): T[] {
  const from = tabs.findIndex((t) => t.id === id)
  if (from === -1) return tabs as T[]
  const pinnedCount = tabs.filter((t) => t.pinned).length
  const [lo, hi] = tabs[from].pinned ? [0, pinnedCount - 1] : [pinnedCount, tabs.length - 1]
  const to = Math.max(lo, Math.min(hi, toIndex))
  if (from === to) return tabs as T[]
  const next = [...tabs]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  if (moved.pinned) return next
  const left = groupOf(next[to - 1])
  const right = groupOf(next[to + 1])
  const own = groupOf(moved)
  const g = left !== null && left === right ? left : own !== null && (left === own || right === own) ? own : null
  if (g !== own) next[to] = { ...moved, groupId: g }
  return next
}

/** A drag of a group's chip (Emil, 2026-10-29: a folded group must move as
 *  one): the whole run goes past `targetId` — after it when the run started
 *  left of it, before it otherwise. It never lands inside another group's
 *  run (it goes to that run's far edge instead) nor in the pinned run. */
export function moveGroup<T extends GroupableTab>(tabs: readonly T[], groupId: string, targetId: string): T[] {
  const run = runOf(tabs, groupId)
  const target = tabs.findIndex((t) => t.id === targetId)
  if (!run || target === -1 || groupOf(tabs[target]) === groupId) return tabs as T[]
  const members = tabs.slice(run[0], run[1] + 1)
  const rest = [...tabs.slice(0, run[0]), ...tabs.slice(run[1] + 1)]
  const rightward = run[0] < target
  const j = rest.findIndex((t) => t.id === targetId)
  let at = rightward ? j + 1 : j
  // Not inside another group: to its far edge in the direction of travel
  const there = groupOf(rest[at])
  if (there !== null && groupOf(rest[at - 1]) === there) {
    const [first, last] = runOf(rest, there)!
    at = rightward ? last + 1 : first
  }
  at = Math.max(at, rest.filter((t) => t.pinned).length)
  const next = [...rest.slice(0, at), ...members, ...rest.slice(at)]
  return next.every((t, i) => t === tabs[i]) ? (tabs as T[]) : next
}

/** Where a tab opened FROM another tab goes (an attachment opened from a
 *  filing): into the opener's group, at the end of its run. Opened from an
 *  ungrouped or pinned tab, or from nowhere — the library, Explorer — it
 *  goes last in the strip, outside any group. */
export function insertOpened<T extends GroupableTab>(tabs: readonly T[], tab: T, openerId: string | null): T[] {
  const opener = openerId === null ? undefined : tabs.find((t) => t.id === openerId)
  const g = opener && !opener.pinned ? groupOf(opener) : null
  if (g === null) return [...tabs, { ...tab, groupId: null }]
  const [, last] = runOf(tabs, g)!
  return [...tabs.slice(0, last + 1), { ...tab, groupId: g }, ...tabs.slice(last + 1)]
}

/** One keyboard step left (-1) or right (+1) — see the rules at the top */
export function stepTab<T extends GroupableTab>(
  tabs: readonly T[],
  groups: readonly TabGroup[],
  id: string,
  delta: -1 | 1
): T[] {
  const at = tabs.findIndex((t) => t.id === id)
  if (at === -1) return tabs as T[]
  const tab = tabs[at]
  const neighbour = tabs[at + delta]
  if (!neighbour || neighbour.pinned !== tab.pinned) return tabs as T[]
  const own = groupOf(tab)
  const theirs = groupOf(neighbour)
  const swap = (to: number): T[] => {
    const next = [...tabs]
    const [moved] = next.splice(at, 1)
    next.splice(to, 0, moved)
    return next
  }
  // At the edge of its own group: out, where it stands
  if (own !== null && theirs !== own) return tabs.map((t) => (t.id === id ? { ...t, groupId: null } : t))
  if (theirs !== null && theirs !== own) {
    const group = groups.find((g) => g.id === theirs)
    // A folded group is stepped over whole
    if (group?.collapsed) {
      const [first, last] = runOf(tabs, theirs)!
      return swap(delta > 0 ? last : first)
    }
    // Beside an open group: in, where it stands
    return tabs.map((t) => (t.id === id ? { ...t, groupId: theirs } : t))
  }
  return swap(at + delta)
}

/** Who is shown once `groupId` folds: the tab shown now when it is outside
 *  the group; else the nearest one the strip still shows — after the group
 *  first, as the browsers do — and null when there is none (the library). */
export function activeAfterCollapse(
  tabs: readonly GroupableTab[],
  groups: readonly TabGroup[],
  groupId: string,
  activeId: string | null
): string | null {
  const active = tabs.find((t) => t.id === activeId)
  if (!active || groupOf(active) !== groupId) return activeId
  const folded = collapsedIds(groups)
  folded.add(groupId)
  const shown = (t: GroupableTab): boolean => !folded.has(groupOf(t) ?? '')
  const run = runOf(tabs, groupId)!
  const after = tabs.slice(run[1] + 1).find(shown)
  if (after) return after.id
  const before = tabs.slice(0, run[0]).reverse().find(shown)
  return before?.id ?? null
}

/** Who is shown once the tab at `closedIndex` has closed (`tabs` is the list
 *  without it): the tab that took its place, unless that one is folded away —
 *  then the nearest shown one, rightwards first. A strip with only folded
 *  tabs left gives the one at the place (showing it unfolds its group). */
export function activeAfterClose(
  tabs: readonly GroupableTab[],
  groups: readonly TabGroup[],
  closedIndex: number
): string | null {
  if (tabs.length === 0) return null
  const at = Math.min(closedIndex, tabs.length - 1)
  const folded = collapsedIds(groups)
  const shown = (t: GroupableTab): boolean => !folded.has(groupOf(t) ?? '')
  const pick = tabs.slice(at).find(shown) ?? tabs.slice(0, at).reverse().find(shown) ?? tabs[at]
  return pick.id
}

/** A stored group list, shape-checked: a known colour (else grey), a name cut
 *  to its cap, an id once, `collapsed` only when it says true */
export function sanitizeGroups(raw: unknown): TabGroup[] {
  if (!Array.isArray(raw)) return []
  const out: TabGroup[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= TAB_GROUPS_MAX) break
    if (!item || typeof item !== 'object') continue
    const { id, name, color, collapsed } = item as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || id.length > 64 || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: typeof name === 'string' ? name.slice(0, TAB_GROUP_NAME_MAX) : '',
      color: TAB_GROUP_COLORS.includes(color as TabGroupColor) ? (color as TabGroupColor) : 'grey',
      collapsed: collapsed === true
    })
  }
  return out
}

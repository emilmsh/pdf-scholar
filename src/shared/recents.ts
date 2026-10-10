// The rules for the library's «Nylig lest» list, in one place because two
// stores keep it: main's pdfx-state.json and the extension's chrome.storage.
// Both used to restate «newest first, at most RECENTS_MAX» inline; with pinning
// (issue #29) the list has three more operations and an invariant that is easy
// to get subtly wrong in two copies — a pinned entry must survive every trim,
// and opening it must not unpin it.
//
// Pure functions over plain arrays: no storage, no Electron, so
// scripts/test-recent-thumbs.mjs runs them as they are.
import type { RecentFile, RecentsGridSize } from './types'
import { RECENTS_MAX } from './defaults'

/** The stored list, shape-checked. A hand-edited or version-skewed state file
 *  can hold anything there; an entry that is not a path with a name and a date
 *  is dropped, and a path listed twice keeps its first (newest) entry. */
export function normalizeRecents(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RecentFile[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { path, name, lastOpened, pinnedAt } = r as Record<string, unknown>
    if (typeof path !== 'string' || path === '' || seen.has(path)) continue
    if (typeof name !== 'string') continue
    if (typeof lastOpened !== 'number' || !Number.isFinite(lastOpened)) continue
    seen.add(path)
    out.push(
      typeof pinnedAt === 'number' && Number.isFinite(pinnedAt)
        ? { path, name, lastOpened, pinnedAt }
        : { path, name, lastOpened }
    )
  }
  return out
}

/** Pinned entries all stay; the unpinned ones keep their order and the
 *  RECENTS_MAX newest of them. The cap therefore means «twenty recent files
 *  besides the ones you chose to keep», which is what a reader expects of it. */
export function trimRecents(list: RecentFile[]): RecentFile[] {
  let unpinned = 0
  return list.filter((r) => r.pinnedAt !== undefined || ++unpinned <= RECENTS_MAX)
}

/** The file was just opened: it goes to the top, keeping its pin. */
export function recordRecent(
  list: RecentFile[],
  path: string,
  name: string,
  now: number
): RecentFile[] {
  const pinnedAt = list.find((r) => r.path === path)?.pinnedAt
  const entry: RecentFile = pinnedAt === undefined
    ? { path, name, lastOpened: now }
    : { path, name, lastOpened: now, pinnedAt }
  return trimRecents([entry, ...list.filter((r) => r.path !== path)])
}

export function removeRecent(list: RecentFile[], path: string): RecentFile[] {
  return list.filter((r) => r.path !== path)
}

/** Undo of a removal: the entry goes back where it was, with its own date and
 *  pin — `recordRecent` would file it as just opened. Anything opened since
 *  stays ahead of it, and the cap still applies. */
export function restoreRecent(list: RecentFile[], entry: RecentFile, index: number): RecentFile[] {
  const rest = list.filter((r) => r.path !== entry.path)
  const at = Math.max(0, Math.min(Math.floor(index), rest.length))
  return trimRecents([...rest.slice(0, at), entry, ...rest.slice(at)])
}

/** Pin or unpin in place. Unpinning does not trim: an old favourite let go of
 *  stays in the list until newer files push it out, rather than vanishing the
 *  moment the pin comes off. */
export function pinRecent(
  list: RecentFile[],
  path: string,
  pinned: boolean,
  now: number
): RecentFile[] {
  return list.map((r) => {
    if (r.path !== path) return r
    if (pinned) return r.pinnedAt === undefined ? { ...r, pinnedAt: now } : r
    if (r.pinnedAt === undefined) return r
    return { path: r.path, name: r.name, lastOpened: r.lastOpened }
  })
}

/** The library's two groups: «Festet» in pinning order, then the rest newest
 *  first (the list's own order). */
export function splitRecents(list: RecentFile[]): { pinned: RecentFile[]; recent: RecentFile[] } {
  const pinned = list
    .filter((r) => r.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
  return { pinned, recent: list.filter((r) => r.pinnedAt === undefined) }
}

const GRID_SIZES: readonly RecentsGridSize[] = ['small', 'medium', 'large']

export function recentsGridSizeOrDefault(value: unknown): RecentsGridSize {
  return GRID_SIZES.includes(value as RecentsGridSize) ? (value as RecentsGridSize) : 'medium'
}

/** One step smaller (-1) or larger (+1), stopping at either end */
export function stepRecentsGridSize(size: RecentsGridSize, dir: -1 | 1): RecentsGridSize {
  const i = GRID_SIZES.indexOf(recentsGridSizeOrDefault(size))
  return GRID_SIZES[Math.max(0, Math.min(GRID_SIZES.length - 1, i + dir))]
}

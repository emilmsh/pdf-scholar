// The desktop's session — which tabs each window had, for the next launch
// (issue #29). Main keeps one record per window as the renderers report their
// strips, writes them to pdfx-state.json, and at startup turns the stored
// record into the windows to open. The rules live here, Electron-free, so
// scripts/test-session.mjs checks them as they are:
//
//   - a stored session is untrusted input (a hand-edited or version-skewed
//     state file): anything that is not a list of paths is dropped, a path is
//     listed once per window, pinned tabs come first, `active` points at a tab
//   - restoreSession off still brings the PINNED tabs back — that is what a
//     pin means — gathered into one window
//   - a tab whose file is gone, or a temp copy, is left out rather than
//     reopened into an error; a window left with no tabs is not reopened
import type { SessionTab, SessionWindow } from './types'

/** Where a window stood, so several windows come back where they were */
export interface SessionBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface StoredSessionWindow extends SessionWindow {
  bounds?: SessionBounds
}

export interface StoredSession {
  windows: StoredSessionWindow[]
}

/** More than anyone keeps open, few enough that a corrupt file listing
 *  thousands cannot stall a launch */
export const SESSION_MAX_TABS = 200
export const SESSION_MAX_WINDOWS = 20

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function sanitizeBounds(raw: unknown): SessionBounds | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const b = raw as Record<string, unknown>
  if (!finite(b.width) || !finite(b.height) || b.width <= 0 || b.height <= 0) return undefined
  const out: SessionBounds = { width: b.width, height: b.height }
  if (finite(b.x) && finite(b.y)) {
    out.x = b.x
    out.y = b.y
  }
  if (b.maximized === true) out.maximized = true
  return out
}

/** One window's strip, shape-checked: valid paths once each, pinned first (in
 *  their own order), `active` clamped into the list — following its tab when
 *  the pinned ones move ahead of it. null when nothing usable is left. */
export function sanitizeSessionWindow(raw: unknown): StoredSessionWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  if (!Array.isArray(w.tabs)) return null
  const seen = new Set<string>()
  const tabs: SessionTab[] = []
  let activePath: string | null = null
  w.tabs.slice(0, SESSION_MAX_TABS).forEach((t, i) => {
    if (!t || typeof t !== 'object') return
    const { path, pinned } = t as Record<string, unknown>
    if (typeof path !== 'string' || path === '' || seen.has(path)) return
    seen.add(path)
    tabs.push(pinned === true ? { path, pinned: true } : { path })
    if (i === w.active) activePath = path
  })
  if (tabs.length === 0) return null
  const ordered = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
  const active = Math.max(0, ordered.findIndex((t) => t.path === activePath))
  const bounds = sanitizeBounds(w.bounds)
  return bounds ? { tabs: ordered, active, bounds } : { tabs: ordered, active }
}

export function sanitizeSession(raw: unknown): StoredSession {
  if (!raw || typeof raw !== 'object') return { windows: [] }
  const list = (raw as Record<string, unknown>).windows
  if (!Array.isArray(list)) return { windows: [] }
  const windows: StoredSessionWindow[] = []
  for (const w of list.slice(0, SESSION_MAX_WINDOWS)) {
    const clean = sanitizeSessionWindow(w)
    if (clean) windows.push(clean)
  }
  return { windows }
}

/** Keep only the tabs `keep` accepts; the active tab follows its document, or
 *  falls to the first tab when its own was dropped */
function filterWindow(w: StoredSessionWindow, keep: (path: string) => boolean): StoredSessionWindow | null {
  const activePath = w.tabs[w.active]?.path
  const tabs = w.tabs.filter((t) => keep(t.path))
  if (tabs.length === 0) return null
  const active = Math.max(0, tabs.findIndex((t) => t.path === activePath))
  return w.bounds ? { tabs, active, bounds: w.bounds } : { tabs, active }
}

/** The windows to open at launch, first one first. `restoreAll` is the
 *  restoreSession setting; `keep` says whether a path is worth reopening (the
 *  file still exists, and is not a temp copy). With restoreAll off, every
 *  window's pinned tabs come back in ONE window — a pin is a promise the tab
 *  will be there, not that the window layout will. */
export function restorePlan(
  session: StoredSession,
  restoreAll: boolean,
  keep: (path: string) => boolean
): StoredSessionWindow[] {
  if (restoreAll) {
    return session.windows
      .map((w) => filterWindow(w, keep))
      .filter((w): w is StoredSessionWindow => w !== null)
  }
  const seen = new Set<string>()
  const pinned: SessionTab[] = []
  for (const w of session.windows) {
    for (const t of w.tabs) {
      if (t.pinned && !seen.has(t.path) && keep(t.path)) {
        seen.add(t.path)
        pinned.push(t)
      }
    }
  }
  return pinned.length > 0 ? [{ tabs: pinned, active: 0 }] : []
}

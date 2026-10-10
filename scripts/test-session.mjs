// The desktop's session rules (src/shared/session.ts, issue #29): what a stored
// session may hold, and which windows and tabs a launch reopens.
//
// What would go wrong silently without these: a hand-edited or version-skewed
// state file reopening junk (or thousands of tabs) at every launch; pinned
// tabs landing behind the others; the tab that was showing losing its place
// when the pinned ones move ahead of it; restoreSession off ALSO dropping the
// pinned tabs (a pin is a promise the tab comes back); a missing file reopened
// into an error tab; an empty window reopened for nothing.
// Run: node scripts/test-session.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/session.ts', import.meta.url))
const outfile = join(mkdtempSync(join(tmpdir(), 'session-build-')), 'session.mjs')
await build({ entryPoints: [SRC], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const S = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const names = (w) => (w ? w.tabs.map((t) => (t.pinned ? `*${t.path}` : t.path)).join(',') : 'null')

console.log('\n1. one window, shape-checked')
{
  const w = S.sanitizeSessionWindow({
    tabs: [{ path: 'a' }, { path: 'b', pinned: true }, null, { path: '' }, { path: 'a' }, { path: 7 }, { path: 'c', pinned: 'yes' }, { path: 'd', pinned: true }],
    active: 0
  })
  check('junk dropped, a path once, pinned first in their own order', names(w) === '*b,*d,a,c', names(w))
  check('the active tab follows its document past the pinned ones', w.tabs[w.active].path === 'a', `active=${w.active}`)
  check('a pin that is not `true` is no pin', !w.tabs.find((t) => t.path === 'c').pinned)

  const act = S.sanitizeSessionWindow({ tabs: [{ path: 'x' }, { path: 'y', pinned: true }], active: 1 })
  check('active on a pinned tab stays on it', act.tabs[act.active].path === 'y')
  const out = S.sanitizeSessionWindow({ tabs: [{ path: 'x' }], active: 9 })
  check('an active index past the end falls to the first tab', out.active === 0)
  check('no tabs: no window', S.sanitizeSessionWindow({ tabs: [] }) === null && S.sanitizeSessionWindow({ tabs: [null] }) === null)
  check('not an object: no window', S.sanitizeSessionWindow('tabs') === null && S.sanitizeSessionWindow(null) === null)

  const many = S.sanitizeSessionWindow({ tabs: Array.from({ length: 1000 }, (_, i) => ({ path: `p${i}` })), active: 0 })
  check(`at most ${S.SESSION_MAX_TABS} tabs`, many.tabs.length === S.SESSION_MAX_TABS)

  const b = S.sanitizeSessionWindow({ tabs: [{ path: 'a' }], active: 0, bounds: { x: 10, y: 20, width: 800, height: 600, maximized: true } })
  check('bounds survive whole', b.bounds && b.bounds.x === 10 && b.bounds.width === 800 && b.bounds.maximized === true)
  const nb = S.sanitizeSessionWindow({ tabs: [{ path: 'a' }], active: 0, bounds: { width: -1, height: 600 } })
  check('nonsense bounds are dropped, the window kept', nb && !('bounds' in nb))
  const np = S.sanitizeSessionWindow({ tabs: [{ path: 'a' }], active: 0, bounds: { width: 800, height: 600, x: 'left' } })
  check('a size without a position keeps the size only', np.bounds.width === 800 && !('x' in np.bounds))
}

console.log('\n2. the stored session')
{
  check('anything but {windows: [...]} is an empty session', S.sanitizeSession(null).windows.length === 0 && S.sanitizeSession({ windows: 'x' }).windows.length === 0)
  const s = S.sanitizeSession({ windows: [{ tabs: [{ path: 'a' }], active: 0 }, { tabs: [] }, 'junk', { tabs: [{ path: 'b' }], active: 0 }] })
  check('empty and junk windows are dropped, order kept', s.windows.map(names).join('|') === 'a|b', s.windows.map(names).join('|'))
  const lots = S.sanitizeSession({ windows: Array.from({ length: 99 }, () => ({ tabs: [{ path: 'a' }], active: 0 })) })
  check(`at most ${S.SESSION_MAX_WINDOWS} windows`, lots.windows.length === S.SESSION_MAX_WINDOWS)
}

console.log('\n3. what a launch reopens')
{
  const session = S.sanitizeSession({
    windows: [
      { tabs: [{ path: 'p1', pinned: true }, { path: 'a' }, { path: 'gone' }], active: 2, bounds: { x: 0, y: 0, width: 900, height: 700 } },
      { tabs: [{ path: 'gone2' }], active: 0 },
      { tabs: [{ path: 'p2', pinned: true }, { path: 'p1', pinned: true }, { path: 'b' }], active: 2 }
    ]
  })
  const exists = (p) => !p.startsWith('gone')
  const all = S.restorePlan(session, true, exists)
  check('every window with a tab left comes back, in order', all.map(names).join('|') === '*p1,a|*p2,*p1,b', all.map(names).join('|'))
  check('a missing file is left out', !all.some((w) => w.tabs.some((t) => t.path.startsWith('gone'))))
  check('…and a showing tab that went missing hands over to the first', all[0].active === 0)
  check('the active tab otherwise stays', all[1].tabs[all[1].active].path === 'b')
  check('bounds ride along', all[0].bounds?.width === 900)

  const pinnedOnly = S.restorePlan(session, false, exists)
  check('restoreSession off: one window of the pinned tabs', pinnedOnly.length === 1 && names(pinnedOnly[0]) === '*p1,*p2', names(pinnedOnly[0]))
  check('…the same pin in two windows comes back once', pinnedOnly[0].tabs.filter((t) => t.path === 'p1').length === 1)
  check('…no bounds: it is not a window that existed', !('bounds' in pinnedOnly[0]))
  check('nothing pinned, restore off: nothing', S.restorePlan(S.sanitizeSession({ windows: [{ tabs: [{ path: 'a' }], active: 0 }] }), false, exists).length === 0)
  check('an empty session reopens nothing', S.restorePlan({ windows: [] }, true, exists).length === 0)
  check('a pinned file that is gone stays gone', S.restorePlan(S.sanitizeSession({ windows: [{ tabs: [{ path: 'gone', pinned: true }], active: 0 }] }), false, exists).length === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

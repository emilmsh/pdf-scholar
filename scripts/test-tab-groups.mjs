// Tab groups (src/shared/tab-groups.ts, Emil 2026-10-29): a named, coloured run
// of tabs that folds away to one chip. And their way through the stored
// session (src/shared/session.ts).
//
// What would go wrong silently without these: a group split in two by a drag
// or a close (two chips for one group); a pinned tab inside a group; an empty
// group's chip left standing; the tab being read folded away out of sight;
// Ctrl+Tab and Ctrl+1–9 landing on tabs the strip does not show; a keyboard
// move that can never leave a group, or walks into the middle of a folded
// one; a stored session's groups reopening garbage or a group with no tabs.
// Run: node scripts/test-tab-groups.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'tab-groups-'))
async function load(rel, name) {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}
const G = await load('../src/shared/tab-groups.ts', 'tab-groups')
const S = await load('../src/shared/session.ts', 'session')

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// A strip written as 'a b:G c:G *p d:H' — `:X` a group, `*` pinned
const strip = (s) =>
  s.split(' ').map((w) => {
    const pinned = w.startsWith('*')
    const [id, g] = w.replace('*', '').split(':')
    return { id, ...(pinned ? { pinned: true } : {}), groupId: g ?? null }
  })
const show = (tabs) => tabs.map((t) => `${t.pinned ? '*' : ''}${t.id}${t.groupId ? ':' + t.groupId : ''}`).join(' ')
const group = (id, collapsed = false, color = 'blue') => ({ id, name: id, color, collapsed })

// --- normalizeGroups --------------------------------------------------------------
{
  const tabs = strip('a:G b:G c')
  const groups = [group('G')]
  const n = G.normalizeGroups(tabs, groups)
  eq(n.tabs === tabs && n.groups === groups, true, 'a sound strip comes back as the same arrays')
}
eq(show(G.normalizeGroups(strip('a:G b c:G'), [group('G')]).tabs), 'a:G b c', 'a member cut off from its run leaves; the first run keeps the group')
eq(show(G.normalizeGroups(strip('*a:G b:G'), [group('G')]).tabs), '*a b:G', 'a pinned tab is never in a group')
eq(show(G.normalizeGroups(strip('a:X b'), [group('G')]).tabs), 'a b', 'an unknown group id is dropped')
eq(G.normalizeGroups(strip('a b'), [group('G')]).groups, [], 'a group without members is gone')
eq(G.normalizeGroups(strip('a:G'), [group('G'), group('G')]).groups.length, 1, 'a group listed twice is kept once')

// --- stripItems / visibleTabs --------------------------------------------------------
{
  const items = G.stripItems(strip('a b:G c:G d'), [group('G')])
  eq(
    items.map((i) => (i.kind === 'group' ? `[${i.group.id}:${i.members.length}]` : `${i.tab.id}${i.last ? '|' : ''}`)),
    ['a', '[G:2]', 'b', 'c|', 'd'],
    'the chip stands in front of its run; the last member ends the line'
  )
  eq(items[4].index, 3, 'a tab item keeps its index into the whole list, not the drawn one')
  const folded = G.stripItems(strip('a b:G c:G d'), [group('G', true)])
  eq(
    folded.map((i) => (i.kind === 'group' ? `[${i.group.id}:${i.members.length}]` : i.tab.id)),
    ['a', '[G:2]', 'd'],
    'a folded group is its chip alone, with its count'
  )
  eq(folded[2].index, 3, 'indexes past a folded group still address the whole list')
}
eq(show(G.visibleTabs(strip('a b:G c:G d e:H'), [group('G', true), group('H')])), 'a d e:H', 'visible = not in a folded group')
eq(G.isHidden({ id: 'b', groupId: 'G' }, [group('G', true)]), true, 'isHidden: in a folded group')
eq(G.isHidden({ id: 'a', groupId: null }, [group('G', true)]), false, 'isHidden: in no group')

// --- nextGroupColor --------------------------------------------------------------------
eq(G.nextGroupColor([]), 'blue', 'the first group is blue')
eq(G.nextGroupColor([group('A', false, 'blue'), group('B', false, 'yellow')]), 'green', 'the first colour no group carries')
eq(
  G.nextGroupColor(G.TAB_GROUP_COLORS.map((c, i) => group(`g${i}`, false, c))),
  'blue',
  'all carried: round the palette again'
)

// --- making and leaving groups ---------------------------------------------------------
eq(show(G.groupTab(strip('a b c'), 'b', 'N')), 'a b:N c', 'a new group holds the tab where it stands')
eq(show(G.groupTab(strip('a:G b:G c:G d'), 'a', 'N')), 'a:N b:G c:G d', 'a grouped tab at its run\'s edge leaves where it stands')
eq(show(G.groupTab(strip('a:G b:G c:G d'), 'b', 'N')), 'a:G c:G b:N d', 'from inside a run: just past it, so the run stays whole')
eq(show(G.groupTab(strip('*a b'), 'a', 'N')), '*a b', 'a pinned tab gets no group')
eq(show(G.addToGroup(strip('a:G b:G c d'), 'd', 'G')), 'a:G b:G d:G c', 'added: joins the END of the run')
eq(show(G.addToGroup(strip('a:H b:G c:G'), 'a', 'G')), 'b:G c:G a:G', 'from another group: leaves it and joins the end')
eq(show(G.addToGroup(strip('*a b:G'), 'a', 'G')), '*a b:G', 'a pinned tab is not added')
eq(show(G.removeFromGroup(strip('a:G b:G c:G d'), 'a')), 'a b:G c:G d', 'the first member is let go where it stands')
eq(show(G.removeFromGroup(strip('a:G b:G c:G d'), 'b')), 'a:G c:G b d', 'one from inside: just past the run, so it stays whole')
eq(show(G.removeFromGroup(strip('a:G b:G c'), 'b')), 'a:G b c', 'the last member is let go where it stands')
eq(show(G.ungroup(strip('a:G b:G c:H'), 'G')), 'a b c:H', 'ungroup lets every member go, in place')

// --- several tabs in one step (Ctrl/Shift+click) -------------------------------------------
eq(show(G.groupTabs(strip('a b c d e'), ['b', 'd'], 'N')), 'a b:N d:N c e', 'grouped together: gathered where the first stood')
eq(show(G.groupTabs(strip('a:G b:G c d'), ['b', 'd'], 'N')), 'a:G b:N d:N c', 'one from a group\'s edge: the new group starts there')
eq(show(G.groupTabs(strip('a:G b:G c:G d'), ['b', 'd'], 'N')), 'a:G c:G b:N d:N', 'one from inside a group: gathered past that run')
eq(show(G.groupTabs(strip('*p a b'), ['p', 'a', 'b'], 'N')), '*p a:N b:N', 'pinned tabs are left out')
{
  const tabs = strip('*p a')
  eq(G.groupTabs(tabs, ['p'], 'N') === tabs, true, 'only pinned picked: nothing')
}
eq(show(G.addTabsToGroup(strip('a b:G c d'), ['a', 'd'], 'G')), 'b:G a:G d:G c', 'added together: the end of the run, in strip order')
eq(show(G.addTabsToGroup(strip('a:G b c:H'), ['a', 'b', 'c'], 'G')), 'a:G b:G c:G', 'a member already in it stays; the rest join after it')
eq(show(G.removeTabsFromGroups(strip('a:G b:G c:G d:H e:H'), ['a', 'b', 'd'])), 'a b c:G d e:H', 'let go together, from two groups, order kept')
eq(show(G.removeTabsFromGroups(strip('a:G b:G c:G d:G'), ['b', 'c'])), 'a:G d:G b c', 'from inside: past the run, in their order')
{
  const tabs = strip('a b')
  eq(G.removeTabsFromGroups(tabs, ['a']) === tabs, true, 'none grouped: the same array')
}
eq(G.tabRange(strip('a b:F c:F d e'), [group('F', true)], 'a', 'e'), ['a', 'd', 'e'], 'Shift+click: the shown tabs between, a folded group skipped')
eq(G.tabRange(strip('a b c'), [], 'c', 'a'), ['a', 'b', 'c'], 'either direction, in strip order')
eq(G.tabRange(strip('a b'), [], 'gone', 'b'), ['b'], 'no anchor: the tab alone')

// --- drag (placeTab) ------------------------------------------------------------------------
{
  const gs = [group('G'), group('F', true)]
  const p = (s, id, target) => show(G.placeTab(strip(s), gs, id, target))
  eq(p('x a:G b:G y', 'y', { kind: 'after', id: 'a' }), 'x a:G y:G b:G', 'beside a member: in its group')
  eq(p('x a:G b:G y', 'y', { kind: 'after', id: 'b' }), 'x a:G b:G y:G', 'after the LAST member: in the group (the old rule could not)')
  eq(p('x a:G b:G y', 'x', { kind: 'before', id: 'a' }), 'x:G a:G b:G y', 'before the FIRST member: in the group, after its chip')
  eq(p('x a:G b:G y', 'x', { kind: 'chipAfter', groupId: 'G' }), 'x:G a:G b:G y', 'after an open group\'s chip: its first member')
  eq(p('a:G b:G y', 'a', { kind: 'chipBefore', groupId: 'G' }), 'a b:G y', 'before the chip: out of the group, at its front')
  eq(p('a:G b:G y', 'b', { kind: 'before', id: 'y' }), 'a:G b y', 'before the next ungrouped tab: out, at its back')
  eq(p('a:G b:G', 'a', { kind: 'end' }), 'b:G a', 'past the last tab: last and ungrouped')
  eq(p('x a:F b:F y', 'x', { kind: 'chipAfter', groupId: 'F' }), 'a:F b:F x y', 'after a FOLDED group\'s chip: past the group, not into it')
  eq(p('*p *q a b', 'a', { kind: 'before', id: 'p' }), '*p *q a b', 'an unpinned tab stops at the pinned run')
  eq(p('*p *q a:G', 'p', { kind: 'after', id: 'a' }), '*q *p a:G', 'a pinned tab stays in the pinned run, ungrouped')
  {
    const tabs = strip('a b')
    eq(G.placeTab(tabs, gs, 'a', { kind: 'before', id: 'b' }) === tabs, true, 'no change: the same array')
    eq(G.placeTab(tabs, gs, 'a', { kind: 'after', id: 'a' }) === tabs, true, 'over itself: nothing')
  }
}
// Every drag keeps every group one run and the pinned run first
{
  const base = strip('*p a:G b:G c d:H e:H f g:F')
  const gs = [group('G'), group('H'), group('F', true)]
  const targets = [
    ...base.flatMap((t) => [{ kind: 'before', id: t.id }, { kind: 'after', id: t.id }]),
    ...['G', 'H', 'F'].flatMap((g) => [{ kind: 'chipBefore', groupId: g }, { kind: 'chipAfter', groupId: g }]),
    { kind: 'end' }
  ]
  let broken = 0
  for (const t of base) {
    for (const target of targets) {
      const moved = G.placeTab(base, gs, t.id, target)
      if (G.normalizeGroups(moved, gs).tabs !== moved || !moved[0].pinned) broken++
    }
  }
  eq(broken, 0, 'no drag anywhere breaks a run or puts a pinned tab in a group')
}

// --- dragging a whole group (moveGroup) ---------------------------------------------------------
eq(show(G.moveGroup(strip('a:G b:G x y'), 'G', 'x')), 'x a:G b:G y', 'rightward: the run goes after the target')
eq(show(G.moveGroup(strip('x y a:G b:G'), 'G', 'x')), 'a:G b:G x y', 'leftward: the run goes before the target')
eq(show(G.moveGroup(strip('a:G b:G c:H d:H e'), 'G', 'c')), 'c:H d:H a:G b:G e', 'never inside another group: past its far edge (rightward)')
eq(show(G.moveGroup(strip('c:H d:H a:G b:G'), 'G', 'd')), 'a:G b:G c:H d:H', 'never inside another group: before its start (leftward)')
eq(show(G.moveGroup(strip('*p x a:G'), 'G', 'p')), '*p a:G x', 'never into the pinned run')
{
  const tabs = strip('a:G b:G x')
  eq(G.moveGroup(tabs, 'G', 'a') === tabs, true, 'onto its own member: nothing')
  eq(G.moveGroup(strip('x a:G'), 'G', 'nope').length, 2, 'an unknown target: nothing')
}
{
  // Every group drag keeps every run whole and the pinned run first
  const base = strip('*p a:G b:G c d:H e:H f')
  let broken = 0
  for (const g of ['G', 'H']) {
    for (const t of base) {
      const moved = G.moveGroup(base, g, t.id)
      if (G.normalizeGroups(moved, [group('G'), group('H')]).tabs !== moved || !moved[0].pinned) broken++
    }
  }
  eq(broken, 0, 'no group drag breaks a run or passes the pinned run')
}

// --- a tab opened from a tab (insertOpened) ------------------------------------------------------
eq(show(G.insertOpened(strip('a b:G c:G d'), { id: 'n' }, 'b')), 'a b:G c:G n:G d', 'from a grouped tab: the end of its group')
eq(show(G.insertOpened(strip('a b:G'), { id: 'n' }, 'a')), 'a b:G n', 'from an ungrouped tab: last, ungrouped')
eq(show(G.insertOpened(strip('a b:G'), { id: 'n' }, null)), 'a b:G n', 'from outside: last, ungrouped')
eq(show(G.insertOpened(strip('a b:G'), { id: 'n' }, 'gone')), 'a b:G n', 'an opener that has closed: last')

// --- keyboard step (stepTab) ------------------------------------------------------------------
{
  const gs = [group('G'), group('F', true)]
  eq(show(G.stepTab(strip('a:G b:G c'), gs, 'b', 1)), 'a:G b c', 'at the edge of its group: steps out where it stands')
  eq(show(G.stepTab(strip('a b:G c:G'), gs, 'a', 1)), 'a:G b:G c:G', 'beside an open group: steps in where it stands')
  eq(show(G.stepTab(strip('a:G b:G c:G'), gs, 'a', 1)), 'b:G a:G c:G', 'inside a group: one place along')
  eq(show(G.stepTab(strip('a b:F c:F d'), gs, 'a', 1)), 'b:F c:F a d', 'a folded group is stepped over whole (right)')
  eq(show(G.stepTab(strip('a b:F c:F d'), gs, 'd', -1)), 'a d b:F c:F', 'a folded group is stepped over whole (left)')
  eq(show(G.stepTab(strip('*p a'), gs, 'a', -1)), '*p a', 'not into the pinned run')
  eq(show(G.stepTab(strip('a b'), gs, 'b', 1)), 'a b', 'not past the end')
}

// --- who is shown ---------------------------------------------------------------------------------
{
  const tabs = strip('a b:G c:G d')
  const gs = [group('G')]
  eq(G.activeAfterCollapse(tabs, gs, 'G', 'a'), 'a', 'folding another group: the shown tab stays')
  eq(G.activeAfterCollapse(tabs, gs, 'G', 'b'), 'd', 'folding the shown tab\'s group: the next tab after it')
  eq(G.activeAfterCollapse(strip('a b:G c:G'), gs, 'G', 'c'), 'a', 'none after: the nearest before')
  eq(G.activeAfterCollapse(strip('a:H b:G c:G'), [group('G'), group('H', true)], 'G', 'b'), null, 'only folded tabs left: none (the library)')
}
{
  const gs = [group('G', true)]
  eq(G.activeAfterClose(strip('a b:G c:G d'), gs, 1), 'd', 'closed before a folded group: passes over it')
  eq(G.activeAfterClose(strip('a b:G c:G'), gs, 1), 'a', 'nothing shown after: the nearest before')
  eq(G.activeAfterClose(strip('b:G c:G'), gs, 0), 'b', 'only folded tabs left: the one at the place')
  eq(G.activeAfterClose(strip('a b'), [], 5), 'b', 'past the end: the last')
  eq(G.activeAfterClose([], [], 0), null, 'no tabs: none')
}

// --- sanitizeGroups ------------------------------------------------------------------------------
{
  const clean = G.sanitizeGroups([
    { id: 'g1', name: 'Disputas', color: 'red', collapsed: true },
    { id: 'g1', name: 'twice' },
    null,
    'junk',
    { id: '', name: 'empty id' },
    { id: 7 },
    { id: 'g2', name: 'x'.repeat(500), color: 'chartreuse', collapsed: 'yes' },
    { id: 'g3' }
  ])
  eq(clean.map((g) => g.id), ['g1', 'g2', 'g3'], 'junk dropped, an id once')
  eq(clean[0], { id: 'g1', name: 'Disputas', color: 'red', collapsed: true }, 'a sound group is kept as it is')
  eq([clean[1].name.length, clean[1].color, clean[1].collapsed], [G.TAB_GROUP_NAME_MAX, 'grey', false], 'name capped, unknown colour grey, a non-true fold is open')
  eq([clean[2].name, clean[2].color], ['', 'grey'], 'missing fields take their defaults')
  eq(G.sanitizeGroups('nope'), [], 'not a list: none')
  eq(G.sanitizeGroups(Array.from({ length: 500 }, (_, i) => ({ id: `g${i}` }))).length, G.TAB_GROUPS_MAX, 'capped')
}

// --- through the stored session ----------------------------------------------------------------------
{
  const w = S.sanitizeSessionWindow({
    tabs: [{ path: 'a', group: 'G' }, { path: 'b', group: 'G' }, { path: 'c', group: 'X' }, { path: 'd', pinned: true, group: 'G' }, { path: 'e' }],
    active: 1,
    groups: [{ id: 'G', name: 'IO', color: 'green', collapsed: true }, { id: 'E', name: 'empty' }]
  })
  eq(w.tabs, [{ path: 'd', pinned: true }, { path: 'a', group: 'G' }, { path: 'b', group: 'G' }, { path: 'c' }, { path: 'e' }], 'pinned first and ungrouped; an unknown group reference dropped')
  eq(w.groups, [{ id: 'G', name: 'IO', color: 'green', collapsed: true }], 'a group with no tab is dropped')
  eq(w.tabs[w.active].path, 'b', 'the active tab follows its document')
}
{
  const w = S.sanitizeSessionWindow({ tabs: [{ path: 'a', group: 'G' }, { path: 'b' }, { path: 'c', group: 'G' }], active: 0, groups: [{ id: 'G' }] })
  eq(w.tabs.map((t) => t.group ?? '-'), ['G', '-', '-'], 'a stored group cut in two keeps its first run')
}
{
  const w = S.sanitizeSessionWindow({ tabs: [{ path: 'a' }], active: 0 })
  eq('groups' in w, false, 'no groups: no field (an old session reads as before)')
}
{
  const session = S.sanitizeSession({
    windows: [{ tabs: [{ path: 'a', group: 'G' }, { path: 'b', group: 'G' }, { path: 'c' }], active: 0, groups: [{ id: 'G', name: 'IO' }] }]
  })
  const [w] = S.restorePlan(session, true, (p) => p !== 'a' && p !== 'b')
  eq([w.tabs, 'groups' in w], [[{ path: 'c' }], false], 'a group whose files are all gone does not come back')
  const [kept] = S.restorePlan(session, true, (p) => p !== 'a')
  eq([kept.tabs, kept.groups.map((g) => g.id)], [[{ path: 'b', group: 'G' }, { path: 'c' }], ['G']], 'a group keeps the files still there')
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('tab-groups: all checks passed')

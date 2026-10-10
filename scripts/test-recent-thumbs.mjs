// The library's grid view (issue #28): the rules in src/shared/recent-thumbs.ts
// and desktop's picture store, src/main/recent-thumbs.ts, against a temp folder.
//
// What would go wrong silently without these: a picture of a LOCKED document
// kept on disk in the clear (the one thing the flag exists to prevent — also a
// cover left behind from before the file was encrypted); a renderer handing
// main something other than a small JPEG to write; pictures outliving the
// recents list they belong to; a progress line reading 140 % after a document
// lost pages; and the extension re-downloading a URL to draw a cover.
//
// Also the LIST rules both stores share (src/shared/recents.ts, issue #29):
// a pinned entry outlives the cap and keeps its pin when reopened, a removal
// takes the picture with it (store.forget, after any write in flight), and
// the undo puts an entry back where it was with its own date — not on top as
// if just opened.
// Run: node scripts/test-recent-thumbs.mjs
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SHARED = fileURLToPath(new URL('../src/shared/recent-thumbs.ts', import.meta.url))
const LIST = fileURLToPath(new URL('../src/shared/recents.ts', import.meta.url))
const DEFAULTS = fileURLToPath(new URL('../src/shared/defaults.ts', import.meta.url))
const STORE = fileURLToPath(new URL('../src/main/recent-thumbs.ts', import.meta.url))
const buildDir = mkdtempSync(join(tmpdir(), 'recent-thumbs-build-'))
const bundle = async (entry, name) => {
  const outfile = join(buildDir, name)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}
const rules = await bundle(SHARED, 'rules.mjs')
const { createRecentThumbStore } = await bundle(STORE, 'store.mjs')
const list = await bundle(LIST, 'recents.mjs')
const { RECENTS_MAX } = await bundle(DEFAULTS, 'defaults.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const jpeg = (n = 64, fill = 7) => {
  const b = new Uint8Array(n).fill(fill)
  b.set([0xff, 0xd8, 0xff, 0xe0])
  return b
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const same = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i])

// ---------- 1. Render scale ----------
console.log('\n1. render scale')
check('portrait Letter: long side lands on 480', Math.round(792 * rules.thumbScale(612, 792)) === 480)
check('landscape: the WIDTH is the long side', Math.round(792 * rules.thumbScale(792, 612)) === 480)
check('a page with no size draws at 1, not infinity', rules.thumbScale(0, 0) === 1)
check('NaN dimensions draw at 1', rules.thumbScale(NaN, NaN) === 1)

// ---------- 2. What a store accepts ----------
console.log('\n2. sanitizeRecentThumb')
const ok = rules.sanitizeRecentThumb({ image: jpeg(), pages: 12, taken: 1000 })
check('a small JPEG with a page count passes', !!ok && ok.pages === 12 && same(ok.image, jpeg()))
check('a Node Buffer is a Uint8Array too', !!rules.sanitizeRecentThumb({ image: Buffer.from(jpeg()), pages: 1, taken: 1 }))
check('no picture is fine (an XFA form)', JSON.stringify(rules.sanitizeRecentThumb({ pages: 3, taken: 5 })) === '{"pages":3,"taken":5}')
check('a PNG is refused — main writes these bytes to disk', rules.sanitizeRecentThumb({ image: png, pages: 1, taken: 1 }) === null)
check(
  'an oversized JPEG is refused',
  rules.sanitizeRecentThumb({ image: jpeg(rules.RECENT_THUMB_MAX_IMAGE_BYTES + 1), pages: 1, taken: 1 }) === null
)
check('an image that is not bytes is refused', rules.sanitizeRecentThumb({ image: [0xff, 0xd8, 0xff], pages: 1, taken: 1 }) === null)
const locked = rules.sanitizeRecentThumb({ image: jpeg(), pages: 9, locked: true, taken: 2 })
check('LOCKED never keeps a picture, even one handed over', !!locked && locked.locked === true && !('image' in locked))
check('a locked file with unknown pages (0) passes', !!rules.sanitizeRecentThumb({ pages: 0, locked: true, taken: 2 }))
for (const pages of [-1, 2.5, NaN, Infinity, '12', 2_000_000]) {
  check(`pages ${String(pages)} is refused`, rules.sanitizeRecentThumb({ pages, taken: 1 }) === null)
}
check('a missing timestamp is refused', rules.sanitizeRecentThumb({ pages: 1 }) === null)
check('null is refused', rules.sanitizeRecentThumb(null) === null)
check('a string is refused', rules.sanitizeRecentThumb('thumb') === null)

// ---------- 3. Housekeeping ----------
console.log('\n3. staleThumbPaths')
check(
  'pictures of files that left the recents go',
  JSON.stringify(rules.staleThumbPaths(['a', 'b', 'c'], ['c', 'a'])) === '["b"]'
)
check('nothing stored, nothing stale', rules.staleThumbPaths([], ['a']).length === 0)
check('an empty recents list empties the store', rules.staleThumbPaths(['a', 'b'], []).length === 2)

// ---------- 4. What the extension may read back ----------
console.log('\n4. thumbReadableInExtension')
check('a local file URL may be read', rules.thumbReadableInExtension('file:///C:/papers/a.pdf'))
check('the scheme is case-blind', rules.thumbReadableInExtension('FILE:///C:/a.pdf'))
check('an https URL is NOT downloaded again', !rules.thumbReadableInExtension('https://arxiv.org/pdf/1706.03762'))
check('an http URL is NOT downloaded again', !rules.thumbReadableInExtension('http://example.org/a.pdf'))
check('a picked (fsa:) file is not read without a click', !rules.thumbReadableInExtension('fsa:paper.pdf'))

// ---------- 5. Reading progress ----------
console.log('\n5. readingProgress')
const p = rules.readingProgress(12, 40)
check('p. 12 of 40 is 30 %', !!p && p.page === 12 && p.pages === 40 && Math.abs(p.fraction - 0.3) < 1e-9)
const past = rules.readingProgress(50, 40)
check('a page past the end reads as the last page, not 125 %', !!past && past.page === 40 && past.fraction === 1)
check('no reading position, no line', rules.readingProgress(undefined, 40) === null)
check('no page count (a locked file), no line', rules.readingProgress(3, 0) === null)
check('page 0 is garbage', rules.readingProgress(0, 10) === null)
check('NaN is garbage', rules.readingProgress(NaN, 10) === null)
check('a fractional page count is garbage', rules.readingProgress(1, 2.5) === null)

// ---------- 6. Desktop store ----------
console.log('\n6. desktop store')
const dir = mkdtempSync(join(tmpdir(), 'recent-thumbs-'))
const store = createRecentThumbStore(join(dir, 'recent-thumbs')) // created on first write
const A = 'C:\\Papers\\attention.pdf'
const B = 'C:\\Papers\\book.pdf'
const keyOf = (path) => createHash('sha1').update(path).digest('hex')

check('reading before anything is stored is empty, not an error', Object.keys(await store.get([A])).length === 0)
await store.prune([A]) // no folder yet
check('pruning a folder that does not exist is a no-op', true)

await store.set(A, { image: jpeg(80, 3), pages: 15, taken: 111 })
let got = await store.get([A, B])
check('a stored picture comes back byte for byte', !!got[A] && same(got[A].image, jpeg(80, 3)))
check('with its page count and stamp', got[A]?.pages === 15 && got[A]?.taken === 111)
check('an unknown path stays absent', !(B in got))

await store.set(A, { image: jpeg(90, 4), pages: 16, taken: 222 })
got = await store.get([A])
check('a later picture replaces the earlier one', same(got[A].image, jpeg(90, 4)) && got[A].taken === 222)

await store.set(A, { pages: 16, locked: true, taken: 333 })
got = await store.get([A])
check('a file that became locked reads as locked', got[A]?.locked === true && !got[A].image)
check(
  'and its old cover is GONE from disk',
  !existsSync(join(dir, 'recent-thumbs', `${keyOf(A)}.jpg`))
)

await store.set(B, { image: png, pages: 1, taken: 1 })
check('a non-JPEG is never written', !existsSync(join(dir, 'recent-thumbs', `${keyOf(B)}.json`)))

// The file name is a hash; a meta file claiming another path is not ours
writeFileSync(
  join(dir, 'recent-thumbs', `${keyOf(B)}.json`),
  JSON.stringify({ path: 'C:\\elsewhere.pdf', pages: 1, taken: 1, image: false })
)
check('a meta file whose path disagrees is ignored', !((await store.get([B]))[B]))
writeFileSync(join(dir, 'recent-thumbs', `${keyOf(B)}.json`), '{ not json')
check('a corrupt meta file reads as absent, not a throw', !((await store.get([B]))[B]))

// Two windows storing the same entry at once
await Promise.all([
  store.set(B, { image: jpeg(70, 5), pages: 2, taken: 444 }),
  store.set(B, { image: jpeg(70, 6), pages: 2, taken: 555 })
])
got = await store.get([B])
check(
  'two simultaneous stores queue: one whole entry, the later call winning',
  !!got[B]?.image && got[B].taken === 555 && same(got[B].image, jpeg(70, 6))
)

// Housekeeping: A leaves the recents; junk and temp files lie around
const folder = join(dir, 'recent-thumbs')
writeFileSync(join(folder, `${keyOf(A)}.jpg.999.1.tmp`), 'stale')
writeFileSync(join(folder, `${keyOf(B)}.jpg.999.2.tmp`), 'in flight')
writeFileSync(join(folder, 'desktop.ini'), 'junk')
await store.prune([B])
const left = readdirSync(folder).sort()
check(
  'prune keeps exactly the kept entry (and its write in flight)',
  JSON.stringify(left) ===
    JSON.stringify([`${keyOf(B)}.jpg`, `${keyOf(B)}.jpg.999.2.tmp`, `${keyOf(B)}.json`].sort()),
  left.join(', ')
)
check('the entry that left the recents is unreadable now', !((await store.get([A]))[A]))
await store.prune([])
check('an empty recents list empties the folder', readdirSync(folder).length === 0)

// forget(): one entry's files go, the others stay — and a write still in
// flight when the reader removes the entry does not bring the picture back
await store.set(A, { image: jpeg(), pages: 3, taken: 10 })
await store.set(B, { image: jpeg(), pages: 4, taken: 11 })
const late = store.set(A, { image: jpeg(128), pages: 3, taken: 12 })
await store.forget(A)
await late
check('forget removes the entry, even with a write of it in flight', !((await store.get([A]))[A]))
check('forget leaves the other entries alone', !!(await store.get([B]))[B])
check(
  'forget leaves no file of the entry behind',
  !readdirSync(folder).some((f) => f.startsWith(keyOf(A))),
  readdirSync(folder).join(', ')
)

console.log('\n7. the recents list (shared/recents.ts)')
{
  const entry = (i, extra = {}) => ({ path: `C:\\docs\\${i}.pdf`, name: `${i}.pdf`, lastOpened: 1000 + i, ...extra })
  const paths = (l) => l.map((r) => r.path.replace(/^.*\\/, '').replace('.pdf', '')).join(',')

  // normalize: junk dropped, duplicates keep the first, pin survives
  const norm = list.normalizeRecents([
    entry(1),
    { path: 'x.pdf', name: 'x.pdf' }, // no date
    null,
    'nonsense',
    entry(2, { pinnedAt: 5 }),
    entry(1, { lastOpened: 1 }),
    { path: 7, name: 'n', lastOpened: 1 },
    entry(3, { pinnedAt: 'yes' })
  ])
  check('normalize keeps the valid entries in order', paths(norm) === '1,2,3', paths(norm))
  check('normalize keeps a numeric pin', norm[1].pinnedAt === 5)
  check('normalize drops a pin that is not a number', !('pinnedAt' in norm[2]))
  check('normalize: anything but an array is an empty list', list.normalizeRecents({}).length === 0)

  // record: to the top, cap applies to the unpinned only
  let l = []
  for (let i = 1; i <= RECENTS_MAX + 5; i++) l = list.recordRecent(l, entry(i).path, entry(i).name, 1000 + i)
  check(`the cap holds at ${RECENTS_MAX}`, l.length === RECENTS_MAX, String(l.length))
  check('newest first', l[0].name === `${RECENTS_MAX + 5}.pdf`)
  const oldest = l[l.length - 1]
  l = list.pinRecent(l, oldest.path, true, 9000)
  for (let i = 100; i < 100 + RECENTS_MAX; i++) l = list.recordRecent(l, entry(i).path, entry(i).name, 2000 + i)
  check(
    'a pinned entry survives a whole cap of newer files',
    l.some((r) => r.path === oldest.path && r.pinnedAt === 9000)
  )
  check('…and the cap still counts twenty unpinned besides it', l.filter((r) => r.pinnedAt === undefined).length === RECENTS_MAX)
  l = list.recordRecent(l, oldest.path, oldest.name, 5000)
  check('reopening a pinned entry keeps its pin', l[0].path === oldest.path && l[0].pinnedAt === 9000 && l[0].lastOpened === 5000)

  // pin / unpin
  let p = [entry(1), entry(2), entry(3)]
  p = list.pinRecent(p, entry(3).path, true, 50)
  p = list.pinRecent(p, entry(1).path, true, 60)
  check('pinning twice keeps the first pin time', list.pinRecent(p, entry(3).path, true, 99)[2].pinnedAt === 50)
  const split = list.splitRecents(p)
  check('«Festet» lists in pinning order, not by date', paths(split.pinned) === '3,1', paths(split.pinned))
  check('the rest keep the list order', paths(split.recent) === '2', paths(split.recent))
  p = list.pinRecent(p, entry(3).path, false, 70)
  check('unpinning drops the pin', !('pinnedAt' in p[2]))
  // An unpinned old favourite is not trimmed the moment it is let go
  let full = []
  for (let i = 1; i <= RECENTS_MAX; i++) full.push(entry(i))
  full.push(entry(99, { pinnedAt: 1 }))
  full = list.pinRecent(full, entry(99).path, false, 2)
  check('unpinning never trims on the spot', full.length === RECENTS_MAX + 1)

  // remove + undo
  const before = [entry(1), entry(2, { pinnedAt: 3 }), entry(3)]
  const gone = list.removeRecent(before, entry(2).path)
  check('remove takes exactly that entry', paths(gone) === '1,3')
  const back = list.restoreRecent(gone, before[1], 1)
  check('undo puts it back at its index', paths(back) === '1,2,3', paths(back))
  check('undo keeps its own date and pin', back[1].lastOpened === before[1].lastOpened && back[1].pinnedAt === 3)
  const opened = list.recordRecent(gone, entry(7).path, entry(7).name, 9999)
  const back2 = list.restoreRecent(opened, before[1], 1)
  check('a file opened in between stays ahead of the restored one', paths(back2) === '7,2,1,3', paths(back2))
  check('undo of an entry already back is not a duplicate', list.restoreRecent(back, before[1], 0).length === 3)
  check('an index past the end lands at the end', paths(list.restoreRecent(gone, before[1], 99)) === '1,3,2')

  // grid sizes
  check('grid size: garbage reads as medium', list.recentsGridSizeOrDefault('huge') === 'medium')
  check('grid size steps and stops at the ends',
    list.stepRecentsGridSize('medium', 1) === 'large' &&
    list.stepRecentsGridSize('large', 1) === 'large' &&
    list.stepRecentsGridSize('small', -1) === 'small')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

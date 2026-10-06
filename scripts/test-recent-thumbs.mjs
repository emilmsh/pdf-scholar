// The library's grid view (issue #28): the rules in src/shared/recent-thumbs.ts
// and desktop's picture store, src/main/recent-thumbs.ts, against a temp folder.
//
// What would go wrong silently without these: a picture of a LOCKED document
// kept on disk in the clear (the one thing the flag exists to prevent — also a
// cover left behind from before the file was encrypted); a renderer handing
// main something other than a small JPEG to write; pictures outliving the
// recents list they belong to; a progress line reading 140 % after a document
// lost pages; and the extension re-downloading a URL to draw a cover.
// Run: node scripts/test-recent-thumbs.mjs
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SHARED = fileURLToPath(new URL('../src/shared/recent-thumbs.ts', import.meta.url))
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
check('portrait Letter: long side lands on 360', Math.round(792 * rules.thumbScale(612, 792)) === 360)
check('landscape: the WIDTH is the long side', Math.round(792 * rules.thumbScale(792, 612)) === 360)
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

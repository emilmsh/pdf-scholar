// Proof for the one-page reload in src/renderer/src/doc-load.ts
// (mergePageReload) — what the annotation state becomes when a reload follows
// this window's OWN write to one page. The full re-read it replaces walked
// every page through pdf.js, which on a 103-page paper with 744 link annots
// cost 640 ms against 2 ms for the page that changed (issue #19: a dragged
// note sat at its old place for that long). The rules under test:
//
//   1. the written page is what the file now says;
//   2. every other page keeps its records — but a session record that has
//      reached the file (has a fileId) turns file-painted, because the swapped
//      pdf.js document now paints it too and the overlay must not paint it a
//      second time (a doubled multiply highlight reads darker);
//   3. a record still waiting for its object number (fileId null) stays with
//      the overlay, on the reloaded page as well — it is not in the file yet.
//
// Run: node scripts/test-doc-load.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/doc-load.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'doc-load-'))
const out = join(dir, 'doc-load.mjs')
await build({
  entryPoints: [SRC],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  external: ['pdfjs-dist'],
  logLevel: 'silent'
})
const { mergePageReload } = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const rec = (id, source, fileId, extra = {}) => ({
  id,
  fileId,
  source,
  type: 'highlight',
  quads: [{ x: 10, y: 10, w: 50, h: 12 }],
  color: [1, 0.84, 0.29],
  opacity: 0.5,
  ...extra
})

// Before: page 1 has a file record and a landed session record; page 2 has a
// landed session record and one still in flight; page 3 (the written page) has
// a file record about to be superseded plus an in-flight one.
const prev = new Map([
  [1, [rec('file-11', 'file', 11), rec('s-a', 'session', 12)]],
  [2, [rec('s-b', 'session', 20), rec('s-pending', 'session', null)]],
  [3, [rec('file-30', 'file', 30, { quads: [{ x: 0, y: 0, w: 20, h: 20 }] }), rec('s-pending3', 'session', null)]]
])
const fresh = [rec('file-30', 'file', 30, { quads: [{ x: 40, y: 0, w: 20, h: 20 }] })]
const next = mergePageReload(prev, 3, fresh)

check('written page: the file record is the fresh one',
  next.get(3)?.find((r) => r.fileId === 30)?.quads[0].x === 40,
  JSON.stringify(next.get(3)?.map((r) => r.id)))
check('written page: an in-flight record survives, still session-painted',
  next.get(3)?.some((r) => r.id === 's-pending3' && r.source === 'session'))
check('other page: a landed session record turns file-painted',
  next.get(2)?.find((r) => r.id === 's-b')?.source === 'file')
check('other page: an in-flight record stays session-painted',
  next.get(2)?.find((r) => r.id === 's-pending')?.source === 'session')
check('other page: file records untouched',
  next.get(1)?.find((r) => r.id === 'file-11')?.source === 'file' &&
  next.get(1)?.find((r) => r.id === 's-a')?.source === 'file')
check('other pages keep every record', next.get(1)?.length === 2 && next.get(2)?.length === 2)
check('input map is not mutated',
  prev.get(2)?.find((r) => r.id === 's-b')?.source === 'session' && prev.get(3)?.length === 2)

// A page whose fresh list is empty and has nothing in flight drops out of the
// map — same shape collectAnnotations produces (no empty entries).
const gone = mergePageReload(new Map([[3, [rec('file-30', 'file', 30)]]]), 3, [])
check('emptied page leaves the map', !gone.has(3))
// … but an in-flight record alone keeps it
const kept = mergePageReload(new Map([[3, [rec('s-p', 'session', null)]]]), 3, [])
check('an in-flight record alone keeps the page', kept.get(3)?.length === 1)
// A page the state never had is simply added
const added = mergePageReload(new Map(), 5, fresh)
check('a page new to the state is added', added.get(5)?.length === 1)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

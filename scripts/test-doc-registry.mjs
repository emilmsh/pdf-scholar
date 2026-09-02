// Proof for src/renderer/src/doc-registry.ts — the renderer-side refcount that
// lets one window show a path twice (a tab + another tab's split pane) while
// main keeps seeing exactly one docOpened before the first viewer and one
// docClosed after the last. The bug this prevents: a Set-backed bookkeeping
// where closing the pane unregisters a path the tab still shows, silently
// dropping the unsaved-close guard and cross-window notifications.
// Run: node scripts/test-doc-registry.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/doc-registry.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'doc-registry-'))
const out = join(dir, 'doc-registry.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { createDocRegistry } = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const log = []
const reg = createDocRegistry(
  (p) => log.push(`open:${p}`),
  (p) => log.push(`close:${p}`)
)

// A tab opens X, then X also lands in another tab's split pane
reg.acquire('X')
reg.acquire('X')
check('second acquire does not re-notify main', log.join(',') === 'open:X', log.join(','))
check('count sees both viewers', reg.count('X') === 2)

// The pane closes — the tab still shows X, so main must NOT hear docClosed
reg.release('X')
check('first release is silent while a viewer remains', log.join(',') === 'open:X', log.join(','))
check('one viewer left', reg.count('X') === 1)

// The tab closes too — now main hears it, exactly once
reg.release('X')
check('last release notifies main once', log.join(',') === 'open:X,close:X', log.join(','))
check('count back to zero', reg.count('X') === 0)

// Defensive: a stray double-close must not go negative and eat a later close
reg.release('X')
check('release without acquire is a no-op', log.join(',') === 'open:X,close:X', log.join(','))
reg.acquire('X')
check('reopening after that works', log.join(',') === 'open:X,close:X,open:X', log.join(','))
reg.release('X')
check('…and closes cleanly', log.join(',') === 'open:X,close:X,open:X,close:X', log.join(','))

// Paths are independent
reg.acquire('A')
reg.acquire('B')
reg.release('A')
check(
  'paths do not share counts',
  reg.count('A') === 0 && reg.count('B') === 1 && log.slice(-3).join(',') === 'open:A,open:B,close:A',
  log.join(',')
)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll doc-registry checks passed.')

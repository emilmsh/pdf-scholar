// The remembered colour-wheel picks (src/shared/custom-colors.ts, issue #50).
//
// Three slots, no history: a pick goes first, a repeat moves to the front, the
// oldest falls off, and the × on a swatch forgets exactly one. The stored
// value is untrusted input — junk, a non-list, a hex in the wrong case, a
// duplicate — and must read as a list every time, never throw, never let a
// bad value into the row. Run: node scripts/test-custom-colors.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/custom-colors.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'custom-colors-'))
const out = join(dir, 'custom-colors.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const C = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// --- normalizeHex -------------------------------------------------------------
eq(C.normalizeHex('#AA3366'), '#aa3366', 'upper-case hex is lower-cased')
eq(C.normalizeHex('aa3366'), '#aa3366', 'a bare hex gets its #')
eq(C.normalizeHex('#abc'), null, 'three-digit form is not accepted')
eq(C.normalizeHex('#12345g'), null, 'a non-hex digit is refused')
eq(C.normalizeHex(''), null, 'empty string')
eq(C.normalizeHex(null), null, 'null')
eq(C.normalizeHex(0xaa3366), null, 'a number is not a colour')

// --- parseCustomColors: the stored value is untrusted ------------------------
eq(C.parseCustomColors(null), [], 'nothing stored')
eq(C.parseCustomColors(''), [], 'empty string stored')
eq(C.parseCustomColors('not json'), [], 'garbage does not throw')
eq(C.parseCustomColors('{"a":1}'), [], 'a non-list reads as empty')
eq(C.parseCustomColors('[1, null, "#zzzzzz", {"hex":"#aa3366"}]'), [], 'junk items are dropped')
eq(
  C.parseCustomColors('["#AA3366", "#aa3366", "#112233"]'),
  ['#aa3366', '#112233'],
  'a duplicate differing only in case is one colour, first occurrence kept'
)
eq(
  C.parseCustomColors('["#111111", "#222222", "#333333", "#444444", "#555555"]'),
  ['#111111', '#222222', '#333333'],
  'an over-long list (an older build, a hand in the profile) is capped to the row'
)
eq(C.CUSTOM_COLORS_MAX, 3, 'the cap the row is laid out for')

// --- rememberColor -----------------------------------------------------------
eq(C.rememberColor([], '#aa3366'), ['#aa3366'], 'first pick')
eq(C.rememberColor(['#aa3366'], '#112233'), ['#112233', '#aa3366'], 'a new pick goes first')
eq(
  C.rememberColor(['#112233', '#aa3366'], '#AA3366'),
  ['#aa3366', '#112233'],
  'a repeat moves to the front (case-insensitively) instead of doubling'
)
eq(
  C.rememberColor(['#111111', '#222222', '#333333'], '#444444'),
  ['#444444', '#111111', '#222222'],
  'the oldest falls off at the cap'
)
eq(C.rememberColor(['#aa3366'], 'nope'), ['#aa3366'], 'an invalid pick changes nothing')
{
  const before = ['#aa3366']
  C.rememberColor(before, '#112233')
  eq(before, ['#aa3366'], 'the input list is not mutated')
}

// --- forgetColor -------------------------------------------------------------
eq(C.forgetColor(['#111111', '#222222', '#333333'], '#222222'), ['#111111', '#333333'], 'one forgotten, order kept')
eq(C.forgetColor(['#111111', '#222222'], '#222222'), ['#111111'], 'forgetting the newest')
eq(C.forgetColor(['#111111'], '#111111'), [], 'forgetting the only one empties the row')
eq(C.forgetColor(['#111111'], '#999999'), ['#111111'], 'forgetting a colour not in the row is a no-op')
eq(C.forgetColor(['#111111'], '#111111'.toUpperCase()), [], 'forgotten case-insensitively')
eq(C.forgetColor(['#111111'], 'garbage'), ['#111111'], 'an invalid hex forgets nothing')

// --- the round trip the swatch row makes -------------------------------------
{
  let list = C.parseCustomColors(null)
  list = C.rememberColor(list, '#aa3366')
  list = C.rememberColor(list, '#112233')
  const stored = JSON.stringify(list)
  const back = C.parseCustomColors(stored)
  eq(back, ['#112233', '#aa3366'], 'what was remembered reads back in order')
  eq(C.parseCustomColors(JSON.stringify(C.forgetColor(back, '#112233'))), ['#aa3366'], 'and a forgotten one stays forgotten')
}

if (failures) {
  console.error(`\ntest:custom-colors — ${failures} failure(s)`)
  process.exit(1)
}
console.log('test:custom-colors — ok')

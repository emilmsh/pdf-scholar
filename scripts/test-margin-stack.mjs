// The margin view's on-screen stacking rule (src/shared/margin-stack.ts).
//
// Cards hang at their anchors, the one above pushes the next down, and a
// stack that runs off the page is pushed back up — but never INTO the card
// above it: when the cards together are taller than the page they overhang
// the page bottom instead of landing on top of each other at the top edge
// (2026-10-27: three paragraph-long comments drew through each other). The
// short-comment case must come out exactly as the old rule placed it.
// Run: node scripts/test-margin-stack.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/margin-stack.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'margin-stack-'))
const out = join(dir, 'margin-stack.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { stackMarginCards } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

const GAP = 8
const PAD = 8
const opts = { gap: GAP, edgePad: PAD }

/** The rule MarginNotes.tsx applied before 2026-10-27, verbatim: the oracle
 *  for every stack that fits, since those must not move by a pixel. */
function oldRule(items, pageH) {
  let prevBottom = PAD - GAP
  const tops = []
  for (const it of items) {
    const top = Math.max(it.anchor, prevBottom + GAP)
    tops.push(top)
    prevBottom = top + it.height
  }
  let ceiling = pageH - PAD
  for (let i = tops.length - 1; i >= 0; i--) {
    tops[i] = Math.max(PAD, Math.min(tops[i], ceiling - items[i].height))
    ceiling = tops[i] - GAP
  }
  return tops
}

/** No card through another, in the given order, and none above the floor */
function readable(tops, items, floor = PAD) {
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] < floor) return false
    if (i > 0 && tops[i] < tops[i - 1] + items[i - 1].height + GAP) return false
  }
  return true
}

// --- short comments: pixel-identical to the old rule ---------------------------
{
  const page = 1000
  const cases = [
    [],
    [{ anchor: 100, height: 40 }],
    [{ anchor: 100, height: 40 }, { anchor: 500, height: 60 }],
    // two anchored on the same line: the second is pushed down
    [{ anchor: 100, height: 40 }, { anchor: 100, height: 60 }],
    // a card at the very top edge is kept off it
    [{ anchor: 0, height: 40 }],
    // a card at the foot is pushed back up, and the one above it with it
    [{ anchor: 900, height: 80 }, { anchor: 960, height: 60 }],
    // three that fit only when the whole tail is pushed up
    [{ anchor: 700, height: 100 }, { anchor: 800, height: 100 }, { anchor: 950, height: 100 }]
  ]
  for (const items of cases) {
    const got = stackMarginCards(items, page, opts)
    eq(got.tops, oldRule(items, page), `fits: ${JSON.stringify(items)} lays out as before`)
    ok(got.overhang === 0, 'a stack that fits reports no overhang')
    ok(readable(got.tops, items), 'a stack that fits is readable')
  }
  eq(stackMarginCards([], page, opts).bottom, PAD, 'no cards: the bottom is the top pad')
  eq(stackMarginCards([{ anchor: 100, height: 40 }], page, opts).bottom, 140, 'bottom = last top + height')
}

// --- taller than the page: overhang, never overlap ----------------------------
{
  const page = 800
  // Three paragraph-long comments (Emil's case): 400 px each on an 800 px page
  const items = [
    { anchor: 100, height: 400 },
    { anchor: 300, height: 400 },
    { anchor: 500, height: 400 }
  ]
  const old = oldRule(items, page)
  ok(!readable(old, items), 'the old rule did draw these through each other (the bug being fixed)')
  const got = stackMarginCards(items, page, opts)
  eq(got.tops, [PAD, PAD + 400 + GAP, PAD + 2 * (400 + GAP)], 'from the top edge down, a gap apart')
  ok(readable(got.tops, items), 'all three readable, in anchor order')
  eq(got.bottom, PAD + 3 * 400 + 2 * GAP, 'the bottom is the last card\'s foot')
  eq(got.overhang, got.bottom - (page - PAD), 'the overhang counts from the bottom pad')
  ok(got.overhang > 0, 'and the stack overhangs')
}
{
  // One comment taller than the page alone
  const items = [{ anchor: 300, height: 1200 }]
  const got = stackMarginCards(items, 800, opts)
  eq(got.tops, [PAD], 'a single over-tall card starts at the top edge')
  eq(got.overhang, PAD + 1200 - 792, 'and overhangs by the rest')
}
{
  // A short card below a tall one: the tall one is pushed to the top, the
  // short one follows it down past the page instead of climbing over it
  const items = [
    { anchor: 50, height: 700 },
    { anchor: 600, height: 150 }
  ]
  const got = stackMarginCards(items, 800, opts)
  eq(got.tops, [PAD, PAD + 700 + GAP], 'the second follows the first past the page bottom')
  ok(readable(got.tops, items), 'readable')
}
{
  // Fits with the push-up but only just: identical to the old rule, no
  // overhang — the border between the two regimes
  const items = [
    { anchor: 500, height: 300 },
    { anchor: 700, height: 400 }
  ]
  const page = 2 * PAD + 300 + GAP + 400
  const got = stackMarginCards(items, page, opts)
  eq(got.tops, oldRule(items, page), 'exactly filling the page is still the old layout')
  eq(got.overhang, 0, 'and no overhang')
  const got2 = stackMarginCards(items, page - 1, opts)
  eq(got2.tops, [PAD, PAD + 300 + GAP], 'one pixel less and the tail overhangs by one')
  eq(got2.overhang, 1, 'by exactly one pixel')
}

// --- the floor: the page above's column runs on into this one ----------------
{
  const items = [
    { anchor: 20, height: 40 },
    { anchor: 500, height: 40 }
  ]
  const got = stackMarginCards(items, 1000, { ...opts, floor: 200 })
  eq(got.tops, [200, 500], 'the first card waits under the floor, the second stays at its anchor')
  ok(readable(got.tops, items, 200), 'readable under the floor')
  const none = stackMarginCards(items, 1000, { ...opts, floor: 2 })
  eq(none.tops, [20, 500], 'a floor above the edge pad changes nothing')
  eq(stackMarginCards([], 1000, { ...opts, floor: 200 }).bottom, 200, 'no cards: the bottom is the floor')
  // Floor plus a stack that must overhang: everything shifts down under it
  const tall = [
    { anchor: 0, height: 500 },
    { anchor: 100, height: 500 }
  ]
  const under = stackMarginCards(tall, 800, { ...opts, floor: 300 })
  eq(under.tops, [300, 300 + 500 + GAP], 'an overhanging stack starts at the floor')
  eq(under.overhang, 300 + 1000 + GAP - 792, 'and its overhang counts the floor')
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('margin-stack: all checks passed')

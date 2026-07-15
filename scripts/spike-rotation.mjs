// Round-trip proof for src/renderer/src/rotation.ts — MUST pass before any UI
// is wired to these transforms (a missed conversion = corrupted PDF coords).
// Run: node spike-rotation.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/rotation.ts', import.meta.url))

// esbuild strips the type-only import and emits ESM we can import directly
const dir = mkdtempSync(join(tmpdir(), 'rot-spike-'))
const out = join(dir, 'rotation.mjs')
await build({
  entryPoints: [SRC],
  outfile: out,
  format: 'esm',
  bundle: false,
  logLevel: 'silent'
})
const R = await import(pathToFileURL(out).href)

let failures = 0
const EPS = 1e-9
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}
function close(a, b, msg) {
  ok(Math.abs(a - b) < EPS, `${msg} (got ${a}, want ${b})`)
}

const ROTS = [0, 90, 180, 270]
// A few page sizes incl. portrait, landscape and non-integer
const SIZES = [
  { pw: 612, ph: 792 },
  { pw: 800, ph: 600 },
  { pw: 595.32, ph: 841.92 }
]
// Test points as fractions of each page (so they stay inside the page box)
const FRACS = [
  [0, 0],
  [0.02, 0.03],
  [0.5, 0.5],
  [0.999, 0.999]
]

console.log('1) point round-trip: viewPointToPage(pagePointToView(p)) === p')
for (const { pw, ph } of SIZES) {
  for (const rot of ROTS) {
    for (const [fx, fy] of FRACS) {
      const px = fx * pw
      const py = fy * ph
      const [vx, vy] = R.pagePointToView(px, py, pw, ph, rot)
      const [bx, by] = R.viewPointToPage(vx, vy, pw, ph, rot)
      close(bx, px, `pt x rot${rot} size ${pw}x${ph} p(${px},${py})`)
      close(by, py, `pt y rot${rot} size ${pw}x${ph} p(${px},${py})`)
      // view point must lie inside the view box
      const vs = R.viewSize(pw, ph, rot)
      ok(vx >= -EPS && vx <= vs.w + EPS && vy >= -EPS && vy <= vs.h + EPS,
        `view pt in-bounds rot${rot} v(${vx},${vy}) box ${vs.w}x${vs.h}`)
    }
  }
}

console.log('2) rect round-trip: viewRectToPage(pageRectToView(q)) === q')
const RECTS = [
  { x: 0, y: 0, w: 100, h: 40 },
  { x: 50.5, y: 120.25, w: 200, h: 18 },
  { x: 300, y: 700, w: 250, h: 60 }
]
for (const { pw, ph } of SIZES) {
  for (const rot of ROTS) {
    for (const q of RECTS) {
      const v = R.pageRectToView(q, pw, ph, rot)
      const b = R.viewRectToPage(v, pw, ph, rot)
      close(b.x, q.x, `rect x rot${rot} q(${q.x},${q.y})`)
      close(b.y, q.y, `rect y rot${rot} q(${q.x},${q.y})`)
      close(b.w, q.w, `rect w rot${rot} q(${q.x},${q.y})`)
      close(b.h, q.h, `rect h rot${rot} q(${q.x},${q.y})`)
      // width/height swap for 90/270
      if (rot === 90 || rot === 270) {
        close(v.w, q.h, `rect w-swap rot${rot}`)
        close(v.h, q.w, `rect h-swap rot${rot}`)
      } else {
        close(v.w, q.w, `rect w-keep rot${rot}`)
        close(v.h, q.h, `rect h-keep rot${rot}`)
      }
    }
  }
}

console.log('3) svgRotationTransform matches pagePointToView for corners')
function applyMatrix(m, x, y) {
  // "matrix(a b c d e f)" or "" (identity)
  if (!m) return [x, y]
  const [a, b, c, d, e, f] = m.slice(7, -1).split(/\s+/).map(Number)
  return [a * x + c * y + e, b * x + d * y + f]
}
for (const { pw, ph } of SIZES) {
  for (const rot of ROTS) {
    const m = R.svgRotationTransform(pw, ph, rot)
    for (const [px, py] of [[0, 0], [pw, 0], [pw, ph], [0, ph], [pw / 2, ph / 3]]) {
      const [mx, my] = applyMatrix(m, px, py)
      const [vx, vy] = R.pagePointToView(px, py, pw, ph, rot)
      close(mx, vx, `svg x rot${rot} corner(${px},${py})`)
      close(my, vy, `svg y rot${rot} corner(${px},${py})`)
    }
  }
}

console.log('4) viewDeltaToPage matches viewPointToPage difference')
for (const rot of ROTS) {
  const pw = 612, ph = 792
  const base = [30, 40]
  const moved = [30 + 12, 40 + 7] // view-space delta (12, 7)
  const pBase = R.viewPointToPage(base[0], base[1], pw, ph, rot)
  const pMoved = R.viewPointToPage(moved[0], moved[1], pw, ph, rot)
  const d = R.viewDeltaToPage(12, 7, rot)
  close(d.dx, pMoved[0] - pBase[0], `delta dx rot${rot}`)
  close(d.dy, pMoved[1] - pBase[1], `delta dy rot${rot}`)
}

console.log('5) buildRows: single vs spread grouping + totals')
{
  const sizes = [
    { w: 600, h: 800 },
    { w: 600, h: 800 },
    { w: 600, h: 800 }
  ]
  const opts = { containerWidth: 1000, pageGap: 16, padTop: 28, padBottom: 28, sidePad: 64, spreadGap: 24 }
  const single = R.buildRows(sizes, 1, 0, false, opts)
  ok(single.rows.length === 3, `single rows=3 (got ${single.rows.length})`)
  ok(single.rows.every((r) => r.pages.length === 1), 'single: one page per row')
  // total = 28 + 3*800 + 2*16 + 28
  close(single.total, 28 + 3 * 800 + 2 * 16 + 28, 'single total')

  const spread = R.buildRows(sizes, 1, 0, true, opts)
  ok(spread.rows.length === 2, `spread rows=2 (got ${spread.rows.length})`)
  ok(spread.rows[0].pages.length === 2 && spread.rows[1].pages.length === 1, 'spread: [2,1] pages')
  // left page of first row is index 0, right is index 1, centred within contentWidth
  ok(spread.lefts[1] > spread.lefts[0], 'spread: page 2 right of page 1')

  // rotated 90: view width/height swap → row height uses swapped dims
  const rot90 = R.buildRows(sizes, 1, 90, false, opts)
  close(rot90.heights[0], 600, 'rot90 single row page height = pw')
  close(rot90.widths[0], 800, 'rot90 single row page width = ph')
}

if (failures === 0) {
  console.log('\nALL ROTATION ROUND-TRIPS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

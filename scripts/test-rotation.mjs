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

console.log('6) buildRows cover mode: page 1 alone, pairs 2-3, 4-5 …')
{
  const opts = { containerWidth: 1000, pageGap: 16, padTop: 28, padBottom: 28, sidePad: 64, spreadGap: 24 }
  const page = { w: 600, h: 800 }
  const mk = (n) => Array.from({ length: n }, () => page)

  // 5 pages → [1], [2,3], [4,5]
  const five = R.buildRows(mk(5), 1, 0, true, opts, true)
  ok(five.rows.length === 3, `cover 5p rows=3 (got ${five.rows.length})`)
  ok(
    five.rows.map((r) => r.pages.length).join(',') === '1,2,2',
    'cover 5p: [1,2,2] pages per row'
  )
  ok(
    five.rows[1].pages[0].index === 1 && five.rows[1].pages[1].index === 2,
    'cover 5p: second row is pages 2-3'
  )
  // the lone cover centres in the content column like any single-page row
  close(five.lefts[0], (five.contentWidth - five.widths[0]) / 2, 'cover page centred')

  // 4 pages → [1], [2,3], [4]: a trailing odd page stays alone
  const four = R.buildRows(mk(4), 1, 0, true, opts, true)
  ok(
    four.rows.map((r) => r.pages.length).join(',') === '1,2,1',
    'cover 4p: [1,2,1] pages per row'
  )

  // degenerate sizes never break the grouping
  ok(R.buildRows(mk(1), 1, 0, true, opts, true).rows.length === 1, 'cover 1p: one row')
  ok(
    R.buildRows(mk(2), 1, 0, true, opts, true).rows.map((r) => r.pages.length).join(',') === '1,1',
    'cover 2p: two single rows'
  )

  // cover=false keeps the strict 1-2, 3-4 pairing untouched
  const plain = R.buildRows(mk(4), 1, 0, true, opts, false)
  ok(
    plain.rows.map((r) => r.pages.length).join(',') === '2,2',
    'no cover: strict pairs unchanged'
  )

  // spreadRow (the shared grouping rule) agrees with the layout for every page
  for (const n of [1, 2, 3, 4, 5, 6]) {
    for (const cover of [false, true]) {
      const lay = R.buildRows(mk(n), 1, 0, true, opts, cover)
      for (let i = 0; i < n; i++) {
        const row = lay.rows.find((r) => r.pages.some((p) => p.index === i))
        const expect = row.pages.map((p) => p.index).join(',')
        const got = R.spreadRow(i, n, cover).join(',')
        ok(got === expect, `spreadRow(${i}, n=${n}, cover=${cover}) = [${expect}] (got [${got}])`)
      }
    }
  }
}

console.log('7) flipTarget: page turns move one layout row, never rewrap, never wrap around')
{
  const opts = { containerWidth: 1000, pageGap: 16, padTop: 28, padBottom: 28, sidePad: 64, spreadGap: 24 }
  const page = { w: 600, h: 800 }
  const mk = (n) => Array.from({ length: n }, () => page)

  // Single mode: plain ±1, null at the ends
  ok(R.flipTarget(2, 1, 10, false, false) === 3, 'single: 3 → 4')
  ok(R.flipTarget(2, -1, 10, false, false) === 1, 'single: 3 → 2')
  ok(R.flipTarget(0, -1, 10, false, false) === null, 'single: no turn before page 1')
  ok(R.flipTarget(9, 1, 10, false, false) === null, 'single: no turn past the last page')
  ok(R.flipTarget(0, 1, 0, false, false) === null, 'empty document: no turn')

  // Spread, no cover (rows 0-1, 2-3, 4): a turn moves a whole spread and lands
  // on the row's FIRST page, from either page of the current row
  ok(R.flipTarget(0, 1, 5, true, false) === 2, 'spread: row 1-2 → row 3-4')
  ok(R.flipTarget(1, 1, 5, true, false) === 2, 'spread: right page turns the same spread')
  ok(R.flipTarget(2, -1, 5, true, false) === 0, 'spread: row 3-4 → row 1-2')
  ok(R.flipTarget(4, -1, 5, true, false) === 2, 'spread: lone last page → row 3-4')
  ok(R.flipTarget(4, 1, 5, true, false) === null, 'spread: no turn past the last row')
  ok(R.flipTarget(1, -1, 5, true, false) === null, 'spread: no turn before the first row')

  // Cover mode (rows 1 | 2-3 | 4-5): the pairing survives every turn
  ok(R.flipTarget(0, 1, 5, true, true) === 1, 'cover: cover → row 2-3')
  ok(R.flipTarget(1, 1, 5, true, true) === 3, 'cover: row 2-3 → row 4-5')
  ok(R.flipTarget(2, 1, 5, true, true) === 3, 'cover: from page 3 too')
  ok(R.flipTarget(3, -1, 5, true, true) === 1, 'cover: row 4-5 → row 2-3')
  ok(R.flipTarget(1, -1, 5, true, true) === 0, 'cover: row 2-3 → cover')
  ok(R.flipTarget(3, 1, 5, true, true) === null, 'cover: no turn past the last row')

  // Against the layout itself: for every document shape, turning forward walks
  // the rows buildRows draws, first page by first page — and next-then-prev
  // always returns to the same row start (turns are involutive at row level)
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    for (const spread of [false, true]) {
      for (const cover of spread ? [false, true] : [false]) {
        const lay = R.buildRows(mk(n), 1, 0, spread, opts, cover)
        const starts = lay.rows.map((r) => r.pages[0].index)
        for (let r = 0; r < starts.length; r++) {
          const fwd = R.flipTarget(starts[r], 1, n, spread, cover)
          const want = r + 1 < starts.length ? starts[r + 1] : null
          ok(fwd === want, `walk n=${n} spread=${spread} cover=${cover} row ${r}: fwd ${fwd} want ${want}`)
          if (fwd !== null) {
            const back = R.flipTarget(fwd, -1, n, spread, cover)
            ok(back === starts[r], `roundtrip n=${n} spread=${spread} cover=${cover} row ${r}`)
          }
        }
      }
    }
  }
}

console.log('8) buildRows paged: every row in a slot of its own, a viewport apart')
{
  const opts = { containerWidth: 1000, pageGap: 16, padTop: 10, padBottom: 10, sidePad: 8, spreadGap: 24 }
  const VH = 900
  const page = { w: 600, h: 800 }
  const land = { w: 800, h: 600 }
  const mk = (n) => Array.from({ length: n }, () => page)

  // The continuous layout is untouched by the option's absence
  const plain = R.buildRows(mk(3), 1, 0, false, opts)
  const zero = R.buildRows(mk(3), 1, 0, false, { ...opts, pagedHeight: 0 })
  ok(JSON.stringify(plain) === JSON.stringify(zero), 'pagedHeight 0 = the continuous layout, exactly')

  for (const spread of [false, true]) {
    for (const cover of spread ? [false, true] : [false]) {
      const sizes = [page, land, page, page, land]
      const lay = R.buildRows(sizes, 1, 0, spread, { ...opts, pagedHeight: VH }, cover)
      const tag = `spread=${spread} cover=${cover}`
      close(lay.rows[0].top, 0, `${tag}: the first slot starts at the top`)
      for (let r = 0; r < lay.rows.length; r++) {
        const row = lay.rows[r]
        ok(row.height >= VH, `${tag} row ${r}: slot at least a viewport tall (got ${row.height})`)
        if (r > 0) close(row.top, lay.rows[r - 1].top + lay.rows[r - 1].height, `${tag} row ${r}: slots touch`)
        for (const p of row.pages) {
          // centred in the slot, inside its margins
          close(p.top - row.top, (row.height - p.height) / 2, `${tag} page ${p.index + 1}: centred in its slot`)
          ok(p.top >= row.top + 10 - 1e-9 && p.top + p.height <= row.top + row.height - 10 + 1e-9,
            `${tag} page ${p.index + 1}: keeps the margin`)
        }
      }
      const last = lay.rows[lay.rows.length - 1]
      close(lay.total, last.top + last.height, `${tag}: total is the slots and nothing else`)
      // A neighbour never shows: a viewport-tall window starting at a slot's
      // top holds pages of that slot only
      for (const row of lay.rows) {
        const seen = lay.tops
          .map((t, i) => ({ i, t, b: t + lay.heights[i] }))
          .filter((p) => p.b > row.top && p.t < row.top + VH)
          .map((p) => p.i)
        const own = row.pages.map((p) => p.index)
        ok(seen.every((i) => own.includes(i)), `${tag}: the slot at ${row.top} shows only its own pages (${seen})`)
      }
    }
  }

  // Zoomed in: a row taller than the viewport gets its height plus the margins
  const big = R.buildRows(mk(2), 2, 0, false, { ...opts, pagedHeight: VH })
  close(big.rows[0].height, 1600 + 20, 'zoomed in: the slot is the page plus its margins')
  close(big.tops[1], big.rows[1].top + 10, 'zoomed in: the next page starts a margin into its own slot')

  // A fitted page (rounding a hair over the viewport) takes exactly the viewport
  const fit = (VH - 20) / 800 + 1e-7
  const fitted = R.buildRows(mk(2), fit, 0, false, { ...opts, pagedHeight: VH })
  close(fitted.rows[0].height, VH, 'a page fitted to a hair over still gets exactly one viewport')

  // The page turn walks slot by slot just as it walks rows
  const lay = R.buildRows(mk(5), 1, 0, true, { ...opts, pagedHeight: VH }, true)
  const starts = lay.rows.map((r) => r.pages[0].index)
  ok(starts.join(',') === '0,1,3', `paged cover spread rows ${starts}`)
  ok(R.flipTarget(1, 1, 5, true, true) === 3, 'paged: flipTarget unchanged')
}

console.log('9) buildRows on whole device pixels (issue #53: fuzzy text at most zoom levels)')
{
  // An A4 page at 100 % on a 1.5× screen: 595.28 CSS px is 892.92 device
  // pixels, and centred in a 1000 px column its left edge is 202.36 CSS px =
  // 303.54 device pixels. Unsnapped, the canvas bitmap (an integer) is
  // stretched over a fractional box and every glyph is resampled.
  const a4 = [{ w: 595.28, h: 841.89 }, { w: 595.28, h: 841.89 }, { w: 595.28, h: 841.89 }]
  const opts = { containerWidth: 1000, pageGap: 10, padTop: 10, padBottom: 10, sidePad: 64, spreadGap: 24 }
  const onGrid = (v, dpr) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6
  const unsnapped = R.buildRows(a4, 1, 0, false, opts)
  ok(!onGrid(unsnapped.lefts[0], 1.5), `without the ratio the left edge is fractional (${unsnapped.lefts[0] * 1.5} device px)`)
  ok(!onGrid(unsnapped.widths[0], 1.5), 'without the ratio the width is fractional')
  for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
    for (const spread of [false, true]) {
      for (const paged of [0, 700.4]) {
        const lay = R.buildRows(a4, 1.137, 0, spread, { ...opts, devicePixelRatio: dpr, ...(paged ? { pagedHeight: paged } : {}) })
        const tag = `dpr ${dpr}${spread ? ' spread' : ''}${paged ? ' paged' : ''}`
        ok(lay.lefts.every((v) => onGrid(v, dpr)), `${tag}: every left on a device pixel`)
        ok(lay.tops.every((v) => onGrid(v, dpr)), `${tag}: every top on a device pixel`)
        ok(lay.widths.every((v) => onGrid(v, dpr)), `${tag}: every width on a device pixel`)
        ok(lay.heights.every((v) => onGrid(v, dpr)), `${tag}: every height on a device pixel`)
        ok(lay.rows.every((r) => onGrid(r.top, dpr) && onGrid(r.height, dpr)), `${tag}: every slot on a device pixel`)
        ok(onGrid(lay.total, dpr), `${tag}: the total on a device pixel`)
        // Snapping moves nothing further than one device pixel: a size by
        // half of one, and an edge that depends on a snapped size (the centred
        // left, the right page of a spread) by half of one more
        const ref = R.buildRows(a4, 1.137, 0, spread, { ...opts, ...(paged ? { pagedHeight: paged } : {}) })
        const drift = Math.max(
          ...lay.lefts.map((v, i) => Math.abs(v - ref.lefts[i])),
          ...lay.widths.map((v, i) => Math.abs(v - ref.widths[i])),
          ...lay.heights.map((v, i) => Math.abs(v - ref.heights[i]))
        )
        ok(drift <= 1 / dpr + 1e-9, `${tag}: no edge moved more than one device pixel (${drift.toFixed(4)})`)
        if (paged) {
          // The slots still touch and still hold their pages
          ok(lay.rows.every((r, i) => i === 0 || Math.abs(lay.rows[i - 1].top + lay.rows[i - 1].height - r.top) < 1e-6), `${tag}: slots touch`)
          ok(lay.rows.every((r) => r.pages.every((p) => p.top >= r.top - 1e-6 && p.top + p.height <= r.top + r.height + 1e-6)), `${tag}: pages inside their slots`)
        }
      }
    }
  }
  // A ratio of 1 is the unsnapped layout rounded to whole CSS pixels — and a
  // layout at 1 with integer page sizes is byte-identical to the unsnapped one
  const ints = [{ w: 600, h: 800 }, { w: 600, h: 800 }]
  const plain = R.buildRows(ints, 1, 0, false, opts)
  const one = R.buildRows(ints, 1, 0, false, { ...opts, devicePixelRatio: 1 })
  ok(JSON.stringify(plain) === JSON.stringify(one), 'dpr 1 with whole-pixel pages changes nothing')
  // The margin gutter shift is snapped too (322 CSS px is 402.5 device px at 1.25×)
  const shifted = R.shiftLayoutX(R.buildRows(a4, 1, 0, false, { ...opts, devicePixelRatio: 1.25 }), 322, 1.25)
  ok(shifted.lefts.every((v) => onGrid(v, 1.25)), 'a shifted layout stays on the grid')
  ok(Math.abs(R.snapToDevicePixels(213.86, 1.5) * 1.5 - 321) < 1e-9, 'snapToDevicePixels: 213.86 CSS px at 1.5× → 321 device px')
  ok(R.snapToDevicePixels(213.86, undefined) === 213.86, 'snapToDevicePixels without a ratio is the identity')
}

if (failures === 0) {
  console.log('\nALL ROTATION ROUND-TRIPS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

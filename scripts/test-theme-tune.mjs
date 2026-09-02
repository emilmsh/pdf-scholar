// Proof for src/renderer/src/theme-tune.ts — the ONE place the reading themes'
// page recolouring can be re-derived from a number. What matters here:
//   1) tune = 1 produces NO override (null) for sepia/night, and day/nightHc
//      never produce one — the shipped CSS renders bit-identically untouched.
//   2) The formulas at t=1 reproduce the shipped values EXACTLY (the strings
//      in app.css), so a slider parked at 100 % and a missing override agree.
//   3) Garbage in the settings file (NaN, Infinity, out-of-range) degrades to
//      the shipped look, never to a broken filter string.
//   4) Every curated custom tone stays readable: WCAG contrast ≥ 7:1 against
//      the custom theme's ink (#1d1d1f) even at maximum intensity, enforced by
//      the luminance floor.
// Run: node scripts/test-theme-tune.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/theme-tune.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'theme-tune-'))
const out = join(dir, 'theme-tune.mjs')
// bundle: the module imports only types from shared, but bundling keeps this
// robust if it ever gains a value import
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const T = await import(pathToFileURL(out).href)

let failures = 0
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const TUNE = (patch) => ({ sepia: 1, night: 1, custom: 1, ...patch })

// Independent WCAG math so a bug in the module's luminance can't hide itself
function luminance(hexStr) {
  const v = hexStr.replace('#', '')
  const ch = (i) => {
    const s = parseInt(v.slice(i, i + 2), 16) / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
}
const contrast = (bgHex, fgHex) => {
  const [hi, lo] = [luminance(bgHex), luminance(fgHex)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

console.log('1) untouched defaults produce NO override')
eq(T.pageTuneCss('sepia', TUNE({}), 'gray', 'warm'), null, 'sepia @1 → null')
eq(T.pageTuneCss('night', TUNE({}), 'gray', 'warm'), null, 'night @1 → null')
eq(T.pageTuneCss('day', TUNE({ sepia: 2, night: 1.5, custom: 2 }), 'gray', 'blue'), null, 'day never overrides')
eq(T.pageTuneCss('nightHc', TUNE({ night: 0.5 }), 'gray', 'blue'), null, 'nightHc never overrides')

console.log('2) formulas at t=1 reproduce the shipped app.css values exactly')
eq(T.sepiaTuneCss(1).filter, 'sepia(0.04)', 'sepia filter @1')
eq(T.sepiaTuneCss(1).bg, '#f5efe3', 'sepia paper @1')
eq(
  T.nightTuneCss(1).filter,
  'invert(0.89) hue-rotate(180deg) contrast(1.02) brightness(1.08)',
  'night filter @1'
)
eq(T.nightTuneCss(1).bg, '#21211f', 'night paper @1')

console.log('3) garbage degrades to the shipped look')
for (const bad of [NaN, Infinity, -Infinity, 'x', null, undefined]) {
  eq(T.pageTuneCss('sepia', TUNE({ sepia: bad }), 'gray', 'warm'), null, `sepia tune=${bad} → null`)
  eq(T.pageTuneCss('night', TUNE({ night: bad }), 'gray', 'warm'), null, `night tune=${bad} → null`)
}
// Out-of-range clamps to the endpoint, not beyond
eq(T.pageTuneCss('sepia', TUNE({ sepia: 99 }), 'gray', 'warm').bg, T.sepiaTuneCss(2).bg, 'sepia clamps to 2')
eq(
  T.pageTuneCss('night', TUNE({ night: -3 }), 'gray', 'warm').filter,
  T.nightTuneCss(0.5).filter,
  'night clamps to 0.5'
)
// An unknown stored tone falls back to the default (sepia/warm), not a crash
eq(
  T.pageTuneCss('custom', TUNE({}), 'plaid', 'warm').bg,
  T.customToneCss('sepia', 1).bg,
  'unknown light tone → sepia'
)
eq(
  T.pageTuneCss('night', TUNE({}), 'gray', 'tartan'),
  null,
  'unknown night tone → warm (no override at default strength)'
)

console.log('4) monotonicity: more intensity = warmer/darker paper, never a reversal')
let prev = luminance(T.sepiaTuneCss(0).bg)
for (let t = 0.25; t <= 2.001; t += 0.25) {
  const lum = luminance(T.sepiaTuneCss(t).bg)
  ok(lum <= prev + 1e-9, `sepia paper luminance falls with t (t=${t})`)
  prev = lum
}
prev = luminance(T.nightTuneCss(0.5).bg)
for (let t = 0.75; t <= 1.501; t += 0.25) {
  const lum = luminance(T.nightTuneCss(t).bg)
  ok(lum >= prev - 1e-9, `night paper luminance rises with t (t=${t})`)
  prev = lum
}

console.log('5) no blend token ever leaks into the filter string')
for (let t = 0; t <= 2.001; t += 0.1) {
  for (const css of [T.sepiaTuneCss(t), t >= 0.5 && t <= 1.5 ? T.nightTuneCss(t) : null]) {
    if (!css) continue
    ok(!/blend|multiply|normal/.test(css.filter), `filter is a filter, t=${t}: ${css.filter}`)
  }
}

console.log('6) every light tone reads at AAA even at max strength — against ITS OWN ink')
for (const tone of T.CUSTOM_TONE_ORDER) {
  const { bg, filter } = T.customToneCss(tone, 2)
  if (tone === 'sepia') {
    // The sepia tone rides the hand-calibrated sepia pipeline (warm filter tie)
    eq(filter, T.sepiaTuneCss(2).filter, 'sepia tone keeps the sepia filter')
  } else {
    eq(filter, 'none', `custom ${tone} uses the blend, not a filter`)
    ok(luminance(bg) >= 0.75 - 1e-6, `custom ${tone} @max respects the luminance floor (bg ${bg})`)
  }
  const chrome = T.customChromeCss(tone)
  const ink = chrome['--text']
  const c = contrast(bg, ink)
  ok(c >= 7, `custom ${tone} @max: paper vs ink ${c.toFixed(2)}:1 ≥ 7:1 (bg ${bg}, ink ${ink})`)
  const cChrome = contrast(chrome['--bg-chrome'], ink)
  ok(cChrome >= 7, `custom ${tone}: chrome vs ink ${cChrome.toFixed(2)}:1 ≥ 7:1`)
  // And at strength 1 the tone is the curated colour verbatim
  const [r, g, b] = T.CUSTOM_TONES[tone].bg
  const hexOf = (v) => v.toString(16).padStart(2, '0')
  eq(T.customToneCss(tone, 1).bg, `#${hexOf(r)}${hexOf(g)}${hexOf(b)}`, `custom ${tone} @1 verbatim`)
}
// Strength 0 is plain white for every tone (multiply against white = identity)
for (const tone of T.CUSTOM_TONE_ORDER) {
  eq(T.customToneCss(tone, 0).bg, '#ffffff', `custom ${tone} @0 → white`)
}

console.log('7) sepia under «Farge» is pixel-identical to the old Sepia theme')
eq(T.customToneCss('sepia', 1).filter, 'sepia(0.04)', 'sepia tone filter @1')
eq(T.customToneCss('sepia', 1).bg, '#f5efe3', 'sepia tone paper @1')
eq(T.customChromeCss('sepia')['--bg-chrome'], '#f0eee6', 'sepia tone chrome verbatim')
eq(T.customChromeCss('sepia')['--text'], '#3d3929', 'sepia tone ink verbatim')

console.log('8) night tones: warm stays blend-free, tints screen and stay readable')
eq(T.nightTuneCss(1, 'warm').blend, undefined, 'warm never sets a blend')
for (const tone of T.NIGHT_TONE_ORDER) {
  if (tone === 'warm') continue
  const css = T.nightTuneCss(1, tone)
  eq(css.blend, 'screen', `night ${tone} tints through screen`)
  const chrome = T.nightChromeCss(tone)
  ok(!!chrome, `night ${tone} derives a chrome`)
  const c = contrast(css.bg, chrome['--text'])
  ok(c >= 7, `night ${tone}: paper vs ink ${c.toFixed(2)}:1 ≥ 7:1 (bg ${css.bg})`)
  const cChrome = contrast(chrome['--bg-chrome'], chrome['--text'])
  ok(cChrome >= 7, `night ${tone}: chrome vs ink ${cChrome.toFixed(2)}:1 ≥ 7:1`)
}
eq(T.nightChromeCss('warm'), null, "warm's chrome is the shipped CSS block")
// The chrome is built from the VISIBLE paper (the screen result), so UI and
// page share a family — the titlebar equals that paper exactly
for (const tone of ['gray', 'blue', 'green']) {
  const [r, g, b] = T.nightPaper(tone)
  const hexOf = (v) => v.toString(16).padStart(2, '0')
  eq(T.nightChromeCss(tone)['--bg-titlebar'], `#${hexOf(r)}${hexOf(g)}${hexOf(b)}`, `night ${tone}: titlebar = visible paper`)
  // …and the tint is actually visible: the paper differs from neutral by a margin
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  ok(tone === 'gray' ? spread <= 12 : spread >= 20, `night ${tone}: tint spread ${spread} (${tone === 'gray' ? 'near-neutral' : 'clearly tinted'})`)
}
// A tinted night tone overrides even at strength 1 (the tone is a choice)…
ok(
  T.pageTuneCss('night', TUNE({}), 'gray', 'blue')?.blend === 'screen',
  'tinted night overrides at default strength'
)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll theme-tune checks passed.')

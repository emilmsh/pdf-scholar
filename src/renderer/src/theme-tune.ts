// Per-theme tuning: paper tones and their strength — the ONE place the reading
// themes' recolouring can be re-derived from a choice. The shipped looks stay
// in app.css untouched; this module only produces the inline overrides for a
// tune ≠ 1 or a tone other than the shipped one. Returning null / clearing the
// variables means "no override": the CSS default applies and an untouched
// setting renders bit-identically to what shipped. Pure module — unit-tested
// by scripts/test-theme-tune.mjs.
//
// The tone model (Emil, 2026-09-02): Sepia is not a separate theme button, it
// is one of the LIGHT paper tones under «Farge» (theme id 'custom', kept for
// stored settings); night mode has its own set of DARK tones with the shipped
// warm near-black as the default. Both pickers are curated presets, never free
// colour input — readability is guaranteed by curation plus the clamps below.
import type { CustomTone, NightTone, ThemeName, ThemeTune } from '../../shared/types'

/** Slider bounds per tunable theme. The light tones dial the paper's distance
 *  from white (0 = plain white, 2 = double tone depth); night dials page
 *  brightness either way around the shipped calibration. */
export const TUNE_RANGE: Record<'sepia' | 'night' | 'custom', { min: number; max: number }> = {
  sepia: { min: 0, max: 2 },
  night: { min: 0.5, max: 1.5 },
  custom: { min: 0, max: 2 }
}

/** The curated light paper tones at strength 1. Pale by construction — the
 *  luminance clamp in customToneCss is the backstop, these are the policy:
 *  every tone stays a paper the ink reads on at AAA contrast (asserted by
 *  test-theme-tune.mjs, not just intended). 'sepia' is the classic cream and
 *  reuses the hand-calibrated sepia theme's exact values. */
export const CUSTOM_TONES: Record<CustomTone, { bg: readonly [number, number, number] }> = {
  sepia: { bg: [245, 239, 227] }, // #f5efe3 — the shipped sepia paper
  gray: { bg: [236, 236, 238] }, // #ececee
  green: { bg: [231, 239, 228] }, // #e7efe4
  blue: { bg: [231, 237, 245] }, // #e7edf5
  sand: { bg: [242, 236, 220] } // #f2ecdc
}

export const CUSTOM_TONE_ORDER: readonly CustomTone[] = ['sepia', 'gray', 'green', 'blue', 'sand']

/** The dark paper tones for night mode. 'warm' is the shipped near-black
 *  (#21211f) and stays on the untouched CSS path; the others tint the page
 *  through a screen blend — the exact mirror of how sepia's multiply tints
 *  white paper cream: dark pixels take the tone, the light text barely moves. */
export const NIGHT_TONES: Record<NightTone, { bg: readonly [number, number, number] }> = {
  warm: { bg: [33, 33, 31] }, // #21211f — the shipped night paper
  gray: { bg: [33, 34, 37] }, // #212225
  blue: { bg: [29, 36, 51] }, // #1d2433
  green: { bg: [29, 42, 34] } // #1d2a22
}

export const NIGHT_TONE_ORDER: readonly NightTone[] = ['warm', 'gray', 'blue', 'green']

/** Non-finite or out-of-range input (a stale settings file, NaN from a broken
 *  merge) degrades to the shipped look, never to a broken filter string. */
function clampTune(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(max, Math.max(min, n))
}

const safeCustomTone = (tone: CustomTone): CustomTone => (tone in CUSTOM_TONES ? tone : 'sepia')
const safeNightTone = (tone: NightTone): NightTone => (tone in NIGHT_TONES ? tone : 'warm')

/** CSS numbers without float noise: 0.04 stays "0.04", never "0.040". */
const num = (v: number): string => String(Math.round(v * 1000) / 1000)

const channel = (v: number): number => Math.min(255, Math.max(0, Math.round(v)))

function hex(r: number, g: number, b: number): string {
  const h = (v: number): string => channel(v).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** WCAG relative luminance of an sRGB colour given as 0–255 channels. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export interface PageTuneCss {
  filter: string
  bg: string
  /** Set only by the tinted night tones: 'screen' lifts dark pixels toward the
   *  tone the way sepia's multiply pulls white paper toward cream. Absent =
   *  leave the theme's own blend alone. */
  blend?: string
}

/** Sepia at strength t. t=1 reproduces the shipped values exactly
 *  (#f5efe3 + sepia(0.04) — see the sepia block in app.css for why the filter
 *  stays low: it lands on the whole composite and clamps red when pushed).
 *  The paper tone carries the intensity instead: its per-channel distance from
 *  white scales linearly, which the multiply blend turns into paper warmth. */
export function sepiaTuneCss(t: number): PageTuneCss {
  return {
    filter: `sepia(${num(0.04 * t)})`,
    // #f5efe3 = white − (10, 16, 28)
    bg: hex(255 - 10 * t, 255 - 16 * t, 255 - 28 * t)
  }
}

/** Night at strength t — page/text brightness around the shipped calibration.
 *  invert(0.89) and hue-rotate stay FIXED: they are what makes night night,
 *  and the app.css comment documents how fragile the contrast/brightness pair
 *  is. Only that pair moves, and the canvas tone under the pages moves with
 *  the brightness so the paper never floats on a mismatched ground. */
export function nightTuneCss(t: number, tone: NightTone = 'warm'): PageTuneCss {
  const brightness = 1.08 + 0.3 * (t - 1)
  const contrast = 1.02 + 0.1 * (t - 1)
  const k = brightness / 1.08
  const [r, g, b] = NIGHT_TONES[safeNightTone(tone)].bg
  const css: PageTuneCss = {
    filter: `invert(0.89) hue-rotate(180deg) contrast(${num(contrast)}) brightness(${num(brightness)})`,
    // the tone scaled with the brightness so page and filter agree
    bg: hex(r * k, g * k, b * k)
  }
  // The tinted tones need the screen blend; 'warm' must NOT set one — its
  // shipped look is blend-free, and t=1 warm means "no override at all".
  if (safeNightTone(tone) !== 'warm') css.blend = 'screen'
  return css
}

/** The luminance floor for a light paper tone. Below this the page stops
 *  reading as light paper and the ink loses its margin — the slider saturates
 *  here instead of crossing it. */
const CUSTOM_LUMINANCE_FLOOR = 0.75

/** Light tone at strength t: each channel's distance from white scales by t,
 *  clamped so the result never drops under the luminance floor (the guardrail
 *  that makes a curated-preset picker safe without any runtime contrast UI).
 *  The sepia tone routes through sepiaTuneCss so «Farge → Sepia» is pixel-
 *  identical to the old standalone Sepia theme, warm filter tie included. */
export function customToneCss(tone: CustomTone, t: number): PageTuneCss {
  if (safeCustomTone(tone) === 'sepia') return sepiaTuneCss(t)
  const [r, g, b] = CUSTOM_TONES[safeCustomTone(tone)].bg
  // Rounded to the 0–255 channels that actually ship in the hex string, so the
  // luminance floor is judged on the REAL colour — a clamp measured on float
  // channels can land a rounding hair below the floor after quantisation.
  const at = (s: number): [number, number, number] => [
    channel(255 - (255 - r) * s),
    channel(255 - (255 - g) * s),
    channel(255 - (255 - b) * s)
  ]
  let s = t
  // Luminance falls monotonically with s, so a short bisection is exact enough
  if (relativeLuminance(...at(s)) < CUSTOM_LUMINANCE_FLOOR) {
    let lo = 0
    let hi = s
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (relativeLuminance(...at(mid)) >= CUSTOM_LUMINANCE_FLOOR) lo = mid
      else hi = mid
    }
    s = lo
  }
  // The multiply blend does the tinting; no filter needed on top
  return { filter: 'none', bg: hex(...at(s)) }
}

/** The chrome variables a tone tints along with the paper (Emil, 2026-09-02:
 *  the UI should follow the colour choice, the way sepia's cream chrome always
 *  followed its cream paper). */
export type ChromeCss = Record<string, string>

/** Chrome for a LIGHT tone. The sepia tone returns the hand-calibrated sepia
 *  theme block verbatim; the others are derived with ratios read off the
 *  shipped day/sepia blocks — chrome slightly darker than paper, canvas darker
 *  again, titlebar darkest of the light surfaces, elevated pulled toward
 *  white, ink the tone scaled deep. Intensity deliberately does NOT move the
 *  chrome — sepia's never did; the slider is about the paper. */
export function customChromeCss(tone: CustomTone): ChromeCss {
  if (safeCustomTone(tone) === 'sepia') {
    // Verbatim from :root[data-theme='sepia'] in app.css — keep in step.
    return {
      '--bg-chrome': '#f0eee6',
      '--bg-canvas': '#eae8dd',
      '--bg-elevated': '#faf9f5',
      '--bg-titlebar': '#e9e6db',
      '--text': '#3d3929',
      '--text-secondary': '#838072',
      '--border': 'rgba(61, 57, 41, 0.14)',
      '--hover': 'rgba(61, 57, 41, 0.06)',
      '--active': 'rgba(61, 57, 41, 0.11)'
    }
  }
  const [r, g, b] = CUSTOM_TONES[safeCustomTone(tone)].bg
  const scale = (k: number): string => hex(r * k, g * k, b * k)
  const towardWhite = (k: number): string =>
    hex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k)
  const ink: [number, number, number] = [
    channel(r * 0.155),
    channel(g * 0.155),
    channel(b * 0.155)
  ]
  const inkRgba = (a: number): string => `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${a})`
  return {
    '--bg-chrome': scale(0.975),
    '--bg-canvas': scale(0.945),
    '--bg-elevated': towardWhite(0.6),
    '--bg-titlebar': scale(0.935),
    '--text': hex(...ink),
    '--text-secondary': scale(0.44),
    '--border': inkRgba(0.12),
    '--hover': inkRgba(0.06),
    '--active': inkRgba(0.11)
  }
}

/** Chrome for a DARK (night) tone. 'warm' returns null — the shipped night
 *  block applies untouched. The ratios mirror that block's own relations:
 *  chrome a step above the paper, canvas below it, elevated another step up,
 *  titlebar = the paper, text pulled almost to white through the tone (the
 *  warm block's #eeece2 is exactly that shape). */
export function nightChromeCss(tone: NightTone): ChromeCss | null {
  if (safeNightTone(tone) === 'warm') return null
  const [r, g, b] = NIGHT_TONES[safeNightTone(tone)].bg
  const scale = (k: number): string => hex(r * k, g * k, b * k)
  const towardWhite = (k: number): string =>
    hex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k)
  return {
    '--bg-chrome': scale(1.16),
    '--bg-canvas': scale(0.85),
    '--bg-elevated': scale(1.45),
    '--bg-titlebar': hex(r, g, b),
    '--text': towardWhite(0.88),
    '--text-secondary': towardWhite(0.55),
    '--border': 'rgba(255, 255, 255, 0.1)',
    '--hover': 'rgba(255, 255, 255, 0.07)',
    '--active': 'rgba(255, 255, 255, 0.12)'
  }
}

/** The native window-controls overlay pair a tone implies, or null when the
 *  theme's static map should stand (same contract as the per-theme maps in the
 *  three host apps — they call this AFTER their static lookup). */
export function tuneTitleBar(
  theme: ThemeName,
  customTone: CustomTone,
  nightTone: NightTone
): [string, string] | null {
  const chrome =
    theme === 'custom'
      ? customChromeCss(customTone)
      : theme === 'night'
        ? nightChromeCss(nightTone)
        : null
  return chrome ? [chrome['--bg-titlebar'], chrome['--text']] : null
}

/** Every variable applyPageTune may set inline — cleared as a set, so leaving
 *  a tinted theme can never strand a tinted border on day. */
const TUNE_VARS = [
  '--page-filter',
  '--page-bg',
  '--page-blend',
  '--bg-chrome',
  '--bg-canvas',
  '--bg-elevated',
  '--bg-titlebar',
  '--text',
  '--text-secondary',
  '--border',
  '--hover',
  '--active'
] as const

/** Write (or clear) the inline override on <html>. The one applier every host
 *  (App, AssistantApp, ExtensionApp) and the slider's live preview share, so
 *  the cascade story stays in one place: inline beats the theme block; absent
 *  inline = the shipped CSS, bit-identical. Tinted themes (a light tone, a
 *  non-warm night tone) also carry their chrome — the untinted ones never
 *  touch it. */
export function applyPageTune(
  theme: ThemeName,
  tune: ThemeTune,
  customTone: CustomTone,
  nightTone: NightTone
): void {
  const style = document.documentElement.style
  for (const v of TUNE_VARS) style.removeProperty(v)
  const tuned = pageTuneCss(theme, tune, customTone, nightTone)
  if (tuned) {
    style.setProperty('--page-filter', tuned.filter)
    style.setProperty('--page-bg', tuned.bg)
    if (tuned.blend) style.setProperty('--page-blend', tuned.blend)
  }
  const chrome =
    theme === 'custom'
      ? customChromeCss(customTone)
      : theme === 'night'
        ? nightChromeCss(nightTone)
        : null
  if (chrome) {
    for (const [name, value] of Object.entries(chrome)) style.setProperty(name, value)
  }
}

/** The inline page-recolouring override for the resolved theme, or null when
 *  the CSS default should apply untouched. A tone other than the shipped one
 *  always overrides (it is a runtime choice); the shipped tones only when the
 *  slider left 1; day and nightHc never. */
export function pageTuneCss(
  theme: ThemeName,
  tune: ThemeTune,
  customTone: CustomTone,
  nightTone: NightTone
): PageTuneCss | null {
  switch (theme) {
    case 'sepia': {
      const t = clampTune(tune.sepia, TUNE_RANGE.sepia.min, TUNE_RANGE.sepia.max)
      return t === 1 ? null : sepiaTuneCss(t)
    }
    case 'night': {
      const t = clampTune(tune.night, TUNE_RANGE.night.min, TUNE_RANGE.night.max)
      const tone = safeNightTone(nightTone)
      if (tone === 'warm') return t === 1 ? null : nightTuneCss(t)
      return nightTuneCss(t, tone)
    }
    case 'custom': {
      const t = clampTune(tune.custom, TUNE_RANGE.custom.min, TUNE_RANGE.custom.max)
      return customToneCss(safeCustomTone(customTone), t)
    }
    default:
      return null
  }
}

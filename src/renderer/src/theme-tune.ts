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
// warm near-black as the default. Beside the curated presets a reader can pick
// a tint of their own; readability then rests on the clamps below alone, which
// is why a picked tint is pulled in BEFORE anything is derived from it.
import { normalizeHex } from '../../shared/custom-colors'
import type {
  CustomTone,
  CustomToneChoice,
  NightTone,
  NightToneChoice,
  ThemeName,
  ThemeTune,
  ToneHex
} from '../../shared/types'

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
 *  (#21211f, labelled «Standard» — it IS faintly warm, Claude's dark palette,
 *  but that is a fact nobody needs) and stays on the untouched CSS path; the
 *  others tint the page through a screen blend — the exact mirror of how
 *  sepia's multiply tints white paper cream: dark pixels take the tone, the
 *  light text barely moves. Saturated on purpose: screen against the near-
 *  black inverted paper dilutes a tone, so a pale one reads as nothing (Emil,
 *  2026-09-02 — first cut moved the UI and barely the page). */
export const NIGHT_TONES: Record<NightTone, { bg: readonly [number, number, number] }> = {
  warm: { bg: [33, 33, 31] }, // #21211f — the shipped night paper
  gray: { bg: [30, 33, 39] }, // #1e2127 — cool neutral, the counterpart of warm
  blue: { bg: [24, 40, 70] }, // #182846
  green: { bg: [24, 46, 32] }, // #182e20
  // «Hvitt»: no inversion, no tint — the document as printed inside the dark
  // chrome (a reader who keeps apps dark but documents white, 2026-10-04).
  // The swatch IS the paper here; nothing is derived from this value.
  paper: { bg: [255, 255, 255] }
}

/** What the page's inverted white paper (~#1c1c1c, see the night block's
 *  calibration note) becomes under the screen blend with a tone — the colour
 *  the reader actually sees as paper. The chrome derives from THIS, not from
 *  the tone itself, so UI and page land in the same family by construction. */
export function nightPaper(tone: NightToneChoice): [number, number, number] {
  if (safeNightTone(tone) === 'paper') return [255, 255, 255]
  const [r, g, b] = nightToneRgb(tone)
  const base = 28 / 255
  const screen = (c: number): number => channel(255 * (1 - (1 - base) * (1 - c / 255)))
  return [screen(r), screen(g), screen(b)]
}

export const NIGHT_TONE_ORDER: readonly NightTone[] = ['warm', 'gray', 'blue', 'green', 'paper']

/** Whether the page raster is being inverted for the theme on screen — what
 *  «Behold bildefarger» and the brightness slider act on. Night+ always
 *  inverts; night inverts for every tone but 'paper', which leaves the
 *  document as printed. Day and the light tones never invert. */
export function isPageInverted(theme: ThemeName, nightTone: NightToneChoice): boolean {
  if (theme === 'nightHc') return true
  return theme === 'night' && safeNightTone(nightTone) !== 'paper'
}

/** Non-finite or out-of-range input (a stale settings file, NaN from a broken
 *  merge) degrades to the shipped look, never to a broken filter string. */
function clampTune(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(max, Math.max(min, n))
}

/** A picked tint as stored, or null for a curated name or anything else */
function tintHex(tone: unknown): ToneHex | null {
  return typeof tone === 'string' && tone.startsWith('#') ? (normalizeHex(tone) as ToneHex | null) : null
}

const safeCustomTone = (tone: CustomToneChoice): CustomToneChoice =>
  (tintHex(tone) ?? (tone in CUSTOM_TONES ? tone : 'sepia'))
const safeNightTone = (tone: NightToneChoice): NightToneChoice =>
  (tintHex(tone) ?? (tone in NIGHT_TONES ? tone : 'warm'))

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
export function nightTuneCss(t: number, tone: NightToneChoice = 'warm'): PageTuneCss {
  // 'paper' ignores the strength entirely: there is no inversion to dial. No
  // blend either — the night block sets none, so the root's 'normal' applies
  // and the canvas paints its own white.
  if (safeNightTone(tone) === 'paper') return { filter: 'none', bg: '#ffffff' }
  const brightness = 1.08 + 0.3 * (t - 1)
  const contrast = 1.02 + 0.1 * (t - 1)
  const k = brightness / 1.08
  const [r, g, b] = nightToneRgb(tone)
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

/** The luminance ceiling for a picked night tint: past it the screen blend
 *  lifts the paper too far for light text to hold 7:1 (the curated tones sit
 *  well under it). */
const NIGHT_LUMINANCE_CEILING = 0.025

/** The largest s in 0…hi that `fits`, which holds at 0 and stops holding once
 *  for good as s grows. A short bisection is exact enough. */
function largestFit(hi: number, fits: (s: number) => boolean): number {
  if (fits(hi)) return hi
  let lo = 0
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** A light colour's channels at strength t, pulled toward white until it is
 *  over the floor. Rounded to the 0–255 channels that actually ship in the hex
 *  string, so the floor is judged on the REAL colour — a clamp measured on
 *  float channels can land a rounding hair below it after quantisation. */
function lightAt([r, g, b]: readonly [number, number, number], t: number): [number, number, number] {
  const at = (s: number): [number, number, number] => [
    channel(255 - (255 - r) * s),
    channel(255 - (255 - g) * s),
    channel(255 - (255 - b) * s)
  ]
  // Luminance falls monotonically with s
  return at(largestFit(t, (s) => relativeLuminance(...at(s)) >= CUSTOM_LUMINANCE_FLOOR))
}

function hexChannels(value: string): [number, number, number] {
  const n = parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A light tone's colour at strength 1: a picked tint as it can actually be
 *  shown, so the chrome and the ink derive from the paper on screen */
function lightToneRgb(tone: CustomToneChoice): readonly [number, number, number] {
  const safe = safeCustomTone(tone)
  return tintHex(safe) ? lightAt(hexChannels(safe), 1) : CUSTOM_TONES[safe as CustomTone].bg
}

/** HSL saturation of 0–255 channels: how far a colour is from the grey of its
 *  own lightness, 0 for grey, 1 for a pure hue at any lightness. The measure
 *  for the night cap because it is what survives the luminance scaling (every
 *  channel scaled by one factor keeps it) — so the cap and the ceiling cannot
 *  fight each other. */
function hslSaturation([r, g, b]: readonly [number, number, number]): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const sum = max + min
  return (max - min) / (sum <= 255 ? sum : 510 - sum)
}

/** The most saturated curated night tone sets the cap for a picked one: the
 *  chrome is derived a step above the paper with the paper's saturation
 *  intact, so a pure hue off the wheel — darkened under the ceiling to a page
 *  that is nearly black — still framed the page in a blood-red toolbar (seen
 *  2026-11-09 with #ff0000). Pulled toward its own grey to the blue tone's
 *  saturation it gives the muted family the curated tones have. */
const NIGHT_SATURATION_CAP = Math.max(
  ...(['gray', 'blue', 'green'] as const).map((t) => hslSaturation(NIGHT_TONES[t].bg))
)

/** A night tone's colour: a picked tint pulled toward its own grey to the cap
 *  and scaled down under the ceiling, in that order (the scaling keeps the
 *  saturation, so both bounds hold on the result and the result is a fixed
 *  point — a stored tint comes back unchanged) */
function nightToneRgb(tone: NightToneChoice): readonly [number, number, number] {
  const safe = safeNightTone(tone)
  if (!tintHex(safe)) return NIGHT_TONES[safe as NightTone].bg
  let [r, g, b] = hexChannels(safe)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const sat = hslSaturation([r, g, b])
  // Judged in channel units with two of slack: a tint stored at the cap is
  // rounded to 0–255, which can put its spread a unit or two over the exact
  // cap, and on a dark colour (a spread over a sum of 60) that reads as 3 %
  // — enough for a second pass to move it again. Two units cover the
  // rounding of both the spread and the sum.
  const spread = max - min
  const capSpread = NIGHT_SATURATION_CAP * (sat === 0 ? 0 : spread / sat)
  if (spread > capSpread + 2) {
    const grey = (max + min) / 2
    const k = capSpread / spread
    ;[r, g, b] = [grey + (r - grey) * k, grey + (g - grey) * k, grey + (b - grey) * k]
  }
  const at = (s: number): [number, number, number] => [channel(r * s), channel(g * s), channel(b * s)]
  return at(largestFit(1, (s) => relativeLuminance(...at(s)) <= NIGHT_LUMINANCE_CEILING))
}

/** A colour off the wheel as the tint it becomes — what the row remembers, so
 *  its chip shows the paper the reader will get and two picks that land on one
 *  paper are one chip. */
export function lightTint(hexValue: string): ToneHex {
  const [r, g, b] = lightToneRgb(hexValue as ToneHex)
  return hex(r, g, b) as ToneHex
}

export function nightTint(hexValue: string): ToneHex {
  const [r, g, b] = nightToneRgb(hexValue as ToneHex)
  return hex(r, g, b) as ToneHex
}

/** Light tone at strength t: each channel's distance from white scales by t,
 *  clamped so the result never drops under the luminance floor (the guardrail
 *  that makes a curated-preset picker safe without any runtime contrast UI).
 *  The sepia tone routes through sepiaTuneCss so «Farge → Sepia» is pixel-
 *  identical to the old standalone Sepia theme, warm filter tie included. */
export function customToneCss(tone: CustomToneChoice, t: number): PageTuneCss {
  if (safeCustomTone(tone) === 'sepia') return sepiaTuneCss(t)
  // The multiply blend does the tinting; no filter needed on top
  return { filter: 'none', bg: hex(...lightAt(lightToneRgb(tone), t)) }
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
export function customChromeCss(tone: CustomToneChoice): ChromeCss {
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
  const [r, g, b] = lightToneRgb(tone)
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
export function nightChromeCss(tone: NightToneChoice): ChromeCss | null {
  // 'paper' keeps the shipped dark chrome too: the point of the tone is a
  // white page in the night UI, not a white UI
  if (safeNightTone(tone) === 'warm' || safeNightTone(tone) === 'paper') return null
  // From the paper the reader SEES (the screen result), not the raw tone —
  // otherwise the UI ends up a deeper colour than the page it frames
  const [r, g, b] = nightPaper(tone)
  const scale = (k: number): string => hex(r * k, g * k, b * k)
  const towardWhite = (k: number): string =>
    hex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k)
  return {
    '--bg-chrome': scale(1.12),
    '--bg-canvas': scale(0.82),
    '--bg-elevated': scale(1.35),
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
  customTone: CustomToneChoice,
  nightTone: NightToneChoice
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
  customTone: CustomToneChoice,
  nightTone: NightToneChoice
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
  customTone: CustomToneChoice,
  nightTone: NightToneChoice
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

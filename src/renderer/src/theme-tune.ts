// Per-theme intensity and the custom paper tones — the ONE place the reading
// themes' page recolouring can be re-derived from a number. The shipped looks
// stay in app.css untouched; this module only produces the inline
// --page-filter/--page-bg override for a tune ≠ 1 (or for the custom theme,
// whose tone is always chosen at runtime). Returning null means "no override":
// the CSS default applies and an untouched setting renders bit-identically to
// what shipped. Pure module — unit-tested by scripts/test-theme-tune.mjs.
import type { CustomTone, ThemeName, ThemeTune } from '../../shared/types'

/** Slider bounds per tunable theme. Sepia dials paper warmth from plain white
 *  (0) to double cream (2); night dials page brightness either way around the
 *  shipped calibration; custom scales its tone's distance from white. */
export const TUNE_RANGE: Record<'sepia' | 'night' | 'custom', { min: number; max: number }> = {
  sepia: { min: 0, max: 2 },
  night: { min: 0.5, max: 1.5 },
  custom: { min: 0, max: 2 }
}

/** The curated custom paper tones at strength 1. Light by construction — the
 *  luminance clamp in customToneCss is the backstop, these are the policy:
 *  every tone stays a pale paper the day-theme ink reads on at AAA contrast
 *  (asserted by test-theme-tune.mjs, not just intended). */
export const CUSTOM_TONES: Record<CustomTone, { bg: readonly [number, number, number] }> = {
  gray: { bg: [236, 236, 238] }, // #ececee
  green: { bg: [231, 239, 228] }, // #e7efe4
  blue: { bg: [231, 237, 245] }, // #e7edf5
  sand: { bg: [242, 236, 220] } // #f2ecdc
}

export const CUSTOM_TONE_ORDER: readonly CustomTone[] = ['gray', 'green', 'blue', 'sand']

/** Non-finite or out-of-range input (a stale settings file, NaN from a broken
 *  merge) degrades to the shipped look, never to a broken filter string. */
function clampTune(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(max, Math.max(min, n))
}

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
export function nightTuneCss(t: number): PageTuneCss {
  const brightness = 1.08 + 0.3 * (t - 1)
  const contrast = 1.02 + 0.1 * (t - 1)
  const k = brightness / 1.08
  return {
    filter: `invert(0.89) hue-rotate(180deg) contrast(${num(contrast)}) brightness(${num(brightness)})`,
    // #21211f scaled with the brightness so page and filter agree
    bg: hex(33 * k, 33 * k, 31 * k)
  }
}

/** The luminance floor for a custom paper tone. Below this the page stops
 *  reading as light paper and the day-ink text loses its margin — the slider
 *  saturates here instead of crossing it. */
const CUSTOM_LUMINANCE_FLOOR = 0.75

/** Custom tone at strength t: each channel's distance from white scales by t,
 *  clamped so the result never drops under the luminance floor (the guardrail
 *  that makes a curated-preset picker safe without any runtime contrast UI). */
export function customToneCss(tone: CustomTone, t: number): PageTuneCss {
  const [r, g, b] = CUSTOM_TONES[tone].bg
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

/** Write (or clear) the inline override on <html>. The one applier every host
 *  (App, AssistantApp, ExtensionApp) and the slider's live preview share, so
 *  the cascade story stays in one place: inline beats the theme block; absent
 *  inline = the shipped CSS, bit-identical. */
export function applyPageTune(theme: ThemeName, tune: ThemeTune, customTone: CustomTone): void {
  const style = document.documentElement.style
  const tuned = pageTuneCss(theme, tune, customTone)
  if (tuned) {
    style.setProperty('--page-filter', tuned.filter)
    style.setProperty('--page-bg', tuned.bg)
  } else {
    style.removeProperty('--page-filter')
    style.removeProperty('--page-bg')
  }
}

/** The inline page-recolouring override for the resolved theme, or null when
 *  the CSS default should apply untouched. Custom always overrides (its tone
 *  is a runtime choice); sepia/night only when tuned away from 1; day and
 *  nightHc never. */
export function pageTuneCss(
  theme: ThemeName,
  tune: ThemeTune,
  customTone: CustomTone
): PageTuneCss | null {
  switch (theme) {
    case 'sepia': {
      const t = clampTune(tune.sepia, TUNE_RANGE.sepia.min, TUNE_RANGE.sepia.max)
      return t === 1 ? null : sepiaTuneCss(t)
    }
    case 'night': {
      const t = clampTune(tune.night, TUNE_RANGE.night.min, TUNE_RANGE.night.max)
      return t === 1 ? null : nightTuneCss(t)
    }
    case 'custom': {
      const t = clampTune(tune.custom, TUNE_RANGE.custom.min, TUNE_RANGE.custom.max)
      const tone: CustomTone = customTone in CUSTOM_TONES ? customTone : 'gray'
      return customToneCss(tone, t)
    }
    default:
      return null
  }
}

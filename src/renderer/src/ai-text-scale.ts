// The assistant's text size: one scale factor for the conversation surface
// (messages, composer, landing — not the header/history/settings chrome),
// applied as the `--ai-scale` CSS variable on the panel root and the quick
// popover. Fixed steps rather than a free slider, and persisted in
// localStorage like the panel widths and tool prefs: a renderer-only view
// preference with no IPC consumer, so it behaves identically on desktop,
// dev:web and the extension by construction.
import { clamp } from './clamp'

export const AI_SCALE_MIN = 0.8
export const AI_SCALE_MAX = 1.6
export const AI_SCALE_STEP = 0.1
export const AI_SCALE_DEFAULT = 1

const LS_KEY = 'pdfx-ai-text-scale'

/** Snap onto the step grid: 0.1 is not representable in binary floating
 *  point, so stepping up and back down must round, or the value drifts and
 *  the ≠-default test (which shows the reset link) misfires forever. */
const snap = (v: number): number => clamp(Math.round(v * 10) / 10, AI_SCALE_MIN, AI_SCALE_MAX)

export function loadAiTextScale(): number {
  try {
    const v = Number(localStorage.getItem(LS_KEY))
    return Number.isFinite(v) && v > 0 ? snap(v) : AI_SCALE_DEFAULT
  } catch {
    return AI_SCALE_DEFAULT
  }
}

export function saveAiTextScale(scale: number): void {
  try {
    if (scale === AI_SCALE_DEFAULT) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, String(scale))
  } catch {
    /* remembering the size is a convenience, never a hard requirement */
  }
}

/** Forget the stored size (app-wide reset to defaults) */
export function clearAiTextScale(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* nothing to forget */
  }
}

export const stepAiTextScale = (scale: number, direction: 1 | -1): number =>
  snap(scale + direction * AI_SCALE_STEP)

/** "100 %" — what the stepper row shows between − and + */
export const aiTextScaleLabel = (scale: number): string => `${Math.round(scale * 100)} %`

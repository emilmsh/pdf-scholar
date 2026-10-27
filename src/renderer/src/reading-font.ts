// The reading font (docs/TYPOGRAPHY.md § 5–6): the face the READING role
// renders in — the assistant's messages, comment and note text, the link
// preview card, the library's conversation snippets — chosen by name from
// the fonts the machine has. Nothing is shipped and no file is touched: the
// name goes into `--font-reading` ahead of the interface stack, so a glyph
// the chosen face lacks falls through per glyph. The interface role never
// follows it.
//
// A renderer-only view preference in localStorage, like the assistant's text
// scale: no IPC consumer, so desktop, dev:web and the extension behave
// identically by construction. The empty name is the default and produces
// NO override at all — the shipped CSS renders bit-identically.
//
// The pure half (normalise, stack, vars, the installed-rule) is what
// `npm run test:reading-font` proves; the DOM half below it is three lines.

export const READING_FONT_DEFAULT = ''
export const READING_FONT_MAX_LEN = 64

/** Segoe UI Variable Text's x-height ratio, measured 2026-10-27 (TYPOGRAPHY.md
 *  § 4). `font-size-adjust` at this value scales any chosen face to Segoe's
 *  x-height, so every pixel size in app.css keeps meaning what it means. */
export const READING_FONT_X_HEIGHT = 0.5

const LS_KEY = 'pdfx-reading-font'

/** Everything that is not a letter, a digit, a space, a hyphen, an underscore
 *  or a full stop. A family name needs nothing else, and the value ends up in
 *  a CSS custom property — quotes, semicolons, braces, backslashes, slashes
 *  and control characters are exactly what must not get there. */
const DISALLOWED = /[^\p{L}\p{N} _.\-]/gu

/** The stored value is untrusted input: a non-string, junk characters, a
 *  runaway length and surrounding blanks all degrade to a clean name or to
 *  the default. Idempotent. */
export function normalizeReadingFont(raw: unknown): string {
  if (typeof raw !== 'string') return READING_FONT_DEFAULT
  // Whitespace first, so a tab or a newline becomes a blank rather than
  // being dropped and gluing two words together
  const cleaned = raw.replace(/\s+/g, ' ').replace(DISALLOWED, '').replace(/ {2,}/g, ' ').trim()
  return cleaned.slice(0, READING_FONT_MAX_LEN).trim()
}

/** The reading stack for a chosen face: the name quoted, then the interface
 *  stack behind it for every glyph the face lacks. */
export const readingFontStack = (name: string): string => `"${name}", var(--font-ui)`

/** The custom properties a chosen face sets on the root — or null for the
 *  default, which sets nothing (the "1 = exactly as shipped" rule). */
export function readingFontVars(name: string): Record<string, string> | null {
  const clean = normalizeReadingFont(name)
  if (!clean) return null
  return {
    '--font-reading': readingFontStack(clean),
    '--font-reading-adjust': String(READING_FONT_X_HEIGHT),
  }
}

/** The installed rule behind `isFontInstalled`: a string measured in the
 *  candidate face with a generic fallback, against the generic alone. Any
 *  pair that differs means the candidate was used for at least one glyph.
 *  (Chromium's `document.fonts.check` answers only for @font-face sets, so
 *  it reports every installed face and every missing one alike as true.) */
export const installedFromWidths = (pairs: ReadonlyArray<readonly [number, number]>): boolean =>
  pairs.some(([withFace, generic]) => withFace !== generic)

const PROBE = 'mmmwwwiiilll Vår sære Zulu 0123'
const GENERICS = ['monospace', 'serif', 'sans-serif'] as const

/** Whether the machine has the face — null when it cannot tell (no canvas). */
export function isFontInstalled(name: string): boolean | null {
  const clean = normalizeReadingFont(name)
  if (!clean) return null
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    const pairs = GENERICS.map((generic) => {
      ctx.font = `72px "${clean}", ${generic}`
      const withFace = ctx.measureText(PROBE).width
      ctx.font = `72px ${generic}`
      return [withFace, ctx.measureText(PROBE).width] as const
    })
    return installedFromWidths(pairs)
  } catch {
    return null
  }
}

/** Put the chosen face on the root, or take the override away for the default. */
export function applyReadingFont(name: string): void {
  const vars = readingFontVars(name)
  const style = document.documentElement.style
  if (!vars) {
    style.removeProperty('--font-reading')
    style.removeProperty('--font-reading-adjust')
    return
  }
  for (const [key, value] of Object.entries(vars)) style.setProperty(key, value)
}

export function loadReadingFont(): string {
  try {
    return normalizeReadingFont(localStorage.getItem(LS_KEY))
  } catch {
    return READING_FONT_DEFAULT
  }
}

export function saveReadingFont(name: string): void {
  try {
    const clean = normalizeReadingFont(name)
    if (!clean) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, clean)
  } catch {
    /* remembering the face is a convenience, never a hard requirement */
  }
}

/** Forget the stored face (app-wide reset to defaults) */
export function clearReadingFont(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* nothing to forget */
  }
}

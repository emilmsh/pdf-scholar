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

// ---- The machine's faces (TYPOGRAPHY.md § 5 «Font picker» and § 6): ONE
// list behind two offers — chips under the field as the name is typed, and
// the whole list behind «Velg …». Chromium's Local Font Access API where the
// browser allows it without asking, or from the button the reader pressed
// for it; otherwise the common faces that measure as installed. Both fill
// the same field through the same commit path, so the typed name stays the
// baseline and works alone wherever no list comes.

/** A listing is untrusted input too: a runaway one is cut here. */
export const READING_FONT_LIST_MAX = 1000

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** The family names in a `queryLocalFonts()` listing: a non-array or an item
 *  that is not an object gives nothing; `family` is read (`fullName` behind
 *  it, which carries the cut — «Libertinus Serif Bold»); every name is
 *  normalised like a typed one; the cuts of one family fold to one entry,
 *  case-insensitively; sorted the way a reader reads them (base letters,
 *  numbers in number order); capped. */
export function familiesFromListing(listing: unknown): string[] {
  if (!Array.isArray(listing)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of listing) {
    if (!item || typeof item !== 'object') continue
    const { family, fullName } = item as { family?: unknown; fullName?: unknown }
    const name = normalizeReadingFont(family) || normalizeReadingFont(fullName)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= READING_FONT_LIST_MAX) break
  }
  return out.sort(collator.compare)
}

/** The list as the menu shows it: the current face first when the machine
 *  has it, the rest in listing order. */
export function orderFamilies(families: readonly string[], current: string): string[] {
  const cur = normalizeReadingFont(current).toLowerCase()
  if (!cur) return [...families]
  const i = families.findIndex((f) => f.toLowerCase() === cur)
  if (i < 0) return [...families]
  return [families[i], ...families.slice(0, i), ...families.slice(i + 1)]
}

/** Faces common enough to be worth measuring for when the machine cannot be
 *  asked for its list (`queryLocalFonts` is Chromium's, behind a permission
 *  a browser prompts for and a gesture): the OS faces of Windows, macOS and
 *  the usual Linux sets, plus the reading faces people install on purpose.
 *  Only the ones the installed rule finds are ever offered. */
export const COMMON_FONT_FAMILIES: readonly string[] = [
  // Windows
  'Segoe UI',
  'Segoe UI Variable Text',
  'Aptos',
  'Aptos Serif',
  'Calibri',
  'Cambria',
  'Candara',
  'Constantia',
  'Corbel',
  'Georgia',
  'Times New Roman',
  'Garamond',
  'Book Antiqua',
  'Palatino Linotype',
  'Century Schoolbook',
  'Sitka Text',
  'Bahnschrift',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Arial',
  // macOS
  'New York',
  'SF Pro Text',
  'Helvetica Neue',
  'Avenir',
  'Avenir Next',
  'Baskerville',
  'Hoefler Text',
  'Iowan Old Style',
  'Charter',
  'Palatino',
  'Optima',
  'Gill Sans',
  'Times',
  // Linux
  'Noto Serif',
  'Noto Sans',
  'DejaVu Serif',
  'DejaVu Sans',
  'Liberation Serif',
  'Liberation Sans',
  'Ubuntu',
  'Cantarell',
  // Installed on purpose
  'Libertinus Serif',
  'Libertinus Sans',
  'Linux Libertine',
  'Source Serif 4',
  'Source Serif Pro',
  'Source Sans 3',
  'IBM Plex Serif',
  'IBM Plex Sans',
  'Literata',
  'Merriweather',
  'EB Garamond',
  'Crimson Pro',
  'Crimson Text',
  'Cormorant Garamond',
  'PT Serif',
  'PT Sans',
  'Lora',
  'Vollkorn',
  'Alegreya',
  'Spectral',
  'Bitter',
  'Roboto',
  'Roboto Slab',
  'Open Sans',
  'Lato',
  'Inter',
  'Fira Sans',
  'Atkinson Hyperlegible',
  'Lexend',
  'OpenDyslexic',
  'Minion Pro',
  'Sabon',
  'Bembo',
  'Bookerly'
]

/** The names worth offering for what is typed so far: a name the query
 *  opens, then one of whose words it opens, then one it occurs in — case-
 *  folded, each once, the exact name left out (nothing left to complete),
 *  at most `limit`. An empty query offers nothing. */
export function matchFontNames(query: string, names: readonly string[], limit = 6): string[] {
  const q = normalizeReadingFont(query).toLowerCase()
  if (!q) return []
  const seen = new Set<string>()
  const tiers: [string[], string[], string[]] = [[], [], []]
  for (const name of names) {
    const n = name.toLowerCase()
    if (n === q || seen.has(n)) continue
    seen.add(n)
    if (n.startsWith(q)) tiers[0].push(name)
    else if (n.split(' ').some((word) => word.startsWith(q))) tiers[1].push(name)
    else if (n.includes(q)) tiers[2].push(name)
  }
  return tiers.flat().slice(0, Math.max(0, limit))
}

/** The open list as the typed text narrows it: an empty query keeps
 *  everything; otherwise the name the query IS (the current face must stay
 *  in the list it opened), then the rest by the chips' own rule — names the
 *  query opens, then a word of them, then anywhere in them — with no cap. */
export function filterFamilies(families: readonly string[], query: string): string[] {
  const q = normalizeReadingFont(query).toLowerCase()
  if (!q) return [...families]
  const exact = families.filter((f) => f.toLowerCase() === q)
  return [...exact, ...matchFontNames(q, families, Number.POSITIVE_INFINITY)]
}

type LocalFontsWindow = { queryLocalFonts?: () => Promise<unknown> }

/** Whether this browser offers the listing at all — Chromium in a secure
 *  context: Electron, the extension, dev:web on localhost. Another engine, or
 *  a plain http origin, has no such function, and the field stands with the
 *  measured chips alone. */
export const localFontsAvailable = (): boolean =>
  typeof (window as unknown as LocalFontsWindow).queryLocalFonts === 'function'

export type LocalFontsResult =
  | { kind: 'list'; families: string[] }
  /** no API, or it failed with something other than a refusal */
  | { kind: 'unavailable' }
  /** the browser's setting for this origin says no */
  | { kind: 'denied' }
  /** the browser's prompt was closed without an answer */
  | { kind: 'dismissed' }
  /** the browser would have to ask, and this was not a click made for that */
  | { kind: 'unasked' }

async function localFontsPermission(): Promise<string> {
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName })
    return status.state
  } catch {
    return 'unknown'
  }
}

/** Ask for the machine's faces. Measured 2026-10-27 (TYPOGRAPHY.md § 5):
 *  Electron answers with no handler in main and no gesture (about 2 s the
 *  first time, at once after) and its permission state reads «granted»; the
 *  extension needs a user gesture and shows the browser's one prompt, and a
 *  Block there resolves with an EMPTY list rather than an error, which is
 *  why an empty list is checked against the permission state before it is
 *  believed. `mayPrompt` false — the keystroke path — asks only where the
 *  state already reads «granted», so typing never raises a dialog. */
export async function queryLocalFontFamilies(mayPrompt = true): Promise<LocalFontsResult> {
  const w = window as unknown as LocalFontsWindow
  if (typeof w.queryLocalFonts !== 'function') return { kind: 'unavailable' }
  if (!mayPrompt) {
    const state = await localFontsPermission()
    if (state === 'denied') return { kind: 'denied' }
    if (state !== 'granted') return { kind: 'unasked' }
  }
  let listing: unknown
  try {
    listing = await w.queryLocalFonts()
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return (await localFontsPermission()) === 'denied' ? { kind: 'denied' } : { kind: 'dismissed' }
    }
    return { kind: 'unavailable' }
  }
  const families = familiesFromListing(listing)
  if (families.length === 0 && (await localFontsPermission()) === 'denied') return { kind: 'denied' }
  return { kind: 'list', families }
}

export type InstalledFonts = {
  families: string[]
  /** `local`: Chromium's own listing; `measured`: the common faces that measure as installed */
  source: 'local' | 'measured'
  /** the browser's setting for this origin said no — the list says so */
  refused: boolean
}

let installed: InstalledFonts | null = null
const pending: { quiet?: Promise<InstalledFonts>; asking?: Promise<InstalledFonts> } = {}

/** The faces the machine has, remembered for the session; never a rejection,
 *  so the field always has something to offer. Chromium's own list where it
 *  comes, else the common faces that measure as installed. `mayPrompt` is
 *  the «Velg …» click — the one place the browser's prompt may be raised —
 *  and a measured list made while the browser would still ask is replaced
 *  by Chromium's once that click allows it. */
export function listInstalledFonts(mayPrompt = false): Promise<InstalledFonts> {
  if (installed && (installed.source === 'local' || installed.refused || !mayPrompt)) {
    return Promise.resolve(installed)
  }
  const slot = mayPrompt ? 'asking' : 'quiet'
  const running = pending[slot]
  if (running) return running
  const run = (async (): Promise<InstalledFonts> => {
    const result = await queryLocalFontFamilies(mayPrompt)
    const found: InstalledFonts =
      result.kind === 'list'
        ? { families: result.families, source: 'local', refused: false }
        : {
            families: COMMON_FONT_FAMILIES.filter((name) => isFontInstalled(name) === true),
            source: 'measured',
            refused: result.kind === 'denied'
          }
    if (!installed || installed.source !== 'local') installed = found
    return installed
  })().finally(() => {
    delete pending[slot]
  })
  pending[slot] = run
  return run
}

// Handwritten notes — the red-pen comment in the margin.
//
// A FreeText annotation cannot carry one: PDFium builds a FreeText's
// appearance from the 14 standard PDF fonts only, and FPDFAnnot_AppendObject
// (the way to put a real, embedded-font text object into an annotation)
// refuses every subtype except STAMP and INK — verified against
// FPDFAnnot_IsObjectSupportedSubtype, which answers false for FREETEXT.
//
// So a handwritten note is a **Stamp** whose appearance stream holds text
// drawn in an embedded TrueType font. That is a plain, portable construct:
// every reader paints a Stamp from its /AP, and because the font travels
// inside the file the glyphs are identical in Acrobat, in a browser, and in
// the app itself. The note's words also live in /Contents, so the notes panel,
// search and the exports keep working on it like any other comment.
// A font is ~110 kB of base64 and is loaded ON DEMAND — the first time someone
// writes or displays a handwritten note. Nothing about a plain reading session
// should pay for a feature it never uses (and a static import put the whole
// thing in every bundle and decoded it at startup).
//
// TWO fonts ship, and each note records which one it was written with (see
// HandFontId). Caveat is the pen today. Patrick Hand is the pen notes written
// before v0.36 carry, and re-baking one of those — a recolour, a drag, a
// resize all re-draw the glyphs — must use ITS font, or the file would quietly
// change typeface under the user. Each font is its own lazy chunk, so a
// session that never touches an old note never fetches the old pen.
//
/** Marks a Stamp as OURS. A Stamp is a generic subtype — other apps use it for
 *  image stamps — so reading one back only treats it as a handwritten note
 *  when this key is present. */
export const HAND_NOTE_KEY = 'PDFX_Hand'

/** Line height as a multiple of font size, shared by the baked appearance and
 *  the on-screen overlay so the two wrap identically. Both fonts are drawn at
 *  this step on screen — measured, not assumed: a two-line block at
 *  line-height 1.24 puts its second baseline exactly 1.24 em below its first
 *  in both. */
export const HAND_LINE_HEIGHT = 1.24

/** Which pen a note was written with. Stored on the annotation itself (see
 *  PDFX_HandFont in pdfium-annot-ops.ts) — an annotation with no such key
 *  predates the key and is Patrick Hand by definition. */
export type HandFontId = 'caveat' | 'patrickhand'

export interface HandFont {
  id: HandFontId
  /** What goes in the annotation's PDFX_HandFont, and what the font calls
   *  itself in its own name table */
  name: string
  /** The CSS family the renderer registers these bytes under */
  cssFamily: string
  /** Distance from the TOP of the note's box down to the first baseline, as a
   *  multiple of the font size, used by the baked appearance.
   *
   *  Not read from the font: it is the offset a BROWSER puts the first
   *  baseline at for a block of this line height, because the overlay and the
   *  editor are browser text and the file has to match what the writer saw.
   *  Measured in Chrome at font-size 100px / line-height 124px, with a
   *  zero-height inline-block strut on the baseline: Caveat 0.950 em, Patrick
   *  Hand 0.980 em. (Chrome derives it from the font's own ascent and the
   *  half-leading, so the two differ by exactly their ascent difference.)
   *
   *  Patrick Hand's is deliberately NOT its measured 0.98: notes already
   *  written with it were baked at 0.75, and re-baking one on a recolour must
   *  not shift its words. 0.75 is the eyeballed constant this file used to
   *  carry for every note — its comment claimed it came from the font's hhea,
   *  which was never true. */
  ascent: number
}

export const HAND_FONTS: Record<HandFontId, HandFont> = {
  caveat: { id: 'caveat', name: 'Caveat', cssFamily: 'PDFX Hand Caveat', ascent: 0.95 },
  patrickhand: {
    id: 'patrickhand',
    name: 'Patrick Hand',
    cssFamily: 'PDFX Hand Patrick',
    ascent: 0.75
  }
}

/** The pen a NEW note is written with. */
export const HAND_FONT_DEFAULT: HandFontId = 'caveat'

/** The font an id names, falling back to today's pen. Use for a value that
 *  came from our own code (a request, a record) — for a value read out of a
 *  FILE use handFontFromAnnotation, whose fallback is the opposite. */
export function handFont(id: HandFontId | null | undefined): HandFont {
  return (id && HAND_FONTS[id]) || HAND_FONTS[HAND_FONT_DEFAULT]
}

/** The font an annotation's PDFX_HandFont names. A MISSING key means the note
 *  predates the key, which means Patrick Hand — every note written before then
 *  was. An unrecognised name (a note from a later version of the app) falls
 *  back to today's pen: we cannot draw a font we do not have. */
export function handFontFromAnnotation(name: string | null | undefined): HandFont {
  if (name === null || name === undefined || name === '') return HAND_FONTS.patrickhand
  const wanted = name.trim().toLowerCase()
  for (const f of Object.values(HAND_FONTS)) {
    if (f.name.toLowerCase() === wanted || f.id === wanted) return f
  }
  return HAND_FONTS[HAND_FONT_DEFAULT]
}

const cachedBytes = new Map<HandFontId, Uint8Array>()
const loading = new Map<HandFontId, Promise<string>>()

/** The base64, fetched from its own chunk the first time it is wanted. The
 *  imports are spelled out rather than built from `id` on purpose: a template
 *  path would leave the bundler unable to split them, which is the whole
 *  point of loading them this way. */
function handFontBase64(id: HandFontId): Promise<string> {
  let p = loading.get(id)
  if (!p) {
    p =
      id === 'patrickhand'
        ? import('./hand-font-data-patrickhand').then((m) => m.HAND_FONT_BASE64)
        : import('./hand-font-data-caveat').then((m) => m.HAND_FONT_BASE64)
    loading.set(id, p)
  }
  return p
}

/** The font bytes, for embedding. Awaited by the engines BEFORE they enter the
 *  synchronous raw-pointer bridge, so the decode never happens under a
 *  borrowed page handle. Decoded once per font. */
export async function handFontBytes(id: HandFontId = HAND_FONT_DEFAULT): Promise<Uint8Array> {
  const hit = cachedBytes.get(id)
  if (hit) return hit
  const b64 = await handFontBase64(id)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  cachedBytes.set(id, out)
  return out
}

/** A `data:` URL for the renderer's @font-face. Registering the face is the
 *  renderer's job — this module is also compiled for Electron main, which has
 *  no DOM: see src/renderer/src/hand-font.ts. */
export async function handFontDataUrl(id: HandFontId = HAND_FONT_DEFAULT): Promise<string> {
  return `data:font/ttf;base64,${await handFontBase64(id)}`
}

/** Greedy word wrap. Width is measured by the caller (it differs per
 *  environment: canvas in the renderer, PDFium glyph widths in the engine), so
 *  the algorithm lives here once and both feed it a measurer. */
export function wrapHandText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (line && measure(candidate) > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

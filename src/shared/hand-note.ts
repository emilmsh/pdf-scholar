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
import { HAND_FONT_BASE64, HAND_FONT_NAME } from './hand-font-data'

export { HAND_FONT_NAME }

/** Marks a Stamp as OURS. A Stamp is a generic subtype — other apps use it for
 *  image stamps — so reading one back only treats it as a handwritten note
 *  when this key is present. */
export const HAND_NOTE_KEY = 'PDFX_Hand'

/** Line height as a multiple of font size, shared by the baked appearance and
 *  the on-screen overlay so the two wrap identically. */
export const HAND_LINE_HEIGHT = 1.24

/** Patrick Hand's own metrics (units per em 1000; ascent from its hhea). Used
 *  to place the first baseline the same way in both renderings. */
export const HAND_ASCENT = 0.75

let cached: Uint8Array | null = null

/** The font bytes. Decoded once — 210 kB of base64 is not worth re-parsing. */
export function handFontBytes(): Uint8Array {
  if (cached) return cached
  const bin = atob(HAND_FONT_BASE64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  cached = out
  return out
}

/** The CSS family name the renderer registers the embedded font under.
 *  (Registering it is the renderer's job — this module is also compiled for
 *  Electron main, which has no DOM: see src/renderer/src/hand-font.ts.) */
export const HAND_FONT_CSS_FAMILY = 'PDFX Hand'

/** A `data:` URL for the renderer's @font-face */
export function handFontDataUrl(): string {
  return `data:font/ttf;base64,${HAND_FONT_BASE64}`
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

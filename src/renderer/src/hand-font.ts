// The browser half of the handwriting fonts. Kept out of src/shared/hand-note.ts
// because that module is also compiled for Electron main, which has no DOM.
//
// The point of both halves is one guarantee: the overlay shows the SAME glyphs
// the engine embeds, and the line wrapping is measured here — on screen, with
// the real font — then baked into the file exactly as measured. Anything else
// and a note would reflow the moment it was saved. That is also why the fonts
// in assets/fonts/ are subsets with their layout features stripped: a browser
// applies `calt` and `liga` by default, PDFium does no shaping at all, and the
// two would disagree about both glyphs and widths.
//
// Loaded ON DEMAND, one font at a time. Each is ~110 kB of base64 in its own
// chunk, and a reading session that never writes a handwritten note should
// never fetch one, let alone decode it at startup.
import { HAND_FONT_DEFAULT, handFont, handFontDataUrl } from '../../shared/hand-note'
import type { HandFontId } from '../../shared/hand-note'

const installing = new Map<HandFontId, Promise<void>>()

/** Register one handwriting font as a webfont. Idempotent, and cheap to call
 *  again — every caller shares the one load. */
export function installHandFont(id: HandFontId = HAND_FONT_DEFAULT): Promise<void> {
  let p = installing.get(id)
  if (!p) {
    p = (async () => {
      if (typeof FontFace === 'undefined') return
      const family = handFont(id).cssFamily
      for (const f of document.fonts) if (f.family === family) return
      const face = new FontFace(family, `url(${await handFontDataUrl(id)})`)
      await face.load()
      document.fonts.add(face)
    })()
    installing.set(id, p)
  }
  return p
}

/** The CSS `font-family` value for a note, its own font first. The record of a
 *  note read back from a file names no font, and one written before the font
 *  was recorded is Patrick Hand — but such a note is painted by pdf.js from
 *  its appearance stream, never by the overlay, so today's pen is the right
 *  default for everything that reaches here. */
export function handFontCss(id: HandFontId | null | undefined): string {
  return `'${handFont(id).cssFamily}', 'Segoe Script', cursive`
}

/** Measure a string in page points with a handwriting font, for
 *  `wrapHandText`. The font must be installed first — measuring against a
 *  fallback would wrap at the wrong widths and the note would reflow on save,
 *  so callers await installHandFont(). */
export function handTextMeasurer(
  fontSize: number,
  id: HandFontId = HAND_FONT_DEFAULT
): (s: string) => number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return (s) => s.length * fontSize * 0.5
  ctx.font = `${fontSize}px "${handFont(id).cssFamily}"`
  return (s) => ctx.measureText(s).width
}

// The browser half of the handwriting font. Kept out of src/shared/hand-note.ts
// because that module is also compiled for Electron main, which has no DOM.
//
// The point of both halves is one guarantee: the overlay shows the SAME glyphs
// the engine embeds, and the line wrapping is measured here — on screen, with
// the real font — then baked into the file exactly as measured. Anything else
// and a note would reflow the moment it was saved.
import { HAND_FONT_CSS_FAMILY, handFontDataUrl } from '../../shared/hand-note'

/** Register the embedded font as a webfont. Idempotent; safe to call before
 *  the first paint. */
export async function installHandFont(): Promise<void> {
  if (typeof FontFace === 'undefined') return
  for (const f of document.fonts) if (f.family === HAND_FONT_CSS_FAMILY) return
  const face = new FontFace(HAND_FONT_CSS_FAMILY, `url(${handFontDataUrl()})`)
  await face.load()
  document.fonts.add(face)
}

/** Measure a string in page points with the handwriting font, for
 *  `wrapHandText`. Falls back to a rough estimate if 2D canvas is unavailable
 *  (never in practice — the app already needs it to render pages). */
export function handTextMeasurer(fontSize: number): (s: string) => number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return (s) => s.length * fontSize * 0.5
  ctx.font = `${fontSize}px "${HAND_FONT_CSS_FAMILY}"`
  return (s) => ctx.measureText(s).width
}

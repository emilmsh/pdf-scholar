// The browser half of the handwriting font. Kept out of src/shared/hand-note.ts
// because that module is also compiled for Electron main, which has no DOM.
//
// The point of both halves is one guarantee: the overlay shows the SAME glyphs
// the engine embeds, and the line wrapping is measured here — on screen, with
// the real font — then baked into the file exactly as measured. Anything else
// and a note would reflow the moment it was saved.
//
// Loaded ON DEMAND. The font is 280 kB of base64 in its own chunk, and a
// reading session that never writes a handwritten note should never fetch it,
// let alone decode it at startup.
import { HAND_FONT_CSS_FAMILY, handFontDataUrl } from '../../shared/hand-note'

let installing: Promise<void> | null = null

/** Register the embedded font as a webfont. Idempotent, and cheap to call
 *  again — every caller shares the one load. */
export function installHandFont(): Promise<void> {
  installing ??= (async () => {
    if (typeof FontFace === 'undefined') return
    for (const f of document.fonts) if (f.family === HAND_FONT_CSS_FAMILY) return
    const face = new FontFace(HAND_FONT_CSS_FAMILY, `url(${await handFontDataUrl()})`)
    await face.load()
    document.fonts.add(face)
  })()
  return installing
}

/** Measure a string in page points with the handwriting font, for
 *  `wrapHandText`. The font must be installed first — measuring against a
 *  fallback would wrap at the wrong widths and the note would reflow on save,
 *  so callers await installHandFont(). */
export function handTextMeasurer(fontSize: number): (s: string) => number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return (s) => s.length * fontSize * 0.5
  ctx.font = `${fontSize}px "${HAND_FONT_CSS_FAMILY}"`
  return (s) => ctx.measureText(s).width
}

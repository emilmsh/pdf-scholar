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
// The font itself is 280 kB of base64 and is loaded ON DEMAND — the first time
// someone writes or displays a handwritten note. Nothing about a plain reading
// session should pay for a feature it never uses (and a static import put the
// whole thing in every bundle and decoded it at startup).
//
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

let cachedBytes: Uint8Array | null = null
let loading: Promise<string> | null = null

/** The base64, fetched from its own chunk the first time it is wanted. */
function handFontBase64(): Promise<string> {
  loading ??= import('./hand-font-data').then((m) => m.HAND_FONT_BASE64)
  return loading
}

/** The font bytes, for embedding. Awaited by the engines BEFORE they enter the
 *  synchronous raw-pointer bridge, so the decode never happens under a
 *  borrowed page handle. Decoded once. */
export async function handFontBytes(): Promise<Uint8Array> {
  if (cachedBytes) return cachedBytes
  const b64 = await handFontBase64()
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  cachedBytes = out
  return out
}

/** The CSS family name the renderer registers the embedded font under.
 *  (Registering it is the renderer's job — this module is also compiled for
 *  Electron main, which has no DOM: see src/renderer/src/hand-font.ts.) */
export const HAND_FONT_CSS_FAMILY = 'PDFX Hand'

/** A `data:` URL for the renderer's @font-face */
export async function handFontDataUrl(): Promise<string> {
  return `data:font/ttf;base64,${await handFontBase64()}`
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

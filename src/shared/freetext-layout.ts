// Where a text box's words sit in the SAVED FILE — the one layout the editor,
// the on-screen mark and both write paths share (issue #66).
//
// A FreeText's appearance is built by whoever writes it: PDFium in the normal
// full-rewrite save, our own incremental appender past 150 MB. PDFium sets the
// text with NO inset at all — the first line starts on the box's left edge,
// its baseline one ASCENT below the top edge, and every further line one STEP
// lower (ascent + descent of the face, so the last line's descenders end on
// the box's bottom when the box is exactly as tall as its lines). It wraps a
// line once the text is WIDER than the box, measured with the Standard-14
// advance widths below. Measured from the appearance streams PDFium writes
// (2026-10-30) — `test:engine` re-reads them on every run, so an EmbedPDF
// update that moves the text fails there and not in a reader's file.
//
// Why it matters: a box that hugs its text (a new box grows as it is typed
// into) is only as wide as its longest line plus FREETEXT_HUG_SLACK. If the
// screen and the file set that line in different places or at different
// widths, the file wraps the last word where the screen did not. The appender
// therefore sets text exactly as PDFium does, with the same widths, and the
// renderer gives the editor and the overlay the same line box (see
// freetextLineCss in the renderer's annotations.ts).

/** Ascent (first baseline below the top edge) and line step, in ems, per
 *  PdfStandardFont value — the twelve text faces the text tool offers */
export interface FreetextFaceMetrics {
  ascent: number
  step: number
}

const FACE_METRICS: Record<number, FreetextFaceMetrics> = {
  0: { ascent: 0.803, step: 1.051 }, // Courier
  1: { ascent: 0.811, step: 1.059 }, // Courier-Bold
  2: { ascent: 0.811, step: 1.059 }, // Courier-BoldOblique
  3: { ascent: 0.803, step: 1.051 }, // Courier-Oblique
  4: { ascent: 0.945, step: 1.169 }, // Helvetica
  5: { ascent: 0.962, step: 1.189 }, // Helvetica-Bold
  6: { ascent: 0.962, step: 1.189 }, // Helvetica-BoldOblique
  7: { ascent: 0.951, step: 1.175 }, // Helvetica-Oblique
  8: { ascent: 0.878, step: 1.127 }, // Times-Roman
  9: { ascent: 0.889, step: 1.138 }, // Times-Bold
  10: { ascent: 0.869, step: 1.118 }, // Times-BoldItalic
  11: { ascent: 0.868, step: 1.117 } // Times-Italic
}

/** Helvetica, the face a box with no face named is set in */
const DEFAULT_FACE = 4

export function freetextFaceMetrics(font: number | undefined): FreetextFaceMetrics {
  return FACE_METRICS[font ?? DEFAULT_FACE] ?? FACE_METRICS[DEFAULT_FACE]
}

/** The room a box that hugs its text keeps past its widest line, in points.
 *  PDFium wraps a line that is wider than the box by any amount (a box
 *  exactly as wide as its text wrapped at some sizes in the measurement — the
 *  rect is written rounded), and the caret needs a pixel at the line's end. */
export const FREETEXT_HUG_SLACK = 2

/** How far short of the page's right edge a growing box stops widening and
 *  starts to wrap, in points */
export const FREETEXT_EDGE_MARGIN = 12

// ---------- Standard-14 advance widths (per mille) ----------
//
// One entry per character of WIDTH_CHARS: printable ASCII, Latin-1 and the
// WinAnsi extras (€, typographic quotes, dashes …) — every character the
// appender can write into a /WinAnsiEncoding string. The Adobe AFM widths, as
// the base-14 fonts mupdf carries report them (`test:appender` checks every
// entry against mupdf's fonts, and `test:annot-edit` checks the screen's
// fonts against them). Oblique shares its upright face's widths; every
// Courier glyph is 600.

const WIDTH_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  ' ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ' +
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'

const WIDTHS: Record<'helv' | 'helvB' | 'times' | 'timesB' | 'timesI' | 'timesBI', string> = {
  helv:
    '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,' +
    '278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500,' +
    '556,222,556,333,1000,556,556,333,1000,667,333,1000,611,222,222,333,333,350,556,1000,333,1000,500,333,944,500,667',
  helvB:
    '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,' +
    '278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556,' +
    '556,278,556,500,1000,556,556,333,1000,667,333,1000,611,278,278,500,500,350,556,1000,333,1000,556,333,944,500,667',
  times:
    '250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,' +
    '250,333,500,500,500,500,200,500,333,760,276,500,564,333,760,333,400,564,300,300,333,500,453,250,333,300,310,500,750,750,750,444,722,722,722,722,722,722,889,667,611,611,611,611,333,333,333,333,722,722,722,722,722,722,722,564,722,722,722,722,722,722,556,500,444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,500,564,500,500,500,500,500,500,500,500,' +
    '500,333,500,444,1000,500,500,333,1000,556,333,889,611,333,333,444,444,350,500,1000,333,980,389,333,722,444,722',
  timesB:
    '250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,' +
    '250,333,500,500,500,500,220,500,333,747,300,500,570,333,747,333,400,570,300,300,333,556,540,250,333,300,330,500,750,750,750,500,722,722,722,722,722,722,1000,722,667,667,667,667,389,389,389,389,722,722,778,778,778,778,778,570,778,722,722,722,722,722,611,556,500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,500,570,500,556,556,556,556,500,556,500,' +
    '500,333,500,500,1000,500,500,333,1000,556,333,1000,667,333,333,500,500,350,500,1000,333,1000,389,333,722,444,722',
  timesI:
    '250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,' +
    '250,389,500,500,500,500,275,500,333,760,276,500,675,333,760,333,400,675,300,300,333,500,523,250,333,300,310,500,750,750,750,500,611,611,611,611,611,611,889,667,611,611,611,611,333,333,333,333,722,667,722,722,722,722,722,675,722,722,722,722,722,556,611,500,500,500,500,500,500,500,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,500,675,500,500,500,500,500,444,500,444,' +
    '500,333,500,556,889,500,500,333,1000,500,333,944,556,333,333,556,556,350,500,889,333,980,389,333,667,389,556',
  timesBI:
    '250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,' +
    '250,389,500,500,500,500,220,500,333,747,266,500,606,333,747,333,400,570,300,300,333,576,500,250,333,300,300,500,750,750,750,500,667,667,667,667,667,667,944,667,667,667,667,667,389,389,389,389,722,722,722,722,722,722,722,570,722,722,722,722,722,611,611,500,500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,500,570,500,556,556,556,556,444,500,444,' +
    '500,333,500,500,1000,500,500,333,1000,556,333,944,611,333,333,500,500,350,500,1000,333,1000,389,333,722,389,611'
}

/** Which table a face reads, by PdfStandardFont value; Courier needs none */
const FACE_TABLE: Record<number, keyof typeof WIDTHS | 'mono'> = {
  0: 'mono',
  1: 'mono',
  2: 'mono',
  3: 'mono',
  4: 'helv',
  5: 'helvB',
  6: 'helvB',
  7: 'helv',
  8: 'times',
  9: 'timesB',
  10: 'timesBI',
  11: 'timesI'
}

const parsed = new Map<string, Map<string, number>>()
function table(key: keyof typeof WIDTHS): Map<string, number> {
  let t = parsed.get(key)
  if (!t) {
    const nums = WIDTHS[key].split(',').map(Number)
    t = new Map([...WIDTH_CHARS].map((ch, i) => [ch, nums[i] ?? 0]))
    parsed.set(key, t)
  }
  return t
}

/** The width of `text` set in a Standard-14 face at `size`, in points — what
 *  PDFium wraps by. A character outside the table counts as an «n». */
export function standardTextWidth(text: string, size: number, font: number | undefined): number {
  const key = FACE_TABLE[font ?? DEFAULT_FACE] ?? FACE_TABLE[DEFAULT_FACE]
  let w = 0
  if (key === 'mono') {
    w = 600 * [...text].length
  } else {
    const t = table(key)
    const fallback = t.get('n') ?? 556
    for (const ch of text) w += t.get(ch) ?? fallback
  }
  return (w / 1000) * size
}

/** Every character the width tables cover, for the tests that check them */
export const STANDARD_WIDTH_CHARS = WIDTH_CHARS

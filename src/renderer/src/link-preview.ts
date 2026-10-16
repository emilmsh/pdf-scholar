// Hover previews of in-document links (issue #31) — the rules, kept free of
// React and the DOM so scripts/test-link-preview.mjs can run them in Node.
//
// A link to a figure, an equation, a section or a reference-list entry is a
// question («which one was that?») that following the link answers at the
// price of your place. The preview answers it in place: a window onto the
// destination page, scrolled to the destination, gone when the pointer leaves.
// The component (components/LinkPreview.tsx) owns the pointer choreography and
// the canvas; this file decides WHERE in the page the window looks and how
// large it is, and the registry PdfPage fills so the component knows what an
// anchor points at without a prop threaded through three layers.

import type { PDFDocumentProxy } from 'pdfjs-dist'

/** What PdfPage records for each in-document link anchor it builds. The
 *  document travels with the destination because a split column can show a
 *  DIFFERENT file than the tab: the anchor knows which one it belongs to. */
export interface LinkRecord {
  pdf: PDFDocumentProxy
  dest: unknown
  /** The view rotation the anchor's page is shown at (on top of /Rotate) */
  rotation: number
  /** Go to a destination of this document from the anchor's column, the way
   *  the link itself goes (Ctrl/Cmd: the other column) — the citation card's
   *  «Gå til» for an entry the link does not point at */
  follow?: (dest: unknown, toOther: boolean) => void
}

/** anchor → what it points at. Weak, so a page that unmounts its link layer
 *  takes its entries with it. */
export const LINK_RECORDS = new WeakMap<Element, LinkRecord>()

/** What a destination is, read from its NAME — the only thing that says.
 *  LaTeX's hyperref names every anchor after its counter (`cite.vaswani2017`,
 *  `figure.3`, `equation.2.1`, `section.4`, `Hfootnote.7`), and the big
 *  publishers' typesetters use their own stable prefixes for reference-list
 *  entries (Elsevier and eLife `bib12`, Springer `CR12`, Wiley `bib-0012`,
 *  Frontiers `B12`, PLOS `pone.0123456.ref012`). An explicit destination (an
 *  array, no name) is 'other'. */
export type LinkKind = 'citation' | 'figure' | 'table' | 'equation' | 'section' | 'footnote' | 'other'

export function linkKind(destName: string | null): LinkKind {
  if (!destName) return 'other'
  const n = destName.trim()
  if (/^cite\./i.test(n)) return 'citation'
  // PLOS names BOTH directions after the entry: `R…refNNN` is the citation
  // in the text, `L…refNNN` the entry's link back to it
  if (/^L[a-z]+\.\d+\.ref\d+$/.test(n)) return 'other'
  if (/^(bib|CR|ref|B|R|BIB|cit)[-_.]?\d+$/i.test(n) || /\.(ref|bib)\d+$/i.test(n)) return 'citation'
  // Springer Nature `bm_CR12`, eLife's InDesign `…indd:R29:216`, REVTeX's
  // `temp:intralink-c7`
  if (/(^|[_.])(CR|bib|ref)\d+$/i.test(n) || /:R\d+(:\d+)?$/.test(n) || /intralink-c\d+$/.test(n)) {
    return 'citation'
  }
  if (/^(figure|subfigure|fig|f)[-_.]?\d/i.test(n)) return 'figure'
  if (/^(table|subtable|tab|t)[-_.]?\d/i.test(n)) return 'table'
  if (/^(equation|eq|eqn|AMS|disp|mjx-eqn)[-_.]?/i.test(n)) return 'equation'
  if (/^(Hfootnote|footnote|fn|FN|mpfootnote)[-_.]?/i.test(n)) return 'footnote'
  if (/^(sub)*(section|chapter|part|appendix|paragraph|sec|app)[-_.*]?/i.test(n)) return 'section'
  return 'other'
}

/** A destination resolved to a point on a page. x/y are PDF user space
 *  (bottom-up y), either may be null when the destination does not name it
 *  (`/Fit` names neither, `/FitH` only a top). */
export interface PreviewTarget {
  pageIndex: number
  x: number | null
  y: number | null
  kind: LinkKind
  /** The destination's name, when it has one — what the reference-list
   *  entry's neighbours are found by (citationEntryText) */
  name: string | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The point an explicit destination array names, per PDF 32000 §12.3.2.2.
 *  Returns [left, top]; FitR names a rectangle, of which the top-left counts. */
export function destPoint(explicit: readonly unknown[]): [number | null, number | null] {
  const mode = (explicit[1] as { name?: string } | undefined)?.name
  switch (mode) {
    case 'XYZ':
      return [num(explicit[2]), num(explicit[3])]
    case 'FitH':
    case 'FitBH':
      return [null, num(explicit[2])]
    case 'FitV':
    case 'FitBV':
      return [num(explicit[2]), null]
    case 'FitR': {
      // [page /FitR left bottom right top]. Springer Nature's typesetter
      // writes the rectangle upside down, so the corners are sorted here.
      const l = num(explicit[2])
      const b = num(explicit[3])
      const r = num(explicit[4])
      const t = num(explicit[5])
      return [l !== null && r !== null ? Math.min(l, r) : l, b !== null && t !== null ? Math.max(b, t) : t]
    }
    default:
      return [null, null]
  }
}

/** Resolve a link's destination against its document. Null for anything that
 *  does not land on a page of it (a dangling name, a page past the end). */
export async function resolvePreviewTarget(
  pdf: PDFDocumentProxy,
  dest: unknown
): Promise<PreviewTarget | null> {
  try {
    const name = typeof dest === 'string' ? dest : null
    const explicit = name !== null ? await pdf.getDestination(name) : (dest as unknown[] | null)
    if (!Array.isArray(explicit) || explicit.length === 0) return null
    const ref = explicit[0]
    const pageIndex =
      typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) return null
    const [x, y] = destPoint(explicit)
    return { pageIndex, x, y, kind: linkKind(name), name }
  } catch {
    return null
  }
}

/** The window's CSS size for a kind of destination. A reference-list entry is
 *  two to four lines, and a little of its neighbours is context enough; a
 *  figure needs the room. Never more than 60 % of the window's height and
 *  never wider than the window minus its margins. */
export function previewSize(kind: LinkKind, winW: number, winH: number): { w: number; h: number } {
  const h =
    kind === 'citation' || kind === 'footnote'
      ? 150
      : kind === 'equation'
        ? 170
        : kind === 'figure' || kind === 'table'
          ? 380
          : 240
  return {
    w: Math.max(200, Math.min(600, winW - 24)),
    h: Math.max(110, Math.min(h, Math.round(winH * 0.6)))
  }
}

/** Where, inside the page image, the window's top-left corner goes — in the
 *  image's own CSS pixels (0,0 = the page's top-left at preview scale).
 *
 *  `vx`/`vy` are the destination in those pixels (null when unnamed).
 *  `captionAbove` = the destination sits ON a figure's caption, with the
 *  figure above it: LaTeX without the caption package anchors a figure at its
 *  caption, and a window that starts there shows a caption and no figure. The
 *  window then looks UP from the caption. With the caption package (hypcap)
 *  the anchor is the top of the float and the window starts there. */
export function previewScroll(
  kind: LinkKind,
  vx: number | null,
  vy: number | null,
  box: { w: number; h: number },
  page: { w: number; h: number },
  captionAbove = false
): { left: number; top: number } {
  const maxLeft = Math.max(0, page.w - box.w)
  const maxTop = Math.max(0, page.h - box.h)
  // Horizontally: a page narrower than the window needs nothing; a wider one
  // starts a little left of the destination, which in a two-column layout is
  // the column it is in.
  const left = vx === null ? 0 : clamp(vx - 18, 0, maxLeft)
  if (vy === null) return { left, top: 0 }
  let above: number
  if (kind === 'figure' && captionAbove) above = box.h * 0.86
  else if (kind === 'equation') above = 28
  else if (kind === 'citation' || kind === 'footnote') above = 6
  else above = 12
  return { left, top: clamp(vy - above, 0, maxTop) }
}

/** Does a text line read as a figure caption's start? «Figure 3:», «Fig. 3.»,
 *  «FIGURE 3», plus the Nordic and German forms the app's readers meet. */
export function isFigureCaption(line: string): boolean {
  return /^\s*(figure|fig\.?|figur|abbildung|abb\.?)\s*[A-Z]?\d/i.test(line)
}

/** Is there a figure caption's first line just below a destination? Then the
 *  destination is LaTeX's caption anchor (no hypcap: hyperref raises it about
 *  a line above the caption's baseline) and the figure is ABOVE it — see
 *  previewScroll. pdf.js caches a page's text, so this is cheap after the
 *  first look, and the reference pages most hovers land on never ask. */
export async function destOnFigureCaption(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  y: number
): Promise<boolean> {
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const content = await page.getTextContent()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const iy = item.transform[5] as number
      const size = Math.hypot(item.transform[2] as number, item.transform[3] as number) || 10
      if (iy <= y + 2 && iy >= y - 3 * size && isFigureCaption(item.str)) return true
    }
  } catch {
    // No text to read: take the anchor for the float's top
  }
  return false
}

/** Where the window opens relative to the hovered link: below it when there
 *  is room, above when not, and the side with more room when neither fits.
 *  Horizontally it centres on the pointer, kept inside the window. */
export function placePreview(
  anchor: { left: number; top: number; bottom: number },
  pointerX: number,
  box: { w: number; h: number },
  win: { w: number; h: number },
  gap = 8,
  margin = 12
): { left: number; top: number; below: boolean } {
  const left = clamp(pointerX - box.w / 2, margin, Math.max(margin, win.w - margin - box.w))
  const roomBelow = win.h - anchor.bottom - gap - margin
  const roomAbove = anchor.top - gap - margin
  const below = roomBelow >= box.h || (roomAbove < box.h && roomBelow >= roomAbove)
  const top = below
    ? Math.min(anchor.bottom + gap, win.h - margin - box.h)
    : Math.max(margin, anchor.top - gap - box.h)
  return { left, top: Math.max(margin, top), below }
}

/** Where the window goes once it holds an abstract (Emil, 2026-10-10: «nesten
 *  ingen del av abstractet var synlig uten scrolling»). It is placed ONCE, as
 *  a whole, by what it now needs: below the link when it fits there, above
 *  when it fits there. When neither side holds all of it, a side with room
 *  worth reading in (`minSide`) takes it and the abstract scrolls the rest;
 *  when not even that, the abstract wins over the citation and the window
 *  covers the link — it is pinned by then, and it can be dragged aside. */
export function placeExpanded(
  anchor: { top: number; bottom: number },
  need: number,
  win: { h: number },
  gap = 8,
  margin = 12,
  minSide = 360
): { top: number; height: number; covers: boolean } {
  const below = win.h - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin
  const h = Math.min(need, win.h - 2 * margin)
  if (h <= below) return { top: anchor.bottom + gap, height: h, covers: false }
  if (h <= above) return { top: anchor.top - gap - h, height: h, covers: false }
  if (Math.max(below, above) >= minSide) {
    return below >= above
      ? { top: anchor.bottom + gap, height: below, covers: false }
      : { top: margin, height: above, covers: false }
  }
  // Over the link, but starting a little above it, so the line read just
  // before the citation is the part that stays in view longest
  const top = clamp(anchor.top - h / 3, margin, win.h - margin - h)
  return { top, height: h, covers: true }
}

/** Hover delay presets (Settings.linkPreviewDelay) — fixed choices rather
 *  than a slider. 'short' is for the reader who sweeps a paragraph's
 *  citations; 'long' for one who rests the pointer on text while reading. */
export const LINK_PREVIEW_DELAYS = { short: 150, medium: 350, long: 700 } as const
export type LinkPreviewDelay = keyof typeof LINK_PREVIEW_DELAYS

export function linkPreviewDelayMs(v: unknown): number {
  return typeof v === 'string' && v in LINK_PREVIEW_DELAYS
    ? LINK_PREVIEW_DELAYS[v as LinkPreviewDelay]
    : LINK_PREVIEW_DELAYS.medium
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------- The reference-list entry behind a citation ----------
//
// The «Sammendrag» button needs the entry's TEXT, which the page holds only as
// positioned glyph runs. The entry starts at the citation's destination and
// ends where the NEXT entry's destination is: the typesetter names every entry
// in one family (`cite.*`, Springer's `bm_CR12`, PLOS's `…ref012`), so the
// family's other destinations on the page are the boundaries. Where there is
// no next one in the column (the last entry on a page), the layout decides: a
// new label, the hanging indent coming back, or a gap. Measured on 695 entries
// from twelve publishers: about 95 % come out clean
// (docs/agent-notes/sitat-sammendrag.md).

/** One line of a page's text, in PDF user space (y = baseline, bottom-up) */
export interface TextLine {
  x0: number
  x1: number
  y: number
  size: number
  text: string
  /** Where each glyph run's characters are, text offsets to x — what lets a
   *  link's box be read back as words (entrySegments). Absent on lines a
   *  caller laid out by hand. */
  runs?: { x0: number; x1: number; start: number; end: number }[]
}

/** Glyph runs (pdf.js text items) to lines. Runs on one baseline join while
 *  they continue each other; a jump sideways starts a new line, which is what
 *  keeps a two-column page's columns apart. Whitespace is collapsed as the
 *  line is built, so the runs' offsets address the line's final text. */
export function textLines(items: readonly unknown[]): TextLine[] {
  const lines: TextLine[] = []
  let cur: TextLine | null = null
  const space = (l: TextLine): void => {
    if (l.text && !l.text.endsWith(' ')) l.text += ' '
  }
  for (const raw of items) {
    const it = raw as { str?: unknown; transform?: unknown; width?: unknown }
    if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
    const tf = it.transform as number[]
    const size = Math.hypot(tf[2] ?? 0, tf[3] ?? 0) || 10
    const x = tf[4] ?? 0
    const y = tf[5] ?? 0
    const w = typeof it.width === 'number' ? it.width : 0
    if (!it.str.trim()) {
      if (cur) space(cur)
      continue
    }
    let str = it.str.replace(/\s+/g, ' ')
    if (cur && Math.abs(y - cur.y) < size * 0.5 && x >= cur.x1 - size && x - cur.x1 < size * 2.5) {
      if (x - cur.x1 > size * 0.15) space(cur)
      if (cur.text.endsWith(' ')) str = str.trimStart()
      cur.runs!.push({ x0: x, x1: x + w, start: cur.text.length, end: cur.text.length + str.length })
      cur.text += str
      cur.x1 = Math.max(cur.x1, x + w)
      cur.size = Math.max(cur.size, size)
    } else {
      // A run's leading blank is part of its width: the text starts after it
      str = str.trimStart()
      cur = { x0: x, x1: x + w, y, size, text: str, runs: [{ x0: x, x1: x + w, start: 0, end: str.length }] }
      lines.push(cur)
    }
  }
  for (const l of lines) l.text = l.text.trimEnd()
  return lines.filter((l) => l.text)
}

/** The x a character of a line sits at (its middle), read from the glyph
 *  run it belongs to; spread evenly over the line when the runs are unknown */
function charX(line: TextLine, i: number): number {
  const run = line.runs?.find((r) => i >= r.start && i < r.end)
  if (run) return run.x0 + ((i - run.start + 0.5) / Math.max(1, run.end - run.start)) * (run.x1 - run.x0)
  return line.x0 + ((i + 0.5) / Math.max(1, line.text.length)) * (line.x1 - line.x0)
}

/** A piece of a reference entry as the card shows it: text, and the address
 *  the PDF links it to when it does (a DOI, a journal page, an arXiv id) */
export interface EntrySegment {
  text: string
  url?: string
}

/** A URI link annotation on the reference page: its box in PDF space */
export interface UriLink {
  rect: readonly number[]
  url: string
}

/** The entry's lines as one paragraph, the way Zotero's reader shows a
 *  reference: line breaks become spaces, a word the typesetter hyphenated at
 *  a line's end is whole again, and the words a URI link's box covers carry
 *  its address. A link that runs on over a line break (a long DOI) is not
 *  broken by a space. Words, not characters, are what a box claims — a run's
 *  glyphs are only spaced evenly here, and a word is claimed by its middle. */
export function entrySegments(lines: readonly TextLine[], links: readonly UriLink[] = []): EntrySegment[] {
  const out: EntrySegment[] = []
  const push = (text: string, url: string | undefined): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.url === url) last.text += text
    else out.push(url ? { text, url } : { text })
  }
  let prevUrl: string | undefined
  lines.forEach((line, li) => {
    // Each word of the line, with the link (if any) whose box holds its middle
    const words: { text: string; url?: string }[] = []
    // A word's closing punctuation is a token of its own: the full stop after
    // a DOI is the sentence's, not the link's
    for (const m of line.text.matchAll(/\S+?(?=[.,;:]*(?:\s|$))|[.,;:]+|\s+/g)) {
      if (/^\s/.test(m[0])) {
        words.push({ text: ' ' })
        continue
      }
      const mid = (charX(line, m.index) + charX(line, m.index + m[0].length - 1)) / 2
      const hit = links.find((k) => {
        const [x0, y0, x1, y1] = k.rect as [number, number, number, number]
        const yMid = line.y + line.size * 0.3
        return mid >= Math.min(x0, x1) && mid <= Math.max(x0, x1) && yMid >= Math.min(y0, y1) && yMid <= Math.max(y0, y1)
      })
      words.push(hit ? { text: m[0], url: hit.url } : { text: m[0] })
    }
    // The blank between two words of one link is the link's too
    words.forEach((w, i) => {
      const u = words[i - 1]?.url
      if (w.text === ' ' && u !== undefined && words[i + 1]?.url === u) w.url = u
    })
    if (li > 0 && words.length) {
      const prev = out[out.length - 1]
      const first = words[0]!
      if (prev && prevUrl !== undefined && first.url === prevUrl && /^\S*\/\S*$/.test(prev.text)) {
        // A DOI or URL set over two lines: one token, no blank in it (a
        // journal reference linked whole, «Phys. Rev. D 18 (1978) ⏎ 3598»,
        // keeps its space)
      } else if (prev && /\p{Ll}-$/u.test(prev.text) && /^\p{Ll}/u.test(first.text)) {
        prev.text = prev.text.slice(0, -1)
      } else {
        // The blank between two lines of one link is the link's too
        push(' ', prevUrl !== undefined && first.url === prevUrl ? prevUrl : undefined)
      }
    }
    for (const w of words) push(w.text, w.url)
    prevUrl = words.length ? words[words.length - 1]!.url : undefined
  })
  return out
}

/** The family a destination name belongs to: hyperref's `cite.` keys are
 *  free text, every other scheme numbers its entries */
export function destFamily(name: string): string {
  return /^cite\./i.test(name) ? 'cite.' : name.replace(/\d+/g, '#')
}

/** The printed label a numbered destination stands for (`bm_CR12` → 12,
 *  `pone.0123.ref012` → 12, REVTeX's `…-c7` → 7); null for hyperref keys */
export function destLabel(name: string | null): number | null {
  if (!name || /^cite\./i.test(name)) return null
  const m = /(\d+)$/.exec(name)
  return m ? Number(m[1]) : null
}

/** A line's own label: «[12]», «12.» — then text, not a page range */
function lineLabel(text: string): number | null {
  // «12.» needs the space after it: a line opening «10.1186/…» is a DOI's tail
  const m = /^\s*(?:\[(\d+)\]\s*|(\d+)\.\s+)\S/.exec(text)
  return m ? Number(m[1] ?? m[2]) : null
}

export interface DestPoint {
  x: number | null
  y: number
  /** The label its name carries (destLabel), for the ordering rule below */
  n?: number | null
}

/** A page set in two columns: almost none of its full lines cross the
 *  middle. (Counting lines that START right of the middle is not enough — a
 *  single-column page split into fragments has plenty.) */
export function isTwoColumn(lines: readonly TextLine[], pageWidth: number): boolean {
  const long = lines.filter((l) => l.x1 - l.x0 > pageWidth * 0.25)
  const crossing = long.filter((l) => l.x0 < pageWidth * 0.45 && l.x1 > pageWidth * 0.55).length
  return long.length >= 6 && crossing < long.length * 0.2
}

/** Where a page's text runs, and the width the window should FIT: one column
 *  of a two-column page, the text block of a one-column page, the whole page
 *  when there is too little text to tell. The preview's scale follows from
 *  it (previewScale) instead of from the document's zoom, which made a
 *  fit-width page's window a keyhole onto one column and a fit-page window
 *  unreadably small (issue #31, second round). */
export function textExtent(
  lines: readonly TextLine[],
  pageWidth: number,
  pageHeight = 792
): { x0: number; x1: number; y0: number; y1: number; twoColumn: boolean; columnW: number } {
  const long = lines.filter((l) => l.x1 - l.x0 > pageWidth * 0.12)
  if (long.length < 4) return { x0: 0, x1: pageWidth, y0: 0, y1: pageHeight, twoColumn: false, columnW: pageWidth }
  const x0 = Math.min(...long.map((l) => l.x0))
  const x1 = Math.max(...long.map((l) => l.x1))
  // The block's vertical reach too: a rotated page (a landscape table in a
  // portrait thesis) shows this axis as its WIDTH, so the caller measures
  // the block through the page's own transform rather than trusting x
  const y0 = Math.min(...long.map((l) => l.y - l.size * 0.35))
  const y1 = Math.max(...long.map((l) => l.y + l.size * 0.95))
  const twoColumn = isTwoColumn(lines, pageWidth)
  if (!twoColumn) return { x0, x1, y0, y1, twoColumn, columnW: x1 - x0 }
  // The left column's right edge: the lines that start left of the middle
  // and end before the right column begins
  const left = long.filter((l) => l.x0 < pageWidth * 0.45 && l.x1 < pageWidth * 0.6)
  const columnW = left.length ? Math.max(...left.map((l) => l.x1)) - x0 : (x1 - x0) / 2
  return { x0, x1, y0, y1, twoColumn, columnW }
}

/** The box every text item on the page lies in, whatever direction the text
 *  runs — the union of each item's own box, built from its transform (the
 *  reading direction and the glyph height) and its advance. textLines reads
 *  x as the reading direction, which is right for upright text and wrong on
 *  a /Rotate 90 page whose content is drawn rotated (pdflscape): there the
 *  rows advance along PDF y, and the page's extent must be measured this
 *  way (Emil, 2026-10-13: a landscape table came out as a keyhole). Null
 *  with no text. */
export function textBounds(
  items: readonly unknown[]
): { x0: number; x1: number; top: number; bottom: number } | null {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const raw of items) {
    const it = raw as { str?: unknown; transform?: unknown; width?: unknown }
    if (typeof it.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform)) continue
    const tf = it.transform as number[]
    const w = typeof it.width === 'number' ? it.width : 0
    const len = Math.hypot(tf[0] ?? 1, tf[1] ?? 0) || 1
    const size = Math.hypot(tf[2] ?? 0, tf[3] ?? 1) || 10
    // Unit vectors: along the text, and up from the baseline
    const dx = (tf[0] ?? 1) / len
    const dy = (tf[1] ?? 0) / len
    const px = (tf[2] ?? 0) / size
    const py = (tf[3] ?? 1) / size
    const ox = tf[4] ?? 0
    const oy = tf[5] ?? 0
    for (const [a, u] of [
      [0, -0.35],
      [w, -0.35],
      [0, 0.95],
      [w, 0.95]
    ] as const) {
      const x = ox + dx * a + px * size * u
      const y = oy + dy * a + py * size * u
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x0 === Infinity ? null : { x0, x1, top: y1, bottom: y0 }
}

/** The scale the window reads the page at: the column fits the window's
 *  width with a little air on each side, never below 100 % (a fitted page on
 *  a small screen) and never above 160 % (a glimpse, not a loupe). In 5 %
 *  steps, so the render cache is hit again by the next link on the page —
 *  rounded DOWN: rounded to the nearest step, an entry came out a few pixels
 *  wider than the window and lost the end of its first line (Emil, 2026-10-13). */
export function previewScale(columnW: number, boxW: number, min = 1, max = 1.6): number {
  if (!(columnW > 0)) return min
  return Math.max(min, Math.floor(clamp((boxW - 24) / columnW, min, max) * 20) / 20)
}

/** «5–9», «[5-9]», «5–9]»: the span of works a citation's own text names
 *  (Zotero shows all of them; so do we). Null for one number, or for a range
 *  no reference list has — past 40 it is a page range or a year. */
export function citedRange(text: string): [number, number] | null {
  const m = /^\s*\[?\s*(\d{1,3})\s*[–—-]\s*(\d{1,3})\s*[\]),.;]*\s*$/.exec(text)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  return b > a && b - a <= 40 ? [a, b] : null
}

// ---------- A citation read from the line around its link ----------
//
// A typesetter links each NUMBER of a citation, not the citation: hyperref
// with the cite package writes «[8–13]» as two links, «[8» and «13]», and
// «[3, 5–9]» as three. The link's own characters therefore say «8», and the
// range is in the text around it (issue #31, third round). The line is read
// for the bracket that encloses the link, the bracket is parsed as a list of
// numbers and ranges, and the member the link lies in is the group shown —
// from either endpoint. Only square brackets: «(5)–(9)» is two equations,
// «pages 5–9» a page range, and neither is a citation.

/** One member of a bracketed citation, «7» or «5–9», with where its numbers
 *  sit in the line (offsets into the line's text, end exclusive) */
export interface CitePart {
  a: number
  b: number
  at: { start: number; end: number }[]
}

/** The bracketed numeric citation around [from, to) in a line of text, its
 *  members in order. Null unless EVERY member is a number or a range: «[see
 *  5]», «[3, pp. 5–9]», a year «[2017–2019]» or a span no list has «[1–80]»
 *  are not read. */
export function citationBracket(line: string, from: number, to: number): CitePart[] | null {
  if (!(to > from) || from < 0 || to > line.length) return null
  // The link may carry the bracket itself («[8», «13]»)
  const open = line.lastIndexOf('[', to - 1)
  if (open < 0 || line.slice(open + 1, from).includes(']')) return null
  const close = line.indexOf(']', Math.max(open + 1, from))
  if (close < 0 || close < to - 1 || line.slice(to, close).includes('[') || close - open > 80) return null
  const parts: CitePart[] = []
  // Members separated by «,» or «;»; each one number or two around a dash
  const member = /\s*(\d{1,3})(?:\s*[–—‐‑−-]\s*(\d{1,3}))?\s*(?:[,;]|$)/y
  const inner = line.slice(open + 1, close)
  member.lastIndex = 0
  while (member.lastIndex < inner.length) {
    const m = member.exec(inner)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (a < 1 || b < a || b - a > 40 || (m[2] !== undefined && b === a)) return null
    const base = open + 1 + m.index
    const aStart = base + m[0].indexOf(m[1]!)
    const at = [{ start: aStart, end: aStart + m[1]!.length }]
    if (m[2] !== undefined) {
      const bStart = base + m[0].lastIndexOf(m[2])
      at.push({ start: bStart, end: bStart + m[2].length })
    }
    parts.push({ a, b, at })
    if (m[0].length === 0) return null
  }
  return parts.length ? parts : null
}

/** A link on the citation's line, as far as the group rule needs it: where
 *  its characters are in the line, what its destination says it is, the
 *  number its destination's NAME carries (`bib12` → 12; null for hyperref),
 *  and whatever the caller needs back (`ref`: its destination) */
export interface LineLink<T = unknown> {
  start: number
  end: number
  kind: LinkKind
  label: number | null
  ref?: T
}

/** One member of a citation group: the works `a`–`b`, and what the links on
 *  its first and last number point at (null where a number is not linked —
 *  the middle of «5–9» never is, and a PDF may link only one end) */
export interface GroupPart<T = unknown> {
  a: number
  b: number
  first: T | null
  last: T | null
}

/** The works a hovered citation link stands for. Like Zotero's reader, the
 *  WHOLE bracket: «[3, 5–9]» is 3, 5, 6, 7, 8, 9 from any of its numbers.
 *  Null — and the preview falls back to the link's own characters — unless
 *  the line holds a bracketed numeric citation around the link AND the links
 *  agree with it: every link on one of its numbers is a citation whose name,
 *  when it carries a number, is the number it covers. A member whose links
 *  contradict it costs the group its other members: the hovered one alone
 *  is shown (`hovered` indexes `parts`). */
export function citationGroup<T>(
  line: string,
  link: LineLink<T>,
  others: readonly LineLink<T>[] = []
): { parts: GroupPart<T>[]; hovered: number } | null {
  if (link.kind !== 'citation') return null
  const bracket = citationBracket(line, link.start, link.end)
  if (!bracket) return null
  const overlaps = (s: { start: number; end: number }, l: { start: number; end: number }): boolean =>
    s.start < l.end && l.start < s.end
  const hovered = bracket.findIndex((p) => p.at.some((s) => overlaps(s, link)))
  if (hovered < 0) return null
  const all = [link, ...others]
  const resolved = bracket.map((p): GroupPart<T> | null => {
    let first: T | null = null
    let last: T | null = null
    for (const l of all) {
      const covered = p.at.filter((s) => overlaps(s, l))
      if (!covered.length) continue
      // A link on «5–9» whole stands at its first number
      const n = covered[0] === p.at[0] ? p.a : p.b
      if (l.kind !== 'citation' || (l.label !== null && l.label !== n)) return null
      if (n === p.a) first ??= l.ref ?? null
      if (n === p.b && covered.length === 1) last ??= l.ref ?? null
    }
    return { a: p.a, b: p.b, first, last }
  })
  const mine = resolved[hovered]
  if (!mine) return null
  return resolved.every((p) => p !== null)
    ? { parts: resolved as GroupPart<T>[], hovered }
    : { parts: [mine], hovered: 0 }
}

/** A reference-list destination of the citation's family, wherever in the
 *  document it is */
export interface FamilyDest {
  name: string
  pageIndex: number
  x: number | null
  y: number
  n: number | null
}

/** The family in the list's own order: page by page, a two-column page's
 *  left column before its right, top-down within a column */
export function orderFamily(dests: readonly FamilyDest[], pageWidth: (pageIndex: number) => number): FamilyDest[] {
  const col = (d: FamilyDest): number => (d.x !== null && d.x > pageWidth(d.pageIndex) * 0.45 ? 1 : 0)
  return [...dests].sort((p, q) => p.pageIndex - q.pageIndex || col(p) - col(q) || q.y - p.y)
}

/** The destinations of one group member's works, first to last. `first` and
 *  `last` are the destination names its linked numbers point at (null where
 *  a number is not linked). Numbered names are matched by their number;
 *  hyperref's keys by their place in the list, counted from a linked end —
 *  and when both ends are linked the count between them must come out
 *  right, or the member is not trusted (null). */
export function groupDests(
  ordered: readonly FamilyDest[],
  part: { a: number; b: number },
  first: string | null,
  last: string | null
): FamilyDest[] | null {
  const count = part.b - part.a + 1
  const i = first === null ? -1 : ordered.findIndex((d) => d.name === first)
  const j = last === null ? -1 : ordered.findIndex((d) => d.name === last)
  const known = ordered[i] ?? ordered[j]
  if (!known) return null
  if (known.n !== null) {
    const out: FamilyDest[] = []
    for (let n = part.a; n <= part.b; n++) {
      const d = ordered.find((x) => x.n === n)
      if (!d) return null
      out.push(d)
    }
    return out
  }
  if (i >= 0 && j >= 0 && j - i + 1 !== count) return null
  const from = i >= 0 ? i : j - count + 1
  if (from < 0 || from + count > ordered.length) return null
  return ordered.slice(from, from + count)
}

/** For `count` entries from `dest` down the list: the y where the LAST of
 *  them starts, so the window can be made tall enough to hold them all.
 *  By the destinations' labels when the family carries them (`bib12` →
 *  `bib16`), by their top-down order otherwise (hyperref's `cite.` keys).
 *  Null when the range runs past this page. */
export function rangeEnd(dest: DestPoint, siblings: readonly DestPoint[], count: number): number | null {
  if (count <= 1) return dest.y
  if (dest.n != null) {
    const last = siblings.find((s) => s.n === dest.n! + count - 1)
    if (last) return last.y
  }
  // Top-down: PDF y grows upward, so the first entry has the largest y
  const all = [dest, ...siblings.filter((s) => s.y !== dest.y || s.x !== dest.x)].sort((p, q) => q.y - p.y)
  const i = all.findIndex((p) => p.y === dest.y && p.x === dest.x)
  const last = all[i + count - 1]
  return last ? last.y : null
}

const BACK_MATTER = /^(acknowledg|funding|author contributions|competing interests|conflicts? of interest|data availability|appendix|supplementary)/i

/** The entry's lines, top-down, joined by newlines. `siblings` are the
 *  family's other destinations on the page; `label` the number the
 *  destination's name carries, if any. Pure, so the test can lay out pages of
 *  its own. */
export function entryFromLines(
  lines: readonly TextLine[],
  dest: DestPoint,
  siblings: readonly DestPoint[],
  label: number | null,
  pageWidth: number
): string {
  return entryLines(lines, dest, siblings, label, pageWidth)
    .map((l) => l.text)
    .join('\n')
}

/** The box an entry's lines occupy, in PDF user space: a line's ascenders
 *  reach about 0.95 of its size above the baseline and its descenders a
 *  third below. Null for no lines. The window onto a citation is cut to
 *  exactly this (Emil, 2026-10-13: «enten burde kun referansen dukke opp»). */
export function entryBox(
  lines: readonly TextLine[]
): { top: number; bottom: number; x0: number; x1: number } | null {
  if (lines.length === 0) return null
  return {
    top: Math.max(...lines.map((l) => l.y + l.size * 0.95)),
    bottom: Math.min(...lines.map((l) => l.y - l.size * 0.35)),
    x0: Math.min(...lines.map((l) => l.x0)),
    x1: Math.max(...lines.map((l) => l.x1))
  }
}

/** The entry's lines themselves (entryFromLines is their text) */
export function entryLines(
  lines: readonly TextLine[],
  dest: DestPoint,
  siblings: readonly DestPoint[],
  label: number | null,
  pageWidth: number
): TextLine[] {
  const twoColumn = isTwoColumn(lines, pageWidth)
  const rightColumnLeft = Math.min(Infinity, ...lines.filter((l) => l.x0 > pageWidth * 0.45).map((l) => l.x0))

  // Destinations that carry no column — Springer Nature's page-wide FitR,
  // every x the same — place an entry by the list's ORDER instead: numbered
  // in sequence down the page, the list climbs back up where it moves on to
  // the next column. Each destination gets the column index of its place.
  const columnByOrder = new Map<DestPoint, number>()
  if (
    twoColumn &&
    label !== null &&
    dest.x !== null &&
    siblings.length >= 2 &&
    siblings.every((s) => s.x !== null && Math.abs(s.x - dest.x!) < 1 && typeof s.n === 'number')
  ) {
    const seq = [...siblings, dest].sort((a, b) => (a === dest ? label : a.n!) - (b === dest ? label : b.n!))
    let col = 0
    seq.forEach((p, i) => {
      if (i > 0 && p.y > seq[i - 1]!.y + 1) col++
      columnByOrder.set(p, col)
    })
  }
  const byOrder = columnByOrder.size > 0
  const destX = byOrder && columnByOrder.get(dest)! > 0 && rightColumnLeft < Infinity ? rightColumnLeft : dest.x

  const columnOf = (x: number | null): { left: number; right: number } => {
    const dx = x ?? 0
    const rightSibs = byOrder ? [] : siblings.filter((s) => s.x !== null && s.x > dx + 100).map((s) => s.x!)
    let right = rightSibs.length ? Math.min(...rightSibs) - 4 : Infinity
    if (right === Infinity && twoColumn && dx < pageWidth * 0.45) right = pageWidth * 0.5
    return { left: x === null ? -Infinity : dx - 12, right }
  }
  const linesIn = (c: { left: number; right: number }): TextLine[] =>
    lines.filter((l) => l.x0 >= c.left && l.x0 < c.right).sort((a, b) => b.y - a.y || a.x0 - b.x0)

  // By position: the lines below the destination, in its column
  let col = columnOf(destX)
  let inCol = linesIn(col)
  let start = inCol.findIndex((l) => l.y <= dest.y + 1)
  // hyperref raises its anchor a whole line above the entry, so in a list set
  // solid the line AT the anchor's height is the PREVIOUS entry's last line.
  // When the next line down is the real start — further left (an author–year
  // list's outdented first line), a label where this has none, or a
  // «Surname,» after a finished sentence — the entry starts there.
  if (start >= 0) {
    const a = inCol[start]!
    const b = inCol[start + 1]
    if (
      b &&
      dest.y - a.y < a.size * 0.6 &&
      a.y - b.y < a.size * 1.8 &&
      (b.x0 < a.x0 - 2 ||
        (lineLabel(b.text) !== null && lineLabel(a.text) === null) ||
        (/[.)]$/.test(a.text) && /^\p{Lu}[^\s,]*,\s/u.test(b.text)))
    ) {
      start++
    }
  }
  let useSiblings = true

  // By label, when the position lies: PLOS's destinations sit ~170 pt off and
  // some are clamped to the page top. A numbered list whose line at the
  // destination carries ANOTHER number than the name does is read by the
  // label instead — an author–year list (no labels) never takes this path.
  if (label !== null) {
    const atDest = start >= 0 ? lineLabel(inCol[start]!.text) : null
    // Only a NUMBERED list: the label's neighbours must be on the page too
    const numbered = lines.some((l) => {
      const n = lineLabel(l.text)
      return n === label - 1 || n === label + 1
    })
    if (numbered && atDest !== label) {
      const labelled = lines.find((l) => lineLabel(l.text) === label)
      if (labelled) {
        col = columnOf(labelled.x0)
        inCol = linesIn(col)
        start = inCol.indexOf(labelled)
        useSiblings = false
      }
    }
  }
  if (start < 0) return []

  const first = inCol[start]!
  const firstLabel = lineLabel(first.text)
  // A numbered list ends an entry at the next label, which is surer than the
  // neighbours' positions: Springer Nature's page-wide FitR destinations
  // carry no column at all, so a neighbour in the other column would cut
  // this entry after one line
  const below =
    useSiblings && firstLabel === null
      ? siblings.filter(
          (s) =>
            s.y < dest.y - 2 &&
            (byOrder
              ? columnByOrder.get(s) === columnByOrder.get(dest)
              : s.x === null || (s.x >= col.left && s.x < col.right))
        )
      : []
  const nextSibling = below.length ? Math.max(...below.map((s) => s.y)) : -Infinity
  const second = inCol[start + 1]
  const hanging = second !== undefined && second.x0 > first.x0 + 3 && first.y - second.y < first.size * 2
  const out: TextLine[] = [first]
  for (let i = start + 1; i < inCol.length && out.length < 10; i++) {
    const l = inCol[i]!
    const prev = out[out.length - 1]!
    // The next entry's destination is raised like this one's (hyperref) or
    // sits at its box's top (Springer's FitR): either way the next entry's
    // first line lies more than half a line BELOW it, while this entry's last
    // line can sit level with it
    if (l.y < nextSibling - l.size * 0.6) break
    // A gap wider than a blank line: the list (or the column) ended
    if (prev.y - l.y > Math.max(prev.size, l.size) * 2.1) break
    // The list's last entry, set solid against the back matter
    if (BACK_MATTER.test(l.text)) break
    if (nextSibling === -Infinity) {
      const lab = lineLabel(l.text)
      if (firstLabel !== null && lab === firstLabel + 1) break
      if (firstLabel !== null && lab !== null && Math.abs(l.x0 - first.x0) < 2) break
      if (firstLabel === null && hanging && l.x0 <= first.x0 + 1.5) break
      if (firstLabel === null && !hanging && /[.)]$/.test(prev.text) && /^\p{Lu}[^\s,]*,\s/u.test(l.text)) break
    }
    out.push(l)
  }
  return out
}

/** Every document's named destinations, read once — a paper can carry
 *  thousands, and the boundaries of one entry need its whole family */
const destTables = new WeakMap<PDFDocumentProxy, Promise<[string, unknown][]>>()

/** A destinations table as pdf.js hands it over: a Map since pdfjs-dist 6.2,
 *  a plain object before. Object.entries on the Map is an empty list — the
 *  boundaries would silently vanish — so both shapes are read here. */
export function destEntries(table: unknown): [string, unknown][] {
  if (table instanceof Map) return [...(table as Map<string, unknown>).entries()]
  if (table && typeof table === 'object') return Object.entries(table as Record<string, unknown>)
  return []
}

/** The family's other destinations on the target's page — the reference
 *  list's other entries, as far as the document names them. Empty for a
 *  destination without a name (an explicit /XYZ link). */
export async function familySiblings(
  pdf: PDFDocumentProxy,
  target: PreviewTarget,
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>
): Promise<DestPoint[]> {
  const siblings: DestPoint[] = []
  if (!target.name) return siblings
  let table = destTables.get(pdf)
  if (!table) {
    table = pdf
      .getDestinations()
      .then((d: unknown) => destEntries(d))
      .catch(() => [])
    destTables.set(pdf, table)
  }
  const family = destFamily(target.name)
  const ref = (page as unknown as { ref?: { num: number; gen: number } }).ref
  for (const [name, d] of await table) {
    if (name === target.name || !Array.isArray(d) || destFamily(name) !== family) continue
    const r = d[0] as { num?: number; gen?: number } | number | null
    const onPage =
      typeof r === 'number' ? r === target.pageIndex : !!ref && !!r && r.num === ref.num && r.gen === ref.gen
    if (!onPage) continue
    const [x, y] = destPoint(d)
    if (y !== null) siblings.push({ x, y, n: destLabel(name) })
  }
  return siblings
}

/** Every destination of a family across the document, in the list's order
 *  (orderFamily) — what a cited range is counted along, over a page break
 *  too. Read once per document and family. */
const familyTables = new WeakMap<PDFDocumentProxy, Map<string, Promise<FamilyDest[]>>>()

export function familyDests(pdf: PDFDocumentProxy, family: string): Promise<FamilyDest[]> {
  let byFamily = familyTables.get(pdf)
  if (!byFamily) familyTables.set(pdf, (byFamily = new Map()))
  let hit = byFamily.get(family)
  if (!hit) {
    hit = readFamily(pdf, family).catch(() => [])
    byFamily.set(family, hit)
  }
  return hit
}

async function readFamily(pdf: PDFDocumentProxy, family: string): Promise<FamilyDest[]> {
  let table = destTables.get(pdf)
  if (!table) {
    table = pdf
      .getDestinations()
      .then((d: unknown) => destEntries(d))
      .catch(() => [])
    destTables.set(pdf, table)
  }
  const pageOf = new Map<string, Promise<number>>()
  const found: Promise<FamilyDest | null>[] = []
  for (const [name, d] of await table) {
    if (!Array.isArray(d) || destFamily(name) !== family) continue
    const [x, y] = destPoint(d)
    if (y === null) continue
    const r = d[0] as { num?: number; gen?: number } | number | null
    let page: Promise<number>
    if (typeof r === 'number') page = Promise.resolve(r)
    else if (r && typeof r.num === 'number') {
      const key = `${r.num}R${r.gen ?? 0}`
      let p = pageOf.get(key)
      if (!p) {
        p = pdf.getPageIndex(r as Parameters<PDFDocumentProxy['getPageIndex']>[0]).catch(() => -1)
        pageOf.set(key, p)
      }
      page = p
    } else continue
    found.push(page.then((pageIndex) => (pageIndex >= 0 ? { name, pageIndex, x, y, n: destLabel(name) } : null)))
  }
  const dests = (await Promise.all(found)).filter((d): d is FamilyDest => d !== null)
  const widths = new Map<number, number>()
  for (const i of new Set(dests.map((d) => d.pageIndex))) {
    const page = await pdf.getPage(i + 1).catch(() => null)
    widths.set(i, page ? (page.view[2] ?? 612) - (page.view[0] ?? 0) : 612)
  }
  return orderFamily(dests, (i) => widths.get(i) ?? 612)
}

/** One reference as the citation card shows it */
export interface CardEntry {
  /** The destination's name — the entry's identity (abstract cache, keys) */
  dest: string
  pageIndex: number
  segments: EntrySegment[]
  /** The entry's lines joined by newlines: what «Sammendrag» looks up */
  text: string
}

/** A reference page read once: its lines, width and URI links */
const pageReads = new WeakMap<
  PDFDocumentProxy,
  Map<number, Promise<{ lines: TextLine[]; width: number; links: UriLink[] }>>
>()

function readPage(
  pdf: PDFDocumentProxy,
  pageIndex: number
): Promise<{ lines: TextLine[]; width: number; links: UriLink[] }> {
  let byPage = pageReads.get(pdf)
  if (!byPage) pageReads.set(pdf, (byPage = new Map()))
  let hit = byPage.get(pageIndex)
  if (!hit) {
    hit = (async () => {
      const page = await pdf.getPage(pageIndex + 1)
      const [content, annots] = await Promise.all([page.getTextContent(), page.getAnnotations().catch(() => [])])
      const links = (annots as { subtype?: string; url?: string; rect?: number[] }[])
        .filter((a) => a.subtype === 'Link' && typeof a.url === 'string' && Array.isArray(a.rect))
        .map((a) => ({ rect: a.rect!, url: a.url! }))
      return { lines: textLines(content.items), width: (page.view[2] ?? 612) - (page.view[0] ?? 0), links }
    })()
    // A failed read is not kept: the next hover asks again
    hit.catch(() => byPage!.delete(pageIndex))
    byPage.set(pageIndex, hit)
  }
  return hit
}

/** The entries for a group's destinations, in order. `family` is the whole
 *  family (familyDests), whose members on each page bound each entry. An
 *  entry the page gives no text for is left out. */
export async function cardEntries(
  pdf: PDFDocumentProxy,
  dests: readonly FamilyDest[],
  family: readonly FamilyDest[]
): Promise<CardEntry[]> {
  const out: CardEntry[] = []
  for (const d of dests) {
    const page = await readPage(pdf, d.pageIndex).catch(() => null)
    if (!page) continue
    const siblings = family
      .filter((s) => s.pageIndex === d.pageIndex && s.name !== d.name)
      .map((s) => ({ x: s.x, y: s.y, n: s.n }))
    const lines = entryLines(page.lines, { x: d.x, y: d.y }, siblings, d.n, page.width)
    if (!lines.length) continue
    out.push({
      dest: d.name,
      pageIndex: d.pageIndex,
      segments: entrySegments(lines, page.links),
      text: lines.map((l) => l.text).join('\n')
    })
  }
  return out
}

/** The text of the reference-list entry a citation points at; '' when the
 *  destination names no point or the page has no text there. */
export async function citationEntryText(pdf: PDFDocumentProxy, target: PreviewTarget): Promise<string> {
  if (target.y === null) return ''
  try {
    const page = await pdf.getPage(target.pageIndex + 1)
    const content = await page.getTextContent()
    const lines = textLines(content.items)
    const siblings = await familySiblings(pdf, target, page)
    const width = (page.view[2] ?? 612) - (page.view[0] ?? 0)
    return entryFromLines(lines, { x: target.x, y: target.y }, siblings, destLabel(target.name), width)
  } catch {
    return ''
  }
}

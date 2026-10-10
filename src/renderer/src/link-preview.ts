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
}

/** Glyph runs (pdf.js text items) to lines. Runs on one baseline join while
 *  they continue each other; a jump sideways starts a new line, which is what
 *  keeps a two-column page's columns apart. */
export function textLines(items: readonly unknown[]): TextLine[] {
  const lines: TextLine[] = []
  let cur: TextLine | null = null
  for (const raw of items) {
    const it = raw as { str?: unknown; transform?: unknown; width?: unknown }
    if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
    const tf = it.transform as number[]
    const size = Math.hypot(tf[2] ?? 0, tf[3] ?? 0) || 10
    const x = tf[4] ?? 0
    const y = tf[5] ?? 0
    const w = typeof it.width === 'number' ? it.width : 0
    if (!it.str.trim()) {
      if (cur && !/\s$/.test(cur.text)) cur.text += ' '
      continue
    }
    if (cur && Math.abs(y - cur.y) < size * 0.5 && x >= cur.x1 - size && x - cur.x1 < size * 2.5) {
      if (x - cur.x1 > size * 0.15 && !/\s$/.test(cur.text)) cur.text += ' '
      cur.text += it.str
      cur.x1 = Math.max(cur.x1, x + w)
      cur.size = Math.max(cur.size, size)
    } else {
      cur = { x0: x, x1: x + w, y, size, text: it.str }
      lines.push(cur)
    }
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim()
  return lines.filter((l) => l.text)
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
  if (start < 0) return ''

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
  return out.map((l) => l.text).join('\n')
}

/** Every document's named destinations, read once — a paper can carry
 *  thousands, and the boundaries of one entry need its whole family */
const destTables = new WeakMap<PDFDocumentProxy, Promise<Record<string, unknown>>>()

/** The text of the reference-list entry a citation points at; '' when the
 *  destination names no point or the page has no text there. */
export async function citationEntryText(pdf: PDFDocumentProxy, target: PreviewTarget): Promise<string> {
  if (target.y === null) return ''
  try {
    const page = await pdf.getPage(target.pageIndex + 1)
    const content = await page.getTextContent()
    const lines = textLines(content.items)
    const siblings: DestPoint[] = []
    if (target.name) {
      let table = destTables.get(pdf)
      if (!table) {
        table = pdf
          .getDestinations()
          .then((d) => (d ?? {}) as Record<string, unknown>)
          .catch(() => ({}))
        destTables.set(pdf, table)
      }
      const family = destFamily(target.name)
      const ref = (page as unknown as { ref?: { num: number; gen: number } }).ref
      for (const [name, d] of Object.entries(await table)) {
        if (name === target.name || !Array.isArray(d) || destFamily(name) !== family) continue
        const r = d[0] as { num?: number; gen?: number } | number | null
        const onPage =
          typeof r === 'number'
            ? r === target.pageIndex
            : !!ref && !!r && r.num === ref.num && r.gen === ref.gen
        if (!onPage) continue
        const [x, y] = destPoint(d)
        if (y !== null) siblings.push({ x, y, n: destLabel(name) })
      }
    }
    const width = (page.view[2] ?? 612) - (page.view[0] ?? 0)
    return entryFromLines(lines, { x: target.x, y: target.y }, siblings, destLabel(target.name), width)
  } catch {
    return ''
  }
}

// Proof for src/renderer/src/link-preview.ts — the rules behind the hover
// preview of in-document links (issue #31). Two tiers:
//   1) Pure rules: what a destination NAME says it is (hyperref's counters and
//      the big publishers' reference-list prefixes), the point each explicit
//      destination form names (PDF 32000 §12.3.2.2), the window's size per
//      kind, where inside the page the window looks (a citation at the top, a
//      figure anchored on its caption looking UP, clamped at the page's ends,
//      a two-column page scrolled to the column), where the window opens next
//      to the link, and the delay presets with garbage reading as the default.
//   2) Real pdf.js: a hand-built PDF whose /Dests name tree holds a hyperref-
//      style citation, a figure anchored on its «Figure 1:» caption, a figure
//      anchored at the float's top, a /Fit destination and a dangling name —
//      plus sample.pdf's own explicit /XYZ table-of-contents links, resolved
//      to the page and point their link annotations name.
// Run: node scripts/test-link-preview.mjs
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SRC = fileURLToPath(new URL('../src/renderer/src/link-preview.ts', import.meta.url))
const SAMPLE = fileURLToPath(new URL('../src/renderer/public/sample.pdf', import.meta.url))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-preview-'))
const out = path.join(dir, 'link-preview.mjs')
// bundle:false — the module's only import is `import type`, which esbuild
// erases, so it runs in plain Node with nothing bundled
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------------ tier 1: rules
{
  const kinds = {
    'cite.vaswani2017attention': 'citation',
    'cite.Hochreiter:1997': 'citation',
    bib12: 'citation', // Elsevier, eLife
    CR12: 'citation', // Springer
    'bib-0012': 'citation', // Wiley
    B12: 'citation', // Frontiers
    'pone.0123456.ref012': 'citation', // PLOS
    'figure.3': 'figure',
    'subfigure.3.2': 'figure',
    fig1: 'figure',
    'table.2': 'table',
    'equation.2.1': 'equation',
    'AMS.12': 'equation',
    'Hfootnote.7': 'footnote',
    'section.4': 'section',
    'subsection.4.2': 'section',
    'subsubsection.4.2.1': 'section',
    'appendix.A': 'section',
    'chapter.2': 'section',
    'page.3': 'other',
    'Item.12': 'other',
    'theorem.1': 'other',
    bm_CR12: 'citation', // Springer Nature
    'Rpone.0315920.ref012': 'citation', // PLOS: the citation in the text …
    'Lpone.0315920.ref012': 'other', // … and the entry's link back to it
    'e10782c3.indd:R29:216': 'citation', // eLife (InDesign)
    'temp:intralink-c7': 'citation' // REVTeX
  }
  for (const [name, kind] of Object.entries(kinds)) {
    check(`linkKind(${name}) = ${kind}`, M.linkKind(name) === kind, M.linkKind(name))
  }
  check('linkKind(null) = other (an explicit destination has no name)', M.linkKind(null) === 'other')
}
{
  const ref = { num: 4, gen: 0 }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check('destPoint XYZ', eq(M.destPoint([ref, { name: 'XYZ' }, 72, 700, null]), [72, 700]))
  check('destPoint XYZ with null left', eq(M.destPoint([ref, { name: 'XYZ' }, null, 700, 0]), [null, 700]))
  check('destPoint FitH names only a top', eq(M.destPoint([ref, { name: 'FitH' }, 500]), [null, 500]))
  check('destPoint FitBH names only a top', eq(M.destPoint([ref, { name: 'FitBH' }, 500]), [null, 500]))
  check('destPoint FitV names only a left', eq(M.destPoint([ref, { name: 'FitV' }, 30]), [30, null]))
  check('destPoint FitR: the rectangle\'s top-left', eq(M.destPoint([ref, { name: 'FitR' }, 10, 20, 300, 400]), [10, 400]))
  check('destPoint Fit names nothing', eq(M.destPoint([ref, { name: 'Fit' }]), [null, null]))
  check('destPoint garbage numbers read as unnamed', eq(M.destPoint([ref, { name: 'XYZ' }, 'x', NaN]), [null, null]))
}
{
  const c = M.previewSize('citation', 1600, 1000)
  const f = M.previewSize('figure', 1600, 1000)
  check('a citation window is short, a figure window tall', c.h < f.h, `${c.h} vs ${f.h}`)
  check('the window is at most 600 px wide', c.w === 600)
  const small = M.previewSize('figure', 300, 300)
  check('never wider than the window minus its margins', small.w <= 300 - 24 || small.w === 200, String(small.w))
  check('never taller than 60 % of the window', small.h <= 180, String(small.h))
}
{
  const box = { w: 400, h: 150 }
  const page = { w: 1000, h: 1000 }
  const cit = M.previewScroll('citation', 420, 600, box, page)
  check('a citation sits at the window\'s top', cit.top === 594, JSON.stringify(cit))
  check('a two-column page scrolls to the destination\'s column', cit.left === 402, JSON.stringify(cit))
  const narrow = M.previewScroll('citation', 420, 600, { w: 1100, h: 150 }, page)
  check('a page narrower than the window does not scroll sideways', narrow.left === 0)
  const fig = M.previewScroll('figure', 60, 600, { w: 400, h: 380 }, page, true)
  check('a figure anchored on its caption: the window looks UP', fig.top < 600 - 380 / 2, JSON.stringify(fig))
  const figTop = M.previewScroll('figure', 60, 600, { w: 400, h: 380 }, page, false)
  check('a figure anchored at the float\'s top: the window starts there', figTop.top === 588, JSON.stringify(figTop))
  const end = M.previewScroll('citation', 0, 990, box, page)
  check('clamped at the page\'s foot', end.top === page.h - box.h, JSON.stringify(end))
  const start = M.previewScroll('figure', 0, 50, { w: 400, h: 380 }, page, true)
  check('clamped at the page\'s head', start.top === 0, JSON.stringify(start))
  const fit = M.previewScroll('section', null, null, box, page)
  check('an unnamed point shows the page\'s top-left', fit.top === 0 && fit.left === 0)
}
{
  const win = { w: 1200, h: 800 }
  const box = { w: 400, h: 150 }
  const low = M.placePreview({ left: 500, top: 100, bottom: 116 }, 520, box, win)
  check('room below: opens below the link', low.below && low.top === 124, JSON.stringify(low))
  check('centred on the pointer', low.left === 320, JSON.stringify(low))
  const high = M.placePreview({ left: 500, top: 700, bottom: 716 }, 520, box, win)
  check('no room below: opens above the link', !high.below && high.top + box.h <= 700, JSON.stringify(high))
  const edge = M.placePreview({ left: 5, top: 100, bottom: 116 }, 10, box, win)
  check('kept inside the window at its left edge', edge.left === 12, JSON.stringify(edge))
  const right = M.placePreview({ left: 1190, top: 100, bottom: 116 }, 1195, box, win)
  check('kept inside the window at its right edge', right.left + box.w <= win.w - 12, JSON.stringify(right))
}
{
  // Once an abstract is in, the window is placed by what it needs
  const win = { h: 800 }
  const fitsBelow = M.placeExpanded({ top: 100, bottom: 116 }, 500, win)
  check('expanded: below the link when all of it fits there', fitsBelow.top === 124 && fitsBelow.height === 500 && !fitsBelow.covers, JSON.stringify(fitsBelow))
  const fitsAbove = M.placeExpanded({ top: 600, bottom: 616 }, 500, win)
  check('expanded: above when it fits there instead', fitsAbove.top + fitsAbove.height === 592 && fitsAbove.height === 500 && !fitsAbove.covers, JSON.stringify(fitsAbove))
  const bigger = M.placeExpanded({ top: 500, bottom: 516 }, 700, win)
  check('expanded: neither side holds it all → the roomier side, the rest scrolls', bigger.top === 12 && bigger.height === 480 && !bigger.covers, JSON.stringify(bigger))
  const cramped = M.placeExpanded({ top: 300, bottom: 316 }, 520, { h: 620 })
  check('expanded: no side worth reading in → covers the link, all of it in view', cramped.covers && cramped.height === 520 && cramped.top >= 12 && cramped.top + cramped.height <= 608, JSON.stringify(cramped))
  const huge = M.placeExpanded({ top: 300, bottom: 316 }, 5000, { h: 620 })
  check('expanded: never taller than the window', huge.height === 620 - 24, JSON.stringify(huge))
}
{
  check('caption: «Figure 3:»', M.isFigureCaption('Figure 3: The Transformer'))
  check('caption: «Fig. 2.»', M.isFigureCaption('Fig. 2. Results'))
  check('caption: «FIGURE 1»', M.isFigureCaption('FIGURE 1'))
  check('caption: «Figur 4» (nb)', M.isFigureCaption('Figur 4 Utvikling'))
  check('not a caption: running text', !M.isFigureCaption('as shown in the figure, 3 cases'))
  check('delay presets', M.linkPreviewDelayMs('short') < M.linkPreviewDelayMs('medium') && M.linkPreviewDelayMs('medium') < M.linkPreviewDelayMs('long'))
  check('a garbage delay reads as medium', M.linkPreviewDelayMs('forever') === M.linkPreviewDelayMs('medium') && M.linkPreviewDelayMs(undefined) === M.linkPreviewDelayMs('medium'))
}

// ------------------------------- tier 1a: scale, cited ranges (second round)
{
  // A one-column page: the text block is what the window fits
  const one = []
  for (let i = 0; i < 12; i++) one.push({ x0: 72, x1: 540, y: 700 - i * 14, size: 10, text: 'a line of running text that is long' })
  const ext1 = M.textExtent(one, 612)
  check('one column: the text block', !ext1.twoColumn && ext1.x0 === 72 && ext1.x1 === 540 && ext1.columnW === 468, JSON.stringify(ext1))
  // A two-column page: one column is what the window fits
  const two = []
  for (let i = 0; i < 12; i++) {
    two.push({ x0: 56, x1: 296, y: 700 - i * 14, size: 10, text: 'left column text, a long line' })
    two.push({ x0: 316, x1: 556, y: 700 - i * 14, size: 10, text: 'right column text, a long line' })
  }
  const ext2 = M.textExtent(two, 612)
  check('two columns: one column\'s width', ext2.twoColumn && ext2.columnW === 240 && ext2.x0 === 56, JSON.stringify(ext2))
  check('too little text: the whole page', M.textExtent([{ x0: 72, x1: 300, y: 700, size: 10, text: 'Figure 1' }], 612).columnW === 612)
  check('scale: the column fits the window with air, rounded down', M.previewScale(468, 600) === 1.2, String(M.previewScale(468, 600)))
  check('scale: a fit that is exact stays', M.previewScale(480, 600) === 1.2)
  check('scale: a narrow column is read larger, up to 160 %', M.previewScale(240, 600) === 1.6)
  check('scale: never below 100 %', M.previewScale(1200, 300) === 1)
  check('scale: a wide block may shrink to the floor it is given', M.previewScale(800, 600) === 1 && M.previewScale(800, 600, 0.75) === 0.75 && M.previewScale(700, 600, 0.75) === 0.8)
  check("extent: the block's vertical reach", (() => { const e = M.textExtent(one, 612, 792); return e.y1 === 709.5 && e.y0 === 700 - 11 * 14 - 3.5 })())
  // textBounds: an item's box follows its direction. Upright: the advance
  // runs along x; drawn rotated (pdflscape): along y, and the glyph height
  // along -x — so a landscape table's reading width is its PDF y-extent
  const upright = M.textBounds([{ str: 'abc', transform: [10, 0, 0, 10, 72, 700], width: 300 }])
  check('bounds: upright text runs along x', upright.x0 === 72 && upright.x1 === 372 && upright.bottom === 696.5 && upright.top === 709.5, JSON.stringify(upright))
  const rotated = M.textBounds([{ str: 'abc', transform: [0, 11, -11, 0, 100, 200], width: 300 }, { str: ' ', transform: [0, 11, -11, 0, 500, 500], width: 50 }])
  check('bounds: rotated text runs along y, a blank item ignored', rotated.bottom === 200 && rotated.top === 500 && Math.abs(rotated.x0 - (100 - 10.45)) < 1e-9 && Math.abs(rotated.x1 - (100 + 3.85)) < 1e-9, JSON.stringify(rotated))
  check('bounds: no text → null', M.textBounds([]) === null)
  check('scale: no column width → 100 %', M.previewScale(0, 600) === 1 && M.previewScale(NaN, 600) === 1)

  check('range: «5–9»', JSON.stringify(M.citedRange('5–9')) === '[5,9]')
  check('range: «[12-15]»', JSON.stringify(M.citedRange('[12-15]')) === '[12,15]')
  check('range: «5–9],» (the link\'s box ends on the bracket)', JSON.stringify(M.citedRange('5–9],')) === '[5,9]')
  check('not a range: one number', M.citedRange('[7]') === null)
  check('not a range: a year', M.citedRange('2017') === null)
  check('not a range: a span no reference list has («1–80»)', M.citedRange('1–80') === null)
  check('not a range: backwards', M.citedRange('9–5') === null)
  check('not a range: prose', M.citedRange('see 5–9 below') === null)

  // Entries 5..9 down a numbered list: labelled destinations are matched by
  // label, unlabelled ones by top-down order
  const labelled = [5, 6, 7, 8, 9, 10].map((n) => ({ x: 72, y: 700 - (n - 5) * 40, n }))
  const [d5, ...rest] = labelled
  check('range end by label: 5–9 ends where 9 starts', M.rangeEnd(d5, rest, 5) === 700 - 160)
  const unlabelled = labelled.map(({ x, y }) => ({ x, y, n: null }))
  check('range end by order: the fifth entry down', M.rangeEnd(unlabelled[0], unlabelled.slice(1), 5) === 700 - 160)
  check('range past the page: null', M.rangeEnd(unlabelled[0], unlabelled.slice(1), 9) === null)
  check('a single entry ends where it starts', M.rangeEnd(d5, rest, 1) === 700)
  // Siblings in any order, the dest itself among them
  const shuffled = [labelled[3], labelled[1], labelled[5], labelled[0], labelled[4], labelled[2]]
  check('order does not matter', M.rangeEnd(labelled[0], shuffled, 3) === 700 - 80)
}

{
  // The box the window is cut to: ascenders above the first baseline,
  // descenders below the last, the widest line's edges
  const entry = [
    { x0: 72, x1: 540, y: 700, size: 10, text: 'Stigler, G. J. (1961). The economics of information.' },
    { x0: 90, x1: 300, y: 688, size: 10, text: '69(3):213–225.' }
  ]
  const b = M.entryBox(entry)
  check('entry box: top above the first line, bottom below the last', b.top === 709.5 && b.bottom === 684.5, JSON.stringify(b))
  check('entry box: the widest line sets the sides', b.x0 === 72 && b.x1 === 540)
  check('entry box: nothing → null', M.entryBox([]) === null)
  // entryLines is what entryFromLines reads its text from
  const lines = [
    { x0: 72, x1: 540, y: 700, size: 10, text: 'Smith, A. (2001). A title.' },
    { x0: 90, x1: 300, y: 688, size: 10, text: 'J. Econ., 1(1):1–2.' },
    { x0: 72, x1: 540, y: 676, size: 10, text: 'Jones, B. (2002). Another title.' }
  ]
  const picked = M.entryLines(lines, { x: 72, y: 710 }, [{ x: 72, y: 686 }], null, 612)
  check('entryLines: the entry\'s own lines', picked.length === 2 && picked[0].text.startsWith('Smith') && picked[1].text.startsWith('J. Econ'), JSON.stringify(picked.map((l) => l.text)))
  check('entryFromLines is their text', M.entryFromLines(lines, { x: 72, y: 710 }, [{ x: 72, y: 686 }], null, 612) === 'Smith, A. (2001). A title.\nJ. Econ., 1(1):1–2.')
}

// -------------------------------------- tier 1b: the reference-list entry
{
  const items = [
    { str: 'Left column text', transform: [10, 0, 0, 10, 72, 700], width: 80 },
    { str: ' ', transform: [10, 0, 0, 10, 152, 700], width: 3 },
    { str: 'continues', transform: [10, 0, 0, 10, 155, 700], width: 45 },
    { str: 'Right column', transform: [10, 0, 0, 10, 320, 700], width: 60 },
    { str: 'next line', transform: [10, 0, 0, 10, 72, 688], width: 40 }
  ]
  const lines = M.textLines(items)
  check('textLines: runs on a baseline join, a jump to the other column does not', lines.length === 3 && lines[0].text === 'Left column text continues' && lines[1].text === 'Right column', JSON.stringify(lines.map((l) => l.text)))
  check('destFamily: hyperref keys are one family', M.destFamily('cite.vaswani2017') === M.destFamily('cite.he2016deep'))
  check('destFamily: numbered schemes by their shape', M.destFamily('bm_CR12') === M.destFamily('bm_CR3') && M.destFamily('bm_CR12') !== M.destFamily('Fig12'))
  check('destLabel', M.destLabel('bm_CR12') === 12 && M.destLabel('Rpone.0315920.ref012') === 12 && M.destLabel('cite.x2017') === null)
}
const L = (x0, y, text, size = 10) => ({ x0, x1: x0 + text.length * size * 0.5, y, size, text })
{
  // hyperref, author–year with a hanging indent: the anchor sits a line ABOVE
  // the entry, level with the previous entry's last line
  const lines = [
    L(84, 500, 'rica 62, 1349–1382.'),
    L(72, 488, 'Robinson, P. M. (1988). Root-N-consistent semiparametric regression.'),
    L(84, 476, 'Econometrica 56, 931–954.'),
    L(72, 464, 'Smith, A. (1990). Another paper entirely.'),
    L(84, 452, 'Journal 1, 1–2.')
  ]
  const text = M.entryFromLines(lines, { x: 72, y: 500 }, [{ x: 72, y: 476 }], null, 612)
  check('author–year: starts at the entry, not the line at the raised anchor; ends before the next', text === 'Robinson, P. M. (1988). Root-N-consistent semiparametric regression.\nEconometrica 56, 931–954.', JSON.stringify(text))
}
{
  // Numbered list in two columns: the right column's entry, ended by the next label
  const lines = []
  for (let i = 0; i < 8; i++) lines.push(L(72, 700 - i * 12, `left column line ${i} with enough words to be long`))
  lines.push(L(320, 712, '[7] A. Author. A title of a paper. Journal, 2001.'), L(332, 700, 'pages 1–10.'), L(320, 688, '[8] B. Author. Another. 2002.'))
  for (let i = 3; i < 8; i++) lines.push(L(320, 700 - i * 12, `right column line ${i} also long enough`))
  const text = M.entryFromLines(lines, { x: 320, y: 722 }, [], null, 612)
  check('numbered, right column: the entry up to the next label', text === '[7] A. Author. A title of a paper. Journal, 2001.\npages 1–10.', JSON.stringify(text))
  check('isTwoColumn on that page', M.isTwoColumn(lines, 612))
}
{
  // PLOS: the destination sits lines away from its entry; the printed label wins
  const lines = [
    L(72, 600, '10. Wrong A. The entry the destination points at. 2010.'),
    L(84, 588, 'https://doi.org/10.1186/1756-8935-8-6 PMID: 25972926'),
    L(72, 576, '11. Other B. Not this one either. 2011.'),
    L(72, 564, '12. Right C. The cited paper. Journal. 2012; 3:1–9.'),
    L(84, 552, 'https://doi.org/10.1000/right PMID: 1'),
    L(72, 540, '13. Next D. After it. 2013.')
  ]
  const text = M.entryFromLines(lines, { x: 72, y: 601 }, [], 12, 612)
  check('numbered names: an offset destination is read by its label', text === '12. Right C. The cited paper. Journal. 2012; 3:1–9.\nhttps://doi.org/10.1000/right PMID: 1', JSON.stringify(text))
  const doiLine = M.entryFromLines(lines, { x: 84, y: 589 }, [], 12, 612)
  check('a line opening with a DOI («10.1186/…») is not label 10', doiLine.startsWith('12. Right C.'), JSON.stringify(doiLine))
}
{
  // Springer Nature: page-wide FitR (every x the page margin), author–year,
  // two columns. Entry 5 is the right column's first: found by the list's order.
  const lines = []
  const left = ['Adams A (2001) First paper. J 1:1', 'Brown B (2002) Second paper. J 2:2', 'Clark C (2003) Third paper. J 3:3', 'Davis D (2004) Fourth paper. J 4:4']
  left.forEach((t, i) => lines.push(L(50, 700 - i * 24, t + ' and more words here'), L(62, 688 - i * 24, 'continued')))
  lines.push(L(320, 700, 'Evans E (2005) Fifth paper in the right column.'), L(332, 688, 'J 5:5'), L(320, 676, 'Frank F (2006) Sixth paper.'), L(332, 664, 'J 6:6'))
  for (let i = 0; i < 3; i++) lines.push(L(320, 640 - i * 12, 'right column filler line long enough to count'))
  const sibs = [1, 2, 3, 4, 6].map((n) => ({ x: 40, y: n <= 4 ? 712 - (n - 1) * 24 : 688, n }))
  const text = M.entryFromLines(lines, { x: 40, y: 712 }, sibs, 5, 612)
  check('page-wide destinations: the column comes from the list order', text === 'Evans E (2005) Fifth paper in the right column.\nJ 5:5', JSON.stringify(text))
}
{
  // The list's last entry, set solid against the back matter
  const lines = [L(72, 500, '46. Robert, X. & Gouet, P. Deciphering key features.'), L(84, 488, 'Nucleic Acids Res. 42, W320–W324 (2014).'), L(72, 476, 'Acknowledgements'), L(72, 464, 'We thank everyone.')]
  const text = M.entryFromLines(lines, { x: 72, y: 510 }, [], 46, 612)
  check('the last entry stops at «Acknowledgements»', text === '46. Robert, X. & Gouet, P. Deciphering key features.\nNucleic Acids Res. 42, W320–W324 (2014).', JSON.stringify(text))
  check('a single-column page is not two columns', !M.isTwoColumn([...Array(10)].map((_, i) => L(72, 700 - i * 12, 'a full width line of running text that crosses the middle of the page easily')), 612))
}

// ------------------- tier 1c: the citation read from the line (third round)
{
  // Where a substring sits in a line: the link's characters
  const at = (line, s, from = 0) => {
    const i = line.indexOf(s, from)
    if (i < 0) throw new Error(`«${s}» not in «${line}»`)
    return { start: i, end: i + s.length }
  }
  const cite = (line, s, ref, from = 0, label = null) => ({ ...at(line, s, from), kind: 'citation', label, ref })
  const parts = (g) => JSON.stringify(g?.parts.map((p) => [p.a, p.b, p.first, p.last]) ?? null)

  // The bracket itself
  const b1 = 'wordline M [8–13] in the midst'
  check('bracket: «[8–13]» from «[8»', JSON.stringify(M.citationBracket(b1, ...Object.values(at(b1, '[8'))).map((p) => [p.a, p.b])) === '[[8,13]]')
  const b2 = 'models [3, 5–9; 12] here'
  check('bracket: «[3, 5–9; 12]» is three members', JSON.stringify(M.citationBracket(b2, ...Object.values(at(b2, '9'))).map((p) => [p.a, p.b])) === '[[3,3],[5,9],[12,12]]')
  check('bracket: «[5 - 9]» with blanks and a hyphen', JSON.stringify(M.citationBracket('[5 - 9]', 1, 2).map((p) => [p.a, p.b])) === '[[5,9]]')
  check('bracket: the numbers\' own places', JSON.stringify(M.citationBracket(b1, 11, 13)[0].at) === JSON.stringify([at(b1, '8'), at(b1, '13')]))
  check('not a bracket: «[see 5]»', M.citationBracket('as in [see 5] above', 11, 12) === null)
  check('not a bracket: «[3, pp. 5–9]» (a locator)', M.citationBracket('in [3, pp. 5–9]', 4, 5) === null)
  check('not a bracket: a year span «[2017–2019]»', M.citationBracket('[2017–2019]', 1, 5) === null)
  check('not a bracket: a span no list has «[1–80]»', M.citationBracket('[1–80]', 1, 2) === null)
  check('not a bracket: backwards «[9–5]»', M.citationBracket('[9–5]', 1, 2) === null)
  check('not a bracket: the link outside it («[3] and 5»)', M.citationBracket('[3] and 5', 8, 9) === null)

  // Both ends linked (hyperref + cite: «[8» and «13]»), from either end
  const l1 = 'a type of thickened wordline M [8–13] in the midst of'
  const end8 = cite(l1, '[8', 'cite.a')
  const end13 = cite(l1, '13]', 'cite.f')
  check('group from the first end: 8–13, both ends known', parts(M.citationGroup(l1, end8, [end13])) === '[[8,13,"cite.a","cite.f"]]')
  check('group from the last end: the same group', parts(M.citationGroup(l1, end13, [end8])) === '[[8,13,"cite.a","cite.f"]]')
  check('group with the other end unlinked: from the linked one', parts(M.citationGroup(l1, end8, [])) === '[[8,13,"cite.a",null]]')
  // A link over «8–13» whole stands at its first number
  check('one link over the whole range', parts(M.citationGroup(l1, cite(l1, '8–13', 'cite.a'), [])) === '[[8,13,"cite.a",null]]')

  // The whole bracket, like Zotero: «[9, 33]» and «[3, 5–9]» from any number
  const l2 = 'patch in two [29–32] and three [9, 33] dimensional models'
  const g2 = M.citationGroup(l2, cite(l2, '33]', 'cite.s'), [cite(l2, '[9,', 'cite.c'), cite(l2, '[29', 'cite.x'), cite(l2, '32]', 'cite.y')])
  check('«[9, 33]» from «33]»: both members, the neighbour bracket not', parts(g2) === '[[9,9,"cite.c","cite.c"],[33,33,"cite.s","cite.s"]]' && g2.hovered === 1)
  const l3 = 'as shown in [3, 5–9] for the'
  const g3 = M.citationGroup(l3, cite(l3, '3,', 'cite.p'), [cite(l3, '5', 'cite.q', l3.indexOf('5')), cite(l3, '9]', 'cite.u')])
  check('«[3, 5–9]» from «3»: 3 and 5–9', parts(g3) === '[[3,3,"cite.p","cite.p"],[5,9,"cite.q","cite.u"]]' && g3.hovered === 0)

  // Corroboration: the links must agree with the reading
  const eqEnd = { ...at(l1, '13]'), kind: 'equation', label: null, ref: 'equation.13' }
  check('the other end goes to an equation: no group', M.citationGroup(l1, end8, [eqEnd]) === null)
  check('a numbered destination that names another entry: no group', M.citationGroup(l1, cite(l1, '[8', 'bib7', 0, 7), []) === null)
  check('a numbered destination that names this one: the group', parts(M.citationGroup(l1, cite(l1, '[8', 'bib8', 0, 8), [cite(l1, '13]', 'bib13', 0, 13)])) === '[[8,13,"bib8","bib13"]]')
  // A member whose links contradict it costs the group its OTHER members only
  const g4 = M.citationGroup(l3, cite(l3, '9]', 'cite.u'), [{ ...at(l3, '3,'), kind: 'figure', label: null, ref: 'figure.3' }])
  check('«[3, 5–9]» with «3» a figure link: 5–9 alone', parts(g4) === '[[5,9,null,"cite.u"]]' && g4.hovered === 0)
  check('the hovered link must be a citation', M.citationGroup(l1, { ...end8, kind: 'other' }, [end13]) === null)

  // False positives: what is not a bracketed numeric citation
  const eqs = 'from (5)–(9) it follows'
  check('equations «(5)–(9)»: no group', M.citationGroup(eqs, cite(eqs, '5', 'cite.k'), []) === null)
  const prose = 'see pages 5–9 of the survey [3] for'
  check('a page range in prose: no group', M.citationGroup(prose, cite(prose, '5', 'cite.k'), []) === null)
  check('…but its own citation still reads: [3]', parts(M.citationGroup(prose, cite(prose, '3', 'cite.k'), [])) === '[[3,3,"cite.k","cite.k"]]')
  const sec = 'Sections [5–9] of Ref. [2]'
  check('a bracket whose other end goes to a section: no group', M.citationGroup(sec, cite(sec, '[5', 'cite.k'), [{ ...at(sec, '9]'), kind: 'section', label: null, ref: 'section.9' }]) === null)
}
{
  // The family in the list's order, and a group's destinations along it
  const D = (name, pageIndex, x, y, n = null) => ({ name, pageIndex, x, y, n })
  const fam = [
    D('cite.k', 45, 320, 700), D('cite.c', 44, 72, 300), D('cite.d', 44, 320, 700),
    D('cite.a', 44, 72, 700), D('cite.b', 44, 72, 500), D('cite.e', 44, 320, 400)
  ]
  const ordered = M.orderFamily(fam, () => 612)
  check('order: page, then the left column top-down, then the right', ordered.map((d) => d.name).join() === 'cite.a,cite.b,cite.c,cite.d,cite.e,cite.k', ordered.map((d) => d.name).join())
  const names = (ds) => (ds ? ds.map((d) => d.name).join() : 'null')
  check('both ends linked: the run between them', names(M.groupDests(ordered, { a: 8, b: 11 }, 'cite.b', 'cite.e')) === 'cite.b,cite.c,cite.d,cite.e')
  check('both ends linked but the count disagrees: not trusted', M.groupDests(ordered, { a: 8, b: 10 }, 'cite.b', 'cite.e') === null)
  check('only the first end: counted forward', names(M.groupDests(ordered, { a: 1, b: 3 }, 'cite.a', null)) === 'cite.a,cite.b,cite.c')
  check('only the last end: counted back, over the column break', names(M.groupDests(ordered, { a: 4, b: 6 }, null, 'cite.k')) === 'cite.d,cite.e,cite.k')
  check('past the list\'s end: null', M.groupDests(ordered, { a: 1, b: 4 }, 'cite.e', null) === null)
  check('a name the family lacks: null', M.groupDests(ordered, { a: 1, b: 2 }, 'cite.zz', null) === null)
  // Numbered names are matched by their number, wherever they are
  const bib = [D('bib5', 20, 72, 700, 5), D('bib6', 20, 72, 650, 6), D('bib7', 20, 320, 700, 7), D('bib9', 21, 72, 700, 9), D('bib8', 20, 320, 600, 8)]
  check('numbered: 5–9 by number, across the page', names(M.groupDests(M.orderFamily(bib, () => 612), { a: 5, b: 9 }, 'bib5', null)) === 'bib5,bib6,bib7,bib8,bib9')
  check('numbered: a number missing → null', M.groupDests(bib, { a: 5, b: 10 }, null, 'bib9') === null)
}
{
  // The entry as text: one paragraph, hyphenation undone, links kept
  const runLine = (x0, y, parts) => {
    // parts: [text, width] — runs laid end to end
    let text = ''
    let x = x0
    const runs = []
    for (const [t, w] of parts) {
      runs.push({ x0: x, x1: x + w, start: text.length, end: text.length + t.length })
      text += t
      x += w
    }
    return { x0, x1: x, y, size: 10, text, runs }
  }
  const lines = [
    runLine(72, 700, [['[5] T. Damour, Black Hole Eddy Currents, ', 200], ['Phys. Rev. D 18 (1978)', 110]]),
    runLine(72, 688, [['3598–3604', 50], ['. Quelques proprietes electromagnet-', 180]]),
    runLine(72, 676, [['iques des trous noirs, ', 110], ['https://doi.org/10.1103/', 120]]),
    runLine(72, 664, [['PhysRevD.18.3598', 80], ['.', 3]])
  ]
  const links = [
    { rect: [272, 698, 382, 708], url: 'https://doi.org/10.1103/PhysRevD.18.3598' },
    { rect: [72, 686, 122, 696], url: 'https://doi.org/10.1103/PhysRevD.18.3598' },
    { rect: [182, 674, 302, 684], url: 'https://doi.org/x' },
    { rect: [72, 662, 152, 672], url: 'https://doi.org/x' }
  ]
  const seg = M.entrySegments(lines, links)
  const text = seg.map((s) => s.text).join('')
  check('entry text: lines joined by a space, a hyphenated word whole, a URL whole', text === '[5] T. Damour, Black Hole Eddy Currents, Phys. Rev. D 18 (1978) 3598–3604. Quelques proprietes electromagnetiques des trous noirs, https://doi.org/10.1103/PhysRevD.18.3598.', JSON.stringify(text))
  const linked = seg.filter((s) => s.url).map((s) => s.text)
  check('entry links: the journal reference over two lines is ONE link, its blank included', linked[0] === 'Phys. Rev. D 18 (1978) 3598–3604', JSON.stringify(linked))
  check('entry links: the URL over two lines is one link, no blank', linked[1] === 'https://doi.org/10.1103/PhysRevD.18.3598', JSON.stringify(linked))
  check('entry links: the full stop after a link is not the link\'s', seg[seg.length - 1].text === '.' && !seg[seg.length - 1].url)
  check('entry text without links or runs: plain', JSON.stringify(M.entrySegments([{ x0: 72, x1: 300, y: 700, size: 10, text: 'Smith, A. A title.' }])) === JSON.stringify([{ text: 'Smith, A. A title.' }]))
  check('a real hyphen before a capital stays', M.entrySegments([L(72, 700, 'the Gibbons-'), L(72, 688, 'Hawking action')]).map((s) => s.text).join('') === 'the Gibbons- Hawking action')
  // textLines records where each run's characters are, collapsed whitespace and all
  const tl = M.textLines([
    { str: '  [5]  T.', transform: [10, 0, 0, 10, 72, 700], width: 40 },
    { str: 'Damour', transform: [10, 0, 0, 10, 115, 700], width: 35 }
  ])
  check('textLines: runs address the final text', tl[0].text === '[5] T. Damour' && JSON.stringify(tl[0].runs) === JSON.stringify([{ x0: 72, x1: 112, start: 0, end: 6 }, { x0: 115, x1: 150, start: 7, end: 13 }]), JSON.stringify(tl[0]))
}

// ------------- tier 1d: the whole target — footnote, float, display (round 4)
// Emil, 2026-10-16: a window onto a footnote showed half a body line, the
// rule, footnotes 6 AND 7 and white; a figure came out cut wherever the
// window happened to end. The window is now cut to the element.
const T = (x0, x1, y, text, size = 10) => ({ x0, x1, y, size, text })
const PROSE = 'running prose of the body text set solid in the column'
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol
{
  // A page's foot: body text, then footnotes 6 and 7, each a marker set in
  // from the margin with its continuation flush left, then the folio
  const lines = []
  for (let i = 0; i < 20; i++) lines.push(T(72, 540, 700 - i * 12, PROSE))
  lines.push(
    T(84, 540, 130, '6The first footnote, which runs on over a line break', 8),
    T(72, 400, 121, 'and ends here.', 8),
    T(84, 540, 112, '7The second footnote, which must not come along', 8),
    T(72, 300, 103, 'with the first.', 8),
    T(300, 305, 50, '3')
  )
  const fn6 = M.footnoteLines(lines, { x: 84, y: 138 }, [{ x: 84, y: 120, n: 7 }], 612)
  check('footnote: from its marker to the next footnote, by the family\'s next anchor', fn6.length === 2 && fn6[1].text === 'and ends here.', JSON.stringify(fn6.map((l) => l.text)))
  const bare = M.footnoteLines(lines, { x: 84, y: 138 }, [], 612)
  check('footnote: without anchors, the next marker set in where this one was ends it', bare.length === 2, JSON.stringify(bare.map((l) => l.text)))
  const fn7 = M.footnoteLines(lines, { x: 84, y: 120 }, [{ x: 84, y: 138, n: 6 }], 612)
  check('footnote: the last one stops before the folio', fn7.length === 2 && fn7[0].text.startsWith('7The second'), JSON.stringify(fn7.map((l) => l.text)))
  check('footnote zone: a point among the footnotes is in it', M.inFootnotes(lines, { x: 84, y: 133 }, 612))
  check('footnote zone: a point in the body is not', !M.inFootnotes(lines, { x: 72, y: 600 }, 612))
}
{
  // A vector figure (paths and nothing else) with its caption under it, in
  // a one-column page between two paragraphs
  const lines = []
  for (let i = 0; i < 7; i++) lines.push(T(72, 540, 700 - i * 12, PROSE))
  lines.push(T(72, 300, 616, 'the paragraph ends short.'))
  lines.push(T(72, 540, 400, 'Figure 2: A vector drawing with no text inside it, whose'), T(72, 330, 389, 'caption runs two lines.'))
  for (let i = 0; i < 12; i++) lines.push(T(72, 540, 360 - i * 12, PROSE))
  const paths = [{ x0: 100, y0: 430, x1: 500, y1: 600 }, { x0: 150, y0: 450, x1: 450, y1: 590 }]
  const box = M.floatBox('figure', { x: 72, y: 412 }, lines, paths, { w: 612, h: 792 })
  check('vector figure, caption below: from the drawing\'s top to the caption\'s foot', box && near(box.top, 600) && near(box.bottom, 389 - 3.5), JSON.stringify(box))
  check('vector figure: the paragraph above and below stay out', box && box.top < 616 - 3.5 && box.bottom > 360 + 9.5)
  const blind = M.floatBox('figure', { x: 72, y: 412 }, lines, [], { w: 612, h: 792 })
  check('a drawing the page does not tell of: the empty band up to the body text', blind && near(blind.top, 616 - 3.5 - 4) && near(blind.bottom, 389 - 3.5), JSON.stringify(blind))
  check('no caption under the anchor: no box (the window opens as before)', M.floatBox('figure', { x: 72, y: 800 }, lines.filter((l) => !l.text.startsWith('Figure')), paths, { w: 612, h: 792 }) === null)
}
{
  // A table with its caption ABOVE (the custom), a wordy header row, ruled,
  // then a section heading and its paragraph
  const lines = [
    T(72, 540, 700, 'Table 1: Results on the test set, a caption long enough to'),
    T(72, 300, 689, 'wrap onto a second line.'),
    T(90, 160, 668, 'Layer Type'), T(220, 420, 668, 'Complexity per Layer Sequential Operations'),
    T(90, 170, 655, 'Self-Attention'), T(250, 280, 655, 'O(1)'), T(380, 410, 655, '0.92'),
    T(90, 150, 643, 'Recurrent'), T(250, 280, 643, 'O(n)'), T(380, 410, 643, '0.87'),
    T(72, 190, 600, '3.5 Positional Encoding')
  ]
  for (let i = 0; i < 12; i++) lines.push(T(72, 540, 580 - i * 12, PROSE))
  const rules = [{ x0: 85, y0: 678, x1: 420, y1: 678 }, { x0: 85, y0: 637, x1: 420, y1: 637 }]
  const box = M.floatBox('table', { x: 72, y: 712 }, lines, rules, { w: 612, h: 792 })
  check('table, caption above: from the caption down to the bottom rule', box && near(box.top, 709.5) && near(box.bottom, 637), JSON.stringify(box))
  check('table: the wordy header row is the table\'s, not prose; the heading below stays out', box && box.bottom > 600 + 9.5)
  check('a table caption: «Table 1:», «Tab. 2», appendix «Table A.1»', M.isTableCaption('Table 1: x') && M.isTableCaption('Tab. 2 x') && M.isTableCaption('Table A.1: Calibrations') && !M.isTableCaption('tables are useful'))
  check('a figure caption numbered in an appendix: «Figure A.1»', M.isFigureCaption('Figure A.1: Urgency'))
}
{
  // Two columns; a figure across both, caption across the middle
  const lines = []
  for (let i = 0; i < 14; i++) lines.push(T(56, 296, 700 - i * 12, PROSE), T(316, 556, 700 - i * 12, PROSE))
  lines.push(T(56, 556, 285, 'Figure 3: A figure set across both columns of the page, its caption too.'))
  for (let i = 0; i < 14; i++) lines.push(T(56, 296, 250 - i * 12, PROSE), T(316, 556, 250 - i * 12, PROSE))
  const graphics = [{ x0: 70, y0: 300, x1: 540, y1: 520 }]
  const box = M.floatBox('figure', { x: 56, y: 297 }, lines, graphics, { w: 612, h: 792 })
  check('two columns, a figure across both: the box runs across both', box && near(box.x0, 56) && near(box.x1, 556) && near(box.top, 520) && near(box.bottom, 285 - 3.5), JSON.stringify(box))
  check('pageColumns: two columns', M.pageColumns(lines, 612).cols.length === 2)
}
{
  // Two columns; a figure in the left one, body text beside it in the right
  const lines = []
  for (let i = 0; i < 12; i++) lines.push(T(56, 296, 700 - i * 12, PROSE))
  lines.push(T(56, 296, 365, 'Figure 4: Only the left column.'))
  for (let i = 0; i < 20; i++) lines.push(T(56, 296, 330 - i * 12, PROSE))
  for (let i = 0; i < 50; i++) lines.push(T(316, 556, 700 - i * 12, PROSE))
  const graphics = [{ x0: 60, y0: 380, x1: 290, y1: 540 }, { x0: 0, y0: 760, x1: 612, y1: 761 }]
  const box = M.floatBox('figure', { x: 56, y: 377 }, lines, graphics, { w: 612, h: 792 })
  check('a figure beside body text in the other column: in its column only', box && box.x0 >= 55 && box.x1 <= 297 && near(box.top, 540) && near(box.bottom, 365 - 3.5), JSON.stringify(box))
}
{
  // Two columns whose floats run across the middle (a results page): too
  // many crossing lines for isTwoColumn, but each half's lines start together
  const lines = []
  for (let i = 0; i < 10; i++) lines.push(T(56, 556, 740 - i * 11, 'a table row across the whole page in a full width float'))
  for (let i = 0; i < 10; i++) lines.push(T(56, 296, 600 - i * 12, PROSE), T(316, 556, 600 - i * 12, PROSE))
  check('pageColumns: two columns under full-width floats', M.pageColumns(lines, 612).cols.length === 2 && !M.isTwoColumn(lines, 612))
}
{
  // A display between two paragraphs: its number, a fraction above and below
  // the baseline, the lead-in's short last line above and «where» below
  const lines = []
  for (let i = 0; i < 6; i++) lines.push(T(72, 540, 730 - i * 12, PROSE))
  lines.push(
    T(72, 200, 658, 'the matrix of outputs as:'),
    T(220, 354, 630, 'Attention(Q, K, V) = softmax('), T(356, 372, 637, 'QK'), T(366, 376, 622, 'dk'), T(380, 390, 630, ')V'),
    T(520, 534, 630, '(1)')
  )
  for (let i = 0; i < 6; i++) lines.push(T(72, 540, 600 - i * 12, 'where the queries and keys are of dimension and the values'))
  const box = M.equationBox({ x: 220, y: 650 }, lines, [{ x0: 356, y0: 633, x1: 376, y1: 633.5 }], { w: 612, h: 792 })
  check('display: the number\'s lines, the fraction above and below, across the column', box && near(box.top, 637 + 9.5) && near(box.bottom, 622 - 3.5) && near(box.x0, 72) && near(box.x1, 540), JSON.stringify(box))
  check('display: the lead-in and the paragraph after stay out', box && box.top < 658 - 3.5 && box.bottom > 600 + 9.5)
}
{
  // A caption is told from a paragraph that opens on «Figure 5.3 …»: the
  // hypcap anchor at the float's top finds the caption under the drawing
  const lines = []
  for (let i = 0; i < 6; i++) lines.push(T(72, 540, 760 - i * 12, PROSE))
  lines.push(T(72, 300, 688, 'Figure 5.3 displays this decomposition.'))
  lines.push(T(72, 540, 470, 'Figure 5.3: Buyer actions and observable outcomes.'))
  for (let i = 0; i < 6; i++) lines.push(T(72, 540, 440 - i * 12, PROSE))
  const box = M.floatBox('figure', { x: 72, y: 680 }, lines, [{ x0: 90, y0: 490, x1: 520, y1: 670 }], { w: 612, h: 792 })
  check('the caption, not the paragraph naming the figure', box && near(box.bottom, 470 - 3.5) && near(box.top, 670), JSON.stringify(box))
  check('hypcap names: figure.caption.3 and table.caption.2', M.linkKind('figure.caption.3') === 'figure' && M.linkKind('table.caption.2') === 'table')
}
{
  // arXiv's id stamped up the margin, drawn rotated: not read as a line
  const items = [
    { str: 'arXiv:1512.03385v1 [cs.CV] 10 Dec 2015', transform: [0, 20, -20, 0, 32, 250], width: 300 },
    { str: 'Deep Residual Learning', transform: [14, 0, 0, 14, 150, 700], width: 200 }
  ]
  const up = M.uprightItems(items)
  check('upright items: the rotated margin stamp is left out', up.length === 1 && up[0].str === 'Deep Residual Learning')
}
{
  // The window sized to its box: grown first, read smaller only to a floor,
  // scrolled only past that
  const room = { w: 900, h: 600 }
  const small = M.fitBox(200, 100, 600, room)
  check('fit: a small box reads at the column scale, the window holds it whole', small.scale === 1.6 && small.fits && small.w === 200 * 1.6 + 24 && small.h === 100 * 1.6 + 12, JSON.stringify(small))
  const wide = M.fitBox(800, 200, 600, room)
  check('fit: a box wider than the default window grows the window first (100 %)', wide.scale === 1 && wide.fits && wide.w === 824, JSON.stringify(wide))
  const tall = M.fitBox(400, 700, 600, room)
  check('fit: a tall box is read smaller until it fits', tall.fits && tall.scale < 1 && tall.scale >= 0.75 && tall.h <= 600, JSON.stringify(tall))
  const huge = M.fitBox(400, 2000, 600, room)
  check('fit: never below the floor — past it the window scrolls', huge.scale === 0.75 && !huge.fits && huge.h === 600, JSON.stringify(huge))
  // A figure is shown whole: its floor is half the 100 % scale
  const figure = M.fitBox(400, 1000, 600, room, 0.5)
  check('fit: a tall figure is read smaller rather than scrolled, down to its floor', figure.fits && figure.scale >= 0.5 && figure.scale < 0.75, JSON.stringify(figure))
  check('fit: past the figure floor it scrolls after all', M.fitBox(400, 2000, 600, room, 0.5).scale === 0.5 && !M.fitBox(400, 2000, 600, room, 0.5).fits)
}

// ---------------- tier 1e: the cut-out's edges on a tight page (round 5)
// Emil's thesis, 2026-10-17: footnotes at 10 pt on 9.25 pt. The window's air
// is blank paper now, so the box's own edges are all that may show — and
// entryBox's generous reach ran into the neighbours on both sides.
{
  // The page as the thesis set it (PDF y up): a body line, the footnote rule,
  // footnote 6 over two lines, footnote 7 with a formula
  const lines = [
    T(72, 523, 118.6, 'acquisition. Bunnpris has maintained a small but growing presence', 11.96),
    T(88.8, 523, 99.2, '6Bunnpris is the largest retail chain outside the four umbrella chains', 9.96),
    T(72, 147, 83.6, 'NorgesGruppen.', 9.96),
    T(88.8, 485, 74.4, '7Ownership concentration is measured using the HHI', 10.38),
    T(479, 509, 67.7, 'i=1(Si)', 10.38),
    T(72, 320, 58.8, '[0, 1], where Si is the market share of firm i in decimals.', 10.38)
  ]
  const fn6 = lines.slice(1, 3)
  const box6 = M.entryBox(fn6)
  check('tight page: entryBox alone reaches into footnote 7\'s capitals', box6.bottom < 74.4 + 10.38 * 0.72)
  const clear6 = M.clearOfNeighbours(box6, lines, fn6)
  check('footnote 6 kept off footnote 7: the edge between its descenders and their capitals', clear6.bottom > box6.bottom && near(clear6.bottom, (74.4 + 10.38 * 0.72 + box6.bottom + 10.38 * 0.13) / 2, 0.01) && clear6.top === box6.top, JSON.stringify(clear6))
  const fn7 = lines.slice(3)
  const box7 = M.entryBox(fn7)
  check('tight page: footnote 6\'s last baseline lies INSIDE footnote 7\'s box', 83.6 < box7.top && 83.6 > box7.bottom)
  const clear7 = M.clearOfNeighbours(box7, lines, fn7)
  check('footnote 7 kept off «NorgesGruppen.» once its own lines are named', clear7.top < box7.top && clear7.top < 83.6, JSON.stringify(clear7))
  check('without its lines named, a baseline inside the box counts as the target\'s', M.clearOfNeighbours(box7, lines).top === box7.top)
  const rule = [{ x0: 72, y0: 107.2, x1: 252.5, y1: 107.2 }]
  const under = M.belowFootnoteRule(clear6, rule)
  check('footnote rule: the box stops under it', near(under.top, 107.2 - 1.5, 0.01) && under.bottom === clear6.bottom, JSON.stringify(under))
  check('footnote rule: a rule far above, or a short tick, is not it', M.belowFootnoteRule(clear6, [{ x0: 72, y0: 140, x1: 252, y1: 140 }]).top === clear6.top && M.belowFootnoteRule(clear6, [{ x0: 72, y0: 107, x1: 80, y1: 107 }]).top === clear6.top)
}
{
  // A caption whose label is set larger than its words (12 pt, then 10)
  // keeps its second line
  const lines = []
  for (let i = 0; i < 4; i++) lines.push(T(72, 523, 720 - i * 18, PROSE, 12))
  lines.push(T(72, 523, 335.5, 'Figure 1.1: Evolution of market shares and the HHI by umbrella', 12), T(72, 239, 323.6, 'chain, 2001–2020. Source: AC Nielsen.'))
  for (let i = 0; i < 4; i++) lines.push(T(72, 523, 290 - i * 18, PROSE, 12))
  const box = M.floatBox('figure', { x: 72, y: 683 }, lines, [{ x0: 90, y0: 365, x1: 510, y1: 660 }], { w: 595, h: 842 })
  check('caption label larger than its text: the second line comes along', box && near(box.bottom, 323.6 - 3.5), JSON.stringify(box))
}
{
  // A table's notes under it are the table's
  const lines = [T(72, 523, 700, 'Table A5: Descriptive statistics: treatment and control groups', 12)]
  for (let i = 0; i < 8; i++) lines.push(T(72, 523, 670 - i * 15.5, 'Sales (millions NOK) 2.68 2.97 10.82% 3.19 3.19 0.00%'))
  lines.push(T(72, 523, 530, 'Notes: This table reports mean values of outcome and control variables'), T(72, 523, 518, 'before the first and after the last rebranding.'), T(72, 300, 506, 'Demographic variables are from 2014.'))
  lines.push(T(72, 523, 470, PROSE, 12))
  const rules = [{ x0: 72, y0: 690, x1: 523, y1: 690 }, { x0: 72, y0: 555, x1: 523, y1: 555 }]
  const float = M.floatBox('table', { x: 72, y: 712 }, lines, rules, { w: 595, h: 842 })
  const box = float && M.withFloatNotes(float, lines)
  check('table notes: «Notes: …» under the table joins it, to its last line', box && near(box.bottom, 506 - 3.5) && box.top === float.top, JSON.stringify({ float, box }))
  check('table notes: the body text after them stays out', box && box.bottom > 470 + 12)
  check('no notes: a box with prose under it is unchanged', M.withFloatNotes(float, lines.filter((l) => !/^(Notes|before|Demographic)/.test(l.text))) === float)
}
{
  // A landscape page (/Rotate 90) whose text is drawn turned so it reads
  // upright as shown: read in the shown frame, the box carried back
  const W = 595, H = 842
  const vp = {
    width: H, height: W, scale: 1, rotation: 90, viewBox: [0, 0, W, H],
    // pdf.js's /Rotate 90 at scale 1: shown x = PDF y, shown y = PDF x
    convertToViewportPoint: (x, y) => [y, x],
    convertToPdfPoint: (vx, vy) => [vy, vx]
  }
  const f = M.viewFrame(vp, W, H)
  check('view frame: a turned page is read at its shown size', f.w === H && f.h === W)
  // A run drawn turned in PDF space (up the page) reads left-to-right as shown
  const items = f.items([{ str: 'Table A5: Descriptive statistics', transform: [0, 12, -12, 0, 100, 60], width: 200 }])
  const up = M.uprightItems(items)
  check('view frame: text drawn turned is upright as shown', up.length === 1 && up[0].transform[0] === 12 && up[0].transform[4] === 60 && up[0].transform[5] === W - 100, JSON.stringify(up[0]?.transform))
  const back = f.back({ x0: 60, x1: 260, top: W - 90, bottom: W - 300 })
  check('view frame: a box carried back covers the same page area', near(back.x0, 90) && near(back.x1, 300) && near(back.bottom, 60) && near(back.top, 260), JSON.stringify(back))
  const flat = M.viewFrame({ ...vp, rotation: 0 }, W, H)
  check('view frame: an upright page is read in PDF space, untouched', flat.w === W && flat.h === H && flat.point({ x: 1, y: 2 }).y === 2)
}

{
  // «Søk»: what the card row asks Google Scholar
  const aea = 'Aguzzoni, Luca, Elena Argentesi, Lorenzo Ciari, Tomaso Duso, and Massimo Tognoni. 2016. “Ex post Merger Evaluation in the U.K. Retail Market for Books.” The Journal of Industrial Economics, 64(1): 170–200.'
  check('scholar query: a quoted title, the first author and the year', M.scholarQuery(aea) === 'Ex post Merger Evaluation in the U.K. Retail Market for Books Aguzzoni 2016', M.scholarQuery(aea))
  const numbered = '[12] K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. In CVPR, 2016. https://doi.org/10.1109/CVPR.2016.90'
  check('scholar query: no quotes — the entry itself, its DOI and URL left out', M.scholarQuery(numbered) === '[12] K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. In CVPR, 2016.', M.scholarQuery(numbered))
  const url = M.scholarUrl('a & b?#c')
  check('scholar url: Google Scholar, the query encoded so it cannot reshape the URL', url === 'https://scholar.google.com/scholar?q=a%20%26%20b%3F%23c', url)
}

// ------------------------------------------------------ tier 2: real pdf.js
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href

/** A two-page PDF with a /Dests name tree, text on page 2 for the caption
 *  check: «Figure 1: ...» on a baseline 12 pt under the figure anchor. */
function namedDestFixture() {
  const page2Text = 'BT /F1 10 Tf 72 400 Td (Figure 1: A caption under the figure) Tj ET\n' +
    'BT /F1 10 Tf 72 200 Td (Some running text far from any anchor) Tj ET\n'
  const objs = [
    // 1 catalog
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests 7 0 R >> >>',
    // 2 pages
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    // 3, 4 pages
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 8 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 8 0 R >> >> >>',
    // 5, 6 contents
    `<< /Length ${'BT /F1 10 Tf 72 700 Td (Reference list) Tj ET\n'.length} >>\nstream\nBT /F1 10 Tf 72 700 Td (Reference list) Tj ET\n\nendstream`,
    `<< /Length ${page2Text.length} >>\nstream\n${page2Text}\nendstream`,
    // 7 the name tree (keys sorted, as the spec requires)
    '<< /Names [(cite.vaswani2017) [3 0 R /XYZ 72 712 null] (dangling) [99 0 R /XYZ 0 0 null] ' +
      '(figure.1) [4 0 R /XYZ 72 412 null] (figure.2) [4 0 R /XYZ 72 212 null] (section.fit) [4 0 R /Fit]] >>',
    // 8 font
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.7\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

{
  const doc = await pdfjs.getDocument({ data: namedDestFixture(), verbosity: 0 }).promise
  const cite = await M.resolvePreviewTarget(doc, 'cite.vaswani2017')
  check('named citation resolves to its page and point', cite?.pageIndex === 0 && cite.x === 72 && cite.y === 712 && cite.kind === 'citation', JSON.stringify(cite))
  const fig = await M.resolvePreviewTarget(doc, 'figure.1')
  check('named figure resolves', fig?.pageIndex === 1 && fig.y === 412 && fig.kind === 'figure', JSON.stringify(fig))
  check('a figure anchored a line above «Figure 1:» is on its caption', await M.destOnFigureCaption(doc, 1, 412))
  check('a figure anchor with no caption under it is the float\'s top', !(await M.destOnFigureCaption(doc, 1, 212)))
  const fit = await M.resolvePreviewTarget(doc, 'section.fit')
  check('/Fit resolves to its page with no point', fit?.pageIndex === 1 && fit.x === null && fit.y === null && fit.kind === 'section', JSON.stringify(fit))
  check('a name that points at no page is null', (await M.resolvePreviewTarget(doc, 'dangling')) === null)
  check('a name that does not exist is null', (await M.resolvePreviewTarget(doc, 'cite.nobody')) === null)
  check('garbage is null', (await M.resolvePreviewTarget(doc, 42)) === null)
}
{
  // The entry's END comes from the next entry's destination, read out of the
  // document's /Dests table. This list gives the layout nothing to go on (no
  // labels, no indent, no gap, and the second entry does not open «Surname,»),
  // so only a table that was actually read stops the cut in the right place.
  // pdfjs-dist 6.2 turned getDestinations() into a Map; reading it as an
  // object yields nothing and the entry ran on into its neighbour.
  const text =
    'BT /F1 10 Tf 72 700 Td (Adams, A. \\(2001\\). First paper title here.) Tj ET\n' +
    'BT /F1 10 Tf 72 688 Td (Journal of Things 1, 1-10.) Tj ET\n' +
    'BT /F1 10 Tf 72 676 Td (The Brown Group \\(2002\\). Second paper.) Tj ET\n' +
    'BT /F1 10 Tf 72 664 Td (Journal of Others 2, 3-4.) Tj ET\n'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests 5 0 R >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    // hyperref raises each anchor a line above its entry
    '<< /Names [(cite.adams) [3 0 R /XYZ 72 712 null] (cite.brown) [3 0 R /XYZ 72 688 null]] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.7\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(body, 'latin1')), verbosity: 0 }).promise
  check('destEntries reads a Map and an object alike', M.destEntries(new Map([['a', [1]]])).length === 1 && M.destEntries({ a: [1] }).length === 1 && M.destEntries(null).length === 0)
  check('this pdf.js hands over a destinations table destEntries can read', M.destEntries(await doc.getDestinations()).length === 2)
  const target = await M.resolvePreviewTarget(doc, 'cite.adams')
  const entry = await M.citationEntryText(doc, target)
  check('real pdf.js: the entry ends at the next destination', entry === 'Adams, A. (2001). First paper title here.\nJournal of Things 1, 1-10.', JSON.stringify(entry))
  // The citation card reads the same table: the whole family in list order,
  // and each entry as one paragraph of text
  const fam = await M.familyDests(doc, M.destFamily('cite.adams'))
  check('real pdf.js: the family in list order, pages resolved', fam.map((d) => `${d.name}@${d.pageIndex}`).join() === 'cite.adams@0,cite.brown@0', JSON.stringify(fam))
  const card = await M.cardEntries(doc, fam, fam)
  check('real pdf.js: one card row per entry, as text', card.length === 2 && card[0].segments.map((s) => s.text).join('') === 'Adams, A. (2001). First paper title here. Journal of Things 1, 1-10.', JSON.stringify(card.map((c) => c.segments)))
  check('real pdf.js: a card row keeps the lookup text line by line', card[0].text === entry)
}
{
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(SAMPLE)), verbosity: 0 }).promise
  const page = await doc.getPage(1)
  const links = (await page.getAnnotations()).filter((a) => a.subtype === 'Link' && a.dest)
  check('sample.pdf has internal links to resolve', links.length > 0, String(links.length))
  let ok = 0
  for (const l of links) {
    const tgt = await M.resolvePreviewTarget(doc, l.dest)
    if (tgt && tgt.pageIndex > 0 && tgt.pageIndex < doc.numPages && tgt.y !== null && tgt.kind === 'other') ok++
  }
  check('every sample.pdf TOC link resolves to a later page and a y', ok === links.length, `${ok}/${links.length}`)
}

fs.rmSync(dir, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll link-preview checks passed')

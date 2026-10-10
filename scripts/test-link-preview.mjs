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

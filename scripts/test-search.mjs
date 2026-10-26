// Proof for the search query rule in src/renderer/src/search.ts (issue #38):
// a phrase the page breaks across a line is still one match. buildPageText
// writes '\n' after every item with hasEOL, so the page text of
//
//     The tree originated
//     in Asia
//
// is «The tree originated\nin Asia», and a query typed with a space,
// «The tree originated in», found nothing while «The tree originated» did.
// The rule now: every whitespace run in the query matches ANY whitespace run
// on the page; leading and trailing blanks in the query are dropped; the
// match's start/end still address the page text itself (the text-layer
// mapping depends on it); case and whole-word options are unchanged.
//
// Run: node scripts/test-search.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/search.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'search-'))
const out = join(dir, 'search.mjs')
await build({
  entryPoints: [SRC],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  external: ['pdfjs-dist'],
  logLevel: 'silent'
})
const { findMatches, queryPattern, dedupeTextContent } = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const page = (text) => ({ text, runs: [] })
const opts = { matchCase: false, wholeWords: false }
const find = (text, query, o = opts) => findMatches([page(text)], query, o)

const broken = 'The tree originated\nin Asia, and the tree\n\n  spread west.'

const m1 = find(broken, 'The tree originated in')
check('a phrase broken across a line is one match', m1.length === 1 && m1[0].start === 0 && m1[0].end === 22,
  JSON.stringify(m1.map((m) => [m.start, m.end])))
check('the match addresses the page text itself (ends on «in»)', broken.slice(m1[0].start, m1[0].end) === 'The tree originated\nin')
check('the snippet shows the break as a space', m1[0].snippet.startsWith('The tree originated in Asia'))

const m2 = find(broken, 'tree spread')
check('a blank line plus indentation is still one whitespace run', m2.length === 1 && broken.slice(m2[0].start, m2[0].end) === 'tree\n\n  spread')

check('a trailing blank in the query is not a demand for a space', find(broken, 'originated ').length === 1)
check('a leading blank likewise', find(broken, ' Asia').length === 1)
check('two spaces in the query match one on the page', find(broken, 'in  Asia').length === 1)
check('a blank query finds nothing', find(broken, '   ').length === 0 && queryPattern('  ', false) === null)

check('case still folds by default', find(broken, 'the tree').length === 2)
check('match case still distinguishes', find(broken, 'The tree', { matchCase: true, wholeWords: false }).length === 1)
check('whole words still refuses a prefix', find(broken, 'tre', { matchCase: false, wholeWords: true }).length === 0)
check('whole words accepts the word', find(broken, 'tree', { matchCase: false, wholeWords: true }).length === 2)
check('regex characters in the query are literal', find('cost (a+b)*c', '(a+b)*c').length === 1)
check('overlapping occurrences are each found', find('aaa', 'aa').length === 2)

const m3 = find('x\n'.repeat(3) + 'needle', 'needle')
check('a match after several line breaks keeps its offset', m3.length === 1 && m3[0].start === 6)

// ---- Text drawn twice in the same place (Atypon's PDFplus: every line as
// outlines, then filled over them — pdf.js reports both) ----
const item = (str, x, y, extra = {}) => ({
  str,
  dir: 'ltr',
  width: str.length * 5,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
  fontName: 'g_d0_f3',
  hasEOL: false,
  ...extra
})
const content = (items) => ({ items, styles: {}, lang: null })
const strs = (c) => c.items.map((i) => i.str)

const twice = content([
  item('structure–', 66, 290),
  item('structure–', 66, 290, { hasEOL: true }),
  item('conduct–performance', 66, 278, { width: 92.3 }),
  item('conduct–performance', 66, 278, { width: 95.1, hasEOL: true }),
  item('', 0, 0, { hasEOL: true }),
  item('conduct', 300, 278),
  item('conduct', 300, 278.4, { hasEOL: true })
])
const once = dedupeTextContent(twice)
check('a line drawn twice in the same place is read once', JSON.stringify(strs(once)) === JSON.stringify(['structure–', 'conduct–performance', '', 'conduct']), JSON.stringify(strs(once)))
check('the line end on the copy carries to the kept item', once.items[0].hasEOL === true && once.items[1].hasEOL === true && once.items[3].hasEOL === true)
check('the kept item is the first one (the outline copy, its own width)', once.items[1].width === 92.3)
check('a copy a hair off (0.4 pt) still counts as the same place', once.items[3].str === 'conduct' && once.items.length === 4)
check('the input is left untouched', twice.items.length === 7 && twice.items[0].hasEOL === false)

const apart = content([item('0.00', 100, 500), item('0.00', 140, 500), item('0.00', 100, 488)])
check('the same string elsewhere on the line or on another line is kept', dedupeTextContent(apart) === apart)
const sized = content([item('A', 66, 700, { transform: [24, 0, 0, 24, 66, 700] }), item('A', 66, 700)])
check('the same string at another size in the same place is kept', dedupeTextContent(sized) === sized)
const turned = content([item('1', 66, 700), item('1', 66, 700, { transform: [0, 10, -10, 0, 66, 700] })])
check('the same string turned 90° from the same origin is two', dedupeTextContent(turned) === turned)
// LaTeX's \pmb: three copies of a symbol 0.04 em apart (Cardoso 2020, p. 11)
const pmb = content([item('M C', 404.41, 515.84, { transform: [9.01, 0, 0, 9.01, 404.41, 515.84] }), item('M C', 404.65, 516.13, { transform: [9.01, 0, 0, 9.01, 404.65, 516.13] }), item('M C', 404.88, 515.84, { transform: [9.01, 0, 0, 9.01, 404.88, 515.84] })])
check('a poor man\'s bold (three copies a hair apart) is one', dedupeTextContent(pmb).items.length === 1)
const tiny = content([item('a', 100, 700, { transform: [3, 0, 0, 3, 100, 700] }), item('a', 100.4, 700, { transform: [3, 0, 0, 3, 100.4, 700] })])
check('at 3 pt, 0.4 pt apart is another place (the tolerance follows the size)', dedupeTextContent(tiny) === tiny)
// The outline copy of a line brings its own space items; left in, every
// line's copy of a space opened the next line («useful\n instrumental»)
const blanks = content([item('fi', 66, 700), item(' ', 76, 700), item('rm', 80, 700), item('fi', 66, 700), item(' ', 76, 700), item('rm', 80, 700, { hasEOL: true })])
check('a space drawn twice in the same place goes with its line', JSON.stringify(strs(dedupeTextContent(blanks))) === JSON.stringify(['fi', ' ', 'rm']))
const breaks = content([item('', 0, 0, { hasEOL: true }), item('', 0, 0, { hasEOL: true }), item('x', 70, 700)])
check('the empty items that mark a paragraph break are never deduplicated', dedupeTextContent(breaks) === breaks)
const xfaItems = { items: [{ str: 'Name', dir: 'ltr', width: 0, height: 0, transform: null, fontName: '', hasEOL: false }, { str: 'Name', dir: 'ltr', width: 0, height: 0, transform: null, fontName: '', hasEOL: false }], styles: {}, lang: null }
check('items with no position (an XFA form) are left alone', dedupeTextContent(xfaItems) === xfaItems)
const noTransform = { items: [{ str: 'a', dir: 'ltr', width: 0, height: 0, hasEOL: false }, { str: 'a', dir: 'ltr', width: 0, height: 0, hasEOL: false }], styles: {}, lang: null }
check('items with no transform at all do not throw', dedupeTextContent(noTransform) === noTransform)
const clean = content([item('one', 66, 700), item('two', 90, 700, { hasEOL: true }), item('one', 66, 688)])
check('a clean page comes back as the same object', dedupeTextContent(clean) === clean)
const far = content([item('one', 66, 700), item('one', 66, 700), item('one', 66, 698)])
const farOut = dedupeTextContent(far)
check('a non-consecutive copy is still found, a line below is not', farOut.items.length === 2 && farOut.items[1].transform[5] === 698)

console.log(failures === 0 ? '\nAll search checks passed' : `\n${failures} search check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

// Proof for src/renderer/src/ai-retrieval.ts — the BM25 excerpt fallback for
// documents that cannot ride along whole. What matters here:
//   - the budget is a HARD bound (an overrun is a provider rejection
//     mid-question), and it is measured against BOTH ceilings: the model's
//     context window and the account's per-request token quota, whichever
//     binds. The quota case is the one that used to be missed entirely — a
//     900k-window model on a 30k tier sent the whole document and was refused;
//   - chunking is paragraph-granular, and every block is an EXACT substring of
//     one page (that is what keeps the citation machinery working);
//   - front matter cannot eat a tight budget whole, and a roomy budget still
//     converges on contiguous pages;
//   - markers carry REAL page numbers, gaps inside a page are marked, and
//     char-offset citations convert to quotes the page text actually contains.
// Run: node scripts/test-ai-retrieval.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/ai-retrieval.ts', import.meta.url))

// esbuild strips the type-only import and emits ESM we can import directly
const dir = mkdtempSync(join(tmpdir(), 'ai-retrieval-test-'))
const out = join(dir, 'ai-retrieval.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const R = await import(pathToFileURL(out).href)

let failures = 0
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}

// ---------- fixture: a 60-page document, paragraphs and all ----------

const N = 60
const para =
  'The model of data and results in this study follows the standard approach discussed in the literature. '
/** Six paragraphs of ~330 chars — a page of an ordinary paper */
const sixParagraphs = (i) =>
  Array.from({ length: 6 }, (_, j) => `Paragraph ${j + 1} of part ${i + 1}. ` + para.repeat(3)).join(
    '\n'
  )
const pages = []
for (let i = 0; i < N; i++) {
  // Page 21 is deliberately ONE long line with no breaks at all — the shape a
  // pdf.js text layer usually hands us, and the case the sentence-boundary
  // split exists for. Pages 41/42 answer the question the tests ask.
  const body = i === 20 ? `Chapter text for part ${i + 1}. ` + para.repeat(14) : sixParagraphs(i)
  pages.push(
    i === 40 || i === 41
      ? body + '\nThe quantile bootstrap inference uses a kernel estimator for the variance.'
      : body
  )
}
const docChars = pages.reduce((a, t) => a + t.length, 0)

// ---------- budget: two ceilings ----------

ok(R.documentFits(100_000, 200_000), 'a 100k-char document fits a 200k-token window')
ok(!R.documentFits(4_000_000, 200_000), 'a 4M-char document does not fit a 200k-token window')
ok(
  R.excerptCharBudget(200_000) < (200_000 - R.CONTEXT_RESERVE_TOKENS) * R.CHARS_PER_TOKEN,
  'excerpt budget leaves slack below the usable window'
)
// No account ceiling known = the arithmetic this module always had
ok(
  R.usableTokens(200_000) === 200_000 - R.CONTEXT_RESERVE_TOKENS &&
    R.usableTokens(200_000, 0) === R.usableTokens(200_000) &&
    R.excerptCharBudget(900_000, undefined) === R.excerptCharBudget(900_000),
  'an unknown (or zero) account ceiling changes nothing'
)
// THE BUG: a 900k-window model on a low usage tier. The document fits the
// window by a mile and is refused by the quota — so it has to be excerpted.
ok(R.documentFits(docChars, 900_000), 'the fixture fits a 900k-token context window')
ok(
  !R.documentFits(docChars, 900_000, 30_000),
  'the same document does NOT fit a 30k-per-request account ceiling'
)
ok(
  R.excerptCharBudget(900_000, 30_000) > 0 &&
    R.excerptCharBudget(900_000, 30_000) < R.excerptCharBudget(900_000) / 10,
  `a 30k ceiling yields a small but usable budget (${R.excerptCharBudget(900_000, 30_000)} chars)`
)
// A flat 24k reserve would leave a 30k ceiling nothing at all
ok(R.usableTokens(900_000, 30_000) === 15_000, 'the reserve scales with a tight ceiling')
ok(
  R.usableTokens(900_000, 2_000_000) === 900_000 - R.CONTEXT_RESERVE_TOKENS,
  'a ceiling above the window leaves the window in charge'
)

// ---------- chunking ----------

const blocks = R.buildBlocks(pages)
{
  ok(blocks.length > N, `chunking is finer than one block per page (${blocks.length} blocks)`)
  ok(
    blocks.every((b) => pages[b.page].slice(b.start, b.start + b.text.length) === b.text),
    'every block is an exact substring of its own page at its own offset'
  )
  ok(
    blocks.every((b) => b.text === b.text.trim()),
    'no block starts or ends on whitespace (it is quoted verbatim)'
  )
  ok(
    blocks.every((b) => b.text.length <= 1200),
    'no block exceeds the max chunk size'
  )
  // Blocks of one page are in order and never overlap
  const page20 = blocks.filter((b) => b.page === 20)
  ok(page20.length >= 2, `a single-line page still splits (${page20.length} blocks)`)
  ok(
    page20.every((b, k) => k === 0 || b.start >= page20[k - 1].start + page20[k - 1].text.length),
    'blocks within a page are ordered and non-overlapping'
  )
  ok(
    blocks.every((b, k) => k === 0 || blocks[k].page >= blocks[k - 1].page),
    'blocks are in document order'
  )
  // Nothing is lost: the blocks of a page cover its non-whitespace content
  const covered = page20.reduce((a, b) => a + b.text.replace(/\s/g, '').length, 0)
  ok(
    covered === pages[20].replace(/\s/g, '').length,
    'a page’s blocks together cover all of its text'
  )
  ok(R.buildBlocks(['']).length === 0, 'an empty (scanned) page contributes no block')
}

/** What the assembled excerpt actually costs, the only bound that matters */
const docLength = (selected) =>
  R.buildExcerptDocument(blocks, selected, 'Page', '').text.length

// ---------- selection: the tight budget ----------

{
  const budget = R.excerptCharBudget(900_000, 30_000)
  const sel = R.selectExcerptBlocks(blocks, 'quantile bootstrap variance', budget)
  const text = R.buildExcerptDocument(blocks, sel, 'Page', '').text
  ok(
    text.includes('quantile bootstrap inference uses a kernel estimator'),
    'the answering passage survives a 30k-ceiling budget'
  )
  ok(docLength(sel) <= budget, `assembled excerpt respects the budget (${docLength(sel)} <= ${budget})`)
  // The point of chunking: front matter may not swallow a tight budget. Pages
  // 1–3 plus the last two are the anchors; at page granularity they were the
  // whole budget, and the question got nothing.
  const anchorChars = sel
    .filter((i) => [0, 1, 2, N - 1, N - 2].includes(blocks[i].page))
    .reduce((a, i) => a + blocks[i].text.length, 0)
  ok(anchorChars < budget * 0.5, `anchors stay a minority of a tight budget (${anchorChars}/${budget})`)
  const covered = new Set(sel.map((i) => blocks[i].page))
  ok(covered.has(40) || covered.has(41), 'the hit page is attached')
  ok(covered.size >= 5, `a tight budget still reaches several pages (${covered.size})`)
}

// ---------- selection: a roomy budget converges on whole pages ----------

{
  // Enough for the whole document: every block must come along, which is the
  // page-granular behaviour this module had before chunking.
  const sel = R.selectExcerptBlocks(blocks, 'quantile bootstrap variance', docChars * 2)
  ok(sel.length === blocks.length, `a roomy budget attaches every block (${sel.length}/${blocks.length})`)
  const doc = R.buildExcerptDocument(blocks, sel, 'Page', '')
  ok(doc.pageNumbers.length === N, 'every page gets its own slot')
  ok(!doc.text.includes(R.EXCERPT_GAP), 'a complete page carries no gap marker')
}

{
  // Mid-sized budget: the hit pages and the front/tail anchors, plus coverage
  const budget = Math.floor(docChars * 0.35)
  const sel = R.selectExcerptBlocks(blocks, 'quantile bootstrap variance', budget)
  ok(docLength(sel) <= budget, `mid-sized selection respects the budget (${docLength(sel)} <= ${budget})`)
  const covered = new Set(sel.map((i) => blocks[i].page))
  ok(covered.has(40) && covered.has(41), 'both query pages selected')
  ok(covered.has(0) && covered.has(N - 1), 'front matter and tail ride along')
  ok(
    sel.every((v, k) => k === 0 || v > sel[k - 1]),
    'selection is ascending and duplicate-free'
  )
}

{
  // No informative query terms → the budget is spread over the document
  const budget = Math.floor(docChars * 0.3)
  const sel = R.selectExcerptBlocks(blocks, 'xyzzy plugh', budget)
  const covered = [...new Set(sel.map((i) => blocks[i].page))].sort((a, b) => a - b)
  ok(covered.length >= 15, `spread fallback fills the budget (${covered.length} pages)`)
  let maxGap = 0
  for (let k = 1; k < covered.length; k++) maxGap = Math.max(maxGap, covered[k] - covered[k - 1])
  ok(maxGap <= 12, `spread coverage has no huge holes (max gap ${maxGap})`)
  ok(docLength(sel) <= budget, 'the query-less spread respects the budget too')
}

{
  // A budget below a single block still attaches exactly one
  const sel = R.selectExcerptBlocks(blocks, 'quantile bootstrap', 10)
  ok(sel.length === 1, `starved budget still attaches one block (got ${sel.length})`)
  ok(R.selectExcerptBlocks([], 'anything', 10_000).length === 0, 'no blocks selects nothing')
}

// ---------- excerpt document + citation conversion ----------

{
  // One partial page (a gap inside it) and one whole page, so both joins are
  // exercised: page 40's first and LAST block with the middle left out.
  const p40 = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.page === 40)
  ok(p40.length >= 3, 'the hit page has enough blocks to leave a gap in')
  const selected = [
    blocks.findIndex((b) => b.page === 0),
    p40[0].i,
    p40[p40.length - 1].i,
    blocks.findIndex((b) => b.page === 59)
  ]
  const doc = R.buildExcerptDocument(blocks, selected, 'Page', '[Excerpt: 3 of 60 pages attached]')
  ok(doc.text.includes('[Page 41]\n'), 'markers carry REAL page numbers')
  ok(!doc.text.includes('[Page 4]\n'), 'no marker for an unselected page')
  ok(
    doc.pageNumbers.join(',') === '1,41,60',
    `pageNumbers maps slots to real pages (got ${doc.pageNumbers.join(',')})`
  )
  ok(doc.pageStarts.length === 3, 'one slot per attached page, not per block')
  ok(doc.text.includes(R.EXCERPT_GAP), 'omitted text inside a page is marked')
  ok(
    doc.text.split('[Page 41]')[1].startsWith('\n' + blocks[p40[0].i].text),
    'a slot opens with its first attached block, verbatim'
  )
  ok(R.slotAtOffset(doc.pageStarts, 0) === 0, 'offsets in the header clamp to slot 0')

  // A char citation inside slot 1 (real page 41)
  const s = doc.pageStarts[1] + 5
  const cited = doc.text.slice(s, s + 40)
  const parts = R.charCitationsToQuotes(
    [{ text: 'x', citations: [{ kind: 'char', start: s, end: s + 40, citedText: cited }] }],
    doc
  )
  const q = parts[0].citations[0]
  ok(q.kind === 'quote', 'char citation converts to a quote citation')
  ok(q.pageNumber === 41, `converted citation points at the REAL page (got ${q.pageNumber})`)
  ok(pages[40].includes(q.quote), 'converted quote is verbatim page text')

  // A span running ACROSS the gap marker keeps the longest real side of it —
  // quoting across omitted text would claim an order no page contains
  const gapAt = doc.text.indexOf(R.EXCERPT_GAP)
  const across = R.charCitationsToQuotes(
    [
      {
        text: 'x',
        citations: [
          {
            kind: 'char',
            start: gapAt - 60,
            end: gapAt + R.EXCERPT_GAP.length + 80,
            citedText: doc.text.slice(gapAt - 60, gapAt + 80)
          }
        ]
      }
    ],
    doc
  )
  const qg = across[0].citations[0]
  ok(!qg.quote.includes(R.EXCERPT_GAP), 'a gap-crossing quote drops the marker')
  ok(pages[40].includes(qg.quote), 'a gap-crossing quote stays verbatim page text')

  // A char citation running past the slot into the next marker gets clamped
  const slotEnd = doc.pageStarts[2]
  const spill = R.charCitationsToQuotes(
    [
      {
        text: 'x',
        citations: [
          {
            kind: 'char',
            start: slotEnd - 30,
            end: slotEnd + 25,
            citedText: doc.text.slice(slotEnd - 30, slotEnd + 25)
          }
        ]
      }
    ],
    doc
  )
  const q2 = spill[0].citations[0]
  ok(!q2.quote.includes('[Page'), 'spill-over quote carries no marker text')

  // Quote and web citations pass through untouched
  const mixed = R.charCitationsToQuotes(
    [
      {
        text: 'x',
        citations: [
          { kind: 'quote', pageNumber: 3, quote: 'hello' },
          { kind: 'web', url: 'https://example.org', title: 'Example' }
        ]
      }
    ],
    doc
  )
  ok(
    mixed[0].citations[0].kind === 'quote' && mixed[0].citations[1].kind === 'web',
    'non-char citations pass through'
  )
}

{
  // Full documents (no pageNumbers) are untouched — char offsets stay valid there
  const doc = { text: pages.join('\n\n'), pageStarts: [0] }
  const parts = R.charCitationsToQuotes(
    [{ text: 'x', citations: [{ kind: 'char', start: 3, end: 9, citedText: 'apter' }] }],
    doc
  )
  ok(parts[0].citations[0].kind === 'char', 'full-document char citations are left alone')
}

if (failures > 0) {
  console.error(`ai-retrieval: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('ai-retrieval: all checks passed')

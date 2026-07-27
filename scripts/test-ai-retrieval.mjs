// Proof for src/renderer/src/ai-retrieval.ts — the BM25 excerpt fallback for
// documents beyond the model's context window. What matters here: the budget
// is a hard bound (overrun = provider 400 mid-question), markers carry REAL
// page numbers (citations resolve through them), and char-offset citations
// convert to quotes the page text actually contains.
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

// ---------- fixture: a 60-page document ----------

const N = 60
const filler =
  'The model of data and results in this study follows the standard approach discussed in the literature. '
const pages = []
for (let i = 0; i < N; i++) {
  let text = `Chapter text for part ${i + 1}. ` + filler.repeat(12)
  if (i === 40 || i === 41) {
    text += ' The quantile bootstrap inference uses a kernel estimator for the variance.'
  }
  pages.push(text)
}
const pageChars = pages.reduce((a, t) => a + t.length, 0) / N

// ---------- documentFits ----------

ok(R.documentFits(100_000, 200_000), 'a 100k-char document fits a 200k-token window')
ok(!R.documentFits(4_000_000, 200_000), 'a 4M-char document does not fit a 200k-token window')
ok(
  R.excerptCharBudget(200_000) < (200_000 - R.CONTEXT_RESERVE_TOKENS) * R.CHARS_PER_TOKEN,
  'excerpt budget leaves slack below the usable window'
)

// ---------- BM25 selection ----------

{
  const budget = Math.floor(20 * (pageChars + 20)) // room for ~20 pages
  const sel = R.selectExcerptPages(pages, 'quantile bootstrap variance', budget)
  ok(sel.includes(40) && sel.includes(41), `query pages 41/42 selected (got ${sel.join(',')})`)
  ok(sel.includes(39) || sel.includes(42), 'a neighbour of the hit pages rides along')
  ok(sel.includes(0) && sel.includes(1) && sel.includes(2), 'front pages always attached')
  ok(sel.includes(N - 1) && sel.includes(N - 2), 'tail pages always attached')
  const spent = sel.reduce((a, i) => a + pages[i].length + 16, 0)
  ok(spent <= budget, `selection respects the budget (${spent} <= ${budget})`)
  ok(
    sel.every((v, k) => k === 0 || v > sel[k - 1]),
    'selection is ascending and duplicate-free'
  )
}

{
  // No informative query terms → the budget is spread over the document
  const budget = Math.floor(20 * (pageChars + 20))
  const sel = R.selectExcerptPages(pages, 'xyzzy plugh', budget)
  ok(sel.length >= 15, `spread fallback fills the budget (${sel.length} pages)`)
  let maxGap = 0
  for (let k = 1; k < sel.length; k++) maxGap = Math.max(maxGap, sel[k] - sel[k - 1])
  ok(maxGap <= 12, `spread coverage has no huge holes (max gap ${maxGap})`)
}

{
  // A budget below a single page still attaches exactly one page
  const sel = R.selectExcerptPages(pages, 'quantile bootstrap', 10)
  ok(sel.length === 1, `starved budget still attaches one page (got ${sel.length})`)
}

// ---------- excerpt document + citation conversion ----------

{
  const indices = [0, 1, 40, 41, 59]
  const doc = R.buildExcerptDocument(pages, indices, 'Page', '[Excerpt: 5 of 60 pages attached]')
  ok(doc.text.includes('[Page 41]\n'), 'markers carry REAL page numbers')
  ok(!doc.text.includes('[Page 4]\n'), 'no marker for an unselected page')
  ok(
    doc.pageNumbers.join(',') === '1,2,41,42,60',
    `pageNumbers maps slots to real pages (got ${doc.pageNumbers.join(',')})`
  )
  indices.forEach((pageIdx, slot) => {
    const start = doc.pageStarts[slot]
    ok(
      doc.text.slice(start, start + pages[pageIdx].length) === pages[pageIdx],
      `slot ${slot} content is exactly page ${pageIdx + 1}`
    )
  })

  ok(R.slotAtOffset(doc.pageStarts, 0) === 0, 'offsets in the header clamp to slot 0')

  // A char citation inside slot 2 (real page 41)
  const s = doc.pageStarts[2] + 5
  const cited = doc.text.slice(s, s + 40)
  const parts = R.charCitationsToQuotes(
    [{ text: 'x', citations: [{ kind: 'char', start: s, end: s + 40, citedText: cited }] }],
    doc
  )
  const q = parts[0].citations[0]
  ok(q.kind === 'quote', 'char citation converts to a quote citation')
  ok(q.pageNumber === 41, `converted citation points at the REAL page (got ${q.pageNumber})`)
  ok(pages[40].includes(q.quote), 'converted quote is verbatim page text')

  // A char citation running past the slot into the next marker gets clamped
  const end2 = doc.pageStarts[2] + pages[40].length
  const spill = R.charCitationsToQuotes(
    [
      {
        text: 'x',
        citations: [
          {
            kind: 'char',
            start: end2 - 30,
            end: end2 + 25,
            citedText: doc.text.slice(end2 - 30, end2 + 25)
          }
        ]
      }
    ],
    doc
  )
  const q2 = spill[0].citations[0]
  ok(!q2.quote.includes('[Page'), 'spill-over quote carries no marker text')
  ok(pages[40].includes(q2.quote), 'spill-over quote clamps to verbatim page text')

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
  ok(mixed[0].citations[0].kind === 'quote' && mixed[0].citations[1].kind === 'web', 'non-char citations pass through')
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

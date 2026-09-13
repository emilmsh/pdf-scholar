// Excerpt retrieval for documents that cannot ride along whole.
//
// The assistant's design is full-document-plus-prompt-cache: every request
// attaches the whole text, follow-ups read it from cache, and citations stay
// anchored in text the model actually saw. That design has TWO ceilings, and
// this module is what happens above either of them:
//   - the model's CONTEXT WINDOW, and
//   - the account's per-request TOKEN CEILING at the provider — a per-minute
//     quota, used as a per-request bound because one request that does not fit
//     a whole minute's budget can never succeed, no matter how long you wait
//     (learned from the provider's own headers, see ai-token-limits.ts).
// The second is routinely an order of magnitude tighter than the first: a
// 900k-window model on a low usage tier may refuse anything past 30k tokens.
// Above either ceiling: score the document against the question (BM25), attach
// the best material under its REAL page markers, and tell the model it is
// reading an excerpt. Below both, nothing here runs — see
// prepareDocumentForRequest in ai.ts.
//
// Retrieval is PARAGRAPH-granular, not page-granular. Pages were the unit
// until the tighter second ceiling arrived, where one page is a large share of
// the entire budget and the front matter alone can eat it. Blocks keep the two
// properties pages gave us — every block is an exact substring of ONE page,
// and every attached page keeps its own marker — so nothing downstream of the
// excerpt had to change. On a roomy budget the selection converges back on
// whole pages (step 4 in selectExcerptBlocks), which is what this module did
// before chunking.
//
// Deliberately lexical, not embeddings: Anthropic has no embeddings endpoint
// (an embeddings path would exist only for OpenAI keys, splitting platform
// behavior), and an excerpt fills most of the budget anyway — recall in bulk,
// not top-5 precision, is what the selection has to deliver.
//
// Pure module (type-only imports) so `npm run test:retrieval` can run it in
// plain Node via the same esbuild pattern as test-rotation.mjs.
import type { AiContentPart } from '../../shared/types'

export interface AiDocument {
  /** All attached pages joined with blank lines, each prefixed with a page marker */
  text: string
  /** Char offset of each attached page's content within `text` (slot i) */
  pageStarts: number[]
  /** Real 1-based page number per slot. Present only on excerpt documents —
   *  absent means identity (slot i = page i+1), i.e. the full document. */
  pageNumbers?: number[]
}

// ---------- Token budget ----------

/** Conservative chars-per-token for academic text (English prose is ~4;
 *  math-heavy or hyphen-broken pages tokenize worse). Overestimating tokens
 *  errs toward excerpting a little early — never toward a provider 400. */
export const CHARS_PER_TOKEN = 3.6

/** Tokens reserved next to the document: system prompt + citation contract,
 *  conversation history, images, and the answer itself (max_tokens tops out
 *  at 16k with thinking on — see anthropicThinking in shared/ai-chat.ts). */
export const CONTEXT_RESERVE_TOKENS = 24_000

/** Share of the usable window an excerpt may fill; the rest is slack for the
 *  chars-per-token estimate being off on unusual documents. */
export const EXCERPT_BUDGET_SHARE = 0.65

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Tokens available for the document itself, under both ceilings.
 *
 *  The context window keeps the flat reserve: there it protects a real total —
 *  a 32k local model must fit prompt AND answer in 32k, and sending it more
 *  buys a truncation rather than an answer.
 *
 *  A per-request token ceiling is a different bucket, and a flat 24k reserve
 *  against a 30k quota would leave nothing at all — so there the reserve
 *  scales with the ceiling, and EXCERPT_BUDGET_SHARE keeps the slack.
 *  `requestLimitTokens` absent — the everyday case, and every case before a
 *  ceiling has been learned — makes this the arithmetic it has always been. */
export function usableTokens(contextTokens: number, requestLimitTokens?: number): number {
  const fromContext = contextTokens - CONTEXT_RESERVE_TOKENS
  if (!requestLimitTokens || requestLimitTokens <= 0) return Math.max(0, fromContext)
  const reserve = Math.min(CONTEXT_RESERVE_TOKENS, Math.floor(requestLimitTokens * 0.5))
  return Math.max(0, Math.min(fromContext, requestLimitTokens - reserve))
}

/** Whether a document of `docChars` fits with room for everything else a
 *  request carries — the model's window, and the account's ceiling wherever
 *  that is known to be tighter. */
export function documentFits(
  docChars: number,
  contextTokens: number,
  requestLimitTokens?: number
): boolean {
  return estimateTokens(docChars) <= usableTokens(contextTokens, requestLimitTokens)
}

/** Char budget for the excerpt when the full text does not fit */
export function excerptCharBudget(contextTokens: number, requestLimitTokens?: number): number {
  return Math.floor(
    usableTokens(contextTokens, requestLimitTokens) * EXCERPT_BUDGET_SHARE * CHARS_PER_TOKEN
  )
}

// ---------- Chunking ----------

/** One retrievable chunk: a paragraph-sized run of ONE page's text, carried as
 *  an exact substring of that page (never re-joined, never normalized) — which
 *  is what keeps the citation locator, the quote contract and
 *  charCitationsToQuotes working against blocks exactly as they worked against
 *  whole pages. */
export interface DocBlock {
  /** 0-based page index */
  page: number
  /** Char offset within that page's text */
  start: number
  text: string
}

/** Chunk size bounds. A block is roughly a paragraph: small enough that a
 *  narrow budget buys many of them, large enough to carry an argument and to
 *  keep BM25's length normalization meaningful. */
const BLOCK_MIN_CHARS = 320
const BLOCK_MAX_CHARS = 1200

/** Marker for text left out INSIDE an attached page. Deliberately the exact
 *  form fallbackNeedles() in ai.ts already splits a quote on, so a model that
 *  quotes across a gap still resolves to a real passage. */
export const EXCERPT_GAP = '[…]'

/** Offset just past the last sentence end in `s` (terminator plus any closing
 *  punctuation), or -1 */
function lastSentenceEnd(s: string): number {
  let at = -1
  for (const m of s.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g)) at = (m.index ?? 0) + m[0].length
  return at
}

/** Ranges of a page's non-blank lines, edges trimmed */
function lineRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const m of text.matchAll(/[^\n]+/g)) {
    const at = m.index ?? 0
    const start = at + (m[0].length - m[0].trimStart().length)
    const end = at + m[0].trimEnd().length
    if (end > start) out.push({ start, end })
  }
  return out
}

/** Split a range longer than BLOCK_MAX_CHARS, preferring a sentence end and
 *  falling back to a word boundary. A pdf.js text layer often joins a whole
 *  page into one line, so this — not the line split above — is what produces
 *  the blocks on most real documents. */
function capRange(
  text: string,
  range: { start: number; end: number }
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let s = range.start
  while (range.end - s > BLOCK_MAX_CHARS) {
    const hard = s + BLOCK_MAX_CHARS
    const from = s + BLOCK_MIN_CHARS
    const window = text.slice(from, hard)
    const sentence = lastSentenceEnd(window)
    const space = window.lastIndexOf(' ')
    const cut = sentence >= 0 ? from + sentence : space >= 0 ? from + space + 1 : hard
    out.push({ start: s, end: cut })
    s = cut
    // Never start a block on whitespace: the block text is quoted verbatim
    while (s < range.end && /\s/.test(text[s])) s++
  }
  if (range.end > s) out.push({ start: s, end: range.end })
  return out
}

/** Paragraph-sized blocks of one page: short lines merged up to
 *  BLOCK_MIN_CHARS, long runs split down to BLOCK_MAX_CHARS. A merge keeps the
 *  text between the merged lines, so a block stays one contiguous substring. */
function pageBlocks(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let cur: { start: number; end: number } | null = null
  for (const line of lineRanges(text)) {
    for (const piece of capRange(text, line)) {
      if (cur && cur.end - cur.start >= BLOCK_MIN_CHARS) {
        out.push(cur)
        cur = null
      }
      if (!cur) {
        cur = { ...piece }
      } else if (piece.end - cur.start <= BLOCK_MAX_CHARS) {
        cur.end = piece.end
      } else {
        out.push(cur)
        cur = { ...piece }
      }
    }
  }
  if (cur) {
    // A trailing runt joins the block before it rather than standing alone —
    // but never past BLOCK_MAX_CHARS: the selection's budget arithmetic
    // assumes that bound, so breaking it here would overrun the budget.
    const prev = out[out.length - 1]
    if (prev && cur.end - cur.start < BLOCK_MIN_CHARS && cur.end - prev.start <= BLOCK_MAX_CHARS)
      prev.end = cur.end
    else out.push(cur)
  }
  return out
}

/** Every page's blocks, in document order. A page with no text contributes
 *  none, so a scanned page cannot claim budget. Consecutive blocks of one page
 *  are separated by WHITESPACE ONLY (pageBlocks cuts at line and sentence
 *  boundaries and skips the space between) — which is what lets
 *  buildExcerptDocument decide from the indices alone whether text was left
 *  out between two attached blocks. */
export function buildBlocks(pageTexts: string[]): DocBlock[] {
  const blocks: DocBlock[] = []
  for (let page = 0; page < pageTexts.length; page++) {
    const text = pageTexts[page]
    for (const r of pageBlocks(text)) {
      blocks.push({ page, start: r.start, text: text.slice(r.start, r.end) })
    }
  }
  return blocks
}

// ---------- BM25 over blocks ----------

// Classic Okapi BM25 (the pre-neural search-engine ranking): term frequency
// with diminishing returns, rare terms weighted up (IDF), long blocks
// deflated. Academic terminology is precise and concentrated, which is exactly
// the distribution this scores well.

const BM25_K1 = 1.2
const BM25_B = 0.75

export interface Bm25Index {
  /** term -> occurrences, per block */
  termFreq: Map<string, number>[]
  /** term -> number of blocks containing it */
  docFreq: Map<string, number>
  /** tokens per block */
  lengths: number[]
  avgLength: number
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function buildBm25Index(texts: string[]): Bm25Index {
  const termFreq: Map<string, number>[] = []
  const docFreq = new Map<string, number>()
  const lengths: number[] = []
  for (const text of texts) {
    const tf = new Map<string, number>()
    const tokens = tokenize(text)
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    termFreq.push(tf)
    lengths.push(tokens.length)
  }
  const total = lengths.reduce((a, b) => a + b, 0)
  return { termFreq, docFreq, lengths, avgLength: total / Math.max(1, lengths.length) }
}

/** BM25 score of every indexed unit against `query` (0 = no informative term
 *  matches) */
export function bm25Scores(index: Bm25Index, query: string): number[] {
  const n = index.termFreq.length
  const scores = new Array<number>(n).fill(0)
  for (const term of new Set(tokenize(query))) {
    const df = index.docFreq.get(term)
    if (!df) continue
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    for (let i = 0; i < n; i++) {
      const tf = index.termFreq[i].get(term)
      if (!tf) continue
      const norm = index.lengths[i] / Math.max(1, index.avgLength)
      scores[i] += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * norm))
    }
  }
  return scores
}

// ---------- Block selection ----------

/** Cost of opening a page in the excerpt: "[Side NNN]\n" plus the "\n\n" that
 *  separates it from the previous page */
const PAGE_MARKER_CHARS = 16

/** Cost of continuing a page: the newline or gap marker between two blocks */
const BLOCK_JOIN_CHARS = 6

/** Share of the budget the unconditional anchors (front matter + tail) may
 *  take. Uncapped they eat a tight budget whole — three pages of title,
 *  authors and abstract plus a reference list, and nothing left for the
 *  question. On a roomy budget the cap never binds and all of them ride
 *  along, exactly as they did when pages were the unit. */
const ANCHOR_BUDGET_SHARE = 0.25

/** Pick the blocks to attach for `query` within `budgetChars`, as ascending
 *  block indices. Four passes, in this order for a reason:
 *    1. ANCHORS — front matter and tail, which nearly every question benefits
 *       from, bounded by ANCHOR_BUDGET_SHARE.
 *    2. HITS — the best-scoring blocks with their immediate neighbours (an
 *       argument rarely respects a paragraph break).
 *    3. SPREAD — one block from each page nothing has been taken from, strided
 *       evenly, so a query-less request (the summary preset) and a question the
 *       ranking misread still see the whole document's shape.
 *    4. UPGRADE — whatever budget is left goes back into pages already
 *       represented, best page first, restoring contiguous reading. This is
 *       what makes a roomy budget converge on whole pages. */
export function selectExcerptBlocks(
  blocks: DocBlock[],
  query: string,
  budgetChars: number,
  index?: Bm25Index
): number[] {
  const n = blocks.length
  if (n === 0) return []
  const pageOrder: number[] = []
  const blocksByPage = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const list = blocksByPage.get(blocks[i].page)
    if (list) list.push(i)
    else {
      blocksByPage.set(blocks[i].page, [i])
      pageOrder.push(blocks[i].page)
    }
  }

  const included = new Set<number>()
  const pagesSeen = new Set<number>()
  let spent = 0
  // Opening a page costs its marker; continuing one costs a joiner. Blocks
  // that turn out to be adjacent need no gap marker, so this over-charges
  // slightly — the safe direction for a bound that must not be crossed.
  const cost = (i: number): number =>
    blocks[i].text.length + (pagesSeen.has(blocks[i].page) ? BLOCK_JOIN_CHARS : PAGE_MARKER_CHARS)
  const tryAdd = (i: number, cap = budgetChars): boolean => {
    if (i < 0 || i >= n || included.has(i)) return false
    const c = cost(i)
    if (spent + c > cap) return false
    included.add(i)
    pagesSeen.add(blocks[i].page)
    spent += c
    return true
  }

  // 1. Anchors
  const lastPage = blocks[n - 1].page
  const anchorCap = Math.max(0, Math.floor(budgetChars * ANCHOR_BUDGET_SHARE))
  for (const page of [0, 1, 2, lastPage, lastPage - 1]) {
    for (const i of blocksByPage.get(page) ?? []) tryAdd(i, anchorCap)
  }

  // 2. Hits, each with its neighbours
  const scores = bm25Scores(index ?? buildBm25Index(blocks.map((b) => b.text)), query)
  const ranked = scores
    .map((score, i) => ({ score, i }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
  for (const { i } of ranked) {
    if (budgetChars - spent < BLOCK_MIN_CHARS) break
    tryAdd(i)
    tryAdd(i - 1)
    tryAdd(i + 1)
  }

  // 3. Spread over the pages still untouched
  const bestOfPage = (page: number): number => {
    const list = blocksByPage.get(page) ?? []
    return list.reduce((best, i) => (scores[i] > scores[best] ? i : best), list[0])
  }
  const avgCost = blocks.reduce((a, b) => a + b.text.length, 0) / n + PAGE_MARKER_CHARS
  let slots = Math.floor((budgetChars - spent) / Math.max(1, avgCost))
  while (slots > 0) {
    const rest = pageOrder.filter((p) => !pagesSeen.has(p))
    if (rest.length === 0) break
    // ceil: never more candidates than slots, so one pass covers the whole
    // uncovered span instead of exhausting the budget on its front half
    const stride = Math.max(1, Math.ceil(rest.length / slots))
    let added = false
    for (let k = 0; k < rest.length; k += stride) added = tryAdd(bestOfPage(rest[k])) || added
    if (!added) break // every remaining page is over budget
    slots = Math.floor((budgetChars - spent) / Math.max(1, avgCost))
  }

  // 4. Give the remainder back to the pages already represented
  const pageScore = (page: number): number =>
    (blocksByPage.get(page) ?? []).reduce((best, i) => Math.max(best, scores[i]), 0)
  const partial = [...pagesSeen]
    .filter((p) => (blocksByPage.get(p) ?? []).some((i) => !included.has(i)))
    .sort((a, b) => pageScore(b) - pageScore(a))
  for (const page of partial) {
    for (const i of blocksByPage.get(page) ?? []) tryAdd(i)
  }

  // A budget too small for even one block still has to attach something: the
  // best-scoring block (or the first) alone, and the estimate slack absorbs it.
  if (included.size === 0) included.add(ranked[0]?.i ?? 0)

  return [...included].sort((a, b) => a - b)
}

// ---------- Excerpt document ----------

/** Join the selected blocks exactly like buildAiDocument joins pages for the
 *  full text, but with each page's REAL number in its marker (so the citation
 *  contract and click-to-jump keep working), EXCERPT_GAP where text inside a
 *  page was left out, and a header line telling the model what it is looking
 *  at. One slot per attached page — which is why slotAtOffset and
 *  charCitationsToQuotes below did not have to learn about blocks. */
export function buildExcerptDocument(
  blocks: DocBlock[],
  selected: number[],
  pageLabel: string,
  header: string
): AiDocument {
  let text = header ? `${header}\n\n` : ''
  const pageStarts: number[] = []
  const pageNumbers: number[] = []
  let prev = -1
  for (const i of selected) {
    const b = blocks[i]
    if (prev < 0 || blocks[prev].page !== b.page) {
      if (prev >= 0) text += '\n\n'
      text += `[${pageLabel} ${b.page + 1}]\n`
      pageStarts.push(text.length)
      pageNumbers.push(b.page + 1)
    } else {
      // Consecutive block indices means nothing was skipped between them (only
      // whitespace, which the newline stands in for); a jump means a stretch
      // of this page was left out, and the reader — and the model — is told.
      text += i === prev + 1 ? '\n' : `\n${EXCERPT_GAP}\n`
    }
    text += b.text
    prev = i
  }
  return { text, pageStarts, pageNumbers }
}

/** Slot whose range contains `offset` (offsets before the first start — the
 *  header or the first marker — clamp to slot 0) */
export function slotAtOffset(pageStarts: number[], offset: number): number {
  for (let i = pageStarts.length - 1; i >= 0; i--) {
    if (offset >= pageStarts[i]) return i
  }
  return 0
}

/** Longest run of `s` between gap markers, trimmed. A cited span that crossed
 *  an omitted stretch would otherwise claim a passage in an order no page
 *  contains; the longest side of the gap is the part actually worth locating. */
function longestUngapped(s: string): string {
  return s
    .split(EXCERPT_GAP)
    .map((part) => part.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), '')
}

/** Rewrite char-offset citations (Anthropic char_location) into quote
 *  citations with REAL page numbers, using the excerpt doc the request
 *  actually attached. Char offsets are only meaningful against that exact
 *  text — an excerpt is rebuilt per question, so offsets must be resolved
 *  NOW, not against whatever document a later click resolves with. Quote
 *  citations then flow through the existing locate machinery unchanged.
 *  No-op for full documents (no pageNumbers). */
export function charCitationsToQuotes(parts: AiContentPart[], doc: AiDocument): AiContentPart[] {
  const pageNumbers = doc.pageNumbers
  if (!pageNumbers) return parts
  return parts.map((part) => ({
    ...part,
    citations: part.citations.map((c) => {
      if (c.kind !== 'char') return c
      const slot = slotAtOffset(doc.pageStarts, c.start)
      // Clamp the cited span to its slot: a span crossing into the next page
      // marker would otherwise carry marker text no page contains. The next
      // slot's marker is the last line before its pageStart (builder writes
      // "...content\n\n[Label N]\ncontent..."), so the newline preceding that
      // line bounds this slot's content.
      const slotEnd =
        slot + 1 < doc.pageStarts.length
          ? doc.text.lastIndexOf('\n', doc.pageStarts[slot + 1] - 2)
          : doc.text.length
      const start = Math.max(c.start, doc.pageStarts[slot])
      const end = Math.min(c.end, slotEnd)
      const quote = longestUngapped(doc.text.slice(start, end))
      return {
        kind: 'quote' as const,
        pageNumber: pageNumbers[slot],
        // A degenerate clamp (span entirely inside a marker/header) falls
        // back to the provider's cited text so the chip is never empty
        quote: quote.length >= 3 ? quote : c.citedText
      }
    })
  }))
}

// Excerpt retrieval for documents larger than the model's context window.
//
// The assistant's design is full-document-plus-prompt-cache: every request
// attaches the whole text, follow-ups read it from cache, and citations stay
// anchored in text the model actually saw. That design has a hard ceiling —
// the model's context window — and this module is what happens above it:
// score the pages against the question (BM25), attach the best ones with
// their REAL page markers, and tell the model it is reading an excerpt.
// Below the ceiling nothing here runs; see prepareDocumentForRequest in ai.ts.
//
// Deliberately lexical, not embeddings: Anthropic has no embeddings endpoint
// (an embeddings path would exist only for OpenAI keys, splitting platform
// behavior), and an excerpt fills most of the window anyway — recall in bulk,
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

/** Whether a document of `docChars` fits a `contextTokens` window with room
 *  for everything else a request carries. */
export function documentFits(docChars: number, contextTokens: number): boolean {
  return estimateTokens(docChars) <= contextTokens - CONTEXT_RESERVE_TOKENS
}

/** Char budget for the excerpt when the full text does not fit */
export function excerptCharBudget(contextTokens: number): number {
  return Math.floor((contextTokens - CONTEXT_RESERVE_TOKENS) * EXCERPT_BUDGET_SHARE * CHARS_PER_TOKEN)
}

// ---------- BM25 over pages ----------

// Classic Okapi BM25 (the pre-neural search-engine ranking): term frequency
// with diminishing returns, rare terms weighted up (IDF), long pages deflated.
// Academic terminology is precise and concentrated, which is exactly the
// distribution this scores well.

const BM25_K1 = 1.2
const BM25_B = 0.75

export interface Bm25Index {
  /** term -> occurrences, per page */
  termFreq: Map<string, number>[]
  /** term -> number of pages containing it */
  docFreq: Map<string, number>
  /** tokens per page */
  lengths: number[]
  avgLength: number
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function buildBm25Index(pageTexts: string[]): Bm25Index {
  const termFreq: Map<string, number>[] = []
  const docFreq = new Map<string, number>()
  const lengths: number[] = []
  for (const text of pageTexts) {
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

/** BM25 score of every page against `query` (0 = no informative term matches) */
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

// ---------- Page selection ----------

/** Per-page overhead in the joined document: "[Side NNN]\n" + "\n\n" joiner */
const PAGE_OVERHEAD_CHARS = 16

/** Pick the pages to attach for `query` within `budgetChars`, 0-based and
 *  ascending. Always tries the front pages (title/abstract/introduction) and
 *  the tail (references/conclusion) first, then the best-scoring pages with
 *  their neighbours; whatever budget remains is spread evenly across the
 *  uncovered stretch so a query-less request (e.g. the summary preset) still
 *  sees the whole document's shape rather than one dense cluster. */
export function selectExcerptPages(
  pageTexts: string[],
  query: string,
  budgetChars: number,
  index?: Bm25Index
): number[] {
  const n = pageTexts.length
  if (n === 0) return []
  const included = new Set<number>()
  let spent = 0
  const cost = (i: number): number => pageTexts[i].length + PAGE_OVERHEAD_CHARS
  const tryAdd = (i: number): boolean => {
    if (i < 0 || i >= n || included.has(i)) return false
    if (spent + cost(i) > budgetChars) return false
    included.add(i)
    spent += cost(i)
    return true
  }

  // Front matter and tail: the pages nearly every question benefits from
  for (const i of [0, 1, 2, n - 1, n - 2]) tryAdd(i)

  // Best-scoring pages, each with its neighbours (arguments rarely respect
  // page breaks), greedily until the ranked list or the budget runs out
  const scores = bm25Scores(index ?? buildBm25Index(pageTexts), query)
  const ranked = scores
    .map((score, i) => ({ score, i }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
  for (const { i } of ranked) {
    if (budgetChars - spent < 200) break
    tryAdd(i)
    tryAdd(i - 1)
    tryAdd(i + 1)
  }

  // Spread the remainder evenly over what is still uncovered
  const uncovered = (): number[] => {
    const out: number[] = []
    for (let i = 0; i < n; i++) if (!included.has(i)) out.push(i)
    return out
  }
  const avgCost = (pageTexts.reduce((a, t) => a + t.length, 0) / n) + PAGE_OVERHEAD_CHARS
  let slots = Math.floor((budgetChars - spent) / Math.max(1, avgCost))
  while (slots > 0) {
    const rest = uncovered()
    if (rest.length === 0) break
    // ceil: never more candidates than slots, so one pass covers the whole
    // uncovered span instead of exhausting the budget on its front half
    const stride = Math.max(1, Math.ceil(rest.length / slots))
    let added = false
    for (let k = 0; k < rest.length; k += stride) added = tryAdd(rest[k]) || added
    if (!added) break // every remaining page is over budget
    slots = Math.floor((budgetChars - spent) / Math.max(1, avgCost))
  }

  // A window too small for even one page still has to attach something: the
  // best-scoring page (or the first) alone, and the estimate slack absorbs it.
  if (included.size === 0) included.add(ranked[0]?.i ?? 0)

  return [...included].sort((a, b) => a - b)
}

// ---------- Excerpt document ----------

/** Join the selected pages exactly like buildAiDocument does for the full
 *  text, but with each page's REAL number in its marker (so the citation
 *  contract and the click-to-jump resolution keep working) and a header line
 *  telling the model what it is looking at. */
export function buildExcerptDocument(
  pageTexts: string[],
  pageIndices: number[],
  pageLabel: string,
  header: string
): AiDocument {
  let text = header ? `${header}\n\n` : ''
  const pageStarts: number[] = []
  const pageNumbers: number[] = []
  for (let k = 0; k < pageIndices.length; k++) {
    const i = pageIndices[k]
    text += `[${pageLabel} ${i + 1}]\n`
    pageStarts.push(text.length)
    text += pageTexts[i]
    if (k < pageIndices.length - 1) text += '\n\n'
    pageNumbers.push(i + 1)
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
      const quote = doc.text.slice(start, end).trim()
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

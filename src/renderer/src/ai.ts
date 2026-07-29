// Renderer-side AI helpers: document text assembly for the API, mapping
// citations back to page positions, and token accounting.
import type { AiCitation, AiProviderId, AiUsage } from '../../shared/types'
import { getLanguage } from './i18n'
import type { PageText } from './search'
import type { AiDocument, Bm25Index } from './ai-retrieval'
import {
  buildBm25Index,
  buildExcerptDocument,
  documentFits,
  excerptCharBudget,
  selectExcerptPages,
  slotAtOffset
} from './ai-retrieval'
import { contextTokensFor } from './components/ai-models'

// The interface lives in ai-retrieval.ts (a pure module the node test can
// import); everything renderer-side keeps importing it from here.
export type { AiDocument } from './ai-retrieval'

// Shared request-id counter for ALL renderer callers of ai:chat (chat panel,
// quick popover, semantic search). The main process keys in-flight requests
// by id, so every caller must draw from one sequence to avoid collisions.
let aiRequestCounter = 1
export const nextAiRequestId = (): number => aiRequestCounter++

/** Page markers let prompt-contract providers (OpenAI/Azure) name page
 *  numbers; Anthropic citations use raw char offsets which we map ourselves.
 *  Offsets are derived from the marker as written, so the localized label is
 *  safe — the built document is cached together with its pageStarts. */
export function buildAiDocument(pages: PageText[]): AiDocument {
  const label = getLanguage() === 'nb' ? 'Side' : 'Page'
  let text = ''
  const pageStarts: number[] = []
  for (let i = 0; i < pages.length; i++) {
    text += `[${label} ${i + 1}]\n`
    pageStarts.push(text.length)
    text += pages[i].text
    if (i < pages.length - 1) text += '\n\n'
  }
  return { text, pageStarts }
}

/** What a request should attach for this document and question.
 *  `excerpt` is null when the full document fits the model's window — the
 *  everyday path, byte-identical to before so the prompt cache keeps working.
 *  Above the window it is the excerpt metadata for the transparency chip, and
 *  `doc` is the BM25-selected excerpt this SPECIFIC request attached — char
 *  citations in the answer are only meaningful against exactly that text, so
 *  resolve them against it at receive time (charCitationsToQuotes). */
export interface PreparedDocument {
  doc: AiDocument
  excerpt: { included: number; total: number } | null
}

// The tokenized index is query-independent; keyed on the pages array itself
// (stable via pageTextsRef) so follow-up questions on the same huge document
// pay the tokenization cost once.
const bm25IndexCache = new WeakMap<PageText[], Bm25Index>()

export function prepareDocumentForRequest(
  ensured: { pages: PageText[]; doc: AiDocument },
  provider: AiProviderId,
  modelId: string,
  queryText: string
): PreparedDocument {
  const contextTokens = contextTokensFor(provider, modelId)
  if (documentFits(ensured.doc.text.length, contextTokens)) {
    return { doc: ensured.doc, excerpt: null }
  }
  const texts = ensured.pages.map((p) => p.text)
  let index = bm25IndexCache.get(ensured.pages)
  if (!index) {
    index = buildBm25Index(texts)
    bm25IndexCache.set(ensured.pages, index)
  }
  const indices = selectExcerptPages(texts, queryText, excerptCharBudget(contextTokens), index)
  const nb = getLanguage() === 'nb'
  const header = nb
    ? `[Utdrag: ${indices.length} av ${texts.length} sider vedlagt — resten er utelatt]`
    : `[Excerpt: ${indices.length} of ${texts.length} pages attached — the rest is omitted]`
  return {
    doc: buildExcerptDocument(texts, indices, nb ? 'Side' : 'Page', header),
    excerpt: { included: indices.length, total: texts.length }
  }
}

/** System-prompt companion for excerpt mode. English on purpose — model-facing
 *  instructions stay English for both UI languages (same rule as the quote
 *  contract in shared/ai-chat.ts). */
export function excerptSystemNote(): string {
  return `

EXCERPT MODE
- This document is larger than your context window, so only the most relevant pages are attached (selected by text search against the user's question), each under its original page marker. Where other instructions say the full document text is attached, read "the attached excerpt" instead.
- The pages between the attached ones are missing. If the excerpt does not answer the question, say that the relevant part of the document may not be attached — never conclude that the document lacks something from the excerpt alone.`
}

export interface ResolvedCitation {
  pageNumber: number
  /** Offsets within that page's PageText.text */
  start: number
  end: number
}

/** Map a normalized citation to a page + in-page char range, or null when it
 *  cannot be located (e.g. hallucinated quote, offsets inside a page marker). */
export function resolveCitation(
  citation: AiCitation,
  pages: PageText[],
  doc: AiDocument
): ResolvedCitation | null {
  // Web citations point outside the document — opened externally, never resolved
  if (citation.kind === 'web') return null
  if (citation.kind === 'quote') {
    const pageIndex = citation.pageNumber - 1
    if (pageIndex < 0 || pageIndex >= pages.length) return null
    // Models are usually right about the page but "verbatim" quotes get
    // normalized (curly quotes, collapsed breaks, expanded ligatures),
    // truncated with an ellipsis, or land one page off (the page-marker
    // offset, or a passage straddling a page break). Try progressively
    // looser anchors — cited page first, then neighbours — and give up
    // rather than guess: every fallback match must be UNIQUE on its page,
    // so a miss degrades to the page jump, never to a wrong highlight.
    const candidates = [pageIndex, pageIndex - 1, pageIndex + 1].filter(
      (i) => i >= 0 && i < pages.length
    )
    for (const pi of candidates) {
      const hit = locateQuote(citation.quote, pages[pi].text, pi !== pageIndex)
      if (hit) return { pageNumber: pi + 1, ...hit }
    }
    for (const needle of fallbackNeedles(citation.quote)) {
      for (const pi of candidates) {
        const hit = locateQuote(needle, pages[pi].text, true)
        if (hit) return { pageNumber: pi + 1, ...hit }
      }
    }
    return null
  }
  // char kind: find the slot whose range contains the citation start (offsets
  // inside the leading "[Side 1]" marker clamp to the first slot), then map
  // slot → real page (identity on full documents, pageNumbers on excerpts —
  // a slot's text IS its page's text, so in-page offsets carry over as-is).
  const slot = slotAtOffset(doc.pageStarts, citation.start)
  const pageIndex = (doc.pageNumbers?.[slot] ?? slot + 1) - 1
  if (pageIndex < 0 || pageIndex >= pages.length) return null
  const pageLen = pages[pageIndex].text.length
  const start = citation.start - doc.pageStarts[slot]
  const end = Math.min(citation.end - doc.pageStarts[slot], pageLen)
  if (start >= pageLen || end <= 0 || end <= start) return null
  return { pageNumber: pageIndex + 1, start: Math.max(0, start), end }
}

/** Locate `quote` in `pageText`: exact case-insensitive first, then on the
 *  normalized copy with offsets mapped back to the original text. With
 *  `requireUnique`, a needle that occurs more than once on the page is
 *  rejected — used for every anchor except the full quote on its cited page,
 *  so fallbacks can never highlight the wrong occurrence. */
function locateQuote(
  quote: string,
  pageText: string,
  requireUnique: boolean
): { start: number; end: number } | null {
  const lower = pageText.toLowerCase()
  const q = quote.toLowerCase()
  const exact = lower.indexOf(q)
  if (exact !== -1 && (!requireUnique || lower.indexOf(q, exact + 1) === -1)) {
    return { start: exact, end: exact + quote.length }
  }
  const { norm, map } = normalizeWithMap(pageText)
  const needle = normalizeNeedle(quote)
  if (needle.length < 3) return null
  const at = norm.indexOf(needle)
  if (at === -1) return null
  if (requireUnique && norm.indexOf(needle, at + 1) !== -1) return null
  return { start: map[at], end: map[at + needle.length - 1] + 1 }
}

/** Looser anchors for a quote that failed as a whole, strongest first: the
 *  longest verbatim segment of an ellipsis-shortened quote, then a prefix or
 *  suffix slice for quotes whose other end the model paraphrased. All of
 *  them are matched with the uniqueness requirement. */
function fallbackNeedles(quote: string): string[] {
  const out: string[] = []
  // "start … end" — the segments are still claimed verbatim by the model;
  // try all of them, longest (most specific) first
  const segments = quote.split(/\s*(?:\.{3,}|…|\[…\]|\[\.{3}\])\s*/)
  if (segments.length > 1) {
    out.push(
      ...segments
        .map((s) => s.trim())
        .filter((s) => normalizeNeedle(s).length >= 12)
        .sort((a, b) => b.length - a.length)
    )
  }
  // Head/tail anchors only for quotes long enough that a 64-char slice is a
  // genuinely partial (and plausibly unique) anchor
  if (normalizeNeedle(quote).length >= 48) {
    const head = quote.slice(0, 64).replace(/\S+$/, '').trim()
    const tail = quote.slice(-64).replace(/^\S+/, '').trim()
    if (normalizeNeedle(head).length >= 24) out.push(head)
    if (normalizeNeedle(tail).length >= 24) out.push(tail)
  }
  return out
}

/** Quote-side normalization: same folds as the page text, no map needed */
function normalizeNeedle(s: string): string {
  let folded = foldChars(s).toLowerCase()
  for (const [lig, expansion] of Object.entries(LIGATURES)) {
    folded = folded.replaceAll(lig, expansion)
  }
  return folded.replace(/\s+/g, ' ').trim()
}

/** Single-glyph ligatures PDF text layers expose where models write the
 *  expanded letters (LaTeX PDFs are full of ﬁ/ﬀ/ﬃ) */
const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'ft',
  'ﬆ': 'st'
}

/** 1:1 char folds so normalized offsets map back to the original text */
function foldChars(s: string): string {
  return s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‐‑–—]/g, '-')
    .replace(/ /g, ' ')
}

/** Lowercased, soft-hyphen-stripped, whitespace-collapsed copy of `text`
 *  with ligatures expanded and end-of-line hyphenation joined, plus
 *  map[i] = offset in the original text of normalized char i (ligature
 *  expansions repeat the ligature's offset). */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  const folded = foldChars(text).toLowerCase()
  let norm = ''
  const map: number[] = []
  let pendingSpace = false
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i]
    if (ch === '­') continue // soft hyphen
    // End-of-line hyphenation: "effi-\ncient" → "efficient". Only join when
    // the hyphen sits directly before a line break and the continuation
    // starts with a lowercase letter (checked on the ORIGINAL text — folded
    // is lowercased) — a dash before "The" is punctuation, not hyphenation.
    if (ch === '-' && folded[i + 1] === '\n') {
      let j = i + 1
      while (j < folded.length && /\s/.test(folded[j])) j++
      if (j < folded.length && /\p{Ll}/u.test(text[j])) {
        i = j - 1 // skip the hyphen and the break; no space is inserted
        continue
      }
    }
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0
      continue
    }
    if (pendingSpace) {
      norm += ' '
      map.push(i)
      pendingSpace = false
    }
    const expansion = LIGATURES[ch]
    if (expansion) {
      for (const c of expansion) {
        norm += c
        map.push(i)
      }
    } else {
      norm += ch
      map.push(i)
    }
  }
  return { norm, map }
}

/** Page number a citation points at (for chip labels), best effort */
export function citationPage(citation: AiCitation, doc: AiDocument | null): number | null {
  if (citation.kind === 'web') return null
  if (citation.kind === 'quote') return citation.pageNumber
  if (!doc || doc.pageStarts.length === 0) return null
  const slot = slotAtOffset(doc.pageStarts, citation.start)
  return doc.pageNumbers?.[slot] ?? slot + 1
}

// ---------- Usage ----------

/**
 * Tokens, not money. A price table hardcoded into a shipped app is a promise
 * the app cannot keep: providers change list prices whenever they like, a new
 * model can match an old pattern at a new rate, and a number the user reads as
 * "what this cost" would quietly drift from what they are actually billed. Only
 * the provider knows the price, and the app is not in that loop at all.
 *
 * Token counts come from the provider's own response, so they never go stale —
 * and they are the input to the two things that actually protect a reader: a
 * spending cap on the key, and the usage page in the provider's console. Both
 * are linked from the key settings.
 */
export function formatTokens(usage: AiUsage): string {
  const inTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return `${inTokens.toLocaleString()}→${usage.outputTokens.toLocaleString()} tokens`
}

// ---------- Prompts (follow the app language) ----------

export function chatSystem(): string {
  if (getLanguage() === 'nb') {
    return `Du er forskningsassistenten i PDF-leseren PDF Scholar. Du svarer i et smalt sidepanel ved siden av et dokument brukeren leser akkurat nå (typisk en forskningsartikkel eller rapport). Hele dokumentteksten er vedlagt med sidemarkører.

STIL
- Svar kort som standard: 2–6 setninger. Bruk lister, overskrifter eller lengre format bare når brukeren ber om dybde, struktur eller sammendrag.
- Akademisk nøkternt: ingen småprat, ikke gjenta spørsmålet, ingen avsluttende tilbud om mer hjelp.
- Panelet er smalt — foretrekk kompakt prosa fremfor brede tabeller.
- Svar på språket brukeren skriver på.

KILDEFORANKRING
- Bygg svarene på dokumentet og siter passasjen for hvert vesentlige poeng, slik at brukeren kan hoppe dit i PDF-en.
- Skill eksplisitt mellom hva dokumentet sier og din egen vurdering eller bakgrunnskunnskap (f.eks. «Artikkelen oppgir … Utover dokumentet: …»).
- Hvis dokumentet ikke besvarer spørsmålet, si det rett ut i stedet for å gjette. Finn aldri på sitater, tall eller referanser.`
  }
  return `You are the research assistant in the PDF reader PDF Scholar. You answer in a narrow side panel next to a document the user is reading right now (typically a research article or report). The full document text is attached with page markers.

STYLE
- Default to short answers: 2–6 sentences. Use lists, headings or longer form only when the user asks for depth, structure or a summary.
- Academically sober: no small talk, do not restate the question, no closing offers of further help.
- The panel is narrow — prefer compact prose over wide tables.
- Answer in the language the user writes in.

GROUNDING
- Base answers on the document and cite the passage for every substantive point, so the user can jump there in the PDF.
- Explicitly separate what the document says from your own assessment or background knowledge (e.g. "The paper reports … Beyond the document: …").
- If the document does not answer the question, say so plainly instead of guessing. Never invent quotes, numbers or references.`
}

/**
 * Replaces the "the full document text is attached" premise when it is false: a
 * scanned PDF has no text layer, so the only thing the model can see is the page
 * images the reader chose to attach. It has to know that, or it answers about the
 * rest of the document from the title and its own priors — the exact failure the
 * no-text notice exists to prevent.
 */
export function scannedPagesNote(pages: number[]): string {
  const list = pages.join(', ')
  if (getLanguage() === 'nb') {
    return `

SKANNET DOKUMENT
- Dette dokumentet har ikke tekstlag. Ingen dokumenttekst er vedlagt — det eneste du kan se, er de vedlagte sidebildene (side ${list}).
- Les det som står på bildene. Vis til sidetall (f.eks. «på side 7»); ordrette [KILDE …]-sitater er ikke mulig her.
- Hvis svaret ville krevd andre sider enn de vedlagte, si det og be brukeren legge ved de sidene. Gjett aldri på innholdet i sider du ikke ser.`
  }
  return `

SCANNED DOCUMENT
- This document has no text layer. No document text is attached — all you can see is the attached page images (page ${list}).
- Read what is on the images. Refer to page numbers (e.g. "on page 7"); verbatim [KILDE …] citations are not possible here.
- If the answer would need pages other than the attached ones, say so and ask the reader to attach them. Never guess at the contents of pages you cannot see.`
}

export function explainSystem(mode: 'explain' | 'simplify'): string {
  if (getLanguage() === 'nb') {
    const task =
      mode === 'explain'
        ? 'Forklar den utvalgte passasjen: pakk ut hva den faktisk hevder, og hvorfor den står akkurat her i dokumentet (rollen i resonnementet). Ikke bare parafraser den.'
        : 'Skriv den utvalgte teksten om med enklere ord og kortere setninger, med samme meningsinnhold og presisjon. Lever bare den omskrevne teksten – ingen kommentar om hva du endret.'
    return `Du hjelper en leser i PDF-leseren PDF Scholar. ${task} Svar kort (2–6 setninger), på norsk bokmål, uten innledning eller oppsummering. Bruk konteksten fra siden når det trengs.`
  }
  const task =
    mode === 'explain'
      ? 'Explain the selected passage: unpack what it actually claims, and why it appears at this exact point in the document (its role in the argument). Do not merely paraphrase it.'
      : 'Rewrite the selected text in plainer words and shorter sentences, preserving the meaning and precision. Return only the rewritten text — no commentary on what you changed.'
  return `You are helping a reader in the PDF reader PDF Scholar. ${task} Answer briefly (2–6 sentences), in English, with no preamble or summary. Use the page context when needed.`
}

/** Free-form question about the selection. The whole document is attached by
 *  the pipeline (like reference lookup) so the answer can draw on the full
 *  paper, not just the page. */
export function askSystem(): string {
  if (getLanguage() === 'nb') {
    return `Du er forskningsassistenten i PDF-leseren PDF Scholar. Brukeren har markert en passasje i et dokument de leser og stiller et eget spørsmål om den. Hele dokumentteksten er vedlagt med sidemarkører.

- Svar kort (2–6 setninger), uten innledning eller oppsummering, på språket spørsmålet er stilt på.
- Bygg svaret på dokumentet og siter passasjen for hvert vesentlige poeng, slik at brukeren kan hoppe dit i PDF-en.
- Skill eksplisitt mellom hva dokumentet sier og din egen vurdering eller bakgrunnskunnskap.
- Hvis dokumentet ikke besvarer spørsmålet, si det rett ut i stedet for å gjette. Finn aldri på sitater, tall eller referanser.`
  }
  return `You are the research assistant in the PDF reader PDF Scholar. The user has selected a passage in a document they are reading and asks their own question about it. The full document text is attached with page markers.

- Answer briefly (2–6 sentences), with no preamble or summary, in the language the question is asked in.
- Base the answer on the document and cite the passage for every substantive point, so the user can jump there in the PDF.
- Explicitly separate what the document says from your own assessment or background knowledge.
- If the document does not answer the question, say so plainly instead of guessing. Never invent quotes, numbers or references.`
}

/** Methodological critique of the selected claim/passage. The whole document
 *  is attached by the pipeline — the identification strategy, data and
 *  caveats usually live elsewhere in the paper. */
export function critiqueSystem(): string {
  if (getLanguage() === 'nb') {
    return `Du er forskningsassistenten i PDF-leseren PDF Scholar. Brukeren har markert en påstand eller passasje i et dokument de leser og vil ha et kritisk-metodisk blikk på den. Hele dokumentteksten er vedlagt med sidemarkører.

Svar i tre korte deler, på norsk bokmål:

1. **Hva påstanden hviler på** – hvilken metode, hvilke data eller hvilke antakelser i dokumentet som bærer akkurat dette. Siter passasjene.
2. **Viktigste forbehold** – 1–2 svakheter eller betingelser som begrenser hvor langt påstanden rekker (gjerne slike dokumentet selv nevner; skill i så fall mellom dokumentets egne forbehold og dine).
3. **Hva en fagfelle ville spurt om** – ett skarpt oppfølgingsspørsmål.

Vær nøktern og konkret; ingen generiske innvendinger som kunne stått til enhver tekst. Skill eksplisitt mellom hva dokumentet sier og din egen vurdering. Hold hele svaret under ca. 130 ord.`
  }
  return `You are the research assistant in the PDF reader PDF Scholar. The user has selected a claim or passage in a document they are reading and wants a critical, methodological look at it. The full document text is attached with page markers.

Answer in three short parts, in English:

1. **What the claim rests on** – which method, data or assumptions in the document carry this exact claim. Cite the passages.
2. **Key caveats** – 1–2 weaknesses or conditions that limit how far the claim reaches (preferably ones the document itself notes; if so, separate the document's own caveats from yours).
3. **What a referee would ask** – one sharp follow-up question.

Be sober and concrete; no generic objections that could apply to any text. Explicitly separate what the document says from your own assessment. Keep the whole answer under about 130 words.`
}

/** Explain a snipped page region (figure/table/equation) sent as an image.
 *  Vision does the reading; the page text rides along as context since axis
 *  labels and captions often live in the text layer too. */
export function figureSystem(): string {
  if (getLanguage() === 'nb') {
    return `Du er forskningsassistenten i PDF-leseren PDF Scholar. Brukeren har markert et område på en side i et dokument de leser – typisk en figur, tabell eller formel – og det er vedlagt som bilde, sammen med tekstkonteksten fra siden.

- Si først i én setning hva utsnittet er (f.eks. «Et spredningsplott av … mot …»).
- Forklar deretter hva det viser og hva som er hovedbudskapet – aksene/kolonnene, mønsteret som betyr noe, og hvordan det knytter an til teksten rundt.
- Les tall og etiketter fra bildet forsiktig; er noe uleselig, si det i stedet for å gjette.
- Svar kort (3–8 setninger), på norsk bokmål, uten innledning eller oppsummering.`
  }
  return `You are the research assistant in the PDF reader PDF Scholar. The user has marked a region on a page in a document they are reading – typically a figure, table or equation – and it is attached as an image, together with the text context from the page.

- First say in one sentence what the snippet is (e.g. "A scatter plot of … against …").
- Then explain what it shows and what the main message is – the axes/columns, the pattern that matters, and how it connects to the surrounding text.
- Read numbers and labels from the image carefully; if something is illegible, say so instead of guessing.
- Answer briefly (3–8 sentences), in English, with no preamble or summary.`
}

/** User-message scaffold for the figure snip (the image itself is attached
 *  on the message via AiMessage.images) */
export function figureUserMessage(pageNumber: number, pageContext: string): string {
  return getLanguage() === 'nb'
    ? `Utsnittet er fra side ${pageNumber} (vedlagt som bilde).\n\nKontekst fra siden:\n${pageContext}`
    : `The snippet is from page ${pageNumber} (attached as an image).\n\nContext from the page:\n${pageContext}`
}

/** User-message scaffold for a free-form question about the selection */
export function askUserMessage(
  question: string,
  selection: string,
  pageNumber: number,
  pageContext: string
): string {
  return getLanguage() === 'nb'
    ? `Spørsmål: ${question}\n\nMarkert tekst (fra side ${pageNumber}):\n«${selection}»\n\nKontekst fra siden:\n${pageContext}`
    : `Question: ${question}\n\nSelected text (from page ${pageNumber}):\n"${selection}"\n\nContext from the page:\n${pageContext}`
}

/** User-message scaffold for the explain-selection popover */
export function explainUserMessage(selection: string, pageNumber: number, pageContext: string): string {
  return getLanguage() === 'nb'
    ? `Utvalgt tekst (fra side ${pageNumber}):\n«${selection}»\n\nKontekst fra siden:\n${pageContext}`
    : `Selected text (from page ${pageNumber}):\n"${selection}"\n\nContext from the page:\n${pageContext}`
}

/** Reference lookup: the whole document is attached by the pipeline, so the
 *  model can find the bibliography entry itself. Epistemic marking is the
 *  point — never let it invent findings for a work it doesn't recognise. */
export function referenceSystem(): string {
  if (getLanguage() === 'nb') {
    return `Du er referanseassistenten i PDF-leseren PDF Scholar. Brukeren har markert en litteraturhenvisning i et dokument de leser. Hele dokumentteksten er vedlagt med sidemarkører; bruk den til å finne referanselisten og konteksten rundt siteringen.

Svar i tre korte deler, på norsk bokmål:

1. **Referansen** – gjengi den fullstendige oppføringen fra dokumentets referanseliste. Finner du den ikke der, si det eksplisitt.
2. **Hvorfor den siteres her** – 1–2 setninger basert på teksten rundt siteringen: hvilken påstand, metode eller premiss henvisningen underbygger på akkurat dette stedet. Siter passasjen.
3. **Om verket** – maks 2–3 setninger, med eksplisitt epistemisk merking av hver opplysning:
   - «Ifølge dokumentet: …» for alt som er hentet fra dokumentet selv.
   - «Fra treningen min (kan være upresist): …» for bakgrunnskunnskap om verket – men BARE hvis du genuint gjenkjenner dette spesifikke verket (forfatter, årstall og tittel stemmer med noe du kjenner). At du kjenner forfatternavnet er IKKE nok.
   - Kjenner du ikke verket, si det rett ut («Jeg kjenner ikke dette verket») og hold deg til det referanselisten og konteksten sier. Gjett aldri på funn, tidsskrift eller innhold.

Hold hele svaret under ca. 120 ord.`
  }
  return `You are the reference assistant in the PDF reader PDF Scholar. The user has selected a literature citation in a document they are reading. The full document text is attached with page markers; use it to find the reference list and the context around the citation.

Answer in three short parts, in English:

1. **The reference** – reproduce the complete entry from the document's reference list. If you cannot find it there, say so explicitly.
2. **Why it is cited here** – 1–2 sentences based on the text around the citation: which claim, method or premise the reference supports at this exact spot. Quote the passage.
3. **About the work** – at most 2–3 sentences, with explicit epistemic marking of every statement:
   - "According to the document: …" for anything taken from the document itself.
   - "From my training (may be imprecise): …" for background knowledge about the work – but ONLY if you genuinely recognise this specific work (author, year and title match something you know). Knowing the author's name is NOT enough.
   - If you do not know the work, say so plainly ("I don't know this work") and stick to what the reference list and context say. Never guess at findings, journal or content.

Keep the whole answer under about 120 words.`
}

/** Semantic search: keep the system prompt = chatSystem() so the Anthropic
 *  document block (with ephemeral cache_control) is byte-identical to the chat
 *  panel and the cache is shared. The search-specific instruction lives ONLY
 *  in the user message. QUOTE_CONTRACT (added by main for OpenAI/Azure) and
 *  Anthropic native citations both come back as AiCitation. */
export function semanticSearchPrompt(query: string): string {
  if (getLanguage() === 'nb') {
    return `Finn de 3–8 stedene i dokumentet som best omtaler dette temaet: «${query}»

Svar KUN med en nummerert liste, uten innledning eller avslutning. Hvert punkt: én kort beskrivelse (maks 15 ord) av hva stedet sier, med et kort ordrett sitat (10–30 ord) fra passasjen som kilde. Ranger etter relevans. Hvis dokumentet ikke omtaler temaet, si det i én setning uten liste.`
  }
  return `Find the 3–8 passages in the document that best discuss this topic: "${query}"

Answer ONLY with a numbered list, no preamble or closing. Each item: one short description (max 15 words) of what the passage says, citing a short verbatim quote (10–30 words) from the passage as the source. Rank by relevance. If the document does not discuss the topic, say so in one sentence with no list.`
}

/** User-message scaffold for reference lookup */
export function referenceUserMessage(selection: string, pageNumber: number, pageContext: string): string {
  return getLanguage() === 'nb'
    ? `Markert henvisning (side ${pageNumber}):\n«${selection}»\n\nTekst rundt henvisningen:\n${pageContext}`
    : `Selected citation (page ${pageNumber}):\n"${selection}"\n\nText around the citation:\n${pageContext}`
}

/** Default (editable) question for the annotations flow — prefilled in the
 *  composer so the user sees and can rephrase what will be asked. */
export function annotationsDefaultQuestion(): string {
  return getLanguage() === 'nb'
    ? 'Oppsummer hva jeg har vært opptatt av i merknadene mine, grupper gjerne etter tema, og pek på punkter det ser ut som jeg bør følge opp. Bruk dokumentet for kontekst der det trengs.'
    : 'Summarize what I have been focusing on in my annotations, group by theme where natural, and point out items I appear to need to follow up on. Use the document for context where needed.'
}

/** Full user message for "ask my annotations": the (possibly user-edited)
 *  question plus the annotations block. The block lists the user's own
 *  highlights/notes; keeping it inside the user message means follow-up
 *  questions retain it via the chat history. */
export function annotationsQuestion(question: string, block: string): string {
  const intro =
    getLanguage() === 'nb'
      ? 'Merknadene mine i dokumentet (markeringer, understrekinger og notater, med sidetall):'
      : 'My annotations in the document (highlights, underlines and notes, with page numbers):'
  return `${question.trim()}\n\n${intro}\n${block}`
}

/** The structured-article-summary request (sent through the normal chat
 *  pipeline so streaming and citation chips come for free) */
export function summaryPrompt(): string {
  if (getLanguage() === 'nb') {
    return `Lag et strukturert sammendrag av dokumentet med disse delene som overskrifter (#### Overskrift):

#### Forskningsspørsmål
#### Metode og identifikasjonsstrategi
#### Data
#### Hovedfunn
#### Bidrag
#### Begrensninger

Hold hver del til 1–4 setninger og siter kilden for hvert vesentlige punkt. Hvis dokumentet ikke er en empirisk forskningsartikkel, tilpass delene til dokumenttypen (f.eks. Problemstilling/Tilnærming/Konklusjoner for en rapport) og si kort fra om det.`
  }
  return `Write a structured summary of the document using these sections as headings (#### Heading):

#### Research question
#### Method and identification strategy
#### Data
#### Main findings
#### Contribution
#### Limitations

Keep each section to 1–4 sentences and cite the source for every substantive point. If the document is not an empirical research article, adapt the sections to the document type (e.g. Problem/Approach/Conclusions for a report) and briefly say so.`
}

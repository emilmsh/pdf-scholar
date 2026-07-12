// Renderer-side AI helpers: document text assembly for the API, mapping
// citations back to page positions, and cost estimation.
import type { AiCitation, AiUsage } from '../../shared/types'
import { getLanguage } from './i18n'
import type { PageText } from './search'

export interface AiDocument {
  /** All pages joined with blank lines, each prefixed with a page marker */
  text: string
  /** Char offset of each page's content within `text` (page i = index i) */
  pageStarts: number[]
}

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
  if (citation.kind === 'quote') {
    const pageIndex = citation.pageNumber - 1
    if (pageIndex < 0 || pageIndex >= pages.length) return null
    const pageText = pages[pageIndex].text
    // Fast path: exact, case-insensitive
    const exact = pageText.toLowerCase().indexOf(citation.quote.toLowerCase())
    if (exact !== -1) {
      return { pageNumber: citation.pageNumber, start: exact, end: exact + citation.quote.length }
    }
    // Robust path: models normalize "verbatim" quotes (curly quotes, collapsed
    // line breaks) while the PDF text has raw whitespace and soft hyphens —
    // match on a normalized copy and map offsets back to the original.
    const { norm, map } = normalizeWithMap(pageText)
    const needle = foldChars(citation.quote).replace(/\s+/g, ' ').trim().toLowerCase()
    if (needle.length < 3) return null
    const at = norm.indexOf(needle)
    if (at === -1) return null
    return { pageNumber: citation.pageNumber, start: map[at], end: map[at + needle.length - 1] + 1 }
  }
  // char kind: find the page whose range contains the citation start.
  // Offsets inside the leading "[Side 1]" marker clamp to the first page.
  let pageIndex = 0
  for (let i = doc.pageStarts.length - 1; i >= 0; i--) {
    if (citation.start >= doc.pageStarts[i]) {
      pageIndex = i
      break
    }
  }
  const pageLen = pages[pageIndex].text.length
  const start = citation.start - doc.pageStarts[pageIndex]
  const end = Math.min(citation.end - doc.pageStarts[pageIndex], pageLen)
  if (start >= pageLen || end <= 0 || end <= start) return null
  return { pageNumber: pageIndex + 1, start: Math.max(0, start), end }
}

/** 1:1 char folds so normalized offsets map back to the original text */
function foldChars(s: string): string {
  return s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‐‑–—]/g, '-')
    .replace(/ /g, ' ')
}

/** Lowercased, soft-hyphen-stripped, whitespace-collapsed copy of `text`,
 *  plus map[i] = offset in the original text of normalized char i. */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  const folded = foldChars(text).toLowerCase()
  let norm = ''
  const map: number[] = []
  let pendingSpace = false
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i]
    if (ch === '­') continue // soft hyphen
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0
      continue
    }
    if (pendingSpace) {
      norm += ' '
      map.push(i)
      pendingSpace = false
    }
    norm += ch
    map.push(i)
  }
  return { norm, map }
}

/** Page number a citation points at (for chip labels), best effort */
export function citationPage(citation: AiCitation, doc: AiDocument | null): number | null {
  if (citation.kind === 'quote') return citation.pageNumber
  if (!doc || doc.pageStarts.length === 0) return null
  for (let i = doc.pageStarts.length - 1; i >= 0; i--) {
    if (citation.start >= doc.pageStarts[i]) return i + 1
  }
  return 1
}

// ---------- Cost ----------

/** USD per MTok [input, output]; cache read = 0.1× input, write = 1.25× */
const PRICES: [RegExp, [number, number]][] = [
  [/fable|mythos/i, [10, 50]],
  [/opus/i, [5, 25]],
  [/sonnet/i, [3, 15]],
  [/haiku/i, [1, 5]],
  [/gpt-5/i, [1.25, 10]],
  [/gpt-4o/i, [2.5, 10]],
  [/mock/i, [0, 0]]
]

export function estimateCost(model: string, usage: AiUsage): number | null {
  const entry = PRICES.find(([re]) => re.test(model))
  if (!entry) return null
  const [inPrice, outPrice] = entry[1]
  return (
    (usage.inputTokens * inPrice +
      usage.outputTokens * outPrice +
      usage.cacheReadTokens * inPrice * 0.1 +
      usage.cacheWriteTokens * inPrice * 1.25) /
    1_000_000
  )
}

export function formatCost(dollars: number): string {
  if (dollars === 0) return '$0'
  if (dollars < 0.005) return '<$0.01'
  return `$${dollars.toFixed(2)}`
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

export function explainSystem(mode: 'explain' | 'simplify' | 'define'): string {
  if (getLanguage() === 'nb') {
    const task =
      mode === 'explain'
        ? 'Forklar den utvalgte passasjen: pakk ut hva den faktisk hevder, og hvorfor den står akkurat her i dokumentet (rollen i resonnementet). Ikke bare parafraser den.'
        : mode === 'simplify'
          ? 'Skriv den utvalgte teksten om med enklere ord og kortere setninger, med samme meningsinnhold og presisjon. Lever bare den omskrevne teksten – ingen kommentar om hva du endret.'
          : 'Gi én stram definisjon av begrepet/uttrykket slik det brukes akkurat her (fagfelt og kontekst tatt i betraktning). Nevn kort hvis bruken her avviker fra vanlig betydning. Ikke forklar resten av setningen.'
    return `Du hjelper en leser i PDF-leseren PDF Scholar. ${task} Svar kort (2–6 setninger), på norsk bokmål, uten innledning eller oppsummering. Bruk konteksten fra siden når det trengs.`
  }
  const task =
    mode === 'explain'
      ? 'Explain the selected passage: unpack what it actually claims, and why it appears at this exact point in the document (its role in the argument). Do not merely paraphrase it.'
      : mode === 'simplify'
        ? 'Rewrite the selected text in plainer words and shorter sentences, preserving the meaning and precision. Return only the rewritten text — no commentary on what you changed.'
        : 'Give one tight definition of the term/expression as used right here (taking field and context into account). Briefly note if this usage deviates from the common meaning. Do not explain the rest of the sentence.'
  return `You are helping a reader in the PDF reader PDF Scholar. ${task} Answer briefly (2–6 sentences), in English, with no preamble or summary. Use the page context when needed.`
}

/** User-message scaffold for the explain-selection popover */
export function explainUserMessage(selection: string, pageNumber: number, pageContext: string): string {
  return getLanguage() === 'nb'
    ? `Utvalgt tekst (fra side ${pageNumber}):\n«${selection}»\n\nKontekst fra siden:\n${pageContext}`
    : `Selected text (from page ${pageNumber}):\n"${selection}"\n\nContext from the page:\n${pageContext}`
}

/** Question scaffold for "ask my annotations": the block lists the user's
 *  own highlights/notes; keeping it inside the user message means follow-up
 *  questions retain it via the chat history. */
export function annotationsQuestion(block: string): string {
  return getLanguage() === 'nb'
    ? `Nedenfor er merknadene mine i dokumentet (markeringer, understrekinger og notater, med sidetall). Oppsummer hva jeg har vært opptatt av, grupper gjerne etter tema, og pek på punkter det ser ut som jeg bør følge opp. Bruk dokumentet for kontekst der det trengs.\n\n${block}`
    : `Below are my annotations in the document (highlights, underlines and notes, with page numbers). Summarize what I have been focusing on, group by theme where natural, and point out items I appear to need to follow up on. Use the document for context where needed.\n\n${block}`
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

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
    const haystack = pages[pageIndex].text.toLowerCase()
    const at = haystack.indexOf(citation.quote.toLowerCase())
    if (at === -1) return null
    return { pageNumber: citation.pageNumber, start: at, end: at + citation.quote.length }
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
    return `Du er forskningsassistenten i PDF-leseren PDF Scholar. Brukeren leser et dokument (typisk en forskningsartikkel eller rapport) og stiller spørsmål om det.

- Svar på samme språk som brukeren skriver (norsk bokmål som standard).
- Vær presis, akademisk nøktern og konsis. Ingen utfyllende småprat.
- Bygg svarene på dokumentet og siter kildene dine, slik at brukeren kan hoppe til stedet i PDF-en.
- Skiller tydelig mellom hva dokumentet sier og hva som er din egen vurdering eller bakgrunnskunnskap.`
  }
  return `You are the research assistant in the PDF reader PDF Scholar. The user is reading a document (typically a research article or report) and asks questions about it.

- Answer in the same language the user writes in (English by default).
- Be precise, academically sober and concise. No filler chatter.
- Ground your answers in the document and cite your sources, so the user can jump to the place in the PDF.
- Distinguish clearly between what the document says and what is your own judgement or background knowledge.`
}

export function explainSystem(mode: 'explain' | 'simplify' | 'define'): string {
  if (getLanguage() === 'nb') {
    const task =
      mode === 'explain'
        ? 'Forklar den utvalgte teksten: hva den betyr og hvilken rolle den spiller i sammenhengen.'
        : mode === 'simplify'
          ? 'Skriv den utvalgte teksten om i enklere språk, uten å miste presisjon.'
          : 'Definer begrepet/uttrykket slik det brukes i akkurat denne sammenhengen.'
    return `Du hjelper en leser i PDF-leseren PDF Scholar. ${task} Svar kort (2–6 setninger), på norsk bokmål, uten innledning eller oppsummering. Bruk konteksten fra siden når det trengs.`
  }
  const task =
    mode === 'explain'
      ? 'Explain the selected text: what it means and what role it plays in context.'
      : mode === 'simplify'
        ? 'Rewrite the selected text in simpler language without losing precision.'
        : 'Define the term/expression as it is used in this specific context.'
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

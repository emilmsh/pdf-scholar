// Renderer-side AI helpers: document text assembly for the API, mapping
// citations back to page positions, and cost estimation.
import type { AiCitation, AiUsage } from '../../shared/types'
import type { PageText } from './search'

export interface AiDocument {
  /** All pages joined with blank lines, each prefixed with a page marker */
  text: string
  /** Char offset of each page's content within `text` (page i = index i) */
  pageStarts: number[]
}

/** Page markers let prompt-contract providers (OpenAI/Azure) name page
 *  numbers; Anthropic citations use raw char offsets which we map ourselves. */
export function buildAiDocument(pages: PageText[]): AiDocument {
  let text = ''
  const pageStarts: number[] = []
  for (let i = 0; i < pages.length; i++) {
    text += `[Side ${i + 1}]\n`
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

// ---------- Prompts ----------

export const CHAT_SYSTEM = `Du er forskningsassistenten i PDF-leseren PDF Scholar. Brukeren leser et dokument (typisk en forskningsartikkel eller rapport) og stiller spørsmål om det.

- Svar på samme språk som brukeren skriver (norsk bokmål som standard).
- Vær presis, akademisk nøktern og konsis. Ingen utfyllende småprat.
- Bygg svarene på dokumentet og siter kildene dine, slik at brukeren kan hoppe til stedet i PDF-en.
- Skiller tydelig mellom hva dokumentet sier og hva som er din egen vurdering eller bakgrunnskunnskap.`

export function explainSystem(mode: 'explain' | 'simplify' | 'define'): string {
  const task =
    mode === 'explain'
      ? 'Forklar den utvalgte teksten: hva den betyr og hvilken rolle den spiller i sammenhengen.'
      : mode === 'simplify'
        ? 'Skriv den utvalgte teksten om i enklere språk, uten å miste presisjon.'
        : 'Definer begrepet/uttrykket slik det brukes i akkurat denne sammenhengen.'
  return `Du hjelper en leser i PDF-leseren PDF Scholar. ${task} Svar kort (2–6 setninger), på norsk bokmål, uten innledning eller oppsummering. Bruk konteksten fra siden når det trengs.`
}

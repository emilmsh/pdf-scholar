// A conversation's turns as Markdown — shared by the renderer's exports
// (chat-export.ts: the copy button, the library's Markdown export, «Kopier
// for KI») and the MCP server in main, which has no i18n of its own. The
// words come in as labels and the citation marker as a function, so the
// renderer keeps its document-aware page markers and its own language while
// main writes plain English. Pure, Node-testable.
import type { AiCitation, AiContentPart } from './types'
import type { ChatMessage } from './chat-history'

export interface ChatMarkdownLabels {
  you: string
  assistant: string
  /** The line an attached image becomes */
  imageAlt: string
  imagesWithheld(count: number): string
  /** The heading over an answer's cited passages */
  passages: string
  passage(marker: string, text: string): string
  /** A citation whose page cannot be told */
  sourceChip: string
  conversationChip: string
  pageAbbrev: string
  /** A failed answer, as one line */
  failed(m: Extract<ChatMessage, { role: 'assistant' }>): string
}

export const ENGLISH_CHAT_LABELS: ChatMarkdownLabels = {
  you: 'You',
  assistant: 'Assistant',
  imageAlt: 'Image',
  imagesWithheld: (count) => `${count} image(s) not kept (password-protected document)`,
  passages: 'Cited passages',
  passage: (marker, text) => `${marker} «${text}»`,
  sourceChip: 'source',
  conversationChip: 'Conversation',
  pageAbbrev: 'p.',
  failed: () => 'The answer failed.'
}

/** The marker a citation reads as without the document's text: a web source
 *  as a link, a conversation by name, a quote by its page, a character-offset
 *  citation as «[kilde]» — its page needs the text it counts into. */
export function plainCitationMarker(citation: AiCitation, labels: ChatMarkdownLabels, page: number | null = null): string {
  if (citation.kind === 'web') {
    let host = ''
    try {
      host = new URL(citation.url).hostname.replace(/^www\./, '')
    } catch {
      /* malformed URL — fall back to the generic label */
    }
    return `[${host || labels.sourceChip}](${citation.url})`
  }
  if (citation.kind === 'conversation') {
    return `[${labels.conversationChip}: ${citation.docName || citation.title}]`
  }
  const p = citation.kind === 'quote' ? citation.pageNumber : page
  return p !== null ? `[${labels.pageAbbrev} ${p}]` : `[${labels.sourceChip}]`
}

type Marker = (c: AiCitation) => string

function assistantMarkdown(parts: AiContentPart[], marker: Marker): string {
  // Same merge as AssistantBody: each part's citations are glued to the end
  // of the sentence that carries them, before the part's trailing whitespace.
  let md = ''
  for (const part of parts) {
    const trailing = /\s*$/.exec(part.text)?.[0] ?? ''
    md += trailing ? part.text.slice(0, part.text.length - trailing.length) : part.text
    const seen = new Set<string>()
    for (const c of part.citations) {
      const m = marker(c)
      if (seen.has(m)) continue // two chips, same page — one marker reads better
      seen.add(m)
      md += ` ${m}`
    }
    md += trailing
  }
  return md.trim()
}

/** Longest passage the list shows; a model may quote a whole paragraph */
const PASSAGE_MAX = 600

/** The passages an answer cites, word for word, listed under it. A «[s. 6]»
 *  alone sends the reader back to the PDF to learn what the sentence stood
 *  on, and an export is read without the PDF (issue #46). Each line opens
 *  with the marker the text carries, so the two can be matched; web sources
 *  and conversations are a link and a name already, with no passage to show. */
function passagesMarkdown(parts: AiContentPart[], labels: ChatMarkdownLabels, marker: Marker): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const part of parts) {
    for (const c of part.citations) {
      if (c.kind !== 'quote' && c.kind !== 'char') continue
      const text = (c.kind === 'quote' ? c.quote : c.citedText).replace(/\s+/g, ' ').trim()
      if (!text) continue
      const m = marker(c)
      const key = `${m}\n${text}`
      if (seen.has(key)) continue
      seen.add(key)
      const shown = text.length > PASSAGE_MAX ? `${text.slice(0, PASSAGE_MAX).trimEnd()} …` : text
      lines.push(`- ${labels.passage(m, shown)}`)
    }
  }
  return lines.length ? `*${labels.passages}*\n\n${lines.join('\n')}` : ''
}

/** One conversation's turns, one block per turn */
export function messagesMarkdown(
  messages: ChatMessage[],
  labels: ChatMarkdownLabels,
  marker: Marker = (c) => plainCitationMarker(c, labels)
): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const lines = [`**${labels.you}:**`]
      lines.push(...(m.images ?? []).map(() => `*${labels.imageAlt}*`))
      if (m.imagesWithheld) lines.push(`*${labels.imagesWithheld(m.imagesWithheld)}*`)
      lines.push((m.display ?? m.text).trim())
      out.push(lines.join('\n\n'))
    } else {
      const body = m.error ? `*${labels.failed(m)}*` : assistantMarkdown(m.parts, marker)
      const passages = m.error ? '' : passagesMarkdown(m.parts, labels, marker)
      out.push(`**${labels.assistant}:**\n\n${body}${passages ? `\n\n${passages}` : ''}`)
    }
  }
  return out
}

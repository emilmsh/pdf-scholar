// Serializes a conversation to Markdown for the clipboard (the header's copy
// button). Assistant answers are already markdown, so they travel verbatim;
// citation chips become inline "[s. 6]" markers (web sources become links),
// resolved through the same citationPage the rendered chips use. Renderer-only
// by design, like chat-store: works identically in Electron, dev:web and the
// extension.
import type { AiCitation, AiContentPart } from '../../shared/types'
import type { AiDocument } from './ai'
import { citationPage } from './ai'
import type { ChatMessage } from './chat-store'
import type { ConversationDoc } from '../../shared/chat-history'
import { errorText, locale, t } from './i18n'

function citationMarker(citation: AiCitation, doc: AiDocument | null): string {
  if (citation.kind === 'web') {
    let host = ''
    try {
      host = new URL(citation.url).hostname.replace(/^www\./, '')
    } catch {
      /* malformed URL — fall back to the generic label */
    }
    return `[${host || t('ai.sourceChip')}](${citation.url})`
  }
  const page = citationPage(citation, doc)
  return page !== null ? `[${t('app.pageAbbrev')} ${page}]` : `[${t('ai.sourceChip')}]`
}

function assistantMarkdown(parts: AiContentPart[], doc: AiDocument | null): string {
  // Same merge as AssistantBody: each part's citations are glued to the end
  // of the sentence that carries them, before the part's trailing whitespace.
  let md = ''
  for (const part of parts) {
    const trailing = /\s*$/.exec(part.text)?.[0] ?? ''
    md += trailing ? part.text.slice(0, part.text.length - trailing.length) : part.text
    const seen = new Set<string>()
    for (const c of part.citations) {
      const marker = citationMarker(c, doc)
      if (seen.has(marker)) continue // two chips, same page — one marker reads better
      seen.add(marker)
      md += ` ${marker}`
    }
    md += trailing
  }
  return md.trim()
}

/** One conversation's turns, as the copy button and the library export share them */
function messagesMarkdown(messages: ChatMessage[], doc: AiDocument | null): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const lines = [`**${t('ai.exportYou')}:**`]
      lines.push(...(m.images ?? []).map(() => `*${t('ai.imageAlt')}*`))
      if (m.imagesWithheld) lines.push(`*${t('ai.imagesWithheld', { count: String(m.imagesWithheld) })}*`)
      lines.push((m.display ?? m.text).trim())
      out.push(lines.join('\n\n'))
    } else {
      const body = m.error
        ? `*${errorText({ error: m.error, code: m.errorCode })}*`
        : assistantMarkdown(m.parts, doc)
      out.push(`**${t('ai.exportAssistant')}:**\n\n${body}`)
    }
  }
  return out
}

export function conversationMarkdown(
  docTitle: string,
  messages: ChatMessage[],
  doc: AiDocument | null
): string {
  const out: string[] = [
    `# ${docTitle.trim() || t('ai.untitledChat')}`,
    `*${new Date().toLocaleDateString(locale())}*`,
    ...messagesMarkdown(messages, doc)
  ]
  return `${out.join('\n\n')}\n`
}

/** Every conversation in the store as one Markdown file (issue #46): a
 *  heading per document with where it lives, a heading per conversation with
 *  its date. Readable without the app — the export's whole point. Images are
 *  named, not embedded; the JSON export carries them. Citations read as page
 *  markers where the citation names its page («[s. 6]»), else as «[kilde]»:
 *  the page of a character-offset citation needs the document's text, which
 *  an export of a hundred documents does not open. */
export function libraryMarkdown(docs: ConversationDoc[], now = Date.now()): string {
  const out: string[] = [
    `# ${t('lib.exportTitle')}`,
    `*${new Date(now).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })}*`
  ]
  const ordered = [...docs].sort(
    (a, b) => (b.conversations[0]?.updatedAt ?? 0) - (a.conversations[0]?.updatedAt ?? 0)
  )
  for (const d of ordered) {
    out.push(`## ${d.name}`, `\`${d.path}\``)
    for (const c of d.conversations) {
      out.push(
        `### ${c.title.trim() || t('ai.untitledChat')}`,
        `*${new Date(c.updatedAt).toLocaleDateString(locale())}*`,
        ...messagesMarkdown(c.messages, null)
      )
    }
  }
  return `${out.join('\n\n')}\n`
}

/** Every conversation in the store as JSON, images included — the whole
 *  history in a form another program can read back */
export function libraryJson(docs: ConversationDoc[], version: string, now = Date.now()): string {
  return JSON.stringify(
    { app: 'PDF Scholar', version, exportedAt: new Date(now).toISOString(), documents: docs },
    null,
    2
  )
}

// Serializes a conversation to Markdown for the clipboard (the header's copy
// button). Assistant answers are already markdown, so they travel verbatim;
// citation chips become inline "[s. 6]" markers (web sources become links),
// resolved through the same citationPage the rendered chips use. Renderer-only
// by design, like chat-store: works identically in Electron, dev:web and the
// extension. The turns themselves are written by shared/chat-markdown.ts,
// which the MCP server in main shares; this file supplies the words.
import type { AiCitation } from '../../shared/types'
import type { AiDocument } from './ai'
import { citationPage } from './ai'
import type { ChatMessage } from './chat-store'
import type { ConversationDoc } from '../../shared/chat-history'
import type { ChatMarkdownLabels } from '../../shared/chat-markdown'
import { messagesMarkdown as sharedMessages, plainCitationMarker } from '../../shared/chat-markdown'
import { errorText, locale, t } from './i18n'

/** The labels in the interface's language — read per call, so a language
 *  switch is followed */
export function chatLabels(): ChatMarkdownLabels {
  return {
    you: t('ai.exportYou'),
    assistant: t('ai.exportAssistant'),
    imageAlt: t('ai.imageAlt'),
    imagesWithheld: (count) => t('ai.imagesWithheld', { count: String(count) }),
    passages: t('ai.exportPassages'),
    passage: (marker, text) => t('ai.exportPassage', { marker, text }),
    sourceChip: t('ai.sourceChip'),
    conversationChip: t('ai.conversationChip'),
    pageAbbrev: t('app.pageAbbrev'),
    failed: (m) => errorText({ error: m.error ?? '', code: m.errorCode })
  }
}

/** One conversation's turns, as the copy button and the library export share them */
export function messagesMarkdown(messages: ChatMessage[], doc: AiDocument | null): string[] {
  const labels = chatLabels()
  return sharedMessages(messages, labels, (c: AiCitation) => plainCitationMarker(c, labels, citationPage(c, doc)))
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
 *  an export of a hundred documents does not open. Either way the passage
 *  itself is listed under the answer. */
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

// Earlier conversations attached to a question as context (issue #46).
//
// The reader picks them — never the app: a «Samtaler» button in the composer
// opens a picker, and what is chosen sits as chips above the composer for as
// long as the conversation lasts, until the reader takes them off. Each
// request then carries them as a block of its own in the SYSTEM prompt,
// rebuilt from what is attached at that moment — never folded into a user
// message (it could never be taken back out of the history) and never into
// the document (a provider with native citations would point its chips into
// the wrong text).
//
// What the model is told: the document is the only source. An attached
// conversation is the reader's notes — when an answer uses one it says so
// and tags it [SAMTALE n], which becomes a chip that opens that
// conversation. The tag has no «s.N:» and no quote, so the quote contract's
// tolerant parser (ai-stream.ts) can never mistake it for a source. Earlier
// answers may be wrong; where one disagrees with the document, the document
// wins and the answer says so.
//
// Only text travels: questions and answers, no images. Each conversation is
// capped, and the block as a whole, so five long conversations cannot crowd
// the document out of a tight request (the panel also takes the block's size
// off the document's budget). Pure, Node-testable
// (scripts/test-conversation-context.mjs).
import type { AiCitation, AiContentPart } from './types'
import type { StoredConversation } from './chat-history'

/** What a chip above the composer names, and what a request looks up */
export interface AttachedConversation {
  docPath: string
  docName: string
  id: string
  title: string
}

export const MAX_ATTACHED = 5
/** Per conversation, and for the block as a whole (≈ 2 200 / 6 700 tokens) */
export const MAX_CHARS_EACH = 8_000
export const MAX_CHARS_TOTAL = 24_000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A stored attachment list is untrusted input like the rest of the store */
export function sanitizeAttached(input: unknown): AttachedConversation[] {
  if (!Array.isArray(input)) return []
  const out: AttachedConversation[] = []
  const seen = new Set<string>()
  for (const a of input) {
    if (!isObj(a) || typeof a.docPath !== 'string' || !a.docPath || typeof a.id !== 'string' || !a.id) continue
    const key = `${a.docPath}\u0000${a.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      docPath: a.docPath,
      id: a.id,
      docName: typeof a.docName === 'string' ? a.docName : '',
      title: typeof a.title === 'string' ? a.title : ''
    })
    if (out.length >= MAX_ATTACHED) break
  }
  return out
}

export const sameConversation = (a: { docPath: string; id: string }, b: { docPath: string; id: string }): boolean =>
  a.docPath === b.docPath && a.id === b.id

/** A conversation as the model reads it: who said what, in order. What the
 *  reader saw of their question (display) rather than what was sent with it,
 *  no images, no failure prose — an answer that failed is not a note. */
export function transcript(c: StoredConversation): string {
  const lines: string[] = []
  for (const m of c.messages) {
    if (m.role === 'user') {
      const text = (m.display ?? m.text).trim()
      if (text) lines.push(`Reader: ${text}`)
    } else if (!m.error) {
      const text = m.parts.map((p) => p.text).join('').trim()
      if (text) lines.push(`Assistant: ${text}`)
    }
  }
  return lines.join('\n')
}

const GAP = '[… part of this conversation is left out …]'

/** A transcript cut to `max` characters: the opening (where the question is
 *  posed) and the end (where it was left), with a marker between */
export function capTranscript(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false }
  const room = Math.max(0, max - GAP.length - 2)
  const head = Math.floor(room * 0.3)
  const tail = room - head
  return { text: `${text.slice(0, head).trimEnd()}\n${GAP}\n${text.slice(text.length - tail).trimStart()}`, cut: true }
}

export interface AttachedItem {
  meta: AttachedConversation
  /** null = the conversation no longer exists (deleted since it was attached) */
  conversation: StoredConversation | null
}

export interface AttachedBlock {
  /** The system-prompt block; '' when nothing could be attached */
  text: string
  /** The attachments in tag order — [SAMTALE n] is items[n - 1] */
  tagged: AttachedConversation[]
  /** Those whose transcript was cut to fit */
  cut: AttachedConversation[]
  /** Those that no longer exist and were left out */
  missing: AttachedConversation[]
}

const RULES = `EARLIER CONVERSATIONS — attached by the reader for this question.
These are the reader's own earlier conversations with you, about other documents or earlier about this one. They are the reader's notes, NOT sources.
RULES:
- The document attached to this conversation is the only thing you cite as a source. Never put a document citation (a [KILDE …] marker or any other source citation) on something taken from these conversations.
- When you use something from one of them, say so in plain words and tag it with its marker right after the sentence, e.g. [SAMTALE 2].
- Earlier answers are notes and may be wrong. Where one disagrees with the document, the document wins — say that they disagree.
- Leave them out of the answer when they do not bear on the question.`

/** The block for the system prompt, with each conversation capped and the
 *  whole within MAX_CHARS_TOTAL. Tags number only what is actually in it. */
export function attachedBlock(items: AttachedItem[]): AttachedBlock {
  const tagged: AttachedConversation[] = []
  const cut: AttachedConversation[] = []
  const missing: AttachedConversation[] = []
  const sections: string[] = []
  let remaining = MAX_CHARS_TOTAL
  for (const item of items.slice(0, MAX_ATTACHED)) {
    if (!item.conversation) {
      missing.push(item.meta)
      continue
    }
    const full = transcript(item.conversation)
    if (!full || remaining < 200) continue
    const capped = capTranscript(full, Math.min(MAX_CHARS_EACH, remaining))
    if (capped.cut) cut.push(item.meta)
    tagged.push(item.meta)
    const n = tagged.length
    const date = new Date(item.conversation.updatedAt).toISOString().slice(0, 10)
    const about = item.meta.docName || 'a document'
    const section = `[SAMTALE ${n}] About "${about}" — "${item.conversation.title || item.meta.title}" (${date})\n${capped.text}`
    sections.push(section)
    remaining -= capped.text.length
  }
  if (tagged.length === 0) return { text: '', tagged, cut, missing }
  return { text: `\n\n${RULES}\n\n${sections.join('\n\n')}`, tagged, cut, missing }
}

const TAG_RE = /\s*\[(?:SAMTALE|SAMTALER|CONVERSATION|对话)\s+(\d+)\]/gi

/** Turn [SAMTALE n] tags in an answer into conversation chips. A tag gives
 *  its chip to the text before it, like a source marker does; a tag naming
 *  no attachment is dropped rather than shown raw. A part's own citations
 *  stay at its end. Idempotent. */
export function splitConversationTags(parts: AiContentPart[], tagged: AttachedConversation[]): AiContentPart[] {
  const out: AiContentPart[] = []
  for (const part of parts) {
    TAG_RE.lastIndex = 0
    if (!TAG_RE.test(part.text)) {
      out.push(part)
      continue
    }
    TAG_RE.lastIndex = 0
    let last = 0
    let m: RegExpExecArray | null
    while ((m = TAG_RE.exec(part.text)) !== null) {
      const meta = tagged[Number(m[1]) - 1]
      const cite: AiCitation[] = meta
        ? [{ kind: 'conversation', docPath: meta.docPath, id: meta.id, docName: meta.docName, title: meta.title }]
        : []
      out.push({ text: part.text.slice(last, m.index), citations: cite })
      last = TAG_RE.lastIndex
    }
    out.push({ text: part.text.slice(last), citations: part.citations })
  }
  // Glue a chip-less empty piece away; keep at least one part
  const merged = out.filter((p, i) => p.text !== '' || p.citations.length > 0 || i === out.length - 1)
  return merged.length ? merged : [{ text: '', citations: [] }]
}

// The AI conversations a document has had, and the history across every
// document (issue #46). The rules every store follows — desktop's files
// (src/main/chat-history.ts), the extension's IndexedDB
// (src/renderer/src/extension-chat-history.ts), dev:web's localStorage
// (bridge.ts) — and the search the panel's history view runs over all of it.
//
// A stored list is untrusted input, like a session or the recents: a
// hand-edited or version-skewed file must come back as what still parses,
// never as an exception the panel cannot show. Nothing here evicts: the
// localStorage store this replaced kept ten conversations for thirty
// documents and silently dropped the rest, which is the fragmentation the
// issue is about. The caps below bound garbage, not use.
//
// Search is a HISTORY search, not retrieval: every word typed must occur
// somewhere in the conversation (title, document name or text), case-folded,
// and the hits list newest first — what one expects of a list of past
// conversations, and predictable in a way a ranked score is not. Pure
// functions, Node-testable (scripts/test-chat-history.mjs).
import type { AiContentPart, AiImage, AiUsage, FileError } from './types'

// `| undefined` on every optional field: messages are built as object literals
// where the unused ones are present and undefined (a user turn with no images
// still writes `images: pendingImages.length ? … : undefined`). These are append-
// only records — never spread over an existing message — so present-and-undefined
// and absent mean the same thing to every reader, including the JSON round-trip
// through the stores, which drops undefined values anyway.
export type ChatMessage =
  | {
      role: 'user'
      text: string
      display?: string | undefined
      images?: AiImage[] | undefined
      /** How many images this turn carried that the store did NOT keep — the
       *  document was password-protected (withoutImages). The bubble shows a
       *  line in their place, so a reopened conversation is not silently
       *  missing what the question was about. */
      imagesWithheld?: number | undefined
    }
  | {
      role: 'assistant'
      parts: AiContentPart[]
      usage?: AiUsage | undefined
      model?: string | undefined
      /** AiChatResult.fallbackModel: another model answered because the chosen
       *  one declined — drives the «Besvart av …» chip on the answer */
      fallbackModel?: string | undefined
      error?: string | undefined
      /** Set when the failure was one we can name. Stored ALONGSIDE `error`
       *  rather than instead of it: the code is what gets translated at render
       *  time (so a language switch redraws old failures correctly), and `error`
       *  stays the fallback for conversations saved before codes existed. */
      errorCode?: FileError['code']
      /** Set when the request attached a BM25 excerpt instead of the full
       *  document (too large for one request to carry) — drives the
       *  transparency chip on the answer */
      excerpt?: { included: number; total: number } | undefined
      /** The per-request token ceiling the provider named while refusing this
       *  one (see AiChatResult.tokenLimit). Kept so the failure can say what
       *  the ceiling IS and that the next attempt is cut to fit it — a promise
       *  we may only make when the provider actually published a number. */
      tokenLimit?: number | undefined
    }

export interface StoredConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

/** One document's conversations as a store keeps them: the document's name
 *  rides along so the cross-document history can name a document the recents
 *  no longer hold (or never held — the extension's URLs). */
export interface ConversationDoc {
  path: string
  name: string
  conversations: StoredConversation[]
}

/** One conversation as the cross-document history lists and searches it: no
 *  messages (and so no images), only what the row shows and the search reads. */
export interface ConversationSummary {
  docPath: string
  docName: string
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** What the user wrote and the model answered, in order — the search text */
  text: string
  /** Images the conversation carries, and their size in bytes — what the
   *  library's «Fjern bilder» would free, counted without reading them */
  images: number
  imageBytes: number
}

/** A summary as it crosses to a window: everything the list shows, without
 *  the conversation's full text. The text stays where the store is — the
 *  search runs there (PdfxApi.searchConversations) — since 5 000
 *  conversations' text is ~22 MB a window had to receive on every listing. */
export type ConversationMeta = Omit<ConversationSummary, 'text'>

export interface ConversationHit extends ConversationMeta {
  /** The text around the first word matched in the conversation's TEXT —
   *  null when the match is in the title or document name alone, which the
   *  row shows anyway */
  snippet: string | null
}

/** A summary without its text, for the list a window receives */
export function toMeta(s: ConversationSummary): ConversationMeta {
  const { text: _text, ...meta } = s
  return meta
}

/** Bounds on a stored list — against garbage, not against use */
export const MAX_CONVERSATIONS_PER_DOC = 2000
export const MAX_MESSAGES_PER_CONVERSATION = 2000

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const validMessage = (m: unknown): m is ChatMessage => {
  if (!isObj(m)) return false
  if (m.role === 'user') return typeof m.text === 'string'
  if (m.role === 'assistant') return Array.isArray(m.parts)
  return false
}

const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** What of a stored list still parses, newest first, each id once (the first
 *  occurrence wins — it is the newest after the sort). A conversation with
 *  no readable messages is kept: an empty one is still the user's. */
export function sanitizeConversations(input: unknown): StoredConversation[] {
  if (!Array.isArray(input)) return []
  const out: StoredConversation[] = []
  for (const c of input) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || typeof c.title !== 'string') continue
    if (!validTime(c.updatedAt) || !Array.isArray(c.messages)) continue
    out.push({
      id: c.id,
      title: c.title,
      createdAt: validTime(c.createdAt) ? c.createdAt : c.updatedAt,
      updatedAt: c.updatedAt,
      messages: c.messages.filter(validMessage).slice(0, MAX_MESSAGES_PER_CONVERSATION)
    })
    if (out.length >= MAX_CONVERSATIONS_PER_DOC) break
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}

/** The name a document shows when its store entry names none: the last
 *  segment of the path, URL or `fsa:` pseudo-path, percent-decoded. */
export function docNameFromPath(path: string): string {
  let tail = path.replace(/^fsa:/, '').replace(/[?#].*$/, '')
  tail = tail.split(/[\\/]/).filter(Boolean).pop() ?? tail
  try {
    tail = decodeURIComponent(tail)
  } catch {
    /* a bare % in a file name — shown as it is */
  }
  return tail || path
}

export function sanitizeConversationDoc(input: unknown): ConversationDoc | null {
  if (!isObj(input) || typeof input.path !== 'string' || !input.path) return null
  const name = typeof input.name === 'string' && input.name.trim() ? input.name : docNameFromPath(input.path)
  return { path: input.path, name, conversations: sanitizeConversations(input.conversations) }
}

/** The union of two lists of one document's conversations: an id in both
 *  keeps the newer record. Newest first. For the one-time import of the
 *  localStorage store and for two windows that wrote the same document. */
export function mergeConversations(a: StoredConversation[], b: StoredConversation[]): StoredConversation[] {
  const byId = new Map<string, StoredConversation>()
  for (const c of [...a, ...b]) {
    const have = byId.get(c.id)
    if (!have || c.updatedAt > have.updatedAt) byId.set(c.id, c)
  }
  return [...byId.values()].sort((x, y) => y.updatedAt - x.updatedAt)
}

/** A password-protected document's conversations as they may be STORED: no
 *  page images, snips or pasted pictures — each turn keeps a count of what it
 *  carried instead. The library's picture store keeps nothing of a locked
 *  document for the same reason (shared/recent-thumbs.ts): the file is
 *  encrypted, and a picture of its pages on disk in the clear is exactly what
 *  the encryption withholds. The text stays — the reader's own questions and
 *  the answers are the history this store exists for. Idempotent. */
export function withoutImages(list: StoredConversation[]): StoredConversation[] {
  return list.map((c) => {
    if (!c.messages.some((m) => m.role === 'user' && m.images && m.images.length > 0)) return c
    return {
      ...c,
      messages: c.messages.map((m) => {
        if (m.role !== 'user' || !m.images || m.images.length === 0) return m
        const { images, ...rest } = m
        return { ...rest, imagesWithheld: (m.imagesWithheld ?? 0) + images.length }
      })
    }
  })
}

/** The searchable text of a conversation: what the user wrote (as shown) and
 *  what the model answered, in order. Images, citations, usage and failure
 *  prose are not text anyone searches for. */
export function conversationText(c: StoredConversation): string {
  const out: string[] = []
  for (const m of c.messages) {
    if (m.role === 'user') out.push((m.display ?? m.text).trim())
    else out.push(m.parts.map((p) => p.text).join('').trim())
  }
  return out.filter(Boolean).join('\n')
}

/** The images a conversation carries and their decoded size (base64 is four
 *  characters for every three bytes) */
export function conversationImages(c: StoredConversation): { images: number; imageBytes: number } {
  let images = 0
  let imageBytes = 0
  for (const m of c.messages) {
    if (m.role !== 'user' || !m.images) continue
    for (const img of m.images) {
      images++
      imageBytes += Math.floor(((img?.dataBase64?.length ?? 0) * 3) / 4)
    }
  }
  return { images, imageBytes }
}

export function summarizeConversations(doc: ConversationDoc): ConversationSummary[] {
  return doc.conversations.map((c) => ({
    docPath: doc.path,
    docName: doc.name,
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    text: conversationText(c),
    ...conversationImages(c)
  }))
}

/** Newest first across documents — the order the cross-document list shows */
export const byNewest = <T extends { updatedAt: number }>(list: T[]): T[] =>
  [...list].sort((a, b) => b.updatedAt - a.updatedAt)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of a query, each as a case-folding regex — the index it finds is
 *  in the ORIGINAL text, so a snippet is cut from the text as written (a
 *  lower-cased copy changes length for some letters). */
export function queryTerms(query: string): RegExp[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(escapeRe(w), 'iu'))
}

/** How much of the text a snippet shows either side of the match */
const SNIPPET_REACH = 70

/** The text around the first match, cut at word boundaries, with ellipses
 *  where there is more. One line: a conversation's newlines read as spaces
 *  in a row that shows one. */
export function snippetAround(text: string, index: number, length: number): string {
  let start = Math.max(0, index - SNIPPET_REACH)
  let end = Math.min(text.length, index + length + SNIPPET_REACH)
  if (start > 0) {
    // Begin at the first whole word inside the reach
    const next = text.indexOf(' ', start)
    if (next !== -1 && next < index) start = next + 1
  }
  if (end < text.length) {
    // End after the last whole word inside the reach
    const prev = text.lastIndexOf(' ', end)
    if (prev > index + length) end = prev
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** The conversations every word of the query occurs in — in the title, the
 *  document's name or the text — newest first. An empty query is every
 *  conversation, newest first. */
export function searchConversations(list: ConversationSummary[], query: string): ConversationHit[] {
  const terms = queryTerms(query)
  const hits: ConversationHit[] = []
  for (const c of byNewest(list)) {
    let snippet: string | null = null
    let all = true
    for (const re of terms) {
      const m = re.exec(c.text)
      if (m && snippet === null) snippet = snippetAround(c.text, m.index, m[0].length)
      if (!m && !re.test(c.title) && !re.test(c.docName)) {
        all = false
        break
      }
    }
    if (all) hits.push({ ...toMeta(c), snippet })
  }
  return hits
}

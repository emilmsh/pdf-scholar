// The renderer's side of the AI conversation store (issue #46): the panel's
// reads and writes go through PdfxApi — desktop's files, the extension's
// IndexedDB, dev:web's localStorage — so the history is kept, not evicted.
// Until 2026-10-22 this module WAS the store: localStorage, ten conversations
// per document, thirty documents, the oldest dropped in silence. What that
// store still holds is imported once, below, then the key is removed.
//
// Also the handoff that opens a conversation in ANOTHER document: the history
// view's cross-document list hands the document to the host (a tab here, a
// window or tab elsewhere), and the panel that ends up showing the document
// picks the conversation up from here. localStorage because it crosses
// windows on every platform (desktop's windows share one partition; the
// extension's tabs one origin), with a short life — a document that fails to
// open must not open on that conversation a day later.
import type { ConversationHit, ConversationMeta, StoredConversation } from '../../shared/chat-history'
import type { AiCitation } from '../../shared/types'
import { mergeConversations, sanitizeConversations, docNameFromPath, withoutImages } from '../../shared/chat-history'
import { bridge } from './bridge'

export type { ChatMessage, StoredConversation, ConversationMeta, ConversationHit } from '../../shared/chat-history'

/** The localStorage store this replaced: `{ [path]: StoredConversation[] }` */
export const LEGACY_CHATS_LS_KEY = 'pdfx-ai-chats'

export const newConversationId = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

let migration: Promise<void> | null = null

/** Import what the old localStorage store holds into the platform store,
 *  once per window, before the first read. Merged by id with whatever the
 *  store has (two windows may import at once; a conversation written there
 *  since is newer and wins), then the key goes. A store write that fails
 *  leaves the key for the next launch to try again. */
export function migrateLegacyChats(): Promise<void> {
  if (migration) return migration
  migration = (async () => {
    let raw: string | null
    try {
      raw = localStorage.getItem(LEGACY_CHATS_LS_KEY)
    } catch {
      return
    }
    if (!raw) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [path, list] of Object.entries(parsed as Record<string, unknown>)) {
        const old = sanitizeConversations(list)
        if (old.length === 0) continue
        const have = await bridge.getConversations(path)
        await bridge.setConversations(path, docNameFromPath(path), mergeConversations(have, old))
      }
    }
    try {
      localStorage.removeItem(LEGACY_CHATS_LS_KEY)
    } catch {
      /* read-only storage: imported again next time, harmlessly */
    }
  })().catch(() => {
    migration = null // try again on the next read
  })
  return migration
}

export async function loadConversations(docPath: string): Promise<StoredConversation[]> {
  await migrateLegacyChats()
  return bridge.getConversations(docPath)
}

/** Write one document's conversation list (newest first). A `locked`
 *  (password-protected) document's list is stored without its images
 *  (withoutImages) — on every platform, since this is the one write path. */
export function saveConversations(
  docPath: string,
  docName: string,
  list: StoredConversation[],
  locked = false
): Promise<void> {
  return bridge.setConversations(docPath, docName, locked ? withoutImages(list) : list)
}

export async function deleteConversation(
  docPath: string,
  docName: string,
  id: string,
  locked = false
): Promise<StoredConversation[]> {
  const next = (await loadConversations(docPath)).filter((c) => c.id !== id)
  await saveConversations(docPath, docName, next, locked)
  return next
}

/** Every document's conversations, without messages or text, newest first */
export async function listAllConversations(): Promise<ConversationMeta[]> {
  await migrateLegacyChats()
  return bridge.listConversations()
}

/** The conversations across every document that match a query — searched
 *  where the store is, so only the hits cross to this window */
export async function searchAllConversations(query: string): Promise<ConversationHit[]> {
  await migrateLegacyChats()
  return bridge.searchConversations(query)
}

/** Fired on this window's own `window` by notifyChangedHere */
const CHANGED_HERE_EVENT = 'pdfx:chats-changed-here'

/** Another window's write (the platform's own channel), or one made in THIS
 *  window by something other than the listener itself — the library tidying
 *  conversations of a document a background tab has open. The platforms tell
 *  only OTHER windows; without this, that tab's panel would keep the list it
 *  loaded and write the deleted conversations back with its next answer. */
export function onConversationsChanged(cb: (path: string | null) => void): () => void {
  const off = bridge.onConversationsChanged(cb)
  const here = (e: Event): void => cb((e as CustomEvent<string | null>).detail ?? null)
  window.addEventListener(CHANGED_HERE_EVENT, here)
  return () => {
    off()
    window.removeEventListener(CHANGED_HERE_EVENT, here)
  }
}

/** Tell this window's panels that the store changed under them */
export function notifyChangedHere(path: string | null): void {
  window.dispatchEvent(new CustomEvent(CHANGED_HERE_EVENT, { detail: path }))
}

// ---------- Opening a conversation in another document ----------

const HANDOFF_KEY = 'pdfx-open-conversation'
/** A handoff older than this is a document that never opened */
const HANDOFF_TTL_MS = 20_000

interface Handoff {
  path: string
  id: string
  /** A source chip clicked outside its document: the panel that takes the
   *  handoff jumps to it, exactly as a click on the chip in that panel does */
  citation?: AiCitation
  at: number
}

function readHandoff(): Handoff | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY)
    if (!raw) return null
    const h = JSON.parse(raw) as Partial<Handoff>
    if (typeof h.path !== 'string' || typeof h.id !== 'string' || typeof h.at !== 'number') return null
    if (Date.now() - h.at > HANDOFF_TTL_MS) return null
    const citation = h.citation && typeof h.citation === 'object' && typeof h.citation.kind === 'string' ? h.citation : undefined
    return { path: h.path, id: h.id, at: h.at, ...(citation ? { citation } : {}) }
  } catch {
    return null
  }
}

/** Ask whichever panel shows this document next to open this conversation —
 *  and, with a citation, to jump to the passage it cites */
export function requestConversationOpen(docPath: string, id: string, citation?: AiCitation): void {
  try {
    const h: Handoff = { path: docPath, id, at: Date.now(), ...(citation ? { citation } : {}) }
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(h))
  } catch {
    /* no storage: the document still opens, on its newest conversation */
  }
}

/** The conversation asked for on this document, if any — left in place for
 *  the panel to take (the viewer looks first, to open the panel at all) */
export function pendingConversationFor(docPath: string): string | null {
  const h = readHandoff()
  return h && h.path === docPath ? h.id : null
}

/** The conversation asked for on this document, taken: nobody else opens it */
export function takeConversationFor(docPath: string): { id: string; citation?: AiCitation } | null {
  const h = readHandoff()
  if (!h || h.path !== docPath) return null
  try {
    localStorage.removeItem(HANDOFF_KEY)
  } catch {
    /* it expires on its own */
  }
  return h.citation ? { id: h.id, citation: h.citation } : { id: h.id }
}

/** Fired on `window` by the host once a document has been opened for a
 *  handoff — the viewer of that document looks for its conversation then */
export const CONVERSATION_HANDOFF_EVENT = 'pdfx:conversation-handoff'

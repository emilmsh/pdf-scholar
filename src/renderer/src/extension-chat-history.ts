// The extension's store for the AI conversations (issue #46; the rules are
// in src/shared/chat-history.ts, desktop's store is src/main/chat-history.ts).
//
// IndexedDB, not chrome.storage.local: that store is capped at 10 MB without
// the `unlimitedStorage` permission, and a conversation carries the page
// images it was asked about. One record per document, keyed by the path (a
// URL, a file:// URL or an `fsa:` pseudo-path), holding a ConversationDoc.
// A write of one document never touches another's record, so two viewer tabs
// on two documents cannot lose one to the other. Other tabs hear of a write
// over a BroadcastChannel, the stand-in for desktop's IPC broadcast.
import type { ConversationDoc, ConversationSummary, StoredConversation } from '../../shared/chat-history'
import {
  byNewest,
  docNameFromPath,
  sanitizeConversationDoc,
  sanitizeConversations,
  summarizeConversations
} from '../../shared/chat-history'

const DB_NAME = 'pdfx-chats'
const STORE = 'docs'
const CHANNEL = 'pdfx-chats'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

const request = <T>(req: IDBRequest<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(undefined)
  })

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })

export async function loadConversationDoc(path: string): Promise<StoredConversation[]> {
  const db = await openDb()
  if (!db) return []
  try {
    const raw = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(path))
    const doc = sanitizeConversationDoc(raw)
    return doc && doc.path === path ? doc.conversations : []
  } catch {
    return []
  }
}

export async function saveConversationDoc(path: string, name: string, list: StoredConversation[]): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const clean = sanitizeConversations(list)
    if (clean.length === 0) store.delete(path)
    else {
      const doc: ConversationDoc = { path, name: name.trim() || docNameFromPath(path), conversations: clean }
      store.put(doc, path)
    }
    await done(tx)
  } catch {
    /* best-effort: the panel keeps its copy until the next write */
  }
  try {
    new BroadcastChannel(CHANNEL).postMessage(path)
  } catch {
    /* no channel: other tabs refresh when their history view opens */
  }
}

async function allDocs(): Promise<ConversationDoc[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    const out: ConversationDoc[] = []
    try {
      const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
      cursor.onsuccess = () => {
        const at = cursor.result
        if (!at) return resolve(out)
        const doc = sanitizeConversationDoc(at.value)
        if (doc) out.push(doc)
        at.continue()
      }
      cursor.onerror = () => resolve(out)
    } catch {
      resolve(out)
    }
  })
}

export async function listConversationDocs(): Promise<ConversationSummary[]> {
  return byNewest((await allDocs()).flatMap(summarizeConversations))
}

export const allConversationDocs = allDocs

/** Another tab wrote a document's conversations. The listener gets the path. */
export function subscribeConversationChanges(cb: (path: string) => void): () => void {
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (e) => {
      if (typeof e.data === 'string') cb(e.data)
    }
  } catch {
    return () => {}
  }
  return () => channel?.close()
}

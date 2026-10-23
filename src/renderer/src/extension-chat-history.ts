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
/** Each document's ConversationSummary[] — no messages, so no images — kept
 *  beside its record and written in the same transaction. The cross-document
 *  list reads only these: reading the records themselves would clone every
 *  page image of every conversation into the page to throw it away again. */
const SUMMARIES = 'summaries'
const CHANNEL = 'pdfx-chats'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      // v2 added SUMMARIES; a v1 database keeps its records and gets their
      // summaries filled in on the first listing (listConversationDocs)
      const req = indexedDB.open(DB_NAME, 2)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES)
      }
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
    const tx = db.transaction([STORE, SUMMARIES], 'readwrite')
    const store = tx.objectStore(STORE)
    const sums = tx.objectStore(SUMMARIES)
    const clean = sanitizeConversations(list)
    if (clean.length === 0) {
      store.delete(path)
      sums.delete(path)
    } else {
      const doc: ConversationDoc = { path, name: name.trim() || docNameFromPath(path), conversations: clean }
      store.put(doc, path)
      sums.put(summarizeConversations(doc), path)
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

/** Is this a summary list as saveConversationDoc writes one? Anything else —
 *  garbage, or a record from before v2 — is rebuilt from its document. */
const validSummaries = (v: unknown, path: string): v is ConversationSummary[] =>
  Array.isArray(v) &&
  v.every((s) => !!s && typeof s === 'object' && (s as ConversationSummary).docPath === path &&
    typeof (s as ConversationSummary).id === 'string' && typeof (s as ConversationSummary).text === 'string' &&
    typeof (s as ConversationSummary).updatedAt === 'number' &&
    // Added with the library view: a summary from before is rebuilt
    typeof (s as ConversationSummary).images === 'number')

export async function listConversationDocs(): Promise<ConversationSummary[]> {
  const db = await openDb()
  if (!db) return []
  try {
    const tx = db.transaction([STORE, SUMMARIES], 'readonly')
    const [docKeys, sumKeys, sumValues] = await Promise.all([
      request(tx.objectStore(STORE).getAllKeys()),
      request(tx.objectStore(SUMMARIES).getAllKeys()),
      request(tx.objectStore(SUMMARIES).getAll())
    ])
    const have = new Map<string, ConversationSummary[]>()
    ;(sumKeys ?? []).forEach((k, i) => {
      const v = sumValues?.[i]
      if (typeof k === 'string' && validSummaries(v, k)) have.set(k, v)
    })
    const out: ConversationSummary[] = []
    const missing: string[] = []
    for (const k of docKeys ?? []) {
      if (typeof k !== 'string') continue
      const s = have.get(k)
      if (s) out.push(...s)
      else missing.push(k)
    }
    // Records written before v2 (or a summary that no longer parses): read
    // each once, list it, and store its summary so the next listing does not
    for (const path of missing) {
      const raw = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(path))
      const doc = sanitizeConversationDoc(raw)
      if (!doc || doc.path !== path) continue
      const list = summarizeConversations(doc)
      out.push(...list)
      try {
        db.transaction(SUMMARIES, 'readwrite').objectStore(SUMMARIES).put(list, path)
      } catch {
        /* listed anyway; filled in next time */
      }
    }
    return byNewest(out)
  } catch {
    return []
  }
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

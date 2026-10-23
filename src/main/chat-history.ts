// Desktop store for the AI conversations (issue #46; the rules are in
// src/shared/chat-history.ts).
//
// One file per document in its own folder beside the state file:
// `chats/<sha1 of path>.json` holding a ConversationDoc. NOT in
// pdfx-state.json: that file is rewritten whole on every reading-position
// save, and a year of conversations (with the page images they carry) would
// ride along each time. Per document rather than one index, so two windows
// writing two documents can never lose one to the other's read-modify-write.
// Two writes of the SAME document (a docked panel and a detached assistant)
// queue behind each other: on Windows a rename onto a file another rename is
// replacing fails with EPERM.
//
// Write-then-rename, so a crash mid-write leaves the previous list, never
// half a file. A file that no longer parses reads as empty and is LEFT where
// it is — the next write of that document replaces it, and until then it is
// still the user's data. Node-only (no Electron import) so
// scripts/test-chat-history.mjs runs it against a temp folder.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationDoc, ConversationSummary, StoredConversation } from '../shared/chat-history'
import {
  byNewest,
  docNameFromPath,
  sanitizeConversationDoc,
  sanitizeConversations,
  summarizeConversations
} from '../shared/chat-history'

export interface ChatHistoryStore {
  /** One document's conversations, newest first ([] = none, or unreadable) */
  get(path: string): Promise<StoredConversation[]>
  /** Replace one document's list. An empty list removes its file. */
  set(path: string, name: string, list: StoredConversation[]): Promise<void>
  /** Every document's conversations, without their messages, newest first */
  list(): Promise<ConversationSummary[]>
  /** Every document's conversations whole — the export's input */
  all(): Promise<ConversationDoc[]>
}

/** `<key>.json`, or one of its temp files mid-write */
const ENTRY_FILE = /^([0-9a-f]{40})\.json$/

const keyOf = (path: string): string => createHash('sha1').update(path).digest('hex')

let tmpSeq = 0

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

/** One file's summaries as last read, and the file stamp they were read at */
interface CachedSummary {
  mtimeMs: number
  size: number
  list: ConversationSummary[]
}

/** `onParse` is told of every file the store reads and parses — the test's
 *  way to prove the listing skips what has not changed */
export function createChatHistoryStore(dir: string, opts: { onParse?: (file: string) => void } = {}): ChatHistoryStore {
  const fileOf = (key: string): string => join(dir, `${key}.json`)
  /** The write in flight per document, which the next write of it waits for */
  const writing = new Map<string, Promise<void>>()
  /** The cross-document list without re-reading what has not changed. Keyed
   *  by file name; a file whose mtime and size still match is not opened —
   *  a conversation that asked about ten pages carries megabytes of page
   *  images, and JSON.parse in main holds every window while it runs. A
   *  write from this store fills its entry from the list it wrote, so the
   *  next listing parses nothing at all. */
  const summaries = new Map<string, CachedSummary>()

  async function remember(name: string, doc: ConversationDoc): Promise<void> {
    try {
      const st = await stat(join(dir, name))
      summaries.set(name, { mtimeMs: st.mtimeMs, size: st.size, list: summarizeConversations(doc) })
    } catch {
      summaries.delete(name)
    }
  }

  async function readDoc(file: string): Promise<ConversationDoc | null> {
    opts.onParse?.(file)
    try {
      return sanitizeConversationDoc(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      return null
    }
  }

  async function write(path: string, name: string, list: StoredConversation[]): Promise<void> {
    const key = keyOf(path)
    const file = fileOf(key)
    if (list.length === 0) {
      await unlink(file).catch(() => {})
      summaries.delete(`${key}.json`)
      return
    }
    await mkdir(dir, { recursive: true })
    const doc: ConversationDoc = { path, name: name.trim() || docNameFromPath(path), conversations: list }
    await writeAtomic(file, JSON.stringify(doc))
    await remember(`${key}.json`, doc)
  }

  async function listSummaries(): Promise<ConversationSummary[]> {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => ENTRY_FILE.test(n))
    } catch {
      summaries.clear()
      return []
    }
    const present = new Set(names)
    for (const name of summaries.keys()) if (!present.has(name)) summaries.delete(name)
    const lists = await Promise.all(
      names.map(async (name) => {
        let st
        try {
          st = await stat(join(dir, name))
        } catch {
          return []
        }
        const have = summaries.get(name)
        if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return have.list
        const doc = await readDoc(join(dir, name))
        // An unreadable file lists as nothing, and is tried again when it changes
        const list = doc ? summarizeConversations(doc) : []
        summaries.set(name, { mtimeMs: st.mtimeMs, size: st.size, list })
        return list
      })
    )
    return byNewest(lists.flat())
  }

  async function allDocs(): Promise<ConversationDoc[]> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const docs = await Promise.all(names.filter((n) => ENTRY_FILE.test(n)).map((n) => readDoc(join(dir, n))))
    return docs.filter((d): d is ConversationDoc => d !== null)
  }

  return {
    get: async (path) => {
      const key = keyOf(path)
      await writing.get(key)
      const doc = await readDoc(fileOf(key))
      // The file is keyed by the path's hash: a collision would hand one
      // document another's conversations, so the path inside must agree.
      return doc && doc.path === path ? doc.conversations : []
    },
    set: (path, name, list) => {
      const key = keyOf(path)
      const clean = sanitizeConversations(list)
      const prev = writing.get(key) ?? Promise.resolve()
      const next = prev.catch(() => {}).then(() => write(path, name, clean))
      writing.set(key, next)
      void next.finally(() => {
        if (writing.get(key) === next) writing.delete(key)
      })
      return next
    },
    list: listSummaries,
    all: allDocs
  }
}

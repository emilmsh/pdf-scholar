// Per-document AI conversation persistence, mirroring the pdfx-custom-colors
// localStorage pattern in annotations.ts. Renderer-only by design: works
// identically in Electron and the dev:web fallback.
import type { AiContentPart, AiUsage } from '../../shared/types'

export type ChatMessage =
  | { role: 'user'; text: string; display?: string }
  | { role: 'assistant'; parts: AiContentPart[]; usage?: AiUsage; model?: string; error?: string }

export interface StoredConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

const LS_KEY = 'pdfx-ai-chats'
const MAX_CHATS_PER_DOC = 10
const MAX_DOCS = 30

type ChatStore = Record<string, StoredConversation[]>

export const newConversationId = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const readStore = (): ChatStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const validConversation = (c: unknown): c is StoredConversation => {
  const x = c as StoredConversation
  return (
    !!x && typeof x.id === 'string' && typeof x.title === 'string' &&
    typeof x.updatedAt === 'number' && Array.isArray(x.messages)
  )
}

export function loadConversations(docPath: string): StoredConversation[] {
  const list = readStore()[docPath]
  return Array.isArray(list) ? list.filter(validConversation) : []
}

/** Write one doc's conversation list (newest first). Caps per-doc count,
 *  evicts the oldest documents beyond MAX_DOCS, and retries once with an
 *  aggressive prune if the quota is hit. */
export function saveConversations(docPath: string, list: StoredConversation[]): void {
  const store = readStore() // fresh read: minimizes clobbering across windows
  store[docPath] = list.slice(0, MAX_CHATS_PER_DOC)
  if (store[docPath].length === 0) delete store[docPath]
  const prune = (max: number): void => {
    const docs = Object.keys(store)
    if (docs.length <= max) return
    docs
      .sort((a, b) => (store[b][0]?.updatedAt ?? 0) - (store[a][0]?.updatedAt ?? 0))
      .slice(max)
      .forEach((k) => { if (k !== docPath) delete store[k] })
  }
  prune(MAX_DOCS)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch {
    prune(5)
    try { localStorage.setItem(LS_KEY, JSON.stringify(store)) } catch { /* give up quietly */ }
  }
}

export function deleteConversation(docPath: string, id: string): StoredConversation[] {
  const next = loadConversations(docPath).filter((c) => c.id !== id)
  saveConversations(docPath, next)
  return next
}

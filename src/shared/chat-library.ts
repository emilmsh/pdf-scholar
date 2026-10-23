// The library's «Samtaler» view (issue #46): every conversation the store
// keeps, grouped by document, and the one-off tidying it offers.
//
// Tidying is a set of ONE-OFF actions, never a standing rule: «keep six
// months» as a setting is the silent eviction the durable store was built to
// end. Each action is a pure SELECTION here — which conversations of which
// documents — so the view can say exactly what it will take («Sletter 42
// samtaler om 17 dokumenter») before anything is taken, and the count it
// shows is the count the deletion uses. Pure, Node-testable
// (scripts/test-chat-history.mjs).
import type { ConversationHit, ConversationMeta } from './chat-history'
import { byNewest } from './chat-history'

export interface DocGroup<T extends ConversationMeta = ConversationHit> {
  docPath: string
  docName: string
  /** Newest first */
  items: T[]
  /** The newest conversation's time — groups list newest first */
  newest: number
}

/** Conversations by document: each group newest first, the groups in the
 *  order of their newest conversation */
export function groupByDocument<T extends ConversationMeta>(list: T[]): DocGroup<T>[] {
  return sortGroups(list, 'updated')
}

/** The orders the «Samtaler» view offers. A document's group sorts by its
 *  best item on the same key — its newest change, its newest conversation,
 *  its longest one — except by name, where the documents go A–Å and each
 *  group's conversations stay newest first. */
export type ConversationSort = 'updated' | 'created' | 'name' | 'messages'
export const SORTS: ConversationSort[] = ['updated', 'created', 'name', 'messages']

export const sortOrDefault = (v: unknown): ConversationSort =>
  SORTS.includes(v as ConversationSort) ? (v as ConversationSort) : 'updated'

const itemKey = (sort: ConversationSort, c: ConversationMeta): number =>
  sort === 'created' ? c.createdAt : sort === 'messages' ? c.messageCount : c.updatedAt

export function sortGroups<T extends ConversationMeta>(list: T[], sort: ConversationSort): DocGroup<T>[] {
  const groups = new Map<string, DocGroup<T>>()
  for (const c of byNewest(list)) {
    let g = groups.get(c.docPath)
    if (!g) {
      g = { docPath: c.docPath, docName: c.docName, items: [], newest: c.updatedAt }
      groups.set(c.docPath, g)
    }
    g.items.push(c)
  }
  const out = [...groups.values()]
  for (const g of out) {
    // Ties keep the newest-first order byNewest gave (Array.sort is stable)
    if (sort === 'created' || sort === 'messages') g.items.sort((a, b) => itemKey(sort, b) - itemKey(sort, a))
  }
  const best = (g: DocGroup<T>): number => Math.max(...g.items.map((c) => itemKey(sort, c)))
  if (sort === 'name') {
    out.sort((a, b) => a.docName.localeCompare(b.docName, undefined, { sensitivity: 'base', numeric: true }) || b.newest - a.newest)
  } else {
    out.sort((a, b) => best(b) - best(a) || b.newest - a.newest)
  }
  return out
}

/** The view's filters: a document (from the library's «Vis samtaler»), the
 *  documents whose file is gone, the conversations carrying images */
export interface ConversationFilter {
  doc: string | null
  missing: boolean
  images: boolean
}

export const NO_FILTER: ConversationFilter = { doc: null, missing: false, images: false }

export function applyFilter<T extends ConversationMeta>(list: T[], f: ConversationFilter, gone: ReadonlySet<string>): T[] {
  return list.filter(
    (c) => (f.doc === null || c.docPath === f.doc) && (!f.missing || gone.has(c.docPath)) && (!f.images || c.images > 0)
  )
}

/** A typed «Egendefinert» value: a whole number within the bounds, or null
 *  while the field holds nothing usable (the action then offers nothing) */
export function customNumber(raw: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

/** How many of each document's conversations — the library's badge */
export function countByDocument(list: ConversationMeta[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of list) m.set(c.docPath, (m.get(c.docPath) ?? 0) + 1)
  return m
}

/** Which conversations of which documents: docPath → conversation ids */
export type Selection = Map<string, Set<string>>

function select(list: ConversationMeta[], pick: (c: ConversationMeta) => boolean): Selection {
  const sel: Selection = new Map()
  for (const c of list) {
    if (!pick(c)) continue
    let ids = sel.get(c.docPath)
    if (!ids) sel.set(c.docPath, (ids = new Set()))
    ids.add(c.id)
  }
  return sel
}

/** Every conversation last touched before `cutoff` (ms since epoch) */
export const selectOlderThan = (list: ConversationMeta[], cutoff: number): Selection =>
  select(list, (c) => c.updatedAt < cutoff)

/** Every conversation but the `keep` newest, across all documents. Ties on
 *  the time are broken by document and id, so the count is stable. */
export function selectBeyondNewest(list: ConversationMeta[], keep: number): Selection {
  const ordered = [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.docPath.localeCompare(b.docPath) || a.id.localeCompare(b.id)
  )
  const drop = new Set(ordered.slice(Math.max(0, Math.floor(keep))))
  return select(list, (c) => drop.has(c))
}

/** Every conversation that carries images — what «Fjern bilder» rewrites */
export const selectWithImages = (list: ConversationMeta[]): Selection => select(list, (c) => c.images > 0)

export function selectionSize(sel: Selection): { conversations: number; documents: number } {
  let conversations = 0
  for (const ids of sel.values()) conversations += ids.size
  return { conversations, documents: sel.size }
}

/** The images a selection holds and their size — what removing them frees */
export function selectionImages(list: ConversationMeta[], sel: Selection): { images: number; bytes: number } {
  let images = 0
  let bytes = 0
  for (const c of list) {
    if (!sel.get(c.docPath)?.has(c.id)) continue
    images += c.images
    bytes += c.imageBytes
  }
  return { images, bytes }
}

/** The store at a glance: the line the view heads its tidying with */
export function storageTotals(list: ConversationMeta[]): {
  conversations: number
  documents: number
  images: number
  imageBytes: number
} {
  const docs = new Set<string>()
  let images = 0
  let imageBytes = 0
  for (const c of list) {
    docs.add(c.docPath)
    images += c.images
    imageBytes += c.imageBytes
  }
  return { conversations: list.length, documents: docs.size, images, imageBytes }
}

/** The ages the «Eldre enn» action offers, in months */
export const AGE_CHOICES = [3, 6, 12, 24] as const
/** How many the «Behold bare de nyeste» action offers to keep */
export const KEEP_CHOICES = [50, 100, 250, 500] as const

/** `months` calendar months before `now` */
export function monthsBefore(now: number, months: number): number {
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  return d.getTime()
}

/** Bytes as the view shows them: whole kB below a megabyte, one decimal above */
export function formatBytes(bytes: number, locale?: string): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} kB`
  return `${(bytes / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`
}

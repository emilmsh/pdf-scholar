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
import type { ConversationHit, ConversationSummary } from './chat-history'
import { byNewest } from './chat-history'

export interface DocGroup<T extends ConversationSummary = ConversationHit> {
  docPath: string
  docName: string
  /** Newest first */
  items: T[]
  /** The newest conversation's time — groups list newest first */
  newest: number
}

/** Conversations by document: each group newest first, the groups in the
 *  order of their newest conversation */
export function groupByDocument<T extends ConversationSummary>(list: T[]): DocGroup<T>[] {
  const groups = new Map<string, DocGroup<T>>()
  for (const c of byNewest(list)) {
    let g = groups.get(c.docPath)
    if (!g) {
      g = { docPath: c.docPath, docName: c.docName, items: [], newest: c.updatedAt }
      groups.set(c.docPath, g)
    }
    g.items.push(c)
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest)
}

/** Which conversations of which documents: docPath → conversation ids */
export type Selection = Map<string, Set<string>>

function select(list: ConversationSummary[], pick: (c: ConversationSummary) => boolean): Selection {
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
export const selectOlderThan = (list: ConversationSummary[], cutoff: number): Selection =>
  select(list, (c) => c.updatedAt < cutoff)

/** Every conversation but the `keep` newest, across all documents. Ties on
 *  the time are broken by document and id, so the count is stable. */
export function selectBeyondNewest(list: ConversationSummary[], keep: number): Selection {
  const ordered = [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.docPath.localeCompare(b.docPath) || a.id.localeCompare(b.id)
  )
  const drop = new Set(ordered.slice(Math.max(0, Math.floor(keep))))
  return select(list, (c) => drop.has(c))
}

/** Every conversation that carries images — what «Fjern bilder» rewrites */
export const selectWithImages = (list: ConversationSummary[]): Selection => select(list, (c) => c.images > 0)

export function selectionSize(sel: Selection): { conversations: number; documents: number } {
  let conversations = 0
  for (const ids of sel.values()) conversations += ids.size
  return { conversations, documents: sel.size }
}

/** The images a selection holds and their size — what removing them frees */
export function selectionImages(list: ConversationSummary[], sel: Selection): { images: number; bytes: number } {
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
export function storageTotals(list: ConversationSummary[]): {
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

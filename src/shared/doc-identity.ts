// A document's identity across a move or a rename (issue #46).
//
// Everything the app keeps about a file — reading position, bookmarks,
// recents entry, the AI conversations — is keyed by its path, so a moved or
// renamed PDF opens as a stranger and its records stay behind under a path
// that no longer exists. This module is the one rule that carries them over:
//
//   When a document opens, its FINGERPRINT is recorded for its path. If
//   another path carries the same fingerprint and the file at that path is
//   GONE, that path's records follow the document to its new path.
//
// The fingerprint is the PDF's own permanent identifier: the first string of
// the trailer's /ID array, which every mainstream producer writes and which
// survives our own saves (PDFium keeps /ID[0] on a full rewrite and
// generates a fresh /ID[1]; the incremental appender carries the array over
// — both are checked in test:engine). It is read from the bytes alone, so it
// is known BEFORE the reading position is looked up, at no cost. A file
// without an /ID (a hand-built fixture, some converters) gets no fingerprint
// and so no rebinding. A copy shares its original's fingerprint, which is
// why «gone» is part of the rule: while the original is still there, nothing
// moves, and the copy starts its own history.
//
// Per record kind, the new path keeps what it already has: conversations
// are MERGED (a document opened at the new path before this rule existed
// may have begun a history there), bookmarks and the position move only
// into an empty slot. The old path's records go in every case — that is
// what a move is. Pure, store-injected, Node-testable
// (scripts/test-doc-identity.mjs).
import type { DocBookmark, ReadingPosition } from './types'
import type { StoredConversation } from './chat-history'
import { mergeConversations } from './chat-history'

/** How far from either end the trailer is looked for. The current trailer
 *  is the LAST in the file; a linearized file also carries one at the head. */
const SCAN_BYTES = 2 * 1024 * 1024

/** A fingerprint is lower-case hex; anything shorter than this is not an
 *  identifier anyone meant (producers write 16 bytes, 32 hex characters) */
const MIN_HEX = 8

const ID_ARRAY = /\/ID\s*\[\s*(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\))\s*(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\))?\s*\]/g

function latin1(bytes: Uint8Array): string {
  // TextDecoder('latin1') maps every byte to the code point of the same
  // value, which is what the PDF syntax layer is: bytes, not text
  return new TextDecoder('latin1').decode(bytes)
}

/** The first /ID string as lower-case hex, or null when it is empty, too
 *  short or malformed */
function idStringHex(s: string): string | null {
  let hex: string
  if (s.startsWith('<')) {
    hex = s.slice(1, -1).replace(/\s+/g, '').toLowerCase()
    if (hex.length % 2) hex += '0' // a trailing nibble reads as if followed by 0
  } else {
    // A literal string: undo the escapes, then hex the bytes
    const bytes: number[] = []
    const body = s.slice(1, -1)
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch !== '\\') {
        bytes.push(ch.charCodeAt(0) & 0xff)
        continue
      }
      const next = body[++i]
      if (next === undefined) break
      if (/[0-7]/.test(next)) {
        let oct = next
        while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i]
        bytes.push(parseInt(oct, 8) & 0xff)
      } else {
        const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
        bytes.push(map[next] ?? next.charCodeAt(0))
      }
    }
    hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return hex.length >= MIN_HEX ? hex : null
}

/** The LAST /ID array's first string in `text`, as hex, or null */
function lastIdIn(text: string): string | null {
  let last: RegExpExecArray | null = null
  ID_ARRAY.lastIndex = 0
  for (let m = ID_ARRAY.exec(text); m; m = ID_ARRAY.exec(text)) last = m
  return last ? idStringHex(last[1]) : null
}

/** The document's permanent identifier (/ID[0]) read from its bytes, or null
 *  when the file carries none the rule can trust */
export function pdfFingerprint(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  const tail = bytes.length > SCAN_BYTES ? bytes.subarray(bytes.length - SCAN_BYTES) : bytes
  const fromTail = lastIdIn(latin1(tail))
  if (fromTail || bytes.length <= SCAN_BYTES) return fromTail
  return lastIdIn(latin1(bytes.subarray(0, SCAN_BYTES)))
}

export const validFingerprint = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= MIN_HEX && /^[0-9a-f]+$/.test(v)

/** The stored path → fingerprint map is untrusted input like the rest of
 *  the state file: what still parses, nothing else */
export function sanitizeFingerprints(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [path, fp] of Object.entries(input as Record<string, unknown>)) {
    if (path && validFingerprint(fp)) out[path] = fp
  }
  return out
}

/** The per-path records a platform keeps, as the rule needs them. `set`
 *  with null / an empty list removes the record. */
export interface IdentityStores {
  /** Whether a file is still at this path. A URL that cannot be checked
   *  reads as present — a record is only ever moved away from a path that
   *  is known to be gone. */
  exists(path: string): Promise<boolean>
  position: {
    get(path: string): Promise<ReadingPosition | null>
    set(path: string, pos: ReadingPosition | null): Promise<void>
  }
  bookmarks: {
    get(path: string): Promise<DocBookmark[]>
    set(path: string, list: DocBookmark[]): Promise<void>
  }
  conversations: {
    get(path: string): Promise<StoredConversation[]>
    set(path: string, name: string, list: StoredConversation[]): Promise<void>
  }
  recents: {
    /** Take the entry (and its picture) out; says whether it was pinned */
    takeOut(path: string): Promise<{ pinned: boolean }>
    pin(path: string): Promise<void>
  }
}

export interface RebindResult {
  /** The map with this path recorded and the moved paths dropped */
  map: Record<string, string>
  /** The gone paths whose records followed the document, if any */
  from: string[]
}

/** Record `fingerprint` for `path` and carry over the records of every
 *  other path with the same fingerprint whose file is gone. */
export async function rebindIdentity(
  path: string,
  name: string,
  fingerprint: string,
  map: Record<string, string>,
  stores: IdentityStores
): Promise<RebindResult> {
  const next: Record<string, string> = { ...map, [path]: fingerprint }
  const gone: string[] = []
  for (const other of Object.keys(map).sort()) {
    if (other === path || map[other] !== fingerprint) continue
    if (!(await stores.exists(other))) gone.push(other)
  }
  if (gone.length === 0) return { map: next, from: [] }

  // Conversations: merged, the old lists removed
  let chats = await stores.conversations.get(path)
  let chatsChanged = false
  for (const other of gone) {
    const old = await stores.conversations.get(other)
    if (old.length === 0) continue
    chats = mergeConversations(chats, old)
    chatsChanged = true
    await stores.conversations.set(other, '', [])
  }
  if (chatsChanged) await stores.conversations.set(path, name, chats)

  // Bookmarks and the reading position: into an empty slot only
  let haveBookmarks = (await stores.bookmarks.get(path)).length > 0
  let havePosition = (await stores.position.get(path)) !== null
  for (const other of gone) {
    const bookmarks = await stores.bookmarks.get(other)
    if (bookmarks.length > 0) {
      if (!haveBookmarks) {
        await stores.bookmarks.set(path, bookmarks)
        haveBookmarks = true
      }
      await stores.bookmarks.set(other, [])
    }
    const pos = await stores.position.get(other)
    if (pos !== null) {
      if (!havePosition) {
        await stores.position.set(path, pos)
        havePosition = true
      }
      await stores.position.set(other, null)
    }
  }

  // The recents entry of a gone file is a dead entry; a pin follows the file
  let pinned = false
  for (const other of gone) {
    const taken = await stores.recents.takeOut(other)
    pinned = pinned || taken.pinned
    delete next[other]
  }
  if (pinned) await stores.recents.pin(path)

  return { map: next, from: gone }
}

// Reading TOGETHER with an AI tool outside the app (Emil, 2026-11-24): the
// tool the reader is talking to — Claude Code, Codex — may point at a passage
// in the RUNNING app, read a document's text as the app sees it, and ask what
// the reader has in front of them. This is the part of that with no side
// effects: what travels between the MCP server's process (src/main/
// mcp-server.ts) and the app (src/main/tool-bridge.ts), and what the app
// keeps of it.
//
// What a tool said about a document is KEPT, as a list the reader takes at
// their own pace — a reference is a claim with the passage that carries it,
// and it must still be there after the reader has looked elsewhere. The list
// is per SESSION of the tool, across documents (literature work hops between
// papers); the session is the server's process, which a tool starts once per
// session of its own (measured: five sessions, five processes).
//
// Everything here crosses a process boundary or comes back from disk, so
// every reader of it is a sanitizer: a request from the pipe, a session from
// its file. Pure and renderer-safe (no Node imports); tested by
// scripts/test-tool-bridge.mjs.
import type { McpClient } from './mcp'

// ---------- Where the app listens ----------

/** FNV-1a, twice with different seeds — a name for the pipe, not a secret
 *  (the token is the secret). Hand-rolled so this file stays free of Node. */
function nameHash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** The pipe the app listens on for one userData folder: a named pipe on
 *  Windows (no file, no network port), a socket file inside userData
 *  elsewhere. Two installs with separate userData (the portable zip beside
 *  the installer) get separate pipes. */
export function bridgePipePath(dataDir: string, platform: string): string {
  if (platform === 'win32') {
    // The same folder spelled with either slash or case is the same pipe
    return `\\\\.\\pipe\\pdf-scholar-bridge-${nameHash(dataDir.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase())}`
  }
  const inData = `${dataDir.replace(/\/+$/, '')}/tool-bridge.sock`
  // A socket's path has a hard length limit (104 bytes on macOS, 108 on
  // Linux), and a bind past it simply fails. A profile folder that deep gets
  // its socket in /tmp under the folder's hash instead.
  return inData.length <= 100 ? inData : `/tmp/pdf-scholar-bridge-${nameHash(dataDir)}.sock`
}

/** The file main writes its token to, beside the state file — readable by
 *  the reader's own account, which is who may start the server */
export const BRIDGE_TOKEN_FILE = 'tool-bridge.json'

// ---------- What a tool asks ----------

export const MAX_QUOTE = 2000
export const MAX_CLAIM = 600
export const MAX_TOPIC = 120
const MAX_PATH = 4096
const MAX_PAGE = 100_000
/** Pages one read may span — the answer is cut to the server's own cap anyway */
export const MAX_READ_PAGES = 400

export interface BridgeSessionInfo {
  /** The server process's own id: random, made once at its start */
  id: string
  client: McpClient
  startedAt: number
}

export type BridgeRequest =
  | { op: 'ping' }
  /** A claim's passage: kept in the session's list, and shown now when asked.
   *  `n` is the number the CALLER has given the citation — a program that
   *  numbers its citations itself, across several sources of which this app
   *  holds some (a plugin with a Word file as [1] and a PDF as [2]): the
   *  card then carries that number, so it reads the same in both places.
   *  Absent, the app numbers it. */
  | { op: 'cite'; path: string; page: number; quote: string; claim?: string; topic?: string; n?: number; show: boolean }
  /** A document's text as the app sees it, page by page */
  | { op: 'read'; path: string; from: number; to: number }
  /** What the reader has in front of them */
  | { op: 'context' }

export interface BridgeEnvelope {
  token: string
  session: BridgeSessionInfo
  request: BridgeRequest
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Text as it is kept and shown: no control characters, runs of blanks kept
 *  as one, cut to its cap */
function tidy(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim()
  return s.length > max ? s.slice(0, max) : s
}

const pathOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length < MAX_PATH && !v.includes('\u0000') ? v.trim() : null

const pageOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_PAGE ? Math.floor(v) : null

/** A reference's number: a whole one from 1, bounded; anything else is 0 = none */
const numberOf = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : 0

const CLIENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'other'])

function sessionOf(v: unknown): BridgeSessionInfo | null {
  if (!isObj(v)) return null
  const id = typeof v.id === 'string' && /^[0-9a-f]{8,64}$/.test(v.id) ? v.id : null
  if (!id || typeof v.client !== 'string' || !CLIENTS.has(v.client)) return null
  const startedAt = typeof v.startedAt === 'number' && Number.isFinite(v.startedAt) && v.startedAt > 0 ? v.startedAt : 0
  return { id, client: v.client as McpClient, startedAt }
}

export function sanitizeBridgeRequest(v: unknown): BridgeRequest | null {
  if (!isObj(v)) return null
  if (v.op === 'ping' || v.op === 'context') return { op: v.op }
  const path = pathOf(v.path)
  if (!path) return null
  if (v.op === 'cite') {
    const page = pageOf(v.page)
    const quote = tidy(v.quote, MAX_QUOTE)
    if (!page || !quote) return null
    const claim = tidy(v.claim, MAX_CLAIM)
    const topic = tidy(v.topic, MAX_TOPIC)
    const n = numberOf(v.n)
    return {
      op: 'cite',
      path,
      page,
      quote,
      ...(claim ? { claim } : {}),
      ...(topic ? { topic } : {}),
      ...(n ? { n } : {}),
      show: v.show !== false
    }
  }
  if (v.op === 'read') {
    const from = pageOf(v.from) ?? 1
    const to = Math.min(pageOf(v.to) ?? from, from + MAX_READ_PAGES - 1)
    return to >= from ? { op: 'read', path, from, to } : null
  }
  return null
}

/** One line off the pipe. Anything that is not exactly a request is null —
 *  the app answers `bad-request` and does nothing. */
export function sanitizeBridgeEnvelope(v: unknown): BridgeEnvelope | null {
  if (!isObj(v) || typeof v.token !== 'string' || v.token.length < 16 || v.token.length > 128) return null
  const session = sessionOf(v.session)
  const request = sanitizeBridgeRequest(v.request)
  return session && request ? { token: v.token, session, request } : null
}

// ---------- What the app answers ----------

export type BridgeErrorCode =
  /** «Les sammen» is off in the app */
  | 'bridge-off'
  /** This tool's own switch is off */
  | 'client-off'
  | 'bad-request'
  | 'bad-token'
  /** The document, or a folder it lies under, is kept out */
  | 'kept-out'
  /** Password-protected: never read, never shown on a tool's word */
  | 'locked'
  /** No such file, or not one the app could open as a PDF */
  | 'unreadable'
  /** On another machine (a UNC path), and not a document the reader has open */
  | 'not-local'
  /** Larger than the app reads without the reader opening it */
  | 'too-large'
  /** No window to show it in, or the window did not answer in time */
  | 'no-window'
  | 'timeout'

export type OpenDocument =
  /** A document kept out or locked is open: the tool learns that much, and
   *  nothing about which */
  | { withheld: true }
  | {
      withheld?: undefined
      /** Full path — what lets the tool find the same file in its project.
       *  Shared only under this switch, and said so where it is turned on. */
      path: string
      name: string
      page: number
      pageCount: number
      /** The text the reader has selected ('' = none), cut to MAX_SELECTION */
      selection: string
    }

export const MAX_SELECTION = 8000

export type BridgeReply =
  | { ok: false; error: BridgeErrorCode }
  | { ok: true; op: 'ping'; version: string }
  | {
      ok: true
      op: 'cite'
      /** The reference's number in this session — what the tool writes as
       *  «[3]» beside its claim, and what the reader sees on the card */
      n: number
      /** The quote occurs in the document's text */
      found: boolean
      /** Every character of it, not only an anchor of it */
      whole: boolean
      /** Where it was found — the cited page when it was not */
      page: number
      citedPage: number
      pageCount: number
      /** The document has no text the app could search (a scan not yet read) */
      hasText: boolean
      /** The window was brought up on the passage */
      shown: boolean
    }
  | { ok: true; op: 'read'; pageCount: number; hasText: boolean; pages: { page: number; text: string }[] }
  | { ok: true; op: 'context'; open: OpenDocument | null }

// ---------- Main ↔ the window that holds the document ----------

/** What main asks a viewer window. `bytes` is the file as main read it, for a
 *  document no tab holds: the text is then read from a throwaway pdf.js
 *  document, without opening a tab or filing the file as just opened. */
export type ViewRequest =
  | { op: 'cite'; path: string; page: number; quote: string; show: boolean; bytes?: Uint8Array }
  | { op: 'read'; path: string; from: number; to: number; bytes?: Uint8Array }
  | { op: 'context' }
  /** Whether a tab holds the path — main reads no bytes for one that does */
  | { op: 'holds'; path: string }

export type ViewReply =
  | { ok: false; error: 'locked' | 'unreadable' | 'no-window' }
  | { ok: true; op: 'holds'; holds: boolean }
  | { ok: true; op: 'cite'; found: boolean; whole: boolean; page: number; pageCount: number; hasText: boolean }
  | { ok: true; op: 'read'; pageCount: number; hasText: boolean; pages: { page: number; text: string }[] }
  | {
      ok: true
      op: 'context'
      open: { path: string; name: string; page: number; pageCount: number; selection: string; locked: boolean } | null
    }

// ---------- What the app keeps ----------

export type ToolEntry =
  | {
      kind: 'reference'
      id: string
      at: number
      /** Its number in the session, from 1. What ties a claim in the tool's
       *  own answer («… [3]») to this card: a list of page chips alone says
       *  nothing about which claim each belongs to (Emil's first real test,
       *  2026-11-24). Never reused, so a number already read stays true. */
      n: number
      docPath: string
      docName: string
      /** Where the passage is — the cited page when it was not found */
      page: number
      quote: string
      claim?: string
      found: boolean
      whole: boolean
    }
  /** The tool read these pages' text. Listed because the reader should see
   *  what left, not only what was pointed at. */
  | { kind: 'read'; id: string; at: number; docPath: string; docName: string; from: number; to: number }
  /** The tool asked what was open; `selection` = it got selected text */
  | { kind: 'context'; id: string; at: number; docPath?: string; docName?: string; selection: boolean }

export interface ToolSession {
  id: string
  client: McpClient
  /** The topic the tool gave, when it gave one — the list's heading */
  title: string
  startedAt: number
  updatedAt: number
  entries: ToolEntry[]
}

/** The most one session keeps; the oldest go first. A list this long is a log
 *  nobody reads from the top. */
export const MAX_SESSION_ENTRIES = 1000
/** The most sessions kept; the least recently used go first */
export const MAX_SESSIONS = 300

const idOf = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-z-]{4,64}$/i.test(v) ? v : null)
const timeOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function entryOf(v: unknown): ToolEntry | null {
  if (!isObj(v)) return null
  const id = idOf(v.id)
  const at = timeOf(v.at)
  if (!id || !at) return null
  if (v.kind === 'context') {
    const docPath = pathOf(v.docPath)
    const docName = tidy(v.docName, 300)
    return { kind: 'context', id, at, ...(docPath && docName ? { docPath, docName } : {}), selection: v.selection === true }
  }
  const docPath = pathOf(v.docPath)
  const docName = tidy(v.docName, 300)
  if (!docPath || !docName) return null
  if (v.kind === 'read') {
    const from = pageOf(v.from)
    const to = pageOf(v.to)
    return from && to && to >= from ? { kind: 'read', id, at, docPath, docName, from, to } : null
  }
  if (v.kind === 'reference') {
    const page = pageOf(v.page)
    const quote = tidy(v.quote, MAX_QUOTE)
    if (!page || !quote) return null
    const claim = tidy(v.claim, MAX_CLAIM)
    return {
      kind: 'reference',
      id,
      at,
      // 0 = none stored: sanitizeToolSession numbers it
      n: numberOf(v.n),
      docPath,
      docName,
      page,
      quote,
      ...(claim ? { claim } : {}),
      found: v.found === true,
      whole: v.found === true && v.whole === true
    }
  }
  return null
}

/** A session from its file: untrusted, like every stored record. An id twice
 *  keeps its first; a session with nothing readable in it is nothing. */
export function sanitizeToolSession(v: unknown): ToolSession | null {
  if (!isObj(v)) return null
  const info = sessionOf({ id: v.id, client: v.client, startedAt: v.startedAt })
  if (!info) return null
  const seen = new Set<string>()
  const entries: ToolEntry[] = []
  for (const raw of Array.isArray(v.entries) ? v.entries.slice(-MAX_SESSION_ENTRIES * 2) : []) {
    const e = entryOf(raw)
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    entries.push(e)
  }
  if (entries.length === 0) return null
  // Every reference has a number, and no two the same: one without, or one
  // whose number is already taken, gets the next free one
  const taken = new Set<number>()
  let top = Math.max(0, ...entries.map((e) => (e.kind === 'reference' ? e.n : 0)))
  for (const e of entries) {
    if (e.kind !== 'reference') continue
    if (e.n === 0 || taken.has(e.n)) e.n = ++top
    taken.add(e.n)
  }
  const kept = entries.slice(-MAX_SESSION_ENTRIES)
  return {
    ...info,
    title: tidy(v.title, MAX_TOPIC),
    updatedAt: Math.max(timeOf(v.updatedAt), kept[kept.length - 1].at),
    entries: kept
  }
}

/** The session with one more entry. The first topic a tool gives names the
 *  session; a later one does not rename what the reader has already seen. */
export function withToolEntry(
  session: ToolSession | null,
  info: BridgeSessionInfo,
  entry: ToolEntry,
  topic?: string
): ToolSession {
  const base: ToolSession = session ?? { ...info, title: '', updatedAt: entry.at, entries: [] }
  // The next number after the highest ever given here — not the count, which
  // would hand an old number out again once the list has dropped its oldest
  if (entry.kind === 'reference' && !(entry.n >= 1)) {
    entry = { ...entry, n: Math.max(0, ...base.entries.map((e) => (e.kind === 'reference' ? e.n : 0))) + 1 }
  }
  return {
    ...base,
    title: base.title || tidy(topic, MAX_TOPIC),
    updatedAt: Math.max(base.updatedAt, entry.at),
    entries: [...base.entries, entry].slice(-MAX_SESSION_ENTRIES)
  }
}

/** What a window is told when a session's list changes */
export interface ToolSessionsChange {
  sessionId: string
  /** A passage was just brought up IN THIS WINDOW: the assistant panel opens
   *  on the list, so the claim and its passage are seen together */
  shownHere: boolean
  docPath?: string
}

/** A session as a list row: no entries, only what the row shows */
export interface ToolSessionMeta {
  id: string
  client: McpClient
  title: string
  startedAt: number
  updatedAt: number
  references: number
  /** How many references name this document (the row's count when filtered) */
  documents: string[]
}

export function toolSessionMeta(s: ToolSession): ToolSessionMeta {
  const refs = s.entries.filter((e) => e.kind === 'reference')
  return {
    id: s.id,
    client: s.client,
    title: s.title,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    references: refs.length,
    documents: [...new Set(refs.map((e) => e.docPath))]
  }
}

/** The reference a session already holds for these words in this document:
 *  a tool that shows a passage again («vis meg [3]») gets the SAME number
 *  back instead of a second card. Paths compare with either slash and any
 *  case; the quote must be the same words. */
export function sameReference(
  session: ToolSession | null,
  docPath: string,
  quote: string
): Extract<ToolEntry, { kind: 'reference' }> | null {
  const key = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
  const words = (q: string): string => q.replace(/\s+/g, ' ').trim()
  const want = words(quote)
  for (const e of session?.entries ?? []) {
    if (e.kind === 'reference' && key(e.docPath) === key(docPath) && words(e.quote) === want) return e
  }
  return null
}

/** The references of one session, newest last, optionally of one document */
export function referencesOf(s: ToolSession, docPath?: string): Extract<ToolEntry, { kind: 'reference' }>[] {
  return s.entries.filter(
    (e): e is Extract<ToolEntry, { kind: 'reference' }> => e.kind === 'reference' && (docPath === undefined || e.docPath === docPath)
  )
}

// «Les sammen», the window's half (shared/tool-bridge.ts has the contract,
// src/main/tool-bridge.ts decides which window is asked): what an AI tool
// outside the app asks of the documents this window holds.
//
// - A passage a tool cites is looked up in the document's text by the SAME
//   rule a source chip in the assistant uses (resolveQuote in ai.ts): the
//   cited page first, then its neighbours, never a guess — and, since a tool
//   is more often wrong about the page than the app's own assistant, then the
//   rest of the document. Found or not is the answer the tool gets; that is
//   what lets it say «unverified» instead of sounding sure.
// - A document a tab holds answers from the tab, with the text the reader
//   sees (OCR included). One no tab holds is read from the bytes main sends,
//   in a throwaway pdf.js document, own text only — no tab opens, nothing is
//   filed as just opened, and nothing is recognised on the tool's word. Only
//   a passage the tool asked to SHOW opens a tab.
// - A password-protected document answers `locked`, whichever way it is met.
//
// Each mounted viewer registers what it can do for its document; App says how
// a path is opened and brought forward. Nothing here runs unless main sends a
// request, and main sends none unless the switches are on.
import { docNameFromPath } from '../../shared/chat-history'
import type { ViewReply, ViewRequest } from '../../shared/tool-bridge'
import { MAX_SELECTION, pathKey } from '../../shared/tool-bridge'
import type { ResolvedCitation } from './ai'
import { citedPage, locatePassage } from './ai'
import { isPasswordException, openDocument } from './pdf-doc'
import { buildPageTexts, hasExtractableText, type PageText } from './search'

export interface DocumentText {
  pages: PageText[]
  hasText: boolean
}

export interface ToolViewer {
  /** The path the tab holds the document under */
  path: string
  /** Opened with a password, or waiting for one */
  locked(): boolean
  page(): number
  pageCount(): number
  /** The document's text as the reader's search and assistant read it; null
   *  while it is not loaded yet */
  texts(): Promise<DocumentText | null>
  /** Go to the passage and mark it — start === end is «just the page». The
   *  mark stays until the reader clicks in the document: they come to it
   *  from another program, in their own time. */
  jump(target: ResolvedCitation): void
  /** What the reader has selected in this document ('' = nothing) */
  selection(): string
}

export interface ToolShell {
  /** Bring the path's tab forward; false when no tab holds it */
  front(path: string): boolean
  open(path: string): Promise<void>
  activePath(): string | null
}

// The renderer's components take the path rule from here, with the rest
export { pathKey }

const viewers = new Map<string, ToolViewer>()
let shell: ToolShell | null = null

export function registerToolViewer(viewer: ToolViewer): () => void {
  const key = pathKey(viewer.path)
  viewers.set(key, viewer)
  return () => {
    if (viewers.get(key) === viewer) viewers.delete(key)
  }
}

export function registerToolShell(s: ToolShell): () => void {
  shell = s
  return () => {
    if (shell === s) shell = null
  }
}

// ---------- A reference pressed in ANOTHER document's panel ----------
//
// The list spans documents; pressing a reference into one that is not in
// front opens it (a tab here), and the viewer that ends up showing it takes
// the passage from here — the same handoff a conversation's source chip makes
// (chat-store.ts requestConversationOpen), kept in the window's own memory.

/** A passage to go to once its document is in front. The viewer that takes
 *  it also opens its assistant panel on the list of references, where the
 *  reader pressed it. */
export interface PendingPassage {
  page: number
  quote: string
}

const pendingPassages = new Map<string, PendingPassage>()
const passageListeners = new Set<() => void>()

export function requestPassageOpen(path: string, passage: PendingPassage): void {
  pendingPassages.set(pathKey(path), passage)
  for (const listener of [...passageListeners]) listener()
}

export const hasPendingPassage = (path: string): boolean => pendingPassages.has(pathKey(path))

export function takePendingPassage(path: string): PendingPassage | null {
  const key = pathKey(path)
  const passage = pendingPassages.get(key) ?? null
  pendingPassages.delete(key)
  return passage
}

export function onPassageRequest(cb: () => void): () => void {
  passageListeners.add(cb)
  return () => {
    passageListeners.delete(cb)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The text of documents read without a tab, kept a while: a tool that cites
 *  ten passages of one paper should not have it parsed ten times */
const QUIET_TTL_MS = 10 * 60_000
const QUIET_KEEP = 3
const quiet = new Map<string, { at: number; text: DocumentText }>()

function quietText(path: string): DocumentText | null {
  const hit = quiet.get(pathKey(path))
  if (!hit) return null
  if (Date.now() - hit.at > QUIET_TTL_MS) {
    quiet.delete(pathKey(path))
    return null
  }
  return hit.text
}

async function textFromBytes(path: string, bytes: Uint8Array): Promise<DocumentText | 'locked' | 'unreadable'> {
  const resources = openDocument(bytes)
  try {
    const pdf = await resources.task.promise
    const pages = await buildPageTexts(pdf, { ownOnly: true })
    const text = { pages, hasText: hasExtractableText(pages) }
    quiet.set(pathKey(path), { at: Date.now(), text })
    while (quiet.size > QUIET_KEEP) quiet.delete(quiet.keys().next().value as string)
    return text
  } catch (err) {
    return isPasswordException(err) ? 'locked' : 'unreadable'
  } finally {
    void resources.task.destroy()
    resources.port.terminate()
  }
}

/** A tab's text, waited for while the document is still loading — a tab just
 *  opened registers before pdf.js has read the file, and registers anew once
 *  it has (so the map is asked again each time) */
async function tabText(path: string, waitMs: number): Promise<{ viewer: ToolViewer; text: DocumentText } | 'locked' | null> {
  for (let waited = 0; waited <= waitMs; waited += 150) {
    const viewer = viewers.get(pathKey(path))
    if (viewer?.locked()) return 'locked'
    const text = viewer ? await viewer.texts() : null
    if (viewer && text) return { viewer, text }
    await sleep(150)
  }
  return null
}

/** The document's text, from its tab or from the bytes main sent */
async function documentText(
  path: string,
  bytes: Uint8Array | undefined
): Promise<{ viewer: ToolViewer | null; text: DocumentText } | 'locked' | 'unreadable'> {
  if (viewers.has(pathKey(path))) return (await tabText(path, 45_000)) ?? 'unreadable'
  const kept = quietText(path)
  if (kept) return { viewer: null, text: kept }
  if (!bytes) return 'unreadable'
  const read = await textFromBytes(path, bytes)
  return typeof read === 'string' ? read : { viewer: null, text: read }
}

/** Where a reference the reader pressed goes: its passage, else its page
 *  alone (start === end) */
export const passageTarget = (pages: PageText[], page: number, quote: string): ResolvedCitation =>
  locatePassage(pages, page, quote)?.target ?? { pageNumber: page, start: 0, end: 0 }

async function cite(req: Extract<ViewRequest, { op: 'cite' }>): Promise<ViewReply> {
  // Shown = in a tab. One that is not open is opened, like any file
  if (req.show && !viewers.has(pathKey(req.path))) {
    if (!shell) return { ok: false, error: 'no-window' }
    await shell.open(req.path)
    for (let waited = 0; waited < 15_000 && !viewers.has(pathKey(req.path)); waited += 100) await sleep(100)
    // The file would not open (gone, not a PDF): the app has said so itself
    if (!viewers.has(pathKey(req.path))) return { ok: false, error: 'unreadable' }
  }
  const doc = await documentText(req.path, req.bytes)
  if (typeof doc === 'string') return { ok: false, error: doc }
  const { pages, hasText } = doc.text
  const cited = citedPage(pages, req.page)
  const hit = locatePassage(pages, req.page, req.quote)
  if (req.show && doc.viewer) {
    shell?.front(req.path)
    doc.viewer.jump(hit?.target ?? { pageNumber: cited, start: 0, end: 0 })
  }
  return {
    ok: true,
    op: 'cite',
    found: hit !== null,
    whole: hit?.whole ?? false,
    page: hit?.target.pageNumber ?? cited,
    pageCount: pages.length,
    hasText
  }
}

async function read(req: Extract<ViewRequest, { op: 'read' }>): Promise<ViewReply> {
  const doc = await documentText(req.path, req.bytes)
  if (typeof doc === 'string') return { ok: false, error: doc }
  const { pages, hasText } = doc.text
  const from = Math.max(1, req.from)
  const to = Math.min(pages.length, req.to)
  return {
    ok: true,
    op: 'read',
    pageCount: pages.length,
    hasText,
    pages: pages.slice(from - 1, to).map((p, i) => ({ page: from + i, text: p.text }))
  }
}

function context(): ViewReply {
  const path = shell?.activePath() ?? null
  const viewer = path ? viewers.get(pathKey(path)) : undefined
  if (!viewer) return { ok: true, op: 'context', open: null }
  const locked = viewer.locked()
  return {
    ok: true,
    op: 'context',
    open: {
      path: viewer.path,
      name: docNameFromPath(viewer.path),
      page: viewer.page(),
      pageCount: viewer.pageCount(),
      // A locked document's selection never leaves the window at all
      selection: locked ? '' : viewer.selection().slice(0, MAX_SELECTION),
      locked
    }
  }
}

/** One request from main, answered. Never throws: a failure is `unreadable`. */
export async function answerToolRequest(req: ViewRequest): Promise<ViewReply> {
  try {
    if (req.op === 'holds') {
      // A tab, or text kept from a read a moment ago: either answers without
      // main reading the file again
      return { ok: true, op: 'holds', holds: viewers.has(pathKey(req.path)) || quietText(req.path) !== null }
    }
    if (req.op === 'context') return context()
    if (req.op === 'cite') return await cite(req)
    return await read(req)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}

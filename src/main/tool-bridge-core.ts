// The bridge between the MCP server's process and the RUNNING app
// (shared/tool-bridge.ts), without Electron: the pipe both ends speak over,
// and the rules the app answers by. src/main/tool-bridge.ts wires the rules
// to real windows; scripts/test-tool-bridge.mjs wires them to fakes.
//
// One named pipe per userData folder — no network port is opened — and one
// JSON line each way per request. The rules, in the order they are asked:
// - The line must be exactly a request (sanitizeBridgeEnvelope) carrying the
//   token main wrote beside the state file when it started listening. The
//   pipe's name is guessable; the token is what says the caller could read
//   the reader's own profile folder.
// - The tool's own switch must be on, and «Les sammen» with it. Both are
//   read at every request, so turning either off takes effect at once.
// - A path must be absolute, and one on another machine (`\\server\share\…`)
//   is followed only to a document the reader has open themselves. What a
//   tool asks for can come out of a PDF written to steer it; a path that
//   makes this machine sign in to a stranger's file server is the request
//   that must not be carried out on a tool's word. And a file the window is
//   asked to OPEN must begin as a PDF does, so a wrong path is an answer to
//   the tool rather than an error on the reader's screen.
// - A document kept out — itself or by a folder — and a password-protected
//   one are refused before any window is asked: neither shown, read nor
//   named. Where the reader has one open, a tool asking what is open learns
//   that something is, and nothing else.
// - What was pointed at and what was read is appended to the session's list
//   (src/main/tool-sessions.ts). A read is listed too: the reader should see
//   what left, not only what was shown.
// - Bringing the window up is asked for last, and only for a passage the tool
//   asked to SHOW. The measurements behind how are in tool-bridge.ts.
import { timingSafeEqual } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { isAbsolute } from 'node:path'
import { docNameFromPath } from '../shared/chat-history'
import { excludedBy, type McpPolicy } from '../shared/mcp'
import {
  MAX_SELECTION,
  sanitizeBridgeEnvelope,
  type BridgeEnvelope,
  type BridgeErrorCode,
  type BridgeReply,
  type BridgeRequest,
  type ToolEntry,
  type ToolSession,
  type ViewReply,
  type ViewRequest
} from '../shared/tool-bridge'
import type { ToolSessionStore } from './tool-sessions'

// ---------- The pipe ----------

/** A request line is small; anything longer is not one of ours */
const MAX_REQUEST_LINE = 64 * 1024

/** Listen on the pipe; every line in is answered with one line out, in the
 *  order the answers are ready. Rejects when the pipe cannot be taken. */
export function listenBridge(pipePath: string, onLine: (line: string) => Promise<object>): Promise<Server> {
  // A socket file left by a run that did not close it would refuse the bind.
  // The single-instance lock means no live app of this profile holds it.
  if (process.platform !== 'win32') {
    try {
      unlinkSync(pipePath)
    } catch {
      /* none there */
    }
  }
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buf += chunk
        if (buf.length > MAX_REQUEST_LINE && !buf.slice(0, MAX_REQUEST_LINE).includes('\n')) {
          socket.destroy()
          return
        }
        for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          void onLine(line)
            .catch((): object => ({ ok: false, error: 'bad-request' }))
            .then((reply) => {
              if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`)
            })
        }
      })
      socket.on('error', () => {
        /* a caller that went away mid-request is not our problem */
      })
    })
    server.once('error', reject)
    server.listen(pipePath, () => {
      server.off('error', reject)
      server.on('error', () => {
        /* a broken connection must not take main down */
      })
      resolve(server)
    })
  })
}

/** Why a call got no answer from an app: nothing listens, it took too long,
 *  or what came back was not an answer */
export type BridgeCallFailure = 'not-running' | 'timeout' | 'bad-reply'

/** One request to the app, from the server's process */
export function bridgeCall(
  pipePath: string,
  envelope: BridgeEnvelope,
  timeoutMs: number
): Promise<BridgeReply | { ok: false; failure: BridgeCallFailure }> {
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    const socket = connect(pipePath)
    const finish = (value: BridgeReply | { ok: false; failure: BridgeCallFailure }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(envelope)}\n`))
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as unknown
        finish(
          parsed && typeof parsed === 'object' && typeof (parsed as { ok?: unknown }).ok === 'boolean'
            ? (parsed as BridgeReply)
            : { ok: false, failure: 'bad-reply' }
        )
      } catch {
        finish({ ok: false, failure: 'bad-reply' })
      }
    })
    // ENOENT: no pipe of that name; ECONNREFUSED: a socket file nobody holds
    socket.on('error', () => finish({ ok: false, failure: 'not-running' }))
    socket.on('close', () => finish({ ok: false, failure: 'bad-reply' }))
  })
}

// ---------- The rules ----------

export interface BridgeDeps {
  token: string
  version: string
  /** Whether paths compare without case (Windows and macOS) */
  foldCase: boolean
  /** The switches, read at every request */
  policy(): McpPolicy
  store: ToolSessionStore
  /** The path as the app spells it: absolute, long form */
  canonical(path: string): string
  /** Whether the app holds a password for the document (it was unlocked here) */
  isLocked(path: string): boolean
  /** Whether a tab in some window holds the document */
  holds(path: string): Promise<boolean>
  /** The file's bytes, for a document no tab holds — or why not */
  readBytes(path: string): Promise<Uint8Array | 'unreadable' | 'too-large'>
  /** Whether the file is there and begins as a PDF does */
  isPdf(path: string): Promise<boolean>
  /** Ask the window that holds the document (or the reader's, when none does) */
  view(req: ViewRequest): Promise<ViewReply>
  /** Bring that window up, without taking the keyboard */
  raise(): void
  /** A session's list changed; `shown` = a passage was just brought up */
  changed(session: ToolSession, entry: ToolEntry, shown: boolean): void
  now(): number
  newId(): string
}

const fail = (error: BridgeErrorCode): BridgeReply => ({ ok: false, error })

/** A path on another machine: `\\server\share` in either slash — but not the
 *  `\\?\C:\…` spelling of a local one */
export const isRemotePath = (path: string): boolean => /^[\\/]{2}(?![?.][\\/][a-zA-Z]:)/.test(path)

function tokenMatches(given: string, want: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createBridgeHandler(deps: BridgeDeps): (line: string) => Promise<BridgeReply> {
  /** A document a tool named: the path the app knows it by, or why not */
  function allowed(path: string, policy: McpPolicy): string | BridgeErrorCode {
    // Relative to WHAT is not something the app could know
    if (!isAbsolute(path)) return 'unreadable'
    const canonical = deps.canonical(path)
    if (excludedBy(canonical, policy, deps.foldCase)) return 'kept-out'
    if (deps.isLocked(canonical)) return 'locked'
    return canonical
  }

  async function cite(env: BridgeEnvelope, req: Extract<BridgeRequest, { op: 'cite' }>, policy: McpPolicy): Promise<BridgeReply> {
    const path = allowed(req.path, policy)
    if (path === 'kept-out' || path === 'locked' || path === 'unreadable') return fail(path)
    // Asked first, always: it is also what routes the request to the window
    // that holds the document. Shown = opened as a tab by the window itself;
    // only a passage that is merely LISTED, of a document no tab holds, is
    // resolved from the file's bytes without a tab.
    const held = await deps.holds(path)
    if (!held && isRemotePath(path)) return fail('not-local')
    if (!held && req.show && !(await deps.isPdf(path))) return fail('unreadable')
    const bytes = held || req.show ? undefined : await deps.readBytes(path)
    if (typeof bytes === 'string') return fail(bytes)
    const answer = await deps.view({ op: 'cite', path, page: req.page, quote: req.quote, show: req.show, ...(bytes ? { bytes } : {}) })
    if (!answer.ok) return fail(answer.error)
    if (answer.op !== 'cite') return fail('no-window')
    const entry: ToolEntry = {
      kind: 'reference',
      id: deps.newId(),
      at: deps.now(),
      docPath: path,
      docName: docNameFromPath(path),
      page: answer.page,
      quote: req.quote,
      ...(req.claim ? { claim: req.claim } : {}),
      found: answer.found,
      whole: answer.found && answer.whole
    }
    const session = await deps.store.append(env.session, entry, req.topic)
    if (req.show) deps.raise()
    deps.changed(session, entry, req.show)
    return {
      ok: true,
      op: 'cite',
      found: answer.found,
      whole: answer.found && answer.whole,
      page: answer.page,
      citedPage: req.page,
      pageCount: answer.pageCount,
      hasText: answer.hasText,
      shown: req.show
    }
  }

  async function read(env: BridgeEnvelope, req: Extract<BridgeRequest, { op: 'read' }>, policy: McpPolicy): Promise<BridgeReply> {
    const path = allowed(req.path, policy)
    if (path === 'kept-out' || path === 'locked' || path === 'unreadable') return fail(path)
    const held = await deps.holds(path)
    if (!held && isRemotePath(path)) return fail('not-local')
    const bytes = held ? undefined : await deps.readBytes(path)
    if (typeof bytes === 'string') return fail(bytes)
    const answer = await deps.view({ op: 'read', path, from: req.from, to: req.to, ...(bytes ? { bytes } : {}) })
    if (!answer.ok) return fail(answer.error)
    if (answer.op !== 'read') return fail('no-window')
    if (answer.pages.length > 0) {
      const entry: ToolEntry = {
        kind: 'read',
        id: deps.newId(),
        at: deps.now(),
        docPath: path,
        docName: docNameFromPath(path),
        from: answer.pages[0].page,
        to: answer.pages[answer.pages.length - 1].page
      }
      deps.changed(await deps.store.append(env.session, entry), entry, false)
    }
    return { ok: true, op: 'read', pageCount: answer.pageCount, hasText: answer.hasText, pages: answer.pages }
  }

  async function context(env: BridgeEnvelope, policy: McpPolicy): Promise<BridgeReply> {
    const answer = await deps.view({ op: 'context' })
    if (!answer.ok) return answer.error === 'no-window' ? { ok: true, op: 'context', open: null } : fail(answer.error)
    if (answer.op !== 'context') return fail('no-window')
    const open = answer.open
    if (!open) return { ok: true, op: 'context', open: null }
    const withheld = open.locked || deps.isLocked(open.path) || excludedBy(open.path, policy, deps.foldCase) !== null
    const selection = withheld ? '' : open.selection.slice(0, MAX_SELECTION)
    const entry: ToolEntry = {
      kind: 'context',
      id: deps.newId(),
      at: deps.now(),
      ...(withheld ? {} : { docPath: open.path, docName: open.name }),
      selection: selection.length > 0
    }
    deps.changed(await deps.store.append(env.session, entry), entry, false)
    return {
      ok: true,
      op: 'context',
      open: withheld
        ? { withheld: true }
        : { path: open.path, name: open.name, page: open.page, pageCount: open.pageCount, selection }
    }
  }

  return async (line) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return fail('bad-request')
    }
    const env = sanitizeBridgeEnvelope(parsed)
    if (!env) return fail('bad-request')
    if (!tokenMatches(env.token, deps.token)) return fail('bad-token')
    const policy = deps.policy()
    if (!policy.clients[env.session.client]) return fail('client-off')
    if (!policy.live) return fail('bridge-off')
    const req = env.request
    if (req.op === 'ping') return { ok: true, op: 'ping', version: deps.version }
    if (req.op === 'cite') return cite(env, req, policy)
    if (req.op === 'read') return read(env, req, policy)
    return context(env, policy)
  }
}

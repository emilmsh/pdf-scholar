// «Les sammen»: the running app answering an AI tool outside it (Emil,
// 2026-11-24; shared/tool-bridge.ts has the contract, tool-bridge-core.ts the
// rules and the pipe). This file is the Electron half: which window is asked,
// how it is brought up, and when the app listens at all.
//
// Main listens ONLY while «Les sammen» is on and some tool's switch is on —
// both off by default — and never in the Microsoft Store build, which no
// other program can start a server for (docs/PLATFORMS.md §33). When it
// starts listening it writes a fresh token beside the state file; the MCP
// server reads it from there, so a caller must be able to read the reader's
// own profile folder. Stopping removes the token.
//
// Bringing the window up (measured 2026-11-24 on Windows 11, with Claude's
// app holding the foreground and this window covered by another):
// - moveTop() + focus() changes NOTHING — Windows' foreground lock — and
//   isFocused() answers true all the same, so it proves nothing.
// - Topmost for an instant (setAlwaysOnTop on, moveTop, off) puts the window
//   visibly above the app in front WITHOUT taking the keyboard from it. That
//   is what a reader who is typing in the other app wants: the passage comes
//   into view and their next keystroke still lands where they were.
// - A MINIMIZED window is the hard case: restore() takes the foreground, and
//   so did showInactive() in two runs of three — Electron's «inactive» show
//   still ends in a focus call. What held, two of two with the reader typing
//   in the other app: make the window unfocusable for the moment it is
//   brought back (WS_EX_NOACTIVATE — nothing can activate it then), and
//   focusable again right after. The price is Electron's own: setFocusable
//   also takes the window out of the taskbar and puts it back, so the button
//   of an app that is not pinned may move to the end of the taskbar.
import { app, BrowserWindow, ipcMain } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { open, stat, unlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:net'
import { join, resolve } from 'node:path'
import { sharesWithAny, type McpPolicy } from '../shared/mcp'
import { RECENT_THUMB_READ_MAX_BYTES } from '../shared/recent-thumbs'
import {
  BRIDGE_TOKEN_FILE,
  bridgePipePath,
  toolSessionMeta,
  type ToolSession,
  type ToolSessionMeta,
  type ToolSessionsChange,
  type ViewReply,
  type ViewRequest
} from '../shared/tool-bridge'
import { passwordFor } from './doc-passwords'
import { readPathFor } from './drafts'
import { toLongPath } from './long-path'
import { getState } from './storage'
import { createBridgeHandler, listenBridge } from './tool-bridge-core'
import { createToolSessionStore, type ToolSessionStore } from './tool-sessions'

export interface ToolBridgeContext {
  /** A window for a tool to show a passage in when the app has none (macOS) */
  createWindow(): BrowserWindow
}

let store: ToolSessionStore | null = null
const sessions = (): ToolSessionStore => (store ??= createToolSessionStore(join(app.getPath('userData'), 'tool-sessions')))

/** Windows whose renderer answers tool requests — viewers, never a detached
 *  assistant (it has no documents to show) */
const ready = new Set<number>()
let lastFocused: number | null = null
/** The window the last request went to: the one raise() means */
let lastTarget: BrowserWindow | null = null
/** Where holds() just found a path, for the request that follows it */
let heldBy: { path: string; win: BrowserWindow } | null = null

const pending = new Map<number, (reply: ViewReply) => void>()
let askSeq = 0

const live = (w: BrowserWindow): boolean => !w.isDestroyed() && !w.webContents.isDestroyed()

function readyWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => live(w) && ready.has(w.webContents.id))
}

/** The window the reader is in: the one last focused, else any viewer */
function readerWindow(): BrowserWindow | null {
  const wins = readyWindows()
  return wins.find((w) => w.webContents.id === lastFocused) ?? wins[0] ?? null
}

function ask(win: BrowserWindow, req: ViewRequest, timeoutMs: number): Promise<ViewReply> {
  return new Promise((done) => {
    const id = ++askSeq
    const timer = setTimeout(() => {
      pending.delete(id)
      done({ ok: false, error: 'no-window' })
    }, timeoutMs)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      done(reply)
    })
    win.webContents.send('tool-bridge:request', id, req)
  })
}

async function holds(path: string): Promise<boolean> {
  heldBy = null
  for (const win of readyWindows()) {
    const reply = await ask(win, { op: 'holds', path }, 3000)
    if (reply.ok && reply.op === 'holds' && reply.holds) {
      heldBy = { path, win }
      return true
    }
  }
  return false
}

/** A viewer window, made when the app has none (macOS keeps running with
 *  every window closed) and waited for until its renderer answers */
async function someWindow(ctx: ToolBridgeContext): Promise<BrowserWindow | null> {
  const have = readerWindow()
  if (have) return have
  const made = BrowserWindow.getAllWindows().some(live) ? null : ctx.createWindow()
  for (let waited = 0; waited < 15_000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100))
    const win = readerWindow()
    if (win) return win
  }
  return made && live(made) && ready.has(made.webContents.id) ? made : null
}

async function view(ctx: ToolBridgeContext, req: ViewRequest): Promise<ViewReply> {
  if (req.op === 'context') {
    const win = readerWindow()
    if (!win) return { ok: false, error: 'no-window' }
    lastTarget = win
    return ask(win, req, 5000)
  }
  if (req.op === 'holds') return { ok: true, op: 'holds', holds: await holds(req.path) }
  const held = heldBy && heldBy.path === req.path && live(heldBy.win) ? heldBy.win : null
  heldBy = null
  const win = held ?? (await someWindow(ctx))
  if (!win) return { ok: false, error: 'no-window' }
  lastTarget = win
  // Opening a file and loading it in pdf.js, or reading every page's text of
  // a long document, is what these wait for
  return ask(win, req, req.op === 'read' ? 120_000 : 60_000)
}

/** The file as opening it would show it (its draft, when it has unsaved
 *  marks), for a document no tab holds — never past what the app reads
 *  without the reader opening it, and only something that is a PDF */
async function readBytes(path: string): Promise<Uint8Array | 'unreadable' | 'too-large'> {
  try {
    const file = readPathFor(path)
    const info = await stat(file)
    if (!info.isFile()) return 'unreadable'
    if (info.size > RECENT_THUMB_READ_MAX_BYTES) return 'too-large'
    const handle = await open(file, 'r')
    try {
      const bytes = new Uint8Array(info.size)
      await handle.read(bytes, 0, info.size, 0)
      // The header may sit a little into the file, never far
      const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
      return head.includes('%PDF-') ? bytes : 'unreadable'
    } finally {
      await handle.close()
    }
  } catch {
    return 'unreadable'
  }
}

/** Whether the file is there and begins as a PDF does — asked before a
 *  window is told to open it, so a wrong path is an answer to the tool
 *  instead of an error on the reader's screen */
async function isPdf(path: string): Promise<boolean> {
  try {
    const handle = await open(readPathFor(path), 'r')
    try {
      const head = Buffer.alloc(1024)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      return head.subarray(0, bytesRead).toString('latin1').includes('%PDF-')
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

function raise(): void {
  const win = lastTarget
  if (!win || !live(win)) return
  if (process.platform !== 'win32') {
    // What the APIs promise; not measured on macOS or Linux (PLATFORMS §37)
    win.showInactive()
    win.moveTop()
    return
  }
  const minimized = win.isMinimized()
  try {
    if (minimized) {
      // Unfocusable while it is brought back: see the measurements above
      win.setFocusable(false)
      win.showInactive()
    }
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.setAlwaysOnTop(false)
  } finally {
    // Never left unfocusable, whatever threw
    if (minimized && live(win)) win.setFocusable(true)
  }
}

function broadcast(session: ToolSession, shown: boolean, docPath?: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!live(w)) continue
    const change: ToolSessionsChange = {
      sessionId: session.id,
      shownHere: shown && w === lastTarget,
      ...(docPath ? { docPath } : {})
    }
    w.webContents.send('tool-sessions:changed', change)
  }
}

// ---------- Listening ----------

let server: Server | null = null
/** Serializes start and stop: a switch flipped twice must not leave two */
let turning: Promise<void> = Promise.resolve()

const tokenFile = (): string => join(app.getPath('userData'), BRIDGE_TOKEN_FILE)
const pipePath = (): string => bridgePipePath(app.getPath('userData'), process.platform)

async function start(ctx: ToolBridgeContext): Promise<void> {
  if (server) return
  const token = randomBytes(32).toString('hex')
  const handle = createBridgeHandler({
    token,
    version: app.getVersion(),
    foldCase: process.platform !== 'linux',
    policy: () => getState().mcp,
    store: sessions(),
    canonical: (path) => toLongPath(resolve(path)),
    isLocked: (path) => passwordFor(path) !== undefined,
    holds,
    readBytes,
    isPdf,
    view: (req) => view(ctx, req),
    raise,
    changed: (session, entry, shown) => broadcast(session, shown, 'docPath' in entry ? entry.docPath : undefined),
    now: () => Date.now(),
    newId: () => randomUUID().replace(/-/g, '').slice(0, 16)
  })
  try {
    server = await listenBridge(pipePath(), handle)
    // The token only after the pipe is ours: a server that finds the file
    // finds a listener behind it
    await writeFile(tokenFile(), JSON.stringify({ token }), { mode: 0o600 })
  } catch (err) {
    console.error('[pdfx] tool bridge could not listen:', err)
    server?.close()
    server = null
  }
}

async function stop(): Promise<void> {
  const s = server
  server = null
  await unlink(tokenFile()).catch(() => {})
  if (s) await new Promise<void>((done) => s.close(() => done()))
}

/** Listen exactly while «Les sammen» and some tool's switch are on */
export function syncToolBridge(ctx: ToolBridgeContext, policy: McpPolicy = getState().mcp): Promise<void> {
  const want = !process.windowsStore && policy.live && sharesWithAny(policy)
  turning = turning.catch(() => {}).then(() => (want ? start(ctx) : stop()))
  return turning
}

export function registerToolBridgeIpc(ctx: ToolBridgeContext): void {
  ipcMain.on('tool-bridge:ready', (e) => {
    const id = e.sender.id
    if (ready.has(id)) return
    ready.add(id)
    e.sender.once('destroyed', () => {
      ready.delete(id)
      if (lastFocused === id) lastFocused = null
    })
    // The window the app started with counts as the reader's until another
    // is focused
    lastFocused ??= id
  })
  ipcMain.on('tool-bridge:reply', (_e, id: unknown, reply: unknown) => {
    if (typeof id !== 'number') return
    const settle = pending.get(id)
    if (!settle) return
    pending.delete(id)
    settle(
      reply && typeof reply === 'object' && typeof (reply as { ok?: unknown }).ok === 'boolean'
        ? (reply as ViewReply)
        : { ok: false, error: 'no-window' }
    )
  })
  app.on('browser-window-focus', (_e, win) => {
    if (live(win) && ready.has(win.webContents.id)) lastFocused = win.webContents.id
  })
  app.on('will-quit', () => {
    void stop()
  })

  ipcMain.handle('tool-sessions:list', async (): Promise<ToolSessionMeta[]> => (await sessions().all()).map(toolSessionMeta))
  ipcMain.handle('tool-sessions:get', (_e, id: unknown): Promise<ToolSession | null> =>
    typeof id === 'string' ? sessions().get(id) : Promise.resolve(null)
  )
  ipcMain.handle('tool-sessions:remove', async (_e, id: unknown): Promise<void> => {
    if (typeof id !== 'string') return
    await sessions().remove(id)
    for (const w of BrowserWindow.getAllWindows()) {
      if (live(w)) w.webContents.send('tool-sessions:changed', { sessionId: id, shownHere: false } satisfies ToolSessionsChange)
    }
  })

  void syncToolBridge(ctx)
}

import { BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron'
import type { Session } from 'electron'
import type { WebSearchBounds, WebSearchState } from '../shared/types'

// An Edge-sidebar-style in-app browser. Main owns one WebContentsView PER host
// window (the app is multi-window): the renderer draws only header chrome + an
// empty placeholder, whose bounds it streams over IPC so the native surface
// tracks it exactly. The view is detached on close but kept alive for a fast
// reopen, and only destroyed when its host window is gone.

interface Entry {
  win: BrowserWindow
  view: WebContentsView
  attached: boolean
  /** Has the view ever loaded a URL (vs. a fresh about:blank)? */
  loaded: boolean
  /** Last query navigated to — reopening with the same query re-shows without
   *  reloading (so switching tabs back doesn't re-run the search). */
  lastQuery: string
}

/** host webContents.id → Entry */
const entries = new Map<number, Entry>()
/** host webContents.id → last placeholder bounds (kept even before the view
 *  exists: the renderer pushes bounds in a layout effect BEFORE it asks to
 *  open, so attach must be able to read a bounds that arrived first) */
const lastBounds = new Map<number, WebSearchBounds>()

let hardenedSession: Session | null = null

/** A locked-down session shared by every web-search view: no downloads, every
 *  permission request denied. The view's own webPreferences add the sandbox. */
function ensureHardenedSession(): Session {
  if (hardenedSession) return hardenedSession
  const ses = session.fromPartition('persist:websearch')
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  hardenedSession = ses
  return ses
}

function searchUrl(query: string): string {
  const q = query.trim()
  return q ? `https://duckduckgo.com/?q=${encodeURIComponent(q)}` : 'https://duckduckgo.com/'
}

function roundBounds(b: WebSearchBounds): Electron.Rectangle {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  }
}

function sendState(hostId: number): void {
  const entry = entries.get(hostId)
  if (!entry) return
  const host = entry.win.webContents
  if (host.isDestroyed()) return
  const wc = entry.view.webContents
  if (wc.isDestroyed()) return
  const state: WebSearchState = {
    open: entry.attached,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    url: wc.getURL(),
    loading: wc.isLoading(),
    title: wc.getTitle()
  }
  host.send('web-search:state', state)
}

function createEntry(win: BrowserWindow, hostId: number): Entry {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:websearch',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
      // no preload — this is untrusted third-party web content
    }
  })
  view.setBackgroundColor('#ffffff')
  const wc = view.webContents
  // Popups (target=_blank, window.open) go to the system browser, never a
  // second in-app view
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  const push = (): void => sendState(hostId)
  wc.on('did-navigate', push)
  wc.on('did-navigate-in-page', push)
  wc.on('did-start-loading', push)
  wc.on('did-stop-loading', push)
  wc.on('page-title-updated', push)

  // If the HOST renderer navigates (HMR reload in dev, or any reload), its
  // panel state is gone — detach so the native view can't float over a blank
  // renderer. This also fires on the very first renderer load (nothing is
  // attached yet, so it's a harmless no-op — do not "optimize" it away).
  win.webContents.on('did-start-navigation', () => detach(hostId))

  // Destroy the view only when the host window itself closes
  win.once('closed', () => destroyEntry(hostId))

  const entry: Entry = { win, view, attached: false, loaded: false, lastQuery: '' }
  entries.set(hostId, entry)
  return entry
}

function attach(entry: Entry, hostId: number): void {
  if (entry.attached || entry.win.isDestroyed()) return
  entry.win.contentView.addChildView(entry.view)
  entry.attached = true
  const b = lastBounds.get(hostId)
  if (b) entry.view.setBounds(roundBounds(b))
}

function detach(hostId: number): void {
  const entry = entries.get(hostId)
  if (!entry || !entry.attached) return
  if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view)
  entry.attached = false
  sendState(hostId)
}

function destroyEntry(hostId: number): void {
  const entry = entries.get(hostId)
  entries.delete(hostId)
  lastBounds.delete(hostId)
  if (!entry) return
  try {
    if (!entry.win.isDestroyed() && entry.attached) {
      entry.win.contentView.removeChildView(entry.view)
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  } catch {
    /* the window may already be tearing down — nothing left to release */
  }
}

function open(win: BrowserWindow, hostId: number, query?: string): void {
  ensureHardenedSession()
  const entry = entries.get(hostId) ?? createEntry(win, hostId)
  attach(entry, hostId)
  const wc = entry.view.webContents
  const q = (query ?? '').trim()
  if (q && q !== entry.lastQuery) {
    // A new search from the selection menu — navigate
    entry.lastQuery = q
    entry.loaded = true
    void wc.loadURL(searchUrl(q))
  } else if (!entry.loaded) {
    // First open with no query — land on the DuckDuckGo home page
    entry.loaded = true
    void wc.loadURL(searchUrl(q))
  }
  sendState(hostId)
}

export function registerWebSearchIpc(): void {
  ipcMain.on('web-search:open', (e, query?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) open(win, e.sender.id, query)
  })

  ipcMain.on('web-search:close', (e) => detach(e.sender.id))

  ipcMain.on('web-search:set-bounds', (e, bounds: WebSearchBounds) => {
    lastBounds.set(e.sender.id, bounds)
    const entry = entries.get(e.sender.id)
    if (entry?.attached && !entry.view.webContents.isDestroyed()) {
      entry.view.setBounds(roundBounds(bounds))
    }
  })

  ipcMain.on('web-search:back', (e) => {
    const wc = entries.get(e.sender.id)?.view.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })

  ipcMain.on('web-search:forward', (e) => {
    const wc = entries.get(e.sender.id)?.view.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward()
    }
  })

  ipcMain.on('web-search:reload', (e) => {
    const wc = entries.get(e.sender.id)?.view.webContents
    if (wc && !wc.isDestroyed()) wc.reload()
  })
}

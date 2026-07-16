import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  powerSaveBlocker,
  screen,
  shell
} from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AnnotateRequest,
  DeleteAnnotationRequest,
  FileError,
  FilePayload,
  ModifyAnnotationRequest,
  ReadingPosition,
  Settings
} from '../shared/types'
import { registerAiIpc } from './ai'
import { registerWebSearchIpc } from './web-search'
import {
  applyAnnotation,
  deleteAnnotation,
  dropAnnotations,
  flushAllAnnotations,
  flushAnnotations,
  updateAnnotation
} from './annotation-engine-embedpdf'
import { discardDraft, draftPathFor, ensureDraft, hasDraft, readPathFor, saveDraft } from './drafts'
import { addRecent, getState, mergeSettings, saveState, setPosition } from './storage'

// One-time migration: renaming the app PDFX → PDF Scholar moved userData;
// carry the state file over so recents, positions and encrypted AI keys
// survive (DPAPI keys stay decryptable — same Windows user).
function migrateUserData(): void {
  try {
    const dir = app.getPath('userData')
    const target = join(dir, 'pdfx-state.json')
    if (existsSync(target)) return
    const legacy = join(dirname(dir), 'PDFX', 'pdfx-state.json')
    if (existsSync(legacy)) {
      mkdirSync(dir, { recursive: true })
      copyFileSync(legacy, target)
    }
  } catch {
    /* a fresh start is an acceptable fallback */
  }
}
migrateUserData()

// A .pdf path passed on the command line (double-click in Explorer / "Open with")
// for the very first window; per-window paths live in pendingPaths below.
let firstPending: string | null = pathFromArgv(process.argv)
/** webContents.id → a .pdf path the renderer should open once it asks */
const pendingPaths = new Map<number, string>()
/** webContents.id → original paths of documents open in that window (for
 *  the unsaved-changes guard on window close) */
const openDocs = new Map<number, Set<string>>()
/** Windows allowed to close without re-running the unsaved-changes guard */
const forceClose = new Set<number>()

/** Native-dialog strings following the app language setting */
function dialogStrings(): {
  buttons: string[]
  message(name: string): string
  messageMany(count: number): string
  detail: string
} {
  const pref = getState().settings.language
  const nb = pref === 'nb' || (pref === 'auto' && app.getLocale().toLowerCase().startsWith('n'))
  return nb
    ? {
        buttons: ['Lagre', 'Ikke lagre', 'Avbryt'],
        message: (name) => `Vil du lagre endringene i «${name}»?`,
        messageMany: (count) => `Vil du lagre endringene i ${count} dokumenter?`,
        detail: 'Endringene går tapt hvis du ikke lagrer dem.'
      }
    : {
        buttons: ['Save', "Don't save", 'Cancel'],
        message: (name) => `Do you want to save the changes to “${name}”?`,
        messageMany: (count) => `Do you want to save the changes to ${count} documents?`,
        detail: 'Your changes will be lost if you don’t save them.'
      }
}

function pathFromArgv(argv: string[]): string | null {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pdf'))
  return arg ? resolve(arg) : null
}

/** The window an IPC event came from, or the currently focused one */
/** Native window-controls overlay colors per theme — MUST mirror the
 *  --bg-titlebar / --text values in app.css. The renderer re-syncs on
 *  theme change; this map only styles the very first frame. */
const TITLEBAR_COLORS: Record<string, { color: string; symbolColor: string }> = {
  day: { color: '#ededf0', symbolColor: '#1d1d1f' },
  sepia: { color: '#e9e6db', symbolColor: '#3d3929' },
  night: { color: '#21211f', symbolColor: '#eeece2' },
  nightHc: { color: '#111113', symbolColor: '#f5f5f7' }
}

function initialTitleBarColors(): { color: string; symbolColor: string } {
  const pref = getState().settings.theme
  const theme = pref === 'auto' ? (nativeTheme.shouldUseDarkColors ? 'night' : 'day') : pref
  return TITLEBAR_COLORS[theme] ?? TITLEBAR_COLORS.day
}

function windowFor(e?: { sender: Electron.WebContents }): BrowserWindow | null {
  if (e) {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) return w
  }
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // A second launch (e.g. "Open with" from Explorer) opens the document as a
  // new TAB in the existing window — a new window is an explicit choice via
  // the tab strip's ⧉ button or the tab context menu, never the default.
  app.on('second-instance', (_event, argv) => {
    const path = pathFromArgv(argv)
    const w = windowFor()
    if (!w) {
      createWindow(path ?? undefined)
      return
    }
    if (w.isMinimized()) w.restore()
    w.focus()
    if (path) w.webContents.send('open-path', path)
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('no.emil.pdfx')
    console.log('[pdfx] annotation engine: embedpdf (MIT)')
    // Show the "Recent" category (fed by app.addRecentDocument) in the
    // taskbar Jump List
    if (process.platform === 'win32') {
      try {
        app.setJumpList([{ type: 'recent' }])
      } catch {
        /* Jump List is cosmetic — never block startup on it */
      }
    }
    registerIpc()
    applyKeepAwake(getState().settings.keepAwake)
    createWindow(firstPending)
    firstPending = null

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // Quit can land inside the debounce window of the engines' document caches —
  // hold the quit once, flush everything to disk, then resume quitting.
  let quitFlushed = false
  app.on('before-quit', (event) => {
    if (quitFlushed) return
    quitFlushed = true
    event.preventDefault()
    void flushAllAnnotations().finally(() => app.quit())
  })
}

function createWindow(openPath?: string | null): BrowserWindow {
  const state = getState()
  // Cascade extra windows so they don't land exactly on top of each other
  const offset = BrowserWindow.getAllWindows().length * 34
  const baseX = state.window?.x
  const baseY = state.window?.y
  const win = new BrowserWindow({
    width: state.window?.width ?? 1280,
    height: state.window?.height ?? 860,
    x: baseX === undefined ? undefined : baseX + offset,
    y: baseY === undefined ? undefined : baseY + offset,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1c1c1e',
    // Edge-style: frameless with native window controls overlaying our
    // own titlebar strip (which hosts the document tabs)
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...initialTitleBarColors(), height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  // Only the first window restores the maximized state
  if (state.window?.maximized && offset === 0) win.maximize()
  // Capture the id now: win.webContents throws "Object has been destroyed"
  // when read inside the 'closed' handler
  const wcId = win.webContents.id
  if (openPath) pendingPaths.set(wcId, openPath)

  // Guard: the window can be closed before ready-to-show ever fires
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  // Persist this window's bounds as the default for the next launch, and
  // guard against closing with unsaved annotation changes
  win.on('close', (event) => {
    if (win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    getState().window = { ...bounds, maximized: win.isMaximized() }
    saveState()

    if (forceClose.has(wcId)) return
    const dirty = [...(openDocs.get(wcId) ?? [])].filter(hasDraft)
    if (dirty.length === 0) return
    event.preventDefault()
    const s = dialogStrings()
    void dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: s.buttons,
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        message:
          dirty.length === 1 ? s.message(basename(dirty[0])) : s.messageMany(dirty.length),
        detail: s.detail
      })
      .then(async ({ response }) => {
        if (response === 2) return // Avbryt
        for (const path of dirty) {
          if (response === 0) {
            // Pending annotation writes may still sit in the engine cache
            await flushDraft(path)
            saveDraft(path)
          } else {
            // Drop cached changes FIRST so a late debounced flush can't
            // resurrect the draft file we're about to delete
            await dropAnnotations(draftPathFor(path)).catch(() => {})
            discardDraft(path)
          }
        }
        forceClose.add(wcId)
        if (!win.isDestroyed()) win.close()
      })
  })

  win.on('closed', () => {
    pendingPaths.delete(wcId)
    openDocs.delete(wcId)
    forceClose.delete(wcId)
  })

  // The renderer hides its titlebar strip while in OS fullscreen
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen', true)
  })
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen', false)
  })

  // Open external links in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** The write-engines cache open docs keyed on the DRAFT path and flush to
 *  disk on a debounce (see doc-cache.ts) — force the flush before any code
 *  path reads or copies the draft's bytes. Logs instead of throwing: reading
 *  a briefly-stale draft beats failing the caller outright. */
async function flushDraft(originalPath: string): Promise<void> {
  try {
    await flushAnnotations(draftPathFor(originalPath))
  } catch (err) {
    console.error(`[pdfx] annotation flush failed for ${originalPath}:`, err)
  }
}

async function loadPdf(path: string): Promise<FilePayload | FileError> {
  try {
    // Recent annotation writes may still sit in the engine's cached doc —
    // flush so the bytes we hand the renderer include them
    await flushDraft(path)
    // A leftover draft means unsaved changes from a previous session —
    // load those bytes so the work is silently recovered
    const data = await readFile(readPathFor(path))
    const name = basename(path)
    addRecent(path, name)
    app.addRecentDocument(path)
    return { path, name, data: new Uint8Array(data) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function registerIpc(): void {
  registerAiIpc()
  registerWebSearchIpc()
  ipcMain.handle('dialog:open', async (e) => {
    const parent = windowFor(e)
    if (!parent) return null
    const result = await dialog.showOpenDialog(parent, {
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return loadPdf(result.filePaths[0])
  })

  // Open a new top-level window, optionally loading a document — lets the user
  // place documents side by side or view two spots in one file at once
  ipcMain.on('window:new', (_e, path?: string) => {
    createWindow(typeof path === 'string' && path ? path : null)
  })

  // A tab was dragged out and released. HTML5 drag events don't cross OS
  // window boundaries, so main hit-tests the OS cursor against every window's
  // bounds and decides where the document goes. The document's draft (unsaved
  // annotations) is keyed by path in main, so it travels automatically: the
  // target opens the same path and picks up the same draft — the renderer just
  // closes the source tab WITHOUT the discard prompt.
  ipcMain.handle('tab:drop-at-cursor', (e, path: string) => {
    const source = BrowserWindow.fromWebContents(e.sender)
    const pt = screen.getCursorScreenPoint()
    const inBounds = (win: BrowserWindow): boolean => {
      const b = win.getBounds()
      return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
    }
    // Another (non-minimized) window under the cursor → merge into it
    const target = BrowserWindow.getAllWindows().find(
      (w) => w !== source && !w.isDestroyed() && !w.isMinimized() && inBounds(w)
    )
    if (target) {
      if (!target.webContents.isDestroyed()) target.webContents.send('open-path', path)
      target.focus()
      return 'window'
    }
    // Dropped back on the source window → treat as a no-op reorder
    if (source && !source.isDestroyed() && inBounds(source)) return 'same'
    // Dropped on empty desktop → tear off into a fresh window
    createWindow(path)
    return 'new'
  })

  ipcMain.handle('file:read', (_e, path: string) => loadPdf(path))

  ipcMain.handle('recents:get', () => getState().recents)

  ipcMain.handle('settings:get', () => getState().settings)

  ipcMain.handle('position:get', (_e, path: string) => getState().positions[path] ?? null)

  ipcMain.handle('pending-path:get', (e) => {
    const id = e.sender.id
    const path = pendingPaths.get(id) ?? null
    pendingPaths.delete(id)
    return path
  })

  ipcMain.on('position:set', (_e, path: string, pos: ReadingPosition) => setPosition(path, pos))

  ipcMain.on('settings:set', (_e, patch: Partial<Settings>) => {
    const state = getState()
    state.settings = mergeSettings(state.settings, patch)
    saveState()
    applyKeepAwake(state.settings.keepAwake)
  })

  // Annotation writes go to the draft copy, never the original (save model)
  ipcMain.handle('annotate', (_e, req: AnnotateRequest) =>
    applyAnnotation({ ...req, path: ensureDraft(req.path) })
  )

  ipcMain.handle('annotation:update', (_e, req: ModifyAnnotationRequest) =>
    updateAnnotation({ ...req, path: ensureDraft(req.path) })
  )

  ipcMain.handle('annotation:delete', (_e, req: DeleteAnnotationRequest) =>
    deleteAnnotation({ ...req, path: ensureDraft(req.path) })
  )

  // ---------- Document lifecycle (save model) ----------

  ipcMain.on('doc:opened', (e, path: string) => {
    const set = openDocs.get(e.sender.id) ?? new Set<string>()
    set.add(path)
    openDocs.set(e.sender.id, set)
  })

  ipcMain.on('doc:closed', (e, path: string) => {
    openDocs.get(e.sender.id)?.delete(path)
  })

  ipcMain.handle('doc:is-dirty', (_e, path: string) => hasDraft(path))

  ipcMain.handle('doc:save', async (_e, path: string) => {
    try {
      // Persist pending cached annotation writes into the draft BEFORE it is
      // copied over the original. Throwing (not flushDraft) is deliberate:
      // silently saving a stale draft would lose the user's latest marks.
      await flushAnnotations(draftPathFor(path))
      saveDraft(path)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Shows the native save/discard/cancel prompt for one document and
  // performs the chosen action; the renderer only needs the verdict
  ipcMain.handle('doc:confirm-close', async (e, path: string) => {
    if (!hasDraft(path)) return 'discard'
    const parent = windowFor(e)
    if (!parent) return 'discard'
    const s = dialogStrings()
    const { response } = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: s.buttons,
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: s.message(basename(path)),
      detail: s.detail
    })
    if (response === 2) return 'cancel'
    if (response === 0) {
      await flushDraft(path)
      saveDraft(path)
      return 'save'
    }
    // Drop cached changes FIRST: a late debounced flush must not resurrect
    // the draft file we are about to delete
    await dropAnnotations(draftPathFor(path)).catch(() => {})
    discardDraft(path)
    return 'discard'
  })

  ipcMain.on('shell:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  ipcMain.on('shell:show-in-folder', (_e, path: string) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })

  ipcMain.handle('file:save-text', async (e, defaultName: string, content: string) => {
    const parent = windowFor(e)
    if (!parent) return null
    const ext = extname(defaultName).replace('.', '') || 'txt'
    const result = await dialog.showSaveDialog(parent, {
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return null
    try {
      await writeFile(result.filePath, content, 'utf-8')
      return { path: result.filePath }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.on('window:set-fullscreen', (e, on: boolean) => {
    windowFor(e)?.setFullScreen(!!on)
  })

  // Theme change: recolor the native window-controls overlay to match
  ipcMain.on('window:titlebar-colors', (e, color: string, symbolColor: string) => {
    const win = windowFor(e)
    if (!win || win.isDestroyed()) return
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 36 })
    } catch {
      /* not supported on this platform */
    }
  })

  // Print via a hidden window hosting Chromium's built-in PDF viewer: it
  // renders the file (with saved annotations) and drives the print dialog.
  ipcMain.handle('file:print', async (_e, path: string) => {
    try {
      // Print what the user just annotated — flush the engine cache first
      await flushDraft(path)
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { plugins: true }
      })
      // Print what the user sees: the draft when there are unsaved changes
      await printWin.loadURL(pathToFileURL(readPathFor(path)).href)
      // Give the PDF plugin a moment to finish rendering before printing
      await new Promise((resolve) => setTimeout(resolve, 700))
      return await new Promise((resolve) => {
        printWin.webContents.print({}, (success, failureReason) => {
          // The hidden window may already be gone if the app is quitting
          if (!printWin.isDestroyed()) printWin.destroy()
          resolve(success || failureReason === 'cancelled' ? { ok: true } : { error: failureReason })
        })
      })
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}

let keepAwakeId: number | null = null
function applyKeepAwake(on: boolean): void {
  if (on && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (!on && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId)
    keepAwakeId = null
  }
}

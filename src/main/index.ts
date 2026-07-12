import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
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
import { applyAnnotation, deleteAnnotation, updateAnnotation } from './annotation-engine'
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

let mainWindow: BrowserWindow | null = null
// A .pdf path passed on the command line (double-click in Explorer / "Open with")
let pendingPath: string | null = pathFromArgv(process.argv)

function pathFromArgv(argv: string[]): string | null {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pdf'))
  return arg ? resolve(arg) : null
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const path = pathFromArgv(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      if (path) mainWindow.webContents.send('open-path', path)
    } else if (path) {
      pendingPath = path
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('no.emil.pdfx')
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
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

function createWindow(): void {
  const state = getState()
  mainWindow = new BrowserWindow({
    width: state.window?.width ?? 1280,
    height: state.window?.height ?? 860,
    x: state.window?.x,
    y: state.window?.y,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  if (state.window?.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', () => {
    if (!mainWindow) return
    const bounds = mainWindow.getNormalBounds()
    getState().window = { ...bounds, maximized: mainWindow.isMaximized() }
    saveState()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the system browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function loadPdf(path: string): Promise<FilePayload | FileError> {
  try {
    const data = await readFile(path)
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
  ipcMain.handle('dialog:open', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return loadPdf(result.filePaths[0])
  })

  ipcMain.handle('file:read', (_e, path: string) => loadPdf(path))

  ipcMain.handle('recents:get', () => getState().recents)

  ipcMain.handle('settings:get', () => getState().settings)

  ipcMain.handle('position:get', (_e, path: string) => getState().positions[path] ?? null)

  ipcMain.handle('pending-path:get', () => {
    const path = pendingPath
    pendingPath = null
    return path
  })

  ipcMain.on('position:set', (_e, path: string, pos: ReadingPosition) => setPosition(path, pos))

  ipcMain.on('settings:set', (_e, patch: Partial<Settings>) => {
    const state = getState()
    state.settings = mergeSettings(state.settings, patch)
    saveState()
    applyKeepAwake(state.settings.keepAwake)
  })

  ipcMain.handle('annotate', (_e, req: AnnotateRequest) => applyAnnotation(req))

  ipcMain.handle('annotation:update', (_e, req: ModifyAnnotationRequest) => updateAnnotation(req))

  ipcMain.handle('annotation:delete', (_e, req: DeleteAnnotationRequest) => deleteAnnotation(req))

  ipcMain.on('shell:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('file:save-text', async (_e, defaultName: string, content: string) => {
    if (!mainWindow) return null
    const ext = extname(defaultName).replace('.', '') || 'txt'
    const result = await dialog.showSaveDialog(mainWindow, {
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

  ipcMain.on('window:set-fullscreen', (_e, on: boolean) => {
    mainWindow?.setFullScreen(!!on)
  })

  // Print via a hidden window hosting Chromium's built-in PDF viewer: it
  // renders the file (with saved annotations) and drives the print dialog.
  ipcMain.handle('file:print', async (_e, path: string) => {
    try {
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { plugins: true }
      })
      await printWin.loadURL(pathToFileURL(path).href)
      // Give the PDF plugin a moment to finish rendering before printing
      await new Promise((resolve) => setTimeout(resolve, 700))
      return await new Promise((resolve) => {
        printWin.webContents.print({}, (success, failureReason) => {
          printWin.destroy()
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

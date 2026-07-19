// Auto-update via electron-updater against the GitHub releases feed
// (publish config in electron-builder.yml → app-update.yml in the package).
// Policy: quiet by default — download in the background, install on quit,
// and only tell the renderer once an update is actually ready. No dialogs,
// no focus stealing, and errors are logged and swallowed: an offline machine
// or a rate-limited GitHub API must never affect the app.
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { flushAllAnnotations } from './annotation-engine-embedpdf'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Version string of a fully downloaded update, if any (guards update:restart) */
let downloadedVersion: string | null = null

export function initUpdater(): void {
  // Dev runs have no app-update.yml (and nothing meaningful to update)
  if (!app.isPackaged) return
  // macOS builds are ad-hoc signed (no Apple Developer identity) and
  // Squirrel.Mac refuses to apply unsigned updates — never even check there
  if (process.platform === 'darwin') return
  // Inside a Microsoft Store/MSIX package the Store owns the update cycle
  if (process.windowsStore) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // An unhandled 'error' on an EventEmitter throws — always listen. Update
  // failures (offline, GitHub down, disk full) are logged and swallowed.
  autoUpdater.on('error', (err) => {
    console.warn('[pdfx] updater error:', err?.message ?? err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('update:ready', info.version)
      }
    }
  })

  // Windows opened after the download still get the "update ready" toast
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => {
      if (downloadedVersion && !win.isDestroyed()) {
        win.webContents.send('update:ready', downloadedVersion)
      }
    })
  })

  // "Start på nytt nå" from the renderer's update toast.
  //
  // Quit/flush interaction (verified against electron-updater's BaseUpdater):
  // quitAndInstall() FIRST spawns the NSIS installer process, THEN calls
  // Electron's app.quit() — which does emit 'before-quit', so index.ts's
  // annotation-flush handler still runs (it prevents the first quit, awaits
  // flushAllAnnotations(), then re-quits). The flush path is therefore NOT
  // skipped. However, at that point the installer is already running and
  // waiting for our process to exit, so a slow flush would race it. To be
  // robust we flush explicitly BEFORE handing control to quitAndInstall;
  // the before-quit handler's second flush then completes instantly.
  ipcMain.on('update:restart', () => {
    if (!downloadedVersion) return
    void flushAllAnnotations()
      .catch((err) => console.error('[pdfx] pre-update annotation flush failed:', err))
      .then(() => autoUpdater.quitAndInstall(true, true))
  })

  const check = (): void => {
    // checkForUpdates rejects when offline etc. — the 'error' listener above
    // already logs it, but keep the rejection from becoming unhandled
    autoUpdater.checkForUpdates().catch(() => {})
  }
  // Don't compete with startup work; then re-check on a long-lived interval
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS)
}

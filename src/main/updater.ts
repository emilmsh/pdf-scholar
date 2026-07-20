// Auto-update via electron-updater against the GitHub releases feed
// (publish config in config/electron-builder.yml → app-update.yml in the package).
// Policy: CHECKS are quiet and automatic, but downloading is the USER'S
// decision — the renderer gets an "update available" notice with a download
// button, and nothing is fetched or installed without that click. Once the
// user has opted in, the downloaded update installs on quit (or via the
// "restart now" button). Errors are logged and swallowed: an offline machine
// or a rate-limited GitHub API must never affect the app.
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckOutcome } from '../shared/types'
import { flushAllAnnotations } from './annotation-engine-embedpdf'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Version detected on the feed but not yet downloaded */
let availableVersion: string | null = null
/** Version string of a fully downloaded update, if any (guards update:restart) */
let downloadedVersion: string | null = null
/** A user-initiated download is in flight */
let downloading = false

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/** Why this build can't self-update, or null when it can */
function unsupportedReason(): 'dev' | 'mac' | 'store' | null {
  if (!app.isPackaged) return 'dev' // no app-update.yml, nothing meaningful to update
  // macOS builds are ad-hoc signed (no Apple Developer identity) and
  // Squirrel.Mac refuses to apply unsigned updates — never even check there
  if (process.platform === 'darwin') return 'mac'
  // Inside a Microsoft Store/MSIX package the Store owns the update cycle
  if (process.windowsStore) return 'store'
  return null
}

export function initUpdater(): void {
  const unsupported = unsupportedReason()

  // The manual check must answer in EVERY build flavour, so it is registered
  // before (and regardless of) the early return below.
  ipcMain.handle('update:check', async (): Promise<UpdateCheckOutcome> => {
    const current = app.getVersion()
    if (unsupported) return { status: 'unsupported', current, reason: unsupported }
    if (downloadedVersion) return { status: 'ready', current, version: downloadedVersion }
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (result?.isUpdateAvailable && version) {
        availableVersion = version
        return { status: 'available', current, version }
      }
      return { status: 'none', current }
    } catch (err) {
      console.warn('[pdfx] manual update check failed:', err instanceof Error ? err.message : err)
      return { status: 'error', current }
    }
  })

  if (unsupported) return

  // Detection only — downloading waits for the user's explicit go-ahead.
  autoUpdater.autoDownload = false
  // Applies only after a user-initiated download, so quitting still installs
  // the update the user already said yes to.
  autoUpdater.autoInstallOnAppQuit = true

  // An unhandled 'error' on an EventEmitter throws — always listen. Update
  // failures (offline, GitHub down, disk full) are logged and swallowed.
  autoUpdater.on('error', (err) => {
    downloading = false
    console.warn('[pdfx] updater error:', err?.message ?? err)
  })

  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version
    broadcast('update:available', info.version)
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast('update:progress', Math.round(progress.percent))
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false
    downloadedVersion = info.version
    broadcast('update:ready', info.version)
  })

  // Windows opened after detection/download still get the current notice
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      if (downloadedVersion) win.webContents.send('update:ready', downloadedVersion)
      else if (availableVersion) win.webContents.send('update:available', availableVersion)
    })
  })

  // "Last ned" from the renderer's update toast
  ipcMain.on('update:download', () => {
    if (downloading || downloadedVersion || !availableVersion) return
    downloading = true
    autoUpdater.downloadUpdate().catch(() => {
      downloading = false // 'error' listener above logs it
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

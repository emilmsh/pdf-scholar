// The .pdf file icon in Explorer, changed from inside the app (issue #26).
//
// The NSIS installer registers the ProgId `PDF-dokument` under
// HKCU\Software\Classes with a DefaultIcon pointing at resources\pdf.ico — the
// document icon. This module rewrites that one value for the reader's choice
// (the app logo, or an .ico of their own) and asks the shell to refresh its
// icon cache. Two facts shape it:
//
//  - The installer writes DefaultIcon again on every upgrade, so a choice is
//    re-applied at startup when the registry no longer says what the settings
//    say. The comparison is what keeps a quiet startup quiet: nothing is
//    written, and no cache refresh flickers every icon, unless they differ.
//  - It is only meaningful where WE registered the ProgId: a packaged Windows
//    install. The portable zip registers nothing, the Store build's
//    associations are MSIX-virtualized and ignore HKCU\Software\Classes, and
//    macOS/Linux have no such key — so the setting hides there and the IPC
//    answers with the named `file-icon-unavailable`.
//
// No native module: reg.exe does the registry, ie4uinit.exe -show the refresh
// (the documented way to rebuild the icon cache on Windows 10/11 without a
// sign-out). Both ship with Windows.
import { app, dialog, ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  fileIconRegistryValue,
  iconSourceKind,
  ICO_SIZES,
  MIN_ICON_SOURCE_PX,
  packIco,
  PDF_PROGID,
  type FileIconChoice,
  type FileIconErrorCode,
  type FileIconResult
} from '../shared/file-icon'
import { isPortableBuild } from './portable'
import { getState, mergeSettings, saveState } from './storage'

const REG_KEY = `HKCU\\Software\\Classes\\${PDF_PROGID}\\DefaultIcon`

/** True only for a packaged, installed Windows build — the one place the
 *  ProgId we write is the ProgId Explorer reads. */
export function fileIconSupported(): boolean {
  return process.platform === 'win32' && app.isPackaged && !process.windowsStore && !isPortableBuild()
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

/** The current DefaultIcon, or null when the key is missing (not installed
 *  by us, or an older install) */
async function readCurrent(): Promise<string | null> {
  try {
    const out = await run('reg.exe', ['query', REG_KEY, '/ve'])
    const m = /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Write the value a choice means, unless it is already there; refresh the
 *  shell's icon cache only after an actual write. */
async function writeChoice(choice: FileIconChoice, customPath: string): Promise<FileIconResult> {
  const value = fileIconRegistryValue(choice, {
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    customPath
  })
  if (!value) return { ok: false, code: 'file-icon-bad-file', error: 'no file chosen' }
  if ((await readCurrent()) !== value) {
    try {
      await run('reg.exe', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
    } catch (err) {
      return { ok: false, code: 'file-icon-registry', error: err instanceof Error ? err.message : String(err) }
    }
    // Fire and forget: the refresh is a courtesy, the value is already written
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {})
  }
  return { ok: true, fileIcon: choice, fileIconPath: customPath }
}

/** On startup: the installer may have rewritten DefaultIcon (every upgrade
 *  does), so a non-default choice is put back. Compares before writing, so a
 *  machine already in step pays nothing. */
export function reapplyFileIconAtStartup(): void {
  if (!fileIconSupported()) return
  const { fileIcon, fileIconPath } = getState().settings
  if (fileIcon === 'document') return
  void writeChoice(fileIcon, fileIconPath)
}

/** The reader's icon, kept in userData under its own name — the original may
 *  live on a USB stick or in Downloads, and a DefaultIcon that points at a
 *  file that is gone shows a blank sheet on every PDF. An .ico is copied; a
 *  .png is rendered into an .ico at Explorer's sizes (only the sizes the
 *  source can fill without upscaling, so a 64 px PNG gives 16/32/48 and the
 *  shell scales the 48 for its large views rather than us blurring a 256). */
function keepIcon(source: string): { path: string } | { code: FileIconErrorCode; error: string } {
  const kind = iconSourceKind(source)
  if (!kind) return { code: 'file-icon-bad-file', error: basename(source) }
  const dir = join(app.getPath('userData'), 'file-icons')
  mkdirSync(dir, { recursive: true })
  if (kind === 'ico') {
    const target = join(dir, basename(source))
    copyFileSync(source, target)
    return { path: target }
  }
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) return { code: 'file-icon-bad-file', error: basename(source) }
  const { width, height } = image.getSize()
  if (width !== height) return { code: 'file-icon-not-square', error: `${width}×${height}` }
  if (width < MIN_ICON_SOURCE_PX) return { code: 'file-icon-too-small', error: `${width} px` }
  const entries = ICO_SIZES.filter((s) => s <= width).map((size) => ({
    size,
    png: new Uint8Array(image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  }))
  const target = join(dir, `${basename(source, extname(source))}.ico`)
  writeFileSync(target, packIco(entries))
  return { path: target }
}

export function registerFileIconIpc(windowFor: (e: Electron.IpcMainInvokeEvent) => BrowserWindow | null): void {
  ipcMain.handle('file-icon:supported', () => fileIconSupported())

  ipcMain.handle('file-icon:set', async (e, choice: FileIconChoice): Promise<FileIconResult> => {
    if (!fileIconSupported()) {
      return { ok: false, code: 'file-icon-unavailable', error: 'not an installed Windows build' }
    }
    const state = getState()
    let customPath = state.settings.fileIconPath
    if (choice === 'custom') {
      const parent = windowFor(e)
      if (!parent) return { ok: false, cancelled: true }
      const picked = await dialog.showOpenDialog(parent, {
        filters: [{ name: 'Ikon (.ico, .png)', extensions: ['ico', 'png'] }],
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true }
      // The dialog filters on .ico/.png, but "All files" is one click away in
      // it — keepIcon judges the name and the bytes itself
      try {
        const kept = keepIcon(picked.filePaths[0])
        if ('code' in kept) return { ok: false, code: kept.code, error: kept.error }
        customPath = kept.path
      } catch (err) {
        return { ok: false, code: 'file-icon-registry', error: err instanceof Error ? err.message : String(err) }
      }
    }
    const result = await writeChoice(choice, customPath)
    if (result.ok) {
      state.settings = mergeSettings(state.settings, { fileIcon: choice, fileIconPath: customPath })
      saveState()
    }
    return result
  })
}

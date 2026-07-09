import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PdfxApi, ReadingPosition, ThemeName } from '../shared/types'

const api: PdfxApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  getRecents: () => ipcRenderer.invoke('recents:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getPosition: (path: string) => ipcRenderer.invoke('position:get', path),
  getPendingPath: () => ipcRenderer.invoke('pending-path:get'),
  setPosition: (path: string, pos: ReadingPosition) => ipcRenderer.send('position:set', path, pos),
  setTheme: (theme: ThemeName) => ipcRenderer.send('theme:set', theme),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  onOpenPath: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('open-path', listener)
    return () => {
      ipcRenderer.removeListener('open-path', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

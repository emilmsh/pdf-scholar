import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AiChatRequest,
  AiConfig,
  AiProviderId,
  AnnotateRequest,
  DeleteAnnotationRequest,
  ModifyAnnotationRequest,
  PdfxApi,
  ReadingPosition,
  Settings
} from '../shared/types'

const api: PdfxApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  getRecents: () => ipcRenderer.invoke('recents:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getPosition: (path: string) => ipcRenderer.invoke('position:get', path),
  getPendingPath: () => ipcRenderer.invoke('pending-path:get'),
  setPosition: (path: string, pos: ReadingPosition) => ipcRenderer.send('position:set', path, pos),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.send('settings:set', patch),
  annotate: (req: AnnotateRequest) => ipcRenderer.invoke('annotate', req),
  updateAnnotation: (req: ModifyAnnotationRequest) => ipcRenderer.invoke('annotation:update', req),
  deleteAnnotation: (req: DeleteAnnotationRequest) => ipcRenderer.invoke('annotation:delete', req),
  openExternal: (url: string) => ipcRenderer.send('shell:open-external', url),
  newWindow: (path?: string) => ipcRenderer.send('window:new', path),
  tabDropAtCursor: (path: string) => ipcRenderer.invoke('tab:drop-at-cursor', path),
  docOpened: (path: string) => ipcRenderer.send('doc:opened', path),
  docClosed: (path: string) => ipcRenderer.send('doc:closed', path),
  docIsDirty: (path: string) => ipcRenderer.invoke('doc:is-dirty', path),
  docWasModifiedExternally: (path: string) =>
    ipcRenderer.invoke('doc:was-modified-externally', path),
  docSave: (path: string) => ipcRenderer.invoke('doc:save', path),
  docConfirmClose: (path: string) => ipcRenderer.invoke('doc:confirm-close', path),
  docConfirmExternalUpdate: (path: string) =>
    ipcRenderer.invoke('doc:confirm-external-update', path),
  docDiscard: (path: string) => ipcRenderer.invoke('doc:discard', path),
  printFile: (path: string) => ipcRenderer.invoke('file:print', path),
  saveTextFile: (defaultName: string, content: string | Uint8Array) =>
    ipcRenderer.invoke('file:save-text', defaultName, content),
  saveFileAs: (defaultName: string, data: Uint8Array, path?: string) =>
    ipcRenderer.invoke('file:save-as', path ?? '', defaultName, data),
  saveDocumentBytes: (path: string, name: string, data: Uint8Array) =>
    ipcRenderer.invoke('file:save-bytes', path, name, data),
  showInFolder: (path: string) => ipcRenderer.send('shell:show-in-folder', path),
  setFullscreen: (on: boolean) => ipcRenderer.send('window:set-fullscreen', on),
  onFullScreen: (cb: (fullscreen: boolean) => void) => {
    const listener = (_e: unknown, fullscreen: boolean): void => cb(fullscreen)
    ipcRenderer.on('window:fullscreen', listener)
    return () => {
      ipcRenderer.removeListener('window:fullscreen', listener)
    }
  },
  setTitleBarColors: (color: string, symbolColor: string) =>
    ipcRenderer.send('window:titlebar-colors', color, symbolColor),
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
  },
  getVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateAvailable: (cb: (version: string) => void) => {
    const listener = (_e: unknown, version: string): void => cb(version)
    ipcRenderer.on('update:available', listener)
    return () => {
      ipcRenderer.removeListener('update:available', listener)
    }
  },
  onUpdateProgress: (cb: (percent: number) => void) => {
    const listener = (_e: unknown, percent: number): void => cb(percent)
    ipcRenderer.on('update:progress', listener)
    return () => {
      ipcRenderer.removeListener('update:progress', listener)
    }
  },
  onUpdateReady: (cb: (version: string) => void) => {
    const listener = (_e: unknown, version: string): void => cb(version)
    ipcRenderer.on('update:ready', listener)
    return () => {
      ipcRenderer.removeListener('update:ready', listener)
    }
  },
  updateSupport: () => ipcRenderer.invoke('update:support'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.send('update:download'),
  updateRestart: () => ipcRenderer.send('update:restart'),
  aiGetConfig: () => ipcRenderer.invoke('ai:get-config'),
  aiSetConfig: (patch: Partial<AiConfig> & { keys?: Partial<Record<AiProviderId, string>> }) =>
    ipcRenderer.invoke('ai:set-config', patch),
  aiChat: (request: AiChatRequest) => ipcRenderer.invoke('ai:chat', request),
  aiAbort: (requestId: number) => ipcRenderer.send('ai:abort', requestId),
  onAiDelta: (cb: (requestId: number, text: string) => void) => {
    const listener = (_e: unknown, requestId: number, text: string): void => cb(requestId, text)
    ipcRenderer.on('ai:delta', listener)
    return () => {
      ipcRenderer.removeListener('ai:delta', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

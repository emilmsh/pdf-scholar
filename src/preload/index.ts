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
  saveTextFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke('file:save-text', defaultName, content),
  setFullscreen: (on: boolean) => ipcRenderer.send('window:set-fullscreen', on),
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

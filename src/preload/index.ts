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
  Settings,
  WebSearchBounds,
  WebSearchState
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
  docSave: (path: string) => ipcRenderer.invoke('doc:save', path),
  docConfirmClose: (path: string) => ipcRenderer.invoke('doc:confirm-close', path),
  printFile: (path: string) => ipcRenderer.invoke('file:print', path),
  saveTextFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke('file:save-text', defaultName, content),
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
  },
  webSearchOpen: (query?: string) => ipcRenderer.send('web-search:open', query),
  webSearchClose: () => ipcRenderer.send('web-search:close'),
  webSearchSetBounds: (bounds: WebSearchBounds) => ipcRenderer.send('web-search:set-bounds', bounds),
  webSearchBack: () => ipcRenderer.send('web-search:back'),
  webSearchForward: () => ipcRenderer.send('web-search:forward'),
  webSearchReload: () => ipcRenderer.send('web-search:reload'),
  onWebSearchState: (cb: (state: WebSearchState) => void) => {
    const listener = (_e: unknown, state: WebSearchState): void => cb(state)
    ipcRenderer.on('web-search:state', listener)
    return () => {
      ipcRenderer.removeListener('web-search:state', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

// Unified access to the platform layer. In Electron the preload script exposes
// window.api; in a plain browser (dev preview) we fall back to web APIs so the
// UI can be developed and screenshotted without Electron.
import type {
  AiChatResult,
  AiConfig,
  AiContentPart,
  DocBookmark,
  PdfxApi,
  ReadingPosition,
  Settings
} from '../../shared/types'
import { t } from './i18n'
import { createExtensionApi, isExtensionContext } from './extension-api'
import { requestAssistantJump, subscribeAssistantJumps } from './assistant-channel'
import { buildAssistantHash } from '../../shared/viewer-url'
import { version as appVersion } from '../../../package.json'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { DEFAULT_AI_MODELS } from '../../shared/defaults'
import {
  browserApplyAnnotation,
  browserDeleteAnnotation,
  browserReadSignatures,
  browserSetFormField,
  browserUpdateAnnotation
} from './annotation-engine-browser'

export const isElectron = typeof window !== 'undefined' && !!window.api

/** True in the WebExtension viewer (has a runtime id and no window.api). Unlike
 *  the plain-web dev fallback, the extension can write back to local files via
 *  a retained File System Access handle, so it supports in-place save. */
export const isExtension = !isElectron && isExtensionContext()

interface WebState {
  positions: Record<string, ReadingPosition>
  bookmarks: Record<string, DocBookmark[]>
  settings: Settings
}

const LS_KEY = 'pdfx-web-state'


function loadWebState(): WebState {
  const fallback: WebState = { positions: {}, bookmarks: {}, settings: DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    return {
      ...fallback,
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings }
    }
  } catch {
    return fallback
  }
}

function saveWebState(state: WebState): void {
  localStorage.setItem(LS_KEY, JSON.stringify(state))
}

export const webApi: PdfxApi = {
  openFileDialog: () =>
    new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/pdf,.pdf'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return resolve(null)
        resolve({ path: file.name, name: file.name, data: new Uint8Array(await file.arrayBuffer()) })
      }
      input.click()
    }),
  readFile: async (path) => {
    try {
      const res = await fetch(path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const name = path.split('/').pop() ?? path
      return { path, name, data: new Uint8Array(await res.arrayBuffer()) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
  getRecents: async () => [],
  getSettings: async () => loadWebState().settings,
  getPosition: async (path) => loadWebState().positions[path] ?? null,
  getBookmarks: async (path) => loadWebState().bookmarks?.[path] ?? [],
  getPendingPath: async () => {
    // A new browser tab opened via newWindow() carries #open=<path>
    const m = /#open=([^&]+)/.exec(location.hash)
    return m ? decodeURIComponent(m[1]) : null
  },
  setPosition: (path, pos) => {
    const state = loadWebState()
    state.positions[path] = pos
    saveWebState(state)
  },
  setBookmarks: (path, bookmarks) => {
    const state = loadWebState()
    state.bookmarks = state.bookmarks ?? {}
    if (bookmarks.length === 0) delete state.bookmarks[path]
    else state.bookmarks[path] = bookmarks
    saveWebState(state)
  },
  setSettings: (patch) => {
    const state = loadWebState()
    state.settings = { ...state.settings, ...patch }
    saveWebState(state)
  },
  // Real annotation writes in the browser: the same EmbedPDF pdfium engine the
  // desktop uses, editing an in-memory twin of the document (the viewer
  // registers the bytes on mount). Platform parity — not a mock.
  annotate: (req) => browserApplyAnnotation(req),
  updateAnnotation: (req) => browserUpdateAnnotation(req),
  deleteAnnotation: (req) => browserDeleteAnnotation(req),
  setFormField: (req) => browserSetFormField(req),
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener')
  },
  // Save model: the browser preview has no real files — everything is a
  // harmless no-op so the save UI can still be exercised
  docOpened: () => {},
  docClosed: () => {},
  // Nothing to hand over: outside Electron the annotation engine is in this same
  // renderer and already holds the password (registerBrowserDoc took it).
  docUnlock: async () => {},
  docSignatures: (path) => browserReadSignatures(path),
  docIsDirty: async () => false,
  docWasModifiedExternally: async () => false,
  docSave: async () => ({ ok: true }),
  docConfirmClose: async () => ({ verdict: 'discard' }),
  docConfirmExternalUpdate: async () => 'discard',
  docDiscard: async () => {},
  // No cross-window annotation sync outside Electron: a second browser tab has
  // its own in-memory copy of the document with no shared draft to re-read, so
  // there is nothing to notify about. See docs/PLATFORMS.md.
  onAnnotationsChangedElsewhere: () => () => {},
  onDraftEndedElsewhere: () => () => {},
  // Browser preview: a new browser tab stands in for a new app window
  newWindow: (path) => {
    window.open(path ? `${location.origin}/#open=${encodeURIComponent(path)}` : location.href, '_blank')
  },
  // No cross-window cursor hit-testing in a plain browser — dropping a tab is
  // a no-op so dev:web keeps working
  tabDropAtCursor: async () => 'same',
  // Browser preview: open the PDF in a new tab — its viewer has print
  printFile: async (path) => {
    window.open(path, '_blank', 'noopener')
    return { ok: true }
  },
  saveTextFile: async (defaultName, content) => {
    const type = defaultName.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain;charset=utf-8'
    const blob = new Blob([content as BlobPart], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
    return { path: defaultName }
  },
  // Browser preview: a blob download stands in for a save dialog (the browser's
  // own "ask where to save" setting decides whether the user picks a folder).
  saveFileAs: async (defaultName, data) => downloadBlob(defaultName, data),
  saveDocumentBytes: async (_path, name, data) => downloadBlob(name, data),
  showInFolder: () => {},
  setFullscreen: (on) => {
    if (on) document.documentElement.requestFullscreen?.().catch(() => {})
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  },
  onFullScreen: (cb) => {
    const listener = (): void => cb(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', listener)
    return () => document.removeEventListener('fullscreenchange', listener)
  },
  setTitleBarColors: () => {},
  getPathForFile: () => null,
  onOpenPath: () => () => {},
  getVersion: async () => appVersion,
  // Auto-update is a desktop concern — the browser/extension just no-ops
  onUpdateAvailable: () => () => {},
  onUpdateProgress: () => () => {},
  onUpdateReady: () => () => {},
  onUpdateManual: () => () => {},
  updateSupport: async () => 'dev' as const,
  updateCheck: async () => ({ status: 'unsupported' as const, current: '', reason: 'dev' as const }),
  updateDownload: () => {},
  updateRestart: () => {},
  // AI in the browser preview: only the offline mock provider is available,
  // so the chat UI (streaming, citation chips, jump+highlight) can be tested.
  aiGetConfig: async () => ({
    ...loadWebAiConfig(),
    hasKey: { anthropic: false, openai: false, azure: false, openrouter: false, gemini: false, xai: false, mistral: false, groq: false, compat: false, mock: true },
    // Mock-only preview: no key is ever stored, so there is nothing to protect
    keyStorage: 'session-only' as const,
    keysSupported: false,
    catalog: {}
  }),
  aiSetConfig: async (patch) => {
    const current = loadWebAiConfig()
    const next: AiConfig = {
      provider: patch.provider ?? current.provider,
      models: { ...current.models, ...patch.models },
      azure: { ...current.azure, ...patch.azure },
      compat: { ...current.compat, ...patch.compat },
      thinking: patch.thinking ?? current.thinking
    }
    localStorage.setItem('pdfx-web-ai', JSON.stringify(next))
    return {
      ...next,
      hasKey: { anthropic: false, openai: false, azure: false, openrouter: false, gemini: false, xai: false, mistral: false, groq: false, compat: false, mock: true },
      keyStorage: 'session-only' as const,
      keysSupported: false,
      catalog: {}
    }
  },
  // No keys in the preview → nothing to fetch; hand back the current view
  aiRefreshModels: async () => webApi.aiGetConfig(),
  aiChat: async (request): Promise<AiChatResult> => {
    const config = loadWebAiConfig()
    if (config.provider !== 'mock') {
      return { error: t('ai.mockOnlyWeb') }
    }
    const doc = request.document
    const imageCount = request.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0)
    const answerA = imageCount
      ? `Dette er et testsvar fra mock-leverandøren. Jeg mottok ${imageCount} bilde${imageCount > 1 ? 'r' : ''} og ser innholdet`
      : 'Dette er et testsvar fra mock-leverandøren. Dokumentets innledning slår an tonen for resten av teksten'
    const answerB = doc
      ? ' og lenger ut i dokumentet utdypes dette med et konkret resonnement du kan hoppe rett til.'
      : '.'
    // Fake an external source so the chip UI is testable: always in 'on' mode,
    // in 'ask' mode only when the last user message looks like a search request
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
    const askedForWeb = /søk|search|nett|web/i.test(lastUser?.text ?? '')
    const searching =
      request.webSearch === 'on' || (request.webSearch === 'ask' && askedForWeb)
    const answerC = searching ? ' Et nettsøk bekrefter dette i en ekstern kilde.' : ''
    const full = answerA + answerB + answerC
    // Few large chunks: background-tab timer clamping (≥1s) would make
    // word-by-word streaming crawl in the automated preview
    const step = Math.ceil(full.length / 5)
    for (let i = 0; i < full.length; i += step) {
      if (webAiAborted.has(request.requestId)) {
        webAiAborted.delete(request.requestId)
        return { error: t('ai.aborted') }
      }
      for (const cb of webAiDeltaListeners) cb(request.requestId, full.slice(i, i + step))
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const mid = doc ? Math.floor(doc.text.length * 0.4) : 0
    const parts: AiContentPart[] = doc
      ? [
          {
            text: answerA,
            citations: [
              { kind: 'char', start: 0, end: Math.min(90, doc.text.length), citedText: doc.text.slice(0, 90) }
            ]
          },
          {
            text: answerB,
            citations: [
              {
                kind: 'char',
                start: mid,
                end: Math.min(mid + 120, doc.text.length),
                citedText: doc.text.slice(mid, mid + 120)
              }
            ]
          }
        ]
      : [{ text: answerA + answerB, citations: [] }]
    if (answerC) {
      parts.push({
        text: answerC,
        citations: [{ kind: 'web', url: 'https://example.org/kilde', title: 'Eksempelkilde (mock)' }]
      })
    }
    return {
      ok: true,
      parts,
      usage: {
        inputTokens: doc ? Math.ceil(doc.text.length / 4) : 50,
        outputTokens: Math.ceil(full.length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      model: 'mock-1'
    }
  },
  aiAbort: (requestId) => {
    webAiAborted.add(requestId)
  },
  onAiDelta: (cb) => {
    webAiDeltaListeners.add(cb)
    return () => {
      webAiDeltaListeners.delete(cb)
    }
  },
  // Detached assistant in a plain browser: a second tab carrying #assistant=,
  // with citation jumps relayed over a BroadcastChannel (assistant-channel.ts).
  // The receiving tab cannot raise itself here — that is a browser rule, not
  // ours; the extension layer adds tab activation where chrome.tabs exists.
  openAssistant: (path) => {
    window.open(`${location.origin}/#${buildAssistantHash(path)}`, '_blank')
  },
  assistantJumpToCitation: (path, target) => requestAssistantJump(path, target),
  onAssistantJumpRequest: (cb) => subscribeAssistantJumps(cb)
}

/** Trigger a browser download of PDF bytes (the browser decides folder prompt). */
function downloadBlob(name: string, data: Uint8Array): { path: string } {
  const blob = new Blob([data as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
  return { path: name }
}

const webAiDeltaListeners = new Set<(requestId: number, text: string) => void>()
const webAiAborted = new Set<number>()

function loadWebAiConfig(): AiConfig {
  const fallback: AiConfig = {
    provider: 'mock',
    models: { ...DEFAULT_AI_MODELS },
    azure: { endpoint: '', deployment: '', apiVersion: '' },
    compat: { baseUrl: '' },
    thinking: 'medium'
  }
  try {
    const parsed = JSON.parse(localStorage.getItem('pdfx-web-ai') ?? '{}')
    return {
      ...fallback,
      ...parsed,
      models: { ...fallback.models, ...parsed.models },
      azure: { ...fallback.azure, ...parsed.azure },
      compat: { ...fallback.compat, ...parsed.compat }
    }
  } catch {
    return fallback
  }
}

// Platform selection: Electron (window.api) → WebExtension → plain-web fallback.
// The extension bridge is an overlay on the web fallback (see extension-api.ts).
export const bridge: PdfxApi = window.api
  ? window.api
  : isExtensionContext()
    ? createExtensionApi(webApi)
    : webApi

// Unified access to the platform layer. In Electron the preload script exposes
// window.api; in a plain browser (dev preview) we fall back to web APIs so the
// UI can be developed and screenshotted without Electron.
import type {
  AiChatResult,
  AiConfig,
  AiContentPart,
  PdfxApi,
  ReadingPosition,
  Settings
} from '../../shared/types'
import { t } from './i18n'

export const isElectron = typeof window !== 'undefined' && !!window.api

interface WebState {
  positions: Record<string, ReadingPosition>
  settings: Settings
}

const LS_KEY = 'pdfx-web-state'

const DEFAULT_SETTINGS: Settings = {
  theme: 'day',
  themeAdjust: {
    day: { contrast: 1, brightness: 1 },
    sepia: { contrast: 1, brightness: 1 },
    night: { contrast: 1, brightness: 1 }
  },
  keepAwake: false,
  language: 'auto'
}

function loadWebState(): WebState {
  const fallback: WebState = { positions: {}, settings: DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    return {
      ...fallback,
      ...parsed,
      settings: {
        ...DEFAULT_SETTINGS,
        ...parsed.settings,
        themeAdjust: { ...DEFAULT_SETTINGS.themeAdjust, ...parsed.settings?.themeAdjust }
      }
    }
  } catch {
    return fallback
  }
}

function saveWebState(state: WebState): void {
  localStorage.setItem(LS_KEY, JSON.stringify(state))
}

const webApi: PdfxApi = {
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
  setSettings: (patch) => {
    const state = loadWebState()
    state.settings = {
      ...state.settings,
      ...patch,
      themeAdjust: { ...state.settings.themeAdjust, ...patch.themeAdjust }
    }
    saveWebState(state)
  },
  // Browser preview cannot write to disk — accept the annotation so the UI
  // flow (overlay, menus) can be exercised, but nothing is persisted.
  annotate: async (req) => {
    console.debug('pdfx (web): annotate mock', req)
    return { ok: true, id: -Math.floor(Math.random() * 1e9) }
  },
  updateAnnotation: async (req) => {
    console.debug('pdfx (web): updateAnnotation mock', req)
    return { ok: true, id: req.id }
  },
  deleteAnnotation: async (req) => {
    console.debug('pdfx (web): deleteAnnotation mock', req)
    return { ok: true, id: req.id }
  },
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener')
  },
  // Browser preview: a new browser tab stands in for a new app window
  newWindow: (path) => {
    window.open(path ? `${location.origin}/#open=${encodeURIComponent(path)}` : location.href, '_blank')
  },
  // Browser preview: open the PDF in a new tab — its viewer has print
  printFile: async (path) => {
    window.open(path, '_blank', 'noopener')
    return { ok: true }
  },
  saveTextFile: async (defaultName, content) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
    return { path: defaultName }
  },
  setFullscreen: (on) => {
    if (on) document.documentElement.requestFullscreen?.().catch(() => {})
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  },
  getPathForFile: () => null,
  onOpenPath: () => () => {},
  // AI in the browser preview: only the offline mock provider is available,
  // so the chat UI (streaming, citation chips, jump+highlight) can be tested.
  aiGetConfig: async () => ({
    ...loadWebAiConfig(),
    hasKey: { anthropic: false, openai: false, azure: false, mock: true },
    encryptionAvailable: false
  }),
  aiSetConfig: async (patch) => {
    const current = loadWebAiConfig()
    const next: AiConfig = {
      provider: patch.provider ?? current.provider,
      models: { ...current.models, ...patch.models },
      azure: { ...current.azure, ...patch.azure },
      thinking: patch.thinking ?? current.thinking
    }
    localStorage.setItem('pdfx-web-ai', JSON.stringify(next))
    return {
      ...next,
      hasKey: { anthropic: false, openai: false, azure: false, mock: true },
      encryptionAvailable: false
    }
  },
  aiChat: async (request): Promise<AiChatResult> => {
    const config = loadWebAiConfig()
    if (config.provider !== 'mock') {
      return { error: t('ai.mockOnlyWeb') }
    }
    const doc = request.document
    const answerA =
      'Dette er et testsvar fra mock-leverandøren. Dokumentets innledning slår an tonen for resten av teksten'
    const answerB =
      ' og lenger ut i dokumentet utdypes dette med et konkret resonnement du kan hoppe rett til.'
    const full = answerA + answerB
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
      : [{ text: full, citations: [] }]
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
  }
}

const webAiDeltaListeners = new Set<(requestId: number, text: string) => void>()
const webAiAborted = new Set<number>()

function loadWebAiConfig(): AiConfig {
  const fallback: AiConfig = {
    provider: 'mock',
    models: { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', azure: '', mock: 'mock-1' },
    azure: { endpoint: '', deployment: '' },
    thinking: 'medium'
  }
  try {
    const parsed = JSON.parse(localStorage.getItem('pdfx-web-ai') ?? '{}')
    return {
      ...fallback,
      ...parsed,
      models: { ...fallback.models, ...parsed.models },
      azure: { ...fallback.azure, ...parsed.azure }
    }
  } catch {
    return fallback
  }
}

export const bridge: PdfxApi = window.api ?? webApi

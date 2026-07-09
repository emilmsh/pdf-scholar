// Unified access to the platform layer. In Electron the preload script exposes
// window.api; in a plain browser (dev preview) we fall back to web APIs so the
// UI can be developed and screenshotted without Electron.
import type { PdfxApi, ReadingPosition, Settings } from '../../shared/types'

export const isElectron = typeof window !== 'undefined' && !!window.api

interface WebState {
  positions: Record<string, ReadingPosition>
  settings: Settings
}

const LS_KEY = 'pdfx-web-state'

function loadWebState(): WebState {
  const fallback: WebState = { positions: {}, settings: { theme: 'day' } }
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
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
  getPendingPath: async () => null,
  setPosition: (path, pos) => {
    const state = loadWebState()
    state.positions[path] = pos
    saveWebState(state)
  },
  setTheme: (theme) => {
    const state = loadWebState()
    state.settings.theme = theme
    saveWebState(state)
  },
  // Browser preview cannot write to disk — accept the annotation so the UI
  // flow (overlay, menus) can be exercised, but nothing is persisted.
  annotate: async (req) => {
    console.debug('pdfx (web): annotate mock', req)
    return { ok: true }
  },
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener')
  },
  setFullscreen: (on) => {
    if (on) document.documentElement.requestFullscreen?.().catch(() => {})
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  },
  getPathForFile: () => null,
  onOpenPath: () => () => {}
}

export const bridge: PdfxApi = window.api ?? webApi

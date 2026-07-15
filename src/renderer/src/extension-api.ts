// Browser-extension implementation of the PdfxApi platform surface.
//
// The renderer is platform-agnostic: it talks to `window.api` (Electron) or a
// fallback (see bridge.ts). This module is the third target — the same UI
// running inside a WebExtension viewer page, where each PDF is a real browser
// tab instead of an in-app tab (Edge/Chrome-style integration).
//
// It is built as an OVERLAY on top of the web fallback (`base`): everything the
// web fallback already does correctly in a plain page (fullscreen, the AI mock,
// text-file export) is inherited; only the genuinely platform-specific pieces
// are overridden here — reading the document handed to us by the browser, tab
// creation, and persistence via chrome.storage. Passing `base` in (rather than
// importing it) keeps bridge.ts the single owner of platform selection and
// avoids an import cycle.
//
// Deliberately staged for later (documented in docs/BROWSER-EXTENSION.md):
//   - annotate/updateAnnotation/deleteAnnotation still use the mock — real
//     write-back needs the mupdf-WASM engine + a save target (File System
//     Access handle or a native-messaging host). The seams are marked TODO.
//   - AI uses the web mock; live providers need a native host (key safety +
//     CORS) or a CORS-enabled proxy.

import type {
  FilePayload,
  FileError,
  PdfxApi,
  ReadingPosition,
  RecentFile,
  Settings
} from '../../shared/types'
import { store } from './extension-store'
import { createExtensionAi } from './extension-ai'

/** True when running inside a WebExtension page (has a runtime id). */
export function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id
}

const K_SETTINGS = 'pdfx-settings'
const K_POSITIONS = 'pdfx-positions'
const K_RECENTS = 'pdfx-recents'

const DEFAULT_SETTINGS: Settings = {
  theme: 'day',
  autoLight: 'day',
  autoDark: 'night',
  keepAwake: false,
  language: 'auto'
}

/** File System Access handles from in-app "Open" — keyed by the path we return,
 *  so a later docSave can write back silently. file://-opened documents have no
 *  handle and fall back to a save-picker (see docSave). */
const handles = new Map<string, FileSystemFileHandle>()

/** The extension viewer URL for a given source path/URL. */
function viewerUrl(path: string): string {
  const base = chrome?.runtime?.getURL('viewer.html') ?? 'viewer.html'
  return `${base}?file=${encodeURIComponent(path)}`
}

function recordRecent(payload: { path: string; name: string }): void {
  void store.get<RecentFile[]>(K_RECENTS, []).then((list) => {
    const next = [
      { path: payload.path, name: payload.name, lastOpened: Date.now() },
      ...list.filter((r) => r.path !== payload.path)
    ].slice(0, 30)
    store.set(K_RECENTS, next)
  })
}

export function createExtensionApi(base: PdfxApi): PdfxApi {
  return {
    ...base,

    // Real multi-provider AI (BYO key) — overrides the web mock inherited from
    // `base`. Keys live in chrome.storage.local; calls go straight to the
    // provider from the viewer page (see extension-ai.ts).
    ...createExtensionAi(),

    // ---------- Documents ----------

    // The background/viewer navigation carries the original document URL as a
    // ?file= param; the shell opens it on mount (mirrors the Electron
    // "pending path" handed to a freshly spawned window).
    getPendingPath: async () => {
      const m = new URLSearchParams(location.search).get('file')
      return m ? m : null
    },

    // file:// requires the "Allow access to file URLs" toggle in the extension
    // details page; http(s) requires the host in manifest host_permissions.
    readFile: async (path): Promise<FilePayload | FileError> => {
      try {
        const res = await fetch(path)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const name = decodeURIComponent(path.split(/[/\\]/).pop() ?? path)
        return { path, name, data: new Uint8Array(await res.arrayBuffer()) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    openFileDialog: async (): Promise<FilePayload | FileError | null> => {
      const picker = (window as unknown as {
        showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>
      }).showOpenFilePicker
      if (!picker) return base.openFileDialog()
      try {
        const [handle] = await picker({
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
          multiple: false
        })
        const file = await handle.getFile()
        const path = `fsa:${file.name}`
        handles.set(path, handle)
        recordRecent({ path, name: file.name })
        return { path, name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
      } catch {
        return null // user cancelled the picker
      }
    },

    // ---------- Tabs / windows ----------

    // A "new window" in the native app is a new browser tab here.
    newWindow: (path?: string) => {
      const url = path ? viewerUrl(path) : viewerUrl('')
      if (chrome?.tabs) void chrome.tabs.create({ url, active: true })
      else window.open(url, '_blank')
    },

    // ---------- Persistence ----------

    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...(await store.get<Partial<Settings>>(K_SETTINGS, {})) }),
    setSettings: (patch) => {
      void store.get<Settings>(K_SETTINGS, DEFAULT_SETTINGS).then((cur) =>
        store.set(K_SETTINGS, { ...cur, ...patch })
      )
    },
    getPosition: async (path) => {
      const all = await store.get<Record<string, ReadingPosition>>(K_POSITIONS, {})
      return all[path] ?? null
    },
    setPosition: (path, pos) => {
      void store
        .get<Record<string, ReadingPosition>>(K_POSITIONS, {})
        .then((all) => store.set(K_POSITIONS, { ...all, [path]: pos }))
    },
    getRecents: () => store.get<RecentFile[]>(K_RECENTS, []),

    docOpened: (path: string) => {
      // The name is derived from the path tail; the shell also records recents
      // via openFileDialog. Keep this cheap and best-effort.
      const name = decodeURIComponent(path.split(/[/\\]/).pop() ?? path)
      if (path) recordRecent({ path, name })
    },

    // ---------- Save model ----------

    // TODO(annotations): once the mupdf-WASM engine produces modified bytes,
    // write them here — via the retained File System Access handle when we have
    // one (silent), else showSaveFilePicker (one dialog, then silent in-session),
    // or a native-messaging host for true silent overwrite of file:// paths.
    docSave: async (path): Promise<{ ok: true } | FileError> => {
      const handle = handles.get(path)
      if (!handle) return { ok: true } // nothing persisted yet (mock annotate)
      try {
        // Placeholder: no modified bytes to write until the engine lands.
        return { ok: true }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    docConfirmClose: async (): Promise<'save' | 'discard' | 'cancel'> => {
      // No native tri-state dialog in a browser tab; a confirm() is the honest
      // stand-in until the save model is wired. Cancel keeps the tab open.
      return window.confirm('Lagre endringer før lukking?') ? 'save' : 'discard'
    }
  }
}

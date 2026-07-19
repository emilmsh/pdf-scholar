// Browser-extension implementation of the PdfxApi platform surface.
//
// The renderer is platform-agnostic: it talks to `window.api` (Electron) or a
// fallback (see bridge.ts). This module is the third target — the same UI
// running inside a WebExtension viewer page, where each PDF is a real browser
// tab instead of an in-app tab (Edge/Chrome-style integration).
//
// It is built as an OVERLAY on top of the web fallback (`base`): everything the
// web fallback already does correctly in a plain page (fullscreen, text-file
// export) is inherited; only the genuinely platform-specific pieces are
// overridden here — reading the document handed to us by the browser, tab
// creation, persistence via chrome.storage, and real AI (extension-ai.ts).
// Passing `base` in (rather than importing it) keeps bridge.ts the single owner
// of platform selection and avoids an import cycle.
//
// annotate/updateAnnotation/deleteAnnotation are inherited from the web
// fallback, which routes them to the real browser annotation engine
// (annotation-engine-browser.ts — same EmbedPDF pdfium as the desktop).
// Persistence is this module's saveDocumentBytes/saveFileAs below.

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
import { ext } from './ext'

/** True when running inside a WebExtension page (has a runtime id). Uses the
 *  `ext` alias so it is true on Firefox (browser.*) as well as Chrome. */
export function isExtensionContext(): boolean {
  return !!ext?.runtime?.id
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
  const base = ext?.runtime?.getURL('viewer.html') ?? 'viewer.html'
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
      if (ext?.tabs) void ext.tabs.create({ url, active: true })
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
    // NOTE: docSave/docConfirmClose stay on the inherited base no-ops. In the
    // browser the real save path is saveDocumentBytes (below) fed by the
    // renderer's live annotation engine, and the unsaved-changes prompt is the
    // in-app dialog in App.tsx — same three verdicts as the desktop's native
    // dialog, with 'save' wired to this same byte path.

    // Save a copy anywhere on disk. The File System Access picker is a real
    // native Save dialog (choose folder + name); fall back to a plain download
    // when it is unavailable.
    saveFileAs: (defaultName, data) => saveViaPicker(defaultName, data, base),

    // Browser save: overwrite the original local file silently when it was
    // opened via a retained file handle (the "save over" case); otherwise a
    // URL-opened PDF has no such target, so prompt for a location.
    saveDocumentBytes: async (path, name, data): Promise<{ path: string } | FileError | null> => {
      const handle = handles.get(path)
      if (handle) {
        try {
          const writable = await handle.createWritable()
          await writable.write(data as unknown as BufferSource)
          await writable.close()
          return { path }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      }
      return saveViaPicker(name, data, base)
    }
  }
}

/** Save bytes through the File System Access "Save file" picker (real folder
 *  chooser); fall back to a plain download when the API is unavailable. */
async function saveViaPicker(
  suggestedName: string,
  data: Uint8Array,
  base: PdfxApi
): Promise<{ path: string } | FileError | null> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
  }).showSaveFilePicker
  if (!picker) return base.saveFileAs(suggestedName, data)
  try {
    const handle = await picker({
      suggestedName,
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]
    })
    const writable = await handle.createWritable()
    await writable.write(data as unknown as BufferSource)
    await writable.close()
    return { path: handle.name }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null // cancelled
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

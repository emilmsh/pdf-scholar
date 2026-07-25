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
import {
  ensureReadPermission,
  ensureWritePermission,
  forgetFileHandle,
  loadFileHandle,
  saveFileHandle
} from './extension-fs-grants'
import { t } from './i18n'

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

/** Original file's `lastModified` at the moment its handle was captured —
 *  the baseline docWasModifiedExternally compares against before an
 *  overwrite-via-handle save. */
const handleBaseline = new Map<string, number>()

/** `fsa:` marks a file the user picked in the File System Access dialog: there is
 *  no URL the browser could re-fetch, so the FILE HANDLE is the identity and the
 *  path is just a stable key (its basename). Handles are persisted, so such a
 *  file stays reopenable from the recents list across sessions — two files with
 *  the same basename share the key, and the most recently opened one wins. */
const FSA = 'fsa:'

/** Display name for a path: picked files carry the pseudo-prefix, real paths
 *  their last segment. */
function fileNameOf(path: string): string {
  if (path.startsWith(FSA)) return path.slice(FSA.length)
  return decodeURIComponent(path.split(/[/\\]/).pop() ?? path)
}

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
    // A picked (fsa:) file is NOT fetchable — it is read back through its stored
    // handle instead, which is what makes it reopenable from the recents list.
    readFile: async (path): Promise<FilePayload | FileError> => {
      if (path.startsWith(FSA)) return readViaHandle(path)
      try {
        const res = await fetch(path)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return { path, name: fileNameOf(path), data: new Uint8Array(await res.arrayBuffer()) }
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
        const path = `${FSA}${file.name}`
        handles.set(path, handle)
        handleBaseline.set(path, file.lastModified)
        // Persist the handle so the recents entry we are about to write stays
        // openable in a later session (readFile reads it back via readViaHandle).
        saveFileHandle(path, handle)
        recordRecent({ path, name: file.name })
        return { path, name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
      } catch {
        return null // user cancelled the picker
      }
    },

    // ---------- Tabs / windows ----------

    // A "new window" in the native app is a new browser tab here.
    // tabs.create is permission-free (see the note in src/extension/background.ts).
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
    // Heal names written before fileNameOf existed (picked files were stored as
    // "fsa:<name>" because the name was derived from the pseudo-path).
    getRecents: async () =>
      (await store.get<RecentFile[]>(K_RECENTS, [])).map((r) =>
        r.name.startsWith(FSA) ? { ...r, name: fileNameOf(r.name) } : r
      ),

    docOpened: (path: string) => {
      // The name is derived from the path tail; the shell also records recents
      // via openFileDialog. Keep this cheap and best-effort.
      if (path) recordRecent({ path, name: fileNameOf(path) })
      // Pre-warm a write grant saved in a previous session so the FIRST save can
      // be silent when the browser still holds the permission. queryPermission
      // never prompts (interactive:false); a grant that needs re-confirming just
      // waits for the Save click, where requestPermission is allowed to prompt.
      if (path && !handles.has(path)) {
        void loadFileHandle(path).then(async (stored) => {
          if (stored && (await ensureWritePermission(stored, false))) handles.set(path, stored)
        })
      }
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

    // In-place "save over the current file". When the document was opened via
    // the app's picker we already hold a writable handle and overwrite it
    // silently — same feel as the desktop app. A URL/file://-opened PDF was
    // fetched read-only (no handle): the browser's security model forbids a web
    // page from writing to a local file until the user points at it once, so
    // the FIRST save opens a Save picker to establish write access. That handle
    // is then RETAINED for the session AND persisted across sessions
    // (extension-fs-grants.ts), so the same file is granted at most once ever —
    // every later save (and Ctrl+S), this session or a future one, overwrites
    // silently. (Edge's built-in PDF viewer skips even that one grant because it
    // is privileged first-party browser code, not sandboxed web content.)
    saveDocumentBytes: async (path, name, data): Promise<{ path: string } | FileError | null> => {
      // Per-file only (not folder-wide) — never asks for broader access than the
      // user reached for. Keyed by the file URL, or by the fsa: basename for a
      // picked file (see FSA above).
      let handle = handles.get(path)
      // Restore a grant from a previous session before asking again.
      if (!handle) {
        const stored = await loadFileHandle(path)
        if (stored && (await ensureWritePermission(stored))) {
          handle = stored
          handles.set(path, handle)
        }
      }
      if (!handle) {
        const picker = (window as unknown as {
          showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
        }).showSaveFilePicker
        if (!picker) return saveViaPicker(name, data, base) // very old browser
        try {
          handle = await picker({
            suggestedName: name,
            types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]
          })
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return null // cancelled
          return { error: err instanceof Error ? err.message : String(err) }
        }
        handles.set(path, handle)
        saveFileHandle(path, handle)
      }
      try {
        const writable = await handle.createWritable()
        await writable.write(data as unknown as BufferSource)
        await writable.close()
        // This write IS the new baseline — otherwise every later save would
        // keep flagging a "conflict" against the pre-fix mtime forever.
        handleBaseline.set(path, (await handle.getFile()).lastModified)
        return { path }
      } catch (err) {
        // The handle is stale (file moved/deleted, or permission lost): drop it
        // so the next save re-establishes access instead of failing forever.
        handles.delete(path)
        forgetFileHandle(path)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    // True when the file behind a retained handle changed since it was
    // captured — a URL-opened PDF (no handle) has no in-place target, so
    // there is nothing to conflict with.
    docWasModifiedExternally: async (path): Promise<boolean> => {
      const handle = handles.get(path)
      const baseline = handleBaseline.get(path)
      if (!handle || baseline == null) return false
      try {
        return (await handle.getFile()).lastModified > baseline
      } catch {
        return false
      }
    }
  }
}

/** Read a picked (fsa:) file back through its File System Access handle — the
 *  session handle if we still hold one, otherwise the one persisted when the
 *  user picked it. After a browser restart the stored handle usually needs its
 *  permission re-confirmed, which is a prompt: this runs from the click on the
 *  recents row, so the gesture is there to spend. If the handle is gone (grants
 *  cleared, file moved, private window) say so in words the user can act on —
 *  "Failed to fetch" was the old, useless failure. */
async function readViaHandle(path: string): Promise<FilePayload | FileError> {
  let handle = handles.get(path)
  if (!handle) {
    const stored = await loadFileHandle(path)
    if (stored && (await ensureReadPermission(stored))) {
      handle = stored
      handles.set(path, handle)
    }
  }
  if (!handle) return { error: t('doc.pickedUnavailable') }
  try {
    const file = await handle.getFile()
    handleBaseline.set(path, file.lastModified)
    return { path, name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
  } catch {
    // Moved, renamed or deleted since we stored it — drop the dead handle so the
    // entry stops pretending it can be reopened.
    handles.delete(path)
    forgetFileHandle(path)
    return { error: t('doc.pickedUnavailable') }
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

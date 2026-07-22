// Persistent per-file write-access grants for the browser-extension viewer.
//
// A PDF opened from File Explorer reaches us as a read-only `file://`
// navigation: the browser's security model forbids a sandboxed page from
// writing to a local file until the user grants access via a gesture (a Save
// picker). To keep that gesture RARE, we persist the writable File System
// Access handle the user picked — keyed by the file's URL — in IndexedDB, which
// (unlike chrome.storage's JSON store) can structured-clone a FileSystemHandle.
//
// On a later session the same file resolves to its stored handle, and a single
// requestPermission (one click at most, often silent) restores write access —
// so each file is granted AT MOST ONCE, ever, rather than once per session.
//
// Scope is deliberately per-file (not a whole folder): it never asks for
// broader access than the user already reached for, which keeps the permission
// story simple for store review.

const DB_NAME = 'pdfx-fs-grants'
const STORE = 'handles'

/** FS Access permission methods are not in every lib.dom version — narrow to
 *  what we call. */
type PermalinkHandle = FileSystemFileHandle & {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE))
          request.onsuccess = () => resolve(request.result as T)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}

/** The stored handle for a file URL, or null if none / IndexedDB unavailable. */
export function loadFileHandle(path: string): Promise<FileSystemFileHandle | null> {
  return tx<FileSystemFileHandle>('readonly', (s) => s.get(path)).then((h) => h ?? null)
}

export function saveFileHandle(path: string, handle: FileSystemFileHandle): void {
  void tx('readwrite', (s) => s.put(handle, path))
}

export function forgetFileHandle(path: string): void {
  void tx('readwrite', (s) => s.delete(path))
}

/** Ensure we hold read/write permission for a restored handle. queryPermission
 *  never prompts (use it to pre-warm silently); requestPermission needs a user
 *  gesture, so only call this from a click handler (e.g. the Save button).
 *  `interactive: false` skips the prompt — returns false if a grant is needed. */
export async function ensureWritePermission(
  handle: FileSystemFileHandle,
  interactive = true
): Promise<boolean> {
  const h = handle as PermalinkHandle
  const opts = { mode: 'readwrite' as const }
  try {
    if ((await h.queryPermission?.(opts)) === 'granted') return true
    if (!interactive) return false
    return (await h.requestPermission?.(opts)) === 'granted'
  } catch {
    return false
  }
}

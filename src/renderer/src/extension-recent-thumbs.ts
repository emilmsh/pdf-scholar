// The extension's store for the library's grid pictures (issue #28; the rules
// are in src/shared/recent-thumbs.ts, desktop's store is src/main/recent-thumbs.ts).
//
// IndexedDB, not chrome.storage.local: that store is JSON (a picture would
// travel as base64, a third larger) and capped at 10 MB without the
// `unlimitedStorage` permission, which the reading positions, the encrypted
// keys and the recents already share. Keyed by the recents path; pruned by
// extension-api.ts against the recents list whenever the library reads it.
import type { RecentThumb } from '../../shared/types'
import { sanitizeRecentThumb } from '../../shared/recent-thumbs'

const DB_NAME = 'pdfx-recent-thumbs'
const STORE = 'thumbs'

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

/** Every stored picture, by path. Empty when IndexedDB is unavailable — the
 *  grid then shows its placeholders, which is all a missing picture costs. */
export async function loadRecentThumbs(): Promise<Record<string, RecentThumb>> {
  const db = await openDb()
  if (!db) return {}
  return new Promise((resolve) => {
    const out: Record<string, RecentThumb> = {}
    try {
      const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
      cursor.onsuccess = () => {
        const at = cursor.result
        if (!at) return resolve(out)
        const thumb = sanitizeRecentThumb(at.value)
        if (thumb && typeof at.key === 'string') out[at.key] = thumb
        at.continue()
      }
      cursor.onerror = () => resolve(out)
    } catch {
      resolve(out)
    }
  })
}

export async function saveRecentThumb(path: string, thumb: RecentThumb): Promise<void> {
  const db = await openDb()
  try {
    db?.transaction(STORE, 'readwrite').objectStore(STORE).put(thumb, path)
  } catch {
    /* best-effort: the grid draws it again next time */
  }
}

export async function forgetRecentThumbs(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const db = await openDb()
  try {
    const store = db?.transaction(STORE, 'readwrite').objectStore(STORE)
    for (const path of paths) store?.delete(path)
  } catch {
    /* best-effort: the next prune tries again */
  }
}

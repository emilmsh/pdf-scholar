// Small async key/value store for the browser-extension target: extension
// storage.local when running as a real extension, localStorage otherwise
// (plain-page dev). Shared by extension-api.ts (settings/positions/recents) and
// extension-ai.ts (AI config + keys) so there is one storage shim, not two.
//
// Goes through the `ext` alias (browser ?? chrome), not bare `chrome`, so the
// promise-style `storage.local.get/set` resolve on Firefox too (see ext.ts).
import { ext } from './ext'

export const store = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (ext?.storage) {
      const got = await ext.storage.local.get(key)
      return (got[key] as T) ?? fallback
    }
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    if (ext?.storage) {
      void ext.storage.local.set({ [key]: value })
    } else {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* ignore quota/serialization errors — parity with web fallback */
      }
    }
  }
}

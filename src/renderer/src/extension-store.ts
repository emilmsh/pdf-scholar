// Small async key/value store for the browser-extension target: chrome.storage
// .local when running as a real extension, localStorage otherwise (plain-page
// dev). Shared by extension-api.ts (settings/positions/recents) and
// extension-ai.ts (AI config + keys) so there is one storage shim, not two.
export const store = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (chrome?.storage) {
      const got = await chrome.storage.local.get(key)
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
    if (chrome?.storage) {
      void chrome.storage.local.set({ [key]: value })
    } else {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* ignore quota/serialization errors — parity with web fallback */
      }
    }
  }
}

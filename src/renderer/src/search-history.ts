// Recent find-bar queries, most recent first. Mirrors the pdfx-custom-colors
// pattern in annotations.ts: localStorage, deduped, capped, and renderer-only —
// nothing in the main process reads it, so it needs no IPC and works the same in
// Electron, the extension and the dev:web preview.
//
// Deliberately global rather than per document: you look up the same terms
// across the papers you are reading, which is the whole reason to keep a list.

const LS_KEY = 'pdfx-search-history'
const MAX_ENTRIES = 10
/** A query longer than this is a paste, not something worth offering again */
const MAX_LENGTH = 120

export function loadSearchHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((q): q is string => typeof q === 'string' && q.length > 0 && q.length <= MAX_LENGTH)
      .slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

/** Remember a query that actually ran. Case-insensitive dedupe, because
 *  offering both "Fisher" and "fisher" would waste a row on nothing. */
export function addSearchHistory(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed || trimmed.length > MAX_LENGTH) return loadSearchHistory()
  const lower = trimmed.toLowerCase()
  const next = [trimmed, ...loadSearchHistory().filter((q) => q.toLowerCase() !== lower)].slice(
    0,
    MAX_ENTRIES
  )
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch {
    /* remembering searches is a convenience, never a requirement */
  }
  return next
}

/** Forget every remembered query — the find bar's own Clear, and the app-wide
 *  reset to defaults (resetPreferences in PdfViewer). */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* nothing to forget */
  }
}

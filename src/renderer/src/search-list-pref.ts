// Whether the find bar's results list is unfolded. Folded by DEFAULT (Emil,
// 2026-10-04, on a reader's ask: the open list — ~300 px of excerpts under the
// field — covered the very hit it pointed at, in the right-hand column of a
// split view most of all); a reader who unfolds it is remembered. Mirrors
// search-history.ts: localStorage, renderer-only, no IPC — the same value in
// Electron, the extension and the dev:web preview.

const LS_KEY = 'pdfx-search-list-open'

export function loadSearchListOpen(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSearchListOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(LS_KEY, '1')
    else localStorage.removeItem(LS_KEY) // absent = the default, folded
  } catch {
    /* a convenience, never a requirement */
  }
}

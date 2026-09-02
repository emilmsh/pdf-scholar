// Renderer-side refcount around main's per-window open-document bookkeeping.
//
// Main keeps `openDocs` as a Set of paths per window — not a counter — which
// was fine while exactly one tab could show a path. The split view breaks that
// premise: a file can be open as its own tab AND inside another tab's second
// column at once, and whichever closes first must not unregister a path the
// other still shows (that would drop the close-time unsaved guard and the
// cross-window change notifications for a document that is still on screen).
//
// Counting HERE, in the renderer, fixes it without touching main — main keeps
// seeing exactly one docOpened before the first viewer and one docClosed after
// the last, so every platform (and the extension) behaves as before.
// Pure and injectable so scripts/test-doc-registry.mjs can drive it without a
// bridge. Unit of scope: one window (module state — each window is its own
// renderer process; in the dev browser, one tab).

export interface DocRegistry {
  /** First acquire for a path notifies main; later ones only count. */
  acquire(path: string): void
  /** Last release notifies main; a release without an acquire is a no-op
   *  (defensive — a double-close must never push the count negative and
   *  swallow a later real close). */
  release(path: string): void
  /** Open viewers for the path right now (for tests and assertions). */
  count(path: string): number
}

export function createDocRegistry(
  notifyOpened: (path: string) => void,
  notifyClosed: (path: string) => void
): DocRegistry {
  const counts = new Map<string, number>()
  return {
    acquire(path: string): void {
      const next = (counts.get(path) ?? 0) + 1
      counts.set(path, next)
      if (next === 1) notifyOpened(path)
    },
    release(path: string): void {
      const current = counts.get(path) ?? 0
      if (current <= 0) return
      if (current === 1) {
        counts.delete(path)
        notifyClosed(path)
      } else {
        counts.set(path, current - 1)
      }
    },
    count(path: string): number {
      return counts.get(path) ?? 0
    }
  }
}

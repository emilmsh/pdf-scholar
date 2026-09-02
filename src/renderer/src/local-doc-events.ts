// Intra-window sibling of main's cross-window `annots:changed-elsewhere` /
// `doc:draft-ended-elsewhere` broadcasts.
//
// Main notifies OTHER windows when a document's draft changes — but with the
// split view one window can show the same file twice (its own tab plus another
// tab's second column), and those two viewers never hear about each other
// through main. This bus closes that gap with the exact same contract: the
// draft in main stays the single source of truth, an event only says "re-read
// it". Senders pass their own token and ignore their own events, so the viewer
// that made a change never reloads on top of itself.

export type DocEventKind = 'changed' | 'draft-ended'

/** One per viewer/session — Symbol so two viewers can never collide. */
export type DocEventSender = symbol

type Listener = (path: string, kind: DocEventKind, sender: DocEventSender | null) => void

const listeners = new Set<Listener>()

/** The document at `path` changed in THIS window (an engine write landed, or a
 *  save/discard retired its draft). `sender` identifies the emitting viewer;
 *  pass null for app-level actions that no viewer owns (App's discard flows). */
export function emitLocalDocEvent(
  path: string,
  kind: DocEventKind,
  sender: DocEventSender | null
): void {
  for (const listener of [...listeners]) listener(path, kind, sender)
}

/** Subscribe to every local doc event; filter by path/sender in the callback
 *  (mirrors how the bridge's cross-window subscriptions are consumed). */
export function onLocalDocEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

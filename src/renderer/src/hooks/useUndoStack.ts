import { useCallback, useRef, useState } from 'react'
import type { PageAnnotation } from '../annotations'
// Type-only, so this does not create a runtime cycle back into the component.
import type { AnnotHandle, AnnotPatch, UndoEntry } from '../components/PdfViewer'

/**
 * Annotation undo/redo, as two stacks of invertible engine operations.
 *
 * Every entry records what the engine did, not what the screen looked like, so
 * an undo is a real write in the opposite direction — which is why this survives
 * a document reopen: the stacks hold object numbers and snapshots, not React
 * state. The three engine calls are injected rather than imported so the hook
 * knows nothing about how a write reaches the file (IPC on the desktop, an
 * in-memory PDFium document in the browser).
 *
 * `undoBusyRef` serialises the operations. Without it, holding Ctrl+Z would pop
 * the next entry while the previous write was still in flight, and the two
 * writes would race on the same annotation.
 *
 * Depths are mirrored into state because the toolbar's undo/redo buttons have to
 * re-render when they become available — refs alone would leave them stale.
 */
export interface UndoStack {
  /** Record an operation and clear the redo branch */
  pushUndo(entry: UndoEntry): void
  performUndoRedo(direction: 'undo' | 'redo'): Promise<void>
  /** Stack depths, for enabling the toolbar buttons */
  undoDepths: { undo: number; redo: number }
  /** Drop every entry belonging to `doc` — called when the split column's
   *  document closes: its session (and the annots map an undo would patch) is
   *  gone, and a Ctrl+Z that silently writes into a closed document is worse
   *  than a shorter history. Batches are filtered per inner entry. */
  purgeDoc(doc: 'main' | 'split'): void
}

export function useUndoStack(
  engineCreate: (handle: AnnotHandle, snapshot: PageAnnotation) => Promise<void>,
  engineDelete: (handle: AnnotHandle) => Promise<void>,
  engineChange: (handle: AnnotHandle, patch: AnnotPatch) => Promise<void>
): UndoStack {
  const undoStackRef = useRef<UndoEntry[]>([])
  const redoStackRef = useRef<UndoEntry[]>([])
  const undoBusyRef = useRef(false)
  // Mirrored stack depths so the toolbar's undo/redo buttons re-render
  const [undoDepths, setUndoDepths] = useState({ undo: 0, redo: 0 })

  const syncUndoDepths = useCallback(() => {
    setUndoDepths({ undo: undoStackRef.current.length, redo: redoStackRef.current.length })
  }, [])

  const pushUndo = useCallback(
    (entry: UndoEntry) => {
      undoStackRef.current.push(entry)
      if (undoStackRef.current.length > 100) undoStackRef.current.shift()
      redoStackRef.current = []
      syncUndoDepths()
    },
    [syncUndoDepths]
  )

  const performUndoRedo = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (undoBusyRef.current) return
      const source = direction === 'undo' ? undoStackRef : redoStackRef
      const target = direction === 'undo' ? redoStackRef : undoStackRef
      const entry = source.current.pop()
      if (!entry) return
      undoBusyRef.current = true
      // Recursive so a batch is just an entry that contains entries; undoing one
      // walks it backwards, because the operations inside were applied in order
      // and the file has to pass back through the same states.
      const apply = async (e: UndoEntry): Promise<void> => {
        if (e.kind === 'batch') {
          const items = direction === 'undo' ? [...e.entries].reverse() : e.entries
          for (const inner of items) await apply(inner)
        } else if (e.kind === 'create') {
          if (direction === 'undo') await engineDelete(e.handle)
          else await engineCreate(e.handle, e.snapshot)
        } else if (e.kind === 'delete') {
          if (direction === 'undo') await engineCreate(e.handle, e.snapshot)
          else await engineDelete(e.handle)
        } else {
          await engineChange(e.handle, direction === 'undo' ? e.before : e.after)
        }
      }
      try {
        await apply(entry)
        target.current.push(entry)
      } finally {
        undoBusyRef.current = false
        syncUndoDepths()
      }
    },
    [engineCreate, engineDelete, engineChange, syncUndoDepths]
  )

  const purgeDoc = useCallback(
    (doc: 'main' | 'split') => {
      const belongs = (e: UndoEntry): boolean =>
        e.kind === 'batch' ? e.entries.some(belongs) : (e.handle.doc ?? 'main') === doc
      const strip = (list: UndoEntry[]): UndoEntry[] =>
        list
          .map((e) =>
            e.kind === 'batch' ? { ...e, entries: e.entries.filter((i) => !belongs(i)) } : e
          )
          .filter((e) => (e.kind === 'batch' ? e.entries.length > 0 : !belongs(e)))
      undoStackRef.current = strip(undoStackRef.current)
      redoStackRef.current = strip(redoStackRef.current)
      syncUndoDepths()
    },
    [syncUndoDepths]
  )

  return { pushUndo, performUndoRedo, undoDepths, purgeDoc }
}

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
      try {
        if (entry.kind === 'create') {
          if (direction === 'undo') await engineDelete(entry.handle)
          else await engineCreate(entry.handle, entry.snapshot)
        } else if (entry.kind === 'delete') {
          if (direction === 'undo') await engineCreate(entry.handle, entry.snapshot)
          else await engineDelete(entry.handle)
        } else {
          await engineChange(entry.handle, direction === 'undo' ? entry.before : entry.after)
        }
        target.current.push(entry)
      } finally {
        undoBusyRef.current = false
        syncUndoDepths()
      }
    },
    [engineCreate, engineDelete, engineChange, syncUndoDepths]
  )

  return { pushUndo, performUndoRedo, undoDepths }
}

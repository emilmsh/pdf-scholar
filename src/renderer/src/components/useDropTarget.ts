// A pages column as a drop target: a TAB dragged in from the strip, or a PDF
// file from the OS. One hook for both columns, so pane A (inline in PdfViewer)
// and pane B (PagesPane) accept exactly the same gestures and show the same
// hint while something acceptable hovers.
//
// The hint is the whole discoverability story of drag-to-split — «Slipp for å
// åpne i delt visning» appears the moment a tab is over a column — so it must
// show for a tab even where no file handler is wired (pane A: a dropped FILE
// there still means "open a tab", App's handler, and gets no hint).
//
// dragenter/dragleave fire for every child element crossed, so a depth counter
// (not a boolean) decides when the pointer has really left the column.
import { useCallback, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { TAB_DRAG_MIME, dragCarriesFiles, dragCarriesTab } from '../drag-types'

export type DropKind = 'tab' | 'file'

export interface DropTargetHandlers {
  onDragEnter(e: ReactDragEvent): void
  onDragOver(e: ReactDragEvent): void
  onDragLeave(e: ReactDragEvent): void
  onDrop(e: ReactDragEvent): void
}

export function useDropTarget(
  /** A tab (its document path) was dropped here */
  onTabDrop: ((path: string) => void) | undefined,
  /** A PDF file was dropped here. Return true to consume the drop; false lets
   *  it bubble (App opens it as a tab). Undefined = files are not this
   *  column's business at all. */
  onFileDrop: ((file: File) => boolean) | undefined
): { handlers: DropTargetHandlers; hint: DropKind | null } {
  const [hint, setHint] = useState<DropKind | null>(null)
  const depth = useRef(0)

  const kindOf = useCallback(
    (dt: DataTransfer | null): DropKind | null => {
      if (onTabDrop && dragCarriesTab(dt)) return 'tab'
      if (onFileDrop && dragCarriesFiles(dt)) return 'file'
      return null
    },
    [onTabDrop, onFileDrop]
  )

  const onDragEnter = useCallback(
    (e: ReactDragEvent) => {
      const kind = kindOf(e.dataTransfer)
      if (!kind) return
      depth.current += 1
      setHint(kind)
    },
    [kindOf]
  )
  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!kindOf(e.dataTransfer)) return
      // Allowing the drop is what makes the browser fire `drop` at all
      e.preventDefault()
    },
    [kindOf]
  )
  const onDragLeave = useCallback(
    (e: ReactDragEvent) => {
      if (!kindOf(e.dataTransfer)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setHint(null)
    },
    [kindOf]
  )
  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      depth.current = 0
      setHint(null)
      const dt = e.dataTransfer
      if (onTabDrop && dragCarriesTab(dt)) {
        const path = dt.getData(TAB_DRAG_MIME)
        e.preventDefault()
        e.stopPropagation()
        if (path) onTabDrop(path)
        return
      }
      if (onFileDrop && dragCarriesFiles(dt)) {
        const file = dt.files[0]
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
        if (!onFileDrop(file)) return // unhandled — App's open-a-tab takes it
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [onTabDrop, onFileDrop]
  )

  return { handlers: { onDragEnter, onDragOver, onDragLeave, onDrop }, hint }
}

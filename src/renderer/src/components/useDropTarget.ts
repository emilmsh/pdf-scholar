// A pages column as a drop target: a TAB dragged in from the strip, or a PDF
// file from the OS. One hook for both columns, so pane A (inline in PdfViewer)
// and pane B (PagesPane) accept exactly the same gestures and show the same
// hint while something acceptable hovers.
//
// The hint is the whole discoverability story of drag-to-split — «Slipp for å
// åpne i delt visning» appears the moment a tab is over a column — so it must
// show for a tab even where no file handler is wired.
//
// With `halves` on (one column open) the column is two drop zones — its left
// and right half — and the hint covers the half the pointer is over: the new
// document will take THAT side (Emil, 2026-09-03: not always the right).
//
// dragenter/dragleave fire for every child element crossed, so a depth counter
// (not a boolean) decides when the pointer has really left the column.
import { useCallback, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { TAB_DRAG_MIME, dragCarriesFiles, dragCarriesTab } from '../drag-types'

export type DropKind = 'tab' | 'file'
export type DropHalf = 'left' | 'right'

export interface DropTargetHandlers {
  onDragEnter(e: ReactDragEvent): void
  onDragOver(e: ReactDragEvent): void
  onDragLeave(e: ReactDragEvent): void
  onDrop(e: ReactDragEvent): void
}

export function useDropTarget(
  /** A tab (its document path) was dropped here — on the given half when the
   *  column is split into halves, null otherwise */
  onTabDrop: ((path: string, half: DropHalf | null) => void) | undefined,
  /** A PDF file was dropped here. Return true to consume the drop; false lets
   *  it bubble (App opens it as a tab). Undefined = files are not this
   *  column's business at all. */
  onFileDrop: ((file: File, half: DropHalf | null) => boolean) | undefined,
  opts: { halves?: boolean } = {}
): { handlers: DropTargetHandlers; hint: DropKind | null; half: DropHalf | null } {
  const [hint, setHint] = useState<DropKind | null>(null)
  const [half, setHalf] = useState<DropHalf | null>(null)
  const depth = useRef(0)
  const halves = opts.halves ?? false

  const halfOf = useCallback(
    (e: ReactDragEvent): DropHalf | null => {
      if (!halves) return null
      const box = e.currentTarget.getBoundingClientRect()
      return e.clientX < box.left + box.width / 2 ? 'left' : 'right'
    },
    [halves]
  )

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
      setHalf(halfOf(e))
    },
    [kindOf, halfOf]
  )
  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!kindOf(e.dataTransfer)) return
      // Allowing the drop is what makes the browser fire `drop` at all
      e.preventDefault()
      // Fires continuously while hovering; the state only changes at the midline
      const h = halfOf(e)
      setHalf((prev) => (prev === h ? prev : h))
    },
    [kindOf, halfOf]
  )
  const onDragLeave = useCallback(
    (e: ReactDragEvent) => {
      if (!kindOf(e.dataTransfer)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) {
        setHint(null)
        setHalf(null)
      }
    },
    [kindOf]
  )
  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      depth.current = 0
      setHint(null)
      setHalf(null)
      const dt = e.dataTransfer
      if (onTabDrop && dragCarriesTab(dt)) {
        const path = dt.getData(TAB_DRAG_MIME)
        e.preventDefault()
        e.stopPropagation()
        if (path) onTabDrop(path, halfOf(e))
        return
      }
      if (onFileDrop && dragCarriesFiles(dt)) {
        const file = dt.files[0]
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
        if (!onFileDrop(file, halfOf(e))) return // unhandled — App's open-a-tab takes it
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [onTabDrop, onFileDrop, halfOf]
  )

  return { handlers: { onDragEnter, onDragOver, onDragLeave, onDrop }, hint, half }
}

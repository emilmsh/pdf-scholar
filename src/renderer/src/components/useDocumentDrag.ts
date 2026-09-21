// Drag handlers for the sidebar's document row in the browser shell: the blob
// the drop target fetches, and when it is let go of. See doc-drag.ts for what
// the drag carries and why.
import { useCallback, useEffect, useRef } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { setDocumentDragData } from '../doc-drag'

export interface DocumentDragHandlers {
  onDragStart(e: ReactDragEvent): void
  onDragEnd(): void
}

/** The browser fetches the blob when the drop lands — during the OS drop, before
 *  our dragend — but a download that is still being set up must not find its
 *  URL revoked, so the URL outlives the drag by this much. One drag's blob at a
 *  time: the next dragstart revokes the previous one. */
const REVOKE_AFTER_MS = 60_000

export function useDocumentDrag(
  path: string,
  name: string,
  /** The bytes to hand over — the document as last saved, or as loaded. Read at
   *  dragstart, so the caller can keep it in a ref. */
  bytes: () => Uint8Array
): DocumentDragHandlers {
  const urlRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const revoke = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }, [])

  useEffect(() => revoke, [revoke])

  const onDragStart = useCallback(
    (e: ReactDragEvent) => {
      revoke()
      // A Blob copies the bytes, so the drag costs one extra copy of the document
      // for as long as the URL lives — never longer than REVOKE_AFTER_MS past the
      // drag's end.
      const blob = new Blob([bytes() as unknown as BlobPart], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setDocumentDragData(e.dataTransfer, { path, name, url })
    },
    [path, name, bytes, revoke]
  )

  const onDragEnd = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(revoke, REVOKE_AFTER_MS)
  }, [revoke])

  return { onDragStart, onDragEnd }
}

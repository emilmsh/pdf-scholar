// Marquee over the page: a full-window crosshair overlay. Two callers, one
// gesture — snip-to-explain (armed from the assistant composer or the point
// menu) and «Kopier bilde» (armed from the save menu or the point menu).
// Drag a box over a figure/table and the viewer captures that region.
//
// The image grab also passes `regions`: the page's raster-image boxes in
// client coordinates. They are outlined while the overlay is up, so a reader
// can SEE which figures the document holds as real pictures, and a plain
// click on one takes exactly that image — no aiming. A drag still wins and is
// always taken literally, so the outlines never change what a drag means.
// Pointer events so mouse, pen and touch all work (touch-action: none keeps
// the drag from scrolling).
import { useEffect, useRef, useState } from 'react'
import { smallestBoxAt } from '../image-export'
import { t, useLang } from '../i18n'

export interface SnipClientRect {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  /** Called with the dragged box in client (viewport) coordinates */
  onDone(rect: SnipClientRect): void
  onCancel(): void
  /** Line across the top; defaults to the assistant's wording */
  hint?: string
  /** Raster-image boxes on the visible pages, client coordinates. Outlined as
   *  click targets; omit for a plain marquee. */
  regions?: readonly SnipClientRect[]
}

/** Below this the pointer never moved enough to mean a box — it was a click. */
const DRAG_FLOOR = 12

export function SnipOverlay({ onDone, onCancel, hint, regions }: Props): React.JSX.Element {
  useLang()
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    // Capture phase so the viewer's own Escape handlers (tools, search)
    // never see the keypress that merely cancels the snip.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const rect =
    start && cursor
      ? {
          x: Math.min(start.x, cursor.x),
          y: Math.min(start.y, cursor.y),
          w: Math.abs(cursor.x - start.x),
          h: Math.abs(cursor.y - start.y)
        }
      : null
  const dragging = !!rect && (rect.w >= DRAG_FLOOR || rect.h >= DRAG_FLOOR)

  return (
    <div
      className="snip-overlay"
      ref={ref}
      onPointerDown={(e) => {
        e.preventDefault()
        try {
          ref.current?.setPointerCapture(e.pointerId)
        } catch {
          /* no active pointer (synthetic events) — move/up still bubble here */
        }
        setStart({ x: e.clientX, y: e.clientY })
        setCursor({ x: e.clientX, y: e.clientY })
      }}
      onPointerMove={(e) => {
        if (start) setCursor({ x: e.clientX, y: e.clientY })
        // Hover-highlight only before a drag starts: once a box is being
        // dragged the outlines must not compete with it.
        setHover(regions?.length ? smallestBoxAt(regions, e.clientX, e.clientY) : -1)
      }}
      onPointerUp={(e) => {
        if (rect && rect.w >= DRAG_FLOOR && rect.h >= DRAG_FLOOR) {
          onDone(rect)
          return
        }
        // Not a drag. On an outlined image that is a pick; anywhere else it
        // is a stray click and disarms quietly.
        const hit = regions?.length ? smallestBoxAt(regions, e.clientX, e.clientY) : -1
        if (hit >= 0 && regions) onDone(regions[hit])
        else onCancel()
      }}
    >
      {!start && <div className="snip-hint">{hint ?? t('snip.hint')}</div>}
      {regions?.map((r, i) => (
        <div
          key={`${r.x},${r.y},${r.w},${r.h},${i}`}
          className={`snip-region${i === hover && !dragging ? ' is-hot' : ''}`}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      ))}
      {rect && (
        <div
          className="snip-marquee"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
    </div>
  )
}

// Snip-to-explain marquee: a full-window crosshair overlay armed from the
// point context menu. Drag a box over a figure/table; the viewer captures the
// region and asks the assistant about it. Pointer events so mouse, pen and
// touch all work (touch-action: none keeps the drag from scrolling).
import { useEffect, useRef, useState } from 'react'
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
}

export function SnipOverlay({ onDone, onCancel }: Props): React.JSX.Element {
  useLang()
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
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
      }}
      onPointerUp={() => {
        if (rect && rect.w >= 12 && rect.h >= 12) onDone(rect)
        else onCancel() // a stray click (no real drag) disarms quietly
      }}
    >
      {!start && <div className="snip-hint">{t('snip.hint')}</div>}
      {rect && (
        <div
          className="snip-marquee"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
    </div>
  )
}

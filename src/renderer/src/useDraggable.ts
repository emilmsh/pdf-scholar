import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Makes a floating (`position: fixed`) bubble draggable by a handle, so it can
 * be pulled aside to read the content underneath.
 *
 * - `ref` goes on the bubble root; `style` supplies its left/top. The bubble is
 *   hidden until measured, so it never flashes at the raw anchor before it is
 *   clamped into the viewport.
 * - `handleProps` go on the drag handle (typically the bubble's header).
 *
 * The bubble re-clamps to the viewport when the anchor or `deps` change, but
 * once the user has dragged it their position wins — it is only edge-clamped,
 * never snapped back to the anchor. Pointer events + `touch-action: none` on the
 * handle make it work with mouse and touch alike. Factored out of the AI popover
 * (AiPanel.tsx) so every draggable bubble behaves identically.
 *
 * Pass `avoid` (a rect in viewport coords, e.g. a text selection's bounding
 * box) and the bubble opens clear of it — just below it if there's room, else
 * just above — so the marked text stays readable while you compose. The user
 * can still drag it anywhere afterwards.
 */
export function useDraggable<T extends HTMLElement = HTMLDivElement>(
  anchorX: number,
  anchorY: number,
  deps: readonly unknown[] = [],
  avoid?: { top: number; bottom: number; left: number } | null
): {
  ref: React.RefObject<T | null>
  style: React.CSSProperties
  /** True once measured and visible. Gate auto-focus on this: the bubble is
   *  `visibility: hidden` until positioned, and a hidden element can't focus. */
  positioned: boolean
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
  }
} {
  const ref = useRef<T>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const draggedRef = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const clamp = (left: number, top: number): { left: number; top: number } => ({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8))
    })
    // Initial placement: clear of `avoid` (below if it fits, else above) so the
    // marked text stays visible; otherwise the raw anchor point.
    const initial = (): { left: number; top: number } => {
      if (!avoid) return clamp(anchorX, anchorY)
      const gap = 10
      const below = avoid.bottom + gap
      const fitsBelow = below + height <= window.innerHeight - 8
      const top = fitsBelow ? below : avoid.top - height - gap
      return clamp(avoid.left, top)
    }
    setPos((p) => {
      const next = draggedRef.current && p ? clamp(p.left, p.top) : initial()
      return p && p.left === next.left && p.top === next.top ? p : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorX, anchorY, avoid?.top, avoid?.bottom, avoid?.left, ...deps])

  const handleProps = {
    onPointerDown: (e: React.PointerEvent): void => {
      if (!pos) return
      dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events have no active pointer to capture */
      }
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      draggedRef.current = true
      const el = ref.current
      const w = el?.offsetWidth ?? 280
      const h = el?.offsetHeight ?? 200
      setPos({
        left: Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8)),
        top: Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - h - 8))
      })
    },
    onPointerUp: (): void => {
      dragRef.current = null
    }
  }

  const style: React.CSSProperties = pos ?? { left: anchorX, top: anchorY, visibility: 'hidden' }
  return { ref, style, positioned: pos !== null, handleProps }
}

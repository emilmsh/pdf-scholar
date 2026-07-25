import { useRef } from 'react'

/** Explicit box size in px. `null` on an axis means "let CSS decide" — the
 *  bubble's shipped default size, which every freshly opened one starts at. */
export interface BoxSize {
  w: number | null
  h: number | null
}

/**
 * Drag-to-resize for a floating bubble (note/comment popover, quick answer) or
 * for the assistant composer.
 *
 * Deliberately CONTROLLED: the size lives with the caller, so a specific
 * comment can be remembered across re-opens while a brand-new note always
 * starts at the default. `null` size = untouched, and the element keeps whatever
 * the stylesheet gives it — that is also what a double-click on the grip
 * restores, so the default shape is never lost behind a drag.
 *
 * The grip is the ONLY affordance (a small corner/edge glyph, see .box-grip in
 * app.css) — no scrollbars appear to announce resizability, per the owner's
 * "subtle indicator, nothing distracting".
 *
 * @param ref    the element being sized (bubble root, or the textarea for a
 *               height-only composer resize)
 * @param axis   'both' for a corner grip, 'height' for an edge grip
 * @param invert drag DOWN shrinks (grip on the element's top edge)
 */
export function useResizable(
  ref: React.RefObject<HTMLElement | null>,
  size: BoxSize | null,
  onResize: (size: BoxSize | null) => void,
  opts: { axis: 'both' | 'height'; minW?: number; minH?: number; invert?: boolean }
): {
  gripProps: {
    onPointerDown(e: React.PointerEvent): void
    onPointerMove(e: React.PointerEvent): void
    onPointerUp(e: React.PointerEvent): void
    onDoubleClick(e: React.MouseEvent): void
  }
  /** Spread onto the sized element (empty object while untouched) */
  style: React.CSSProperties
} {
  const startRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const minW = opts.minW ?? 200
  const minH = opts.minH ?? 90
  const sign = opts.invert ? -1 : 1

  const gripProps = {
    onPointerDown: (e: React.PointerEvent): void => {
      const el = ref.current
      if (!el) return
      // Start from the CURRENT rendered box, so the first drag continues from
      // the stylesheet default instead of jumping to some stored guess.
      const box = el.getBoundingClientRect()
      startRef.current = { x: e.clientX, y: e.clientY, w: box.width, h: box.height }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events have no active pointer to capture */
      }
      // The grip usually sits inside a bubble whose own pointerdown starts a
      // MOVE drag — resizing must not also drag the bubble away.
      e.stopPropagation()
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const s = startRef.current
      if (!s) return
      e.stopPropagation()
      const h = Math.max(minH, Math.min(s.h + (e.clientY - s.y) * sign, window.innerHeight - 24))
      if (opts.axis === 'height') {
        onResize({ w: size?.w ?? null, h })
        return
      }
      const w = Math.max(minW, Math.min(s.w + (e.clientX - s.x), window.innerWidth - 24))
      onResize({ w, h })
    },
    onPointerUp: (e: React.PointerEvent): void => {
      startRef.current = null
      e.stopPropagation()
    },
    // Back to the shipped shape — the escape hatch that makes dragging safe to
    // experiment with.
    onDoubleClick: (e: React.MouseEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      onResize(null)
    }
  }

  const style: React.CSSProperties = {}
  if (size?.w != null) style.width = size.w
  if (size?.h != null) {
    style.height = size.h
    // A grown box must actually grow: several of these elements are capped by
    // a max-height in the stylesheet (the composer, the quick popover body).
    style.maxHeight = 'none'
  }
  return { gripProps, style }
}

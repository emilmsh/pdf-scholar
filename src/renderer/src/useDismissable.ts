import { useEffect } from 'react'

/**
 * Closes a menu or popover on a click outside it and on Escape.
 *
 * Every transient surface in the app owes the user both exits — the standing
 * rule is that a bubble must never be dismissible only by its own Lukk button
 * (one once sat offscreen and trapped the bubble open). This was written out
 * nine separate times and had drifted into three incompatible variants, one of
 * which had no Escape path at all. Now there is one, and `grep useDismissable`
 * answers which surfaces honour the rule.
 *
 * Two details the copies disagreed on, both settled here:
 *
 * - `pointerdown`, not `mousedown`: a page overlay can suppress the compat
 *   mousedown with preventDefault, and pointerdown is what actually fires for
 *   touch. Touch parity is a standing requirement, not a nice-to-have.
 * - capture phase, so a child calling stopPropagation cannot keep the menu open.
 *
 * Escape also stops propagation: a menu must swallow the key before the
 * viewer's own Escape chain (which clears tools and selections) sees it.
 *
 * Pass `escape: false` only when something else already owns Escape for this
 * surface and needs to order it against other state — the toolbar does, because
 * Escape there must close the reset confirmation before the menu containing it.
 * Two independent capture listeners cannot express that priority: both would
 * fire, since stopPropagation does not stop siblings on the same node.
 *
 * @param ref   the surface's root — a pointerdown inside it is not "outside"
 * @param open  when false the listeners are not attached at all
 * @param close called with no arguments; keep it stable or accept re-binding
 */
export function useDismissable(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  opts?: { escape?: boolean }
): void {
  const escape = opts?.escape ?? true
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: Event): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    if (escape) window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      if (escape) window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [ref, open, close, escape])
}

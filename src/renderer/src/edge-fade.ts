import { useEffect } from 'react'

/** How deep the fade at an edge with more beyond it runs */
export const FADE_PX = 18

/** No scrollbar in a small floating window, not even the overlay pills — in
 *  a window this small they distract (Emil, 2026-10-17). What a bar said, that
 *  there is more, a soft fade at that edge says instead, and only while there
 *  is: the edges are CSS variables the stylesheet's mask reads (`--fade-t`,
 *  `--fade-b`, `--fade-l`, `--fade-r`; see `.link-preview-scroll` in app.css
 *  for the mask). Shared by the link preview and the note hover card. */
export function useEdgeFade(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const f = (more: boolean): string => (more ? `${FADE_PX}px` : '0px')
      el.style.setProperty('--fade-t', f(el.scrollTop > 1))
      el.style.setProperty('--fade-b', f(el.scrollTop + el.clientHeight < el.scrollHeight - 1))
      el.style.setProperty('--fade-l', f(el.scrollLeft > 1))
      el.style.setProperty('--fade-r', f(el.scrollLeft + el.clientWidth < el.scrollWidth - 1))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // An abstract folding out, a resize, a render: the scroll range moves
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
}

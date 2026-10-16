import { useEffect, useRef } from 'react'

const MIN_PILL = 36
const EDGE = 4
/** Space ceded to the other pill in the shared corner */
const CORNER = 12
const HIDE_DELAY = 1000
/** Pointer distance from the right/bottom edge that re-reveals the pills */
const REVEAL_ZONE = 18

/** macOS-style overlay scrollbars for the pages container. The native bars
 *  are hidden entirely (their gutter is a grey strip stealing page width);
 *  these pills float over the content, appear on activity and fade when
 *  idle. Scroll-path updates are direct DOM writes inside one rAF — no
 *  React state — per the standing efficiency concern. */
export function OverlayScrollbars({
  scrollRef,
  layoutKey
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Changes whenever the scrollable content is re-laid-out (zoom, document
   *  switch, rotation) — anything that moves scrollWidth/scrollHeight. */
  layoutKey: string
}): React.JSX.Element {
  const vRef = useRef<HTMLDivElement>(null)
  const hRef = useRef<HTMLDivElement>(null)
  /** update + show as refs so the layoutKey effect can call them without
   *  re-running the listener-wiring effect */
  const apiRef = useRef<{ update(): void; show(): void }>(null)

  useEffect(() => {
    const el = scrollRef.current
    const v = vRef.current
    const h = hRef.current
    if (!el || !v || !h) return

    const state = { dragging: false, hovered: false, raf: 0, hideTimer: 0 }

    const update = (): void => {
      const { clientWidth: cw, clientHeight: ch, scrollWidth: sw, scrollHeight: sh } = el
      const needV = sh > ch + 1
      const needH = sw > cw + 1
      v.style.display = needV ? '' : 'none'
      h.style.display = needH ? '' : 'none'
      if (needV) {
        const track = ch - EDGE * 2 - (needH ? CORNER : 0)
        const len = Math.min(track, Math.max(MIN_PILL, (ch / sh) * track))
        const pos = EDGE + (el.scrollTop / (sh - ch)) * (track - len)
        v.style.height = `${len}px`
        v.style.transform = `translateY(${pos}px)`
      }
      if (needH) {
        const track = cw - EDGE * 2 - (needV ? CORNER : 0)
        const len = Math.min(track, Math.max(MIN_PILL, (cw / sw) * track))
        const pos = EDGE + (el.scrollLeft / (sw - cw)) * (track - len)
        h.style.width = `${len}px`
        h.style.transform = `translateX(${pos}px)`
      }
    }

    const show = (): void => {
      v.classList.add('show')
      h.classList.add('show')
      window.clearTimeout(state.hideTimer)
      state.hideTimer = window.setTimeout(() => {
        if (state.dragging || state.hovered) return
        v.classList.remove('show')
        h.classList.remove('show')
      }, HIDE_DELAY)
    }

    apiRef.current = { update, show }

    const onScroll = (): void => {
      if (state.raf) return
      state.raf = requestAnimationFrame(() => {
        state.raf = 0
        update()
        show()
      })
    }

    // Moving the pointer near the right/bottom edge re-reveals faded pills
    // (matches macOS overlay bars); wheel/scroll is the primary reveal.
    const onMouseMove = (e: MouseEvent): void => {
      const r = el.getBoundingClientRect()
      if (r.right - e.clientX < REVEAL_ZONE || r.bottom - e.clientY < REVEAL_ZONE) {
        update()
        show()
      }
    }

    const beginDrag = (axis: 'v' | 'h') => (e: PointerEvent): void => {
      e.preventDefault()
      const pill = axis === 'v' ? v : h
      const { clientWidth: cw, clientHeight: ch, scrollWidth: sw, scrollHeight: sh } = el
      const range = axis === 'v' ? sh - ch : sw - cw
      const bothVisible = axis === 'v' ? sw > cw + 1 : sh > ch + 1
      const track = (axis === 'v' ? ch : cw) - EDGE * 2 - (bothVisible ? CORNER : 0)
      const len = axis === 'v' ? pill.offsetHeight : pill.offsetWidth
      const denom = track - len
      const startPointer = axis === 'v' ? e.clientY : e.clientX
      const startScroll = axis === 'v' ? el.scrollTop : el.scrollLeft
      state.dragging = true
      pill.classList.add('dragging')
      try {
        pill.setPointerCapture(e.pointerId)
      } catch {
        // Inactive pointerId (synthetic/AT events) — drag still tracks while
        // the pointer stays over the pill
      }
      const onMove = (ev: PointerEvent): void => {
        const delta = (axis === 'v' ? ev.clientY : ev.clientX) - startPointer
        const target = startScroll + (denom > 0 ? (delta / denom) * range : 0)
        if (axis === 'v') el.scrollTop = target
        else el.scrollLeft = target
      }
      const onUp = (): void => {
        state.dragging = false
        pill.classList.remove('dragging')
        pill.removeEventListener('pointermove', onMove)
        pill.removeEventListener('pointerup', onUp)
        pill.removeEventListener('pointercancel', onUp)
        show()
      }
      pill.addEventListener('pointermove', onMove)
      pill.addEventListener('pointerup', onUp)
      pill.addEventListener('pointercancel', onUp)
    }

    const onEnter = (): void => {
      state.hovered = true
      show()
    }
    const onLeave = (): void => {
      state.hovered = false
      show()
    }

    const dragV = beginDrag('v')
    const dragH = beginDrag('h')
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('mousemove', onMouseMove, { passive: true })
    for (const pill of [v, h]) {
      pill.addEventListener('pointerenter', onEnter)
      pill.addEventListener('pointerleave', onLeave)
    }
    v.addEventListener('pointerdown', dragV)
    h.addEventListener('pointerdown', dragH)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()

    return () => {
      cancelAnimationFrame(state.raf)
      window.clearTimeout(state.hideTimer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousemove', onMouseMove)
      for (const pill of [v, h]) {
        pill.removeEventListener('pointerenter', onEnter)
        pill.removeEventListener('pointerleave', onLeave)
      }
      v.removeEventListener('pointerdown', dragV)
      h.removeEventListener('pointerdown', dragH)
      ro.disconnect()
      apiRef.current = null
    }
  }, [scrollRef])

  // Re-measure on zoom / document switch / rotation, and flash the pills so
  // the reader sees where they landed.
  useEffect(() => {
    apiRef.current?.update()
    apiRef.current?.show()
  }, [layoutKey])

  return (
    <>
      <div className="osb-pill osb-v" ref={vRef} />
      <div className="osb-pill osb-h" ref={hRef} />
    </>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WebSearchState } from '../../../shared/types'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { IconArrowLeft, IconArrowRight, IconExternal, IconReload } from './icons'

interface Props {
  /** Current search query — changing it navigates the view to a new results
   *  page (an empty string just shows whatever page is already loaded) */
  query: string
  onClose(): void
}

/** A short, readable label for the address chip (hostname without www.) */
function displayHost(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Edge-sidebar-style in-app browser. The native surface (a WebContentsView) is
 * owned by main and floats over this component's empty `.web-panel-body`; we
 * only draw the header chrome and stream the body's bounds so the native view
 * tracks it exactly. Mounted only for the active tab while the panel is open —
 * a stale rect from a background tab would float the native view over another
 * document.
 */
export default function WebSearchPanel({ query, onClose }: Props): React.JSX.Element {
  useLang()
  const bodyRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<WebSearchState | null>(null)
  const rafRef = useRef<number | null>(null)

  // Stream the placeholder bounds to main. A layout effect (runs before the
  // open effect below) so the first bounds reaches main BEFORE we ask to
  // attach; rAF-coalesced so a burst of resize events collapses to one push.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const push = (): void => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const r = el.getBoundingClientRect()
        bridge.webSearchSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
      })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    // ResizeObserver fires on size changes, not pure position changes — a
    // window move that shifts our origin needs the window listener as well.
    window.addEventListener('resize', push)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Open on mount and re-navigate when the query changes
  useEffect(() => {
    bridge.webSearchOpen(query || undefined)
  }, [query])

  // Subscribe to nav state; detach the native view when this panel goes away
  // (tab switch, close, unmount) — the WebContents stays alive for a fast reopen
  useEffect(() => {
    const unsub = bridge.onWebSearchState(setState)
    return () => {
      unsub()
      bridge.webSearchClose()
    }
  }, [])

  return (
    <aside className="web-panel">
      <header className="web-header">
        <button
          className="tb-btn"
          title={t('web.back')}
          disabled={!state?.canGoBack}
          onClick={() => bridge.webSearchBack()}
        >
          <IconArrowLeft size={16} />
        </button>
        <button
          className="tb-btn"
          title={t('web.forward')}
          disabled={!state?.canGoForward}
          onClick={() => bridge.webSearchForward()}
        >
          <IconArrowRight size={16} />
        </button>
        <button className="tb-btn" title={t('web.reload')} onClick={() => bridge.webSearchReload()}>
          <IconReload size={15} />
        </button>
        <span className="web-url" title={state?.url}>
          {displayHost(state?.url) || t('web.title')}
        </span>
        <button
          className="tb-btn"
          title={t('web.openExternal')}
          disabled={!state?.url}
          onClick={() => {
            if (state?.url) bridge.openExternal(state.url)
          }}
        >
          <IconExternal size={15} />
        </button>
        <button className="tb-btn" title={t('web.close')} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="web-panel-body" ref={bodyRef} />
    </aside>
  )
}

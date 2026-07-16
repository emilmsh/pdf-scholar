import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { ThemeName } from '../../../shared/types'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { IconArrowLeft, IconArrowRight, IconFullscreen } from './icons'

interface PageSize {
  w: number
  h: number
}

/** Clickable link region over the slide, in CSS px relative to the canvas */
interface SlideLink {
  left: number
  top: number
  width: number
  height: number
  url?: string
  dest?: unknown
}

interface Props {
  pdf: PDFDocumentProxy
  sizes: PageSize[]
  /** Page to open the slideshow on (1-based) */
  initialPage: number
  resolvedTheme: ThemeName
  /** Keep the underlying viewer's current page in sync so exiting lands there */
  onPageChange(page: number): void
  onExit(): void
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Acrobat-style presentation mode: one page at a time, fit to the screen on a
 *  dark backdrop, advanced with the keyboard or a click. Renders its own canvas
 *  (independent of the scrolling viewer) and owns the keyboard while open. */
export default function PresentationMode({
  pdf,
  sizes,
  initialPage,
  onPageChange,
  onExit
}: Props): React.JSX.Element {
  useLang()
  const numPages = sizes.length
  const [page, setPage] = useState(() => clamp(initialPage, 1, numPages))
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [controlsShown, setControlsShown] = useState(true)
  const [links, setLinks] = useState<SlideLink[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const idleTimerRef = useRef<number | null>(null)
  const pageRef = useRef(page)
  pageRef.current = page
  /** Browser-style history over link jumps (Alt+←/→) — no on-screen pills,
   *  the slideshow chrome stays as calm as it is today */
  const histRef = useRef<{ back: number[]; forward: number[] }>({ back: [], forward: [] })

  const go = useCallback(
    (delta: number) => setPage((p) => clamp(p + delta, 1, numPages)),
    [numPages]
  )

  /** Jump with a breadcrumb (link click) — a new jump clears the forward stack */
  const jumpTo = useCallback(
    (target: number) => {
      const cur = pageRef.current
      target = clamp(target, 1, numPages)
      if (target === cur) return
      const h = histRef.current
      h.back = [...h.back.slice(-49), cur]
      h.forward = []
      setPage(target)
    },
    [numPages]
  )

  const histGo = useCallback(
    (dir: 'back' | 'forward') => {
      const h = histRef.current
      const from = dir === 'back' ? h.back : h.forward
      const target = from.pop()
      if (target === undefined) return
      ;(dir === 'back' ? h.forward : h.back).push(pageRef.current)
      setPage(clamp(target, 1, numPages))
    },
    [numPages]
  )

  const followDest = useCallback(
    async (dest: unknown) => {
      try {
        const explicit =
          typeof dest === 'string' ? await pdf.getDestination(dest) : (dest as unknown[] | null)
        if (!Array.isArray(explicit) || explicit.length === 0) return
        const ref = explicit[0]
        const pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as never)
        if (pageIndex >= 0 && pageIndex < numPages) jumpTo(pageIndex + 1)
      } catch (err) {
        console.error('pdfx: klarte ikke å følge lenken', err)
      }
    },
    [pdf, numPages, jumpTo]
  )

  // Report the current page up so the scrolling viewer lands here on exit
  useEffect(() => {
    onPageChange(page)
  }, [page, onPageChange])

  // Track the window size for fit-to-screen rendering
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Own the keyboard while the overlay is open (the viewer's handler defers)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Alt+arrows walk the link-jump history (same shortcut as the viewer)
      if (e.altKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          histGo('back')
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          histGo('forward')
        }
        return
      }
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          onExit()
          break
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          e.preventDefault()
          go(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault()
          go(-1)
          break
        case 'Home':
          e.preventDefault()
          setPage(1)
          break
        case 'End':
          e.preventDefault()
          setPage(numPages)
          break
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, numPages, onExit, histGo])

  // Render the current page to fill the screen (crisp on HiDPI displays)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let task: RenderTask | null = null
    setLinks([])
    void (async () => {
      const pageObj = await pdf.getPage(page)
      if (cancelled) return
      const base = pageObj.getViewport({ scale: 1 })
      const pad = 56
      const fit = Math.min((viewport.w - pad) / base.width, (viewport.h - pad) / base.height)
      const dpr = window.devicePixelRatio || 1
      const vp = pageObj.getViewport({ scale: Math.max(0.1, fit) * dpr })
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.width = `${vp.width / dpr}px`
      canvas.style.height = `${vp.height / dpr}px`
      task = pageObj.render({ canvas, viewport: vp })
      await task.promise.catch(() => {})
      if (cancelled) return
      // Hyperlinks stay clickable during a talk — invisible overlays in CSS px
      // (a dpr-free viewport gives on-screen coordinates directly)
      const cssVp = pageObj.getViewport({ scale: Math.max(0.1, fit) })
      const annots = (await pageObj.getAnnotations()) as {
        subtype: string
        rect: number[]
        url?: string
        dest?: unknown
      }[]
      if (cancelled) return
      setLinks(
        annots
          .filter((a) => a.subtype === 'Link' && (a.url || a.dest))
          .map((a) => {
            const [x1, y1] = cssVp.convertToViewportPoint(a.rect[0], a.rect[1])
            const [x2, y2] = cssVp.convertToViewportPoint(a.rect[2], a.rect[3])
            return {
              left: Math.min(x1, x2),
              top: Math.min(y1, y2),
              width: Math.abs(x2 - x1),
              height: Math.abs(y2 - y1),
              url: a.url,
              dest: a.dest
            }
          })
      )
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, page, viewport.w, viewport.h])

  // Auto-hide the controls after idle; any pointer movement brings them back
  const wakeControls = useCallback(() => {
    setControlsShown(true)
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => setControlsShown(false), 2400)
  }, [])

  useEffect(() => {
    wakeControls()
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    }
  }, [wakeControls])

  return (
    <div
      className={`presentation${controlsShown ? '' : ' controls-hidden'}`}
      onMouseMove={wakeControls}
      onClick={() => go(1)}
      onContextMenu={(e) => {
        e.preventDefault()
        go(-1)
      }}
    >
      <div className="presentation-page">
        <canvas ref={canvasRef} className="presentation-canvas" />
        {links.map((link, i) => (
          <a
            key={`${page}-${i}`}
            className="presentation-link"
            href="#"
            title={link.url}
            style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
            onClick={(e) => {
              // A link click must never double as "next slide"
              e.preventDefault()
              e.stopPropagation()
              if (link.url) bridge.openExternal(link.url)
              else if (link.dest) void followDest(link.dest)
            }}
          />
        ))}
      </div>

      <div className="presentation-bar" onClick={(e) => e.stopPropagation()}>
        <button
          className="presentation-btn"
          onClick={() => go(-1)}
          disabled={page <= 1}
          title={t('present.prev')}
        >
          <IconArrowLeft size={18} />
        </button>
        <span className="presentation-counter">
          {page} / {numPages}
        </span>
        <button
          className="presentation-btn"
          onClick={() => go(1)}
          disabled={page >= numPages}
          title={t('present.next')}
        >
          <IconArrowRight size={18} />
        </button>
        <button className="presentation-btn presentation-exit" onClick={onExit} title={t('present.exit')}>
          <IconFullscreen size={16} />
          <span>{t('present.exit')}</span>
        </button>
      </div>
    </div>
  )
}

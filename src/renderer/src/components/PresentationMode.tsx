import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { ThemeName } from '../../../shared/types'
import { t, useLang } from '../i18n'
import { IconArrowLeft, IconArrowRight, IconFullscreen } from './icons'

interface PageSize {
  w: number
  h: number
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const idleTimerRef = useRef<number | null>(null)

  const go = useCallback(
    (delta: number) => setPage((p) => clamp(p + delta, 1, numPages)),
    [numPages]
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
  }, [go, numPages, onExit])

  // Render the current page to fill the screen (crisp on HiDPI displays)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let task: RenderTask | null = null
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
      <canvas ref={canvasRef} className="presentation-canvas" />

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

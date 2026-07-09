import { memo, useEffect, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect } from '../../../shared/types'
import type { PageAnnotation } from '../annotations'
import { annotationCss } from '../annotations'

interface Props {
  pdf: PDFDocumentProxy
  pageNumber: number
  top: number
  left: number
  cssWidth: number
  cssHeight: number
  scale: number
  /** Only pages near the viewport actually render their canvas */
  active: boolean
  /** Annotations created this session, drawn by the overlay (PDF page space) */
  annotations: PageAnnotation[]
  /** Rects of the active search match on this page (page space) */
  searchRects: PageRect[]
  /** Stable callbacks (identity must not change with viewer state) */
  onInternalLink(dest: unknown): void
  onExternalLink(url: string): void
}

interface Cancellable {
  cancel(): void
}

function PdfPage({
  pdf,
  pageNumber,
  top,
  left,
  cssWidth,
  cssHeight,
  scale,
  active,
  annotations,
  searchRects,
  onInternalLink,
  onExternalLink
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const linkRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const textHost = textRef.current
    const linkHost = linkRef.current
    if (!host || !textHost || !linkHost) return
    if (!active) {
      // Free bitmap + text nodes when far outside the viewport
      host.replaceChildren()
      textHost.replaceChildren()
      linkHost.replaceChildren()
      return
    }

    let cancelled = false
    let renderTask: Cancellable | null = null
    let textLayer: Cancellable | null = null

    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale })

      // Render into a detached canvas and swap it in when finished, so the
      // previous (CSS-stretched) bitmap stays visible during zoom — no flash.
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const task = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      })
      renderTask = task
      await task.promise
      if (cancelled) return
      host.replaceChildren(canvas)

      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      const tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport
      })
      textLayer = tl
      await tl.render()
      if (cancelled) return
      const endOfContent = document.createElement('div')
      endOfContent.className = 'endOfContent'
      textDiv.append(endOfContent)
      textHost.replaceChildren(textDiv)

      // Clickable link annotations (internal destinations + external URLs)
      const annots = (await page.getAnnotations()) as {
        subtype: string
        rect: number[]
        url?: string
        dest?: unknown
      }[]
      if (cancelled) return
      const links = annots.filter((a) => a.subtype === 'Link' && (a.url || a.dest))
      const frag = document.createDocumentFragment()
      for (const link of links) {
        const [px1, py1] = viewport.convertToViewportPoint(link.rect[0], link.rect[1])
        const [px2, py2] = viewport.convertToViewportPoint(link.rect[2], link.rect[3])
        const anchor = document.createElement('a')
        anchor.className = 'pdf-link'
        anchor.href = '#'
        anchor.style.left = `${Math.min(px1, px2)}px`
        anchor.style.top = `${Math.min(py1, py2)}px`
        anchor.style.width = `${Math.abs(px2 - px1)}px`
        anchor.style.height = `${Math.abs(py2 - py1)}px`
        if (link.url) anchor.title = link.url
        anchor.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (link.url) onExternalLink(link.url)
          else if (link.dest) onInternalLink(link.dest)
        })
        frag.append(anchor)
      }
      linkHost.replaceChildren(frag)
    })().catch((err: unknown) => {
      const name = err instanceof Error ? err.name : ''
      if (!cancelled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
        console.error(`pdfx: klarte ikke å tegne side ${pageNumber}`, err)
      }
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [pdf, pageNumber, scale, active, onInternalLink, onExternalLink])

  const style = {
    top,
    left,
    width: cssWidth,
    height: cssHeight,
    '--scale-factor': String(scale)
  } as React.CSSProperties

  return (
    <div className="pdf-page" data-page={pageNumber} style={style}>
      <div className="canvas-host" ref={hostRef} />
      {annotations.some((a) => a.source === 'session') && (
        <div className="annot-overlay">
          {annotations
            .filter((a) => a.source === 'session')
            .map((a) => (
              <AnnotationMarks
                key={a.id}
                annotation={a}
                scale={scale}
                pageHeight={cssHeight / scale}
              />
            ))}
        </div>
      )}
      {searchRects.length > 0 && (
        <div className="annot-overlay">
          {searchRects.map((r, i) => (
            <div
              key={i}
              className="search-hit"
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
            />
          ))}
        </div>
      )}
      <div className="text-host" ref={textRef} />
      <div className="link-host" ref={linkRef} />
    </div>
  )
}

function AnnotationMarks({
  annotation,
  scale,
  pageHeight
}: {
  annotation: PageAnnotation
  scale: number
  pageHeight: number
}): React.JSX.Element {
  return (
    <>
      {annotation.quads.map((q, i) => {
        const css = annotationCss(annotation, q, scale, pageHeight)
        return <div key={i} className={`annot annot-${annotation.type}`} style={css} />
      })}
    </>
  )
}

export default memo(PdfPage)

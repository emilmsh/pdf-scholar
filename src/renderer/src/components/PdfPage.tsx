import { memo, useEffect, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
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
  annotations
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const textHost = textRef.current
    if (!host || !textHost) return
    if (!active) {
      // Free bitmap + text nodes when far outside the viewport
      host.replaceChildren()
      textHost.replaceChildren()
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
  }, [pdf, pageNumber, scale, active])

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
      {annotations.length > 0 && (
        <div className="annot-overlay">
          {annotations.map((a) => (
            <AnnotationMarks key={a.id} annotation={a} scale={scale} pageHeight={cssHeight / scale} />
          ))}
        </div>
      )}
      <div className="text-host" ref={textRef} />
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

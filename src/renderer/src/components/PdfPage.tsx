import { useEffect, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

interface Props {
  pdf: PDFDocumentProxy
  pageNumber: number
  top: number
  cssWidth: number
  cssHeight: number
  scale: number
  /** Only pages near the viewport actually render their canvas */
  active: boolean
}

interface Cancellable {
  cancel(): void
}

export default function PdfPage({
  pdf,
  pageNumber,
  top,
  cssWidth,
  cssHeight,
  scale,
  active
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const textDiv = textRef.current
    if (!canvas || !textDiv) return

    let cancelled = false
    let renderTask: Cancellable | null = null
    let textLayer: Cancellable | null = null

    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale })
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

      textDiv.textContent = ''
      const tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport
      })
      textLayer = tl
      await tl.render()
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
      canvas.width = 0
      canvas.height = 0
      textDiv.textContent = ''
    }
  }, [pdf, pageNumber, scale, active])

  const style = {
    top,
    width: cssWidth,
    height: cssHeight,
    '--scale-factor': String(scale),
    '--total-scale-factor': String(scale)
  } as React.CSSProperties

  return (
    <div className="pdf-page" data-page={pageNumber} style={style}>
      {active && <canvas ref={canvasRef} />}
      {active && <div className="textLayer" ref={textRef} />}
    </div>
  )
}

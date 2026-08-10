// Whole pages as images, for the assistant to READ when the document has no
// text layer (the other half of the scanned-PDF story: it could say "I cannot
// read this" but not read it). Shared by the viewer's panel and the detached
// assistant window — it needs only the pdf.js document handle and an off-DOM
// canvas, never a mounted page.
//
// Rendered offscreen rather than captured from the on-screen canvas, which may
// be low-res at fit-width and is recoloured by the reading theme. JPEG, not
// PNG: a full page of scanned text as PNG runs several megabytes, and every
// attachment is also persisted in the chat store.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { AiImage } from '../../shared/types'
import { clamp } from './clamp'

/** Long side, in px, of a whole page rendered for the assistant to READ (scanned
 *  documents). 1400 matches the cap on pasted images: enough that body text in a
 *  300 dpi scan stays legible to a vision model, small enough that four of them
 *  fit in a request — and in the localStorage chat store — without trouble. */
export const AI_PAGE_IMAGE_SIDE = 1400

export async function renderPagesAsImages(
  pdf: PDFDocumentProxy,
  from: number,
  count: number
): Promise<{ pages: number[]; images: AiImage[] }> {
  const first = clamp(from, 1, pdf.numPages)
  const last = Math.min(pdf.numPages, first + Math.max(1, count) - 1)
  const pages: number[] = []
  const images: AiImage[] = []
  for (let n = first; n <= last; n++) {
    try {
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1, rotation: page.rotate })
      const k = AI_PAGE_IMAGE_SIDE / Math.max(base.width, base.height)
      const viewport = page.getViewport({ scale: k, rotation: page.rotate })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      // Scanned pages are photographs of paper: white behind them, so a
      // transparent canvas does not come out grey once flattened to JPEG.
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      await page.render({ canvas, viewport }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      images.push({ mediaType: 'image/jpeg', dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      pages.push(n)
    } catch {
      /* one page that will not render is skipped; the rest still go */
    }
  }
  return { pages, images }
}

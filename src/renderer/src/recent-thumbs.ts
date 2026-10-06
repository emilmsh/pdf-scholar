// Taking the library's grid pictures (issue #28; the rules live in
// src/shared/recent-thumbs.ts). Page 1, offscreen and unthemed — the grid
// recolours it with the reading theme the way it recolours a page, so one
// picture serves every theme — as a JPEG small enough that twenty of them are
// nothing to store or to send across IPC.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { RecentThumb } from '../../shared/types'
import { RECENT_THUMB_QUALITY, thumbScale } from '../../shared/recent-thumbs'
import { bridge } from './bridge'

/** Page 1 as JPEG bytes, or null when there is nothing to draw: an XFA form's
 *  PDF page is a blank placeholder (its content is HTML pdf.js lays out).
 *  THROWS when the render fails — the document may simply have been closed or
 *  swapped for a re-read under it, and storing «no picture» then would replace
 *  a good one with a placeholder. */
export async function renderFirstPage(pdf: PDFDocumentProxy): Promise<Uint8Array | null> {
  if (pdf.isPureXfa || pdf.numPages < 1) return null
  const page = await pdf.getPage(1)
  const base = page.getViewport({ scale: 1, rotation: page.rotate })
  const viewport = page.getViewport({
    scale: thumbScale(base.width, base.height),
    rotation: page.rotate
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  // White behind the page, or a transparent one flattens to black in a JPEG
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  await page.render({ canvas, viewport }).promise
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', RECENT_THUMB_QUALITY)
  )
  if (!blob) throw new Error('page 1 did not encode')
  return new Uint8Array(await blob.arrayBuffer())
}

/** The picture for a document, as a store keeps it. A document opened with a
 *  password gets none — only the flag, so the grid can show a lock. Throws
 *  when the render does (see renderFirstPage). */
export async function takeRecentThumb(pdf: PDFDocumentProxy, locked: boolean): Promise<RecentThumb> {
  const taken = Date.now()
  if (locked) return { pages: pdf.numPages, locked: true, taken }
  const image = await renderFirstPage(pdf)
  return image ? { image, pages: pdf.numPages, taken } : { pages: pdf.numPages, taken }
}

/** Run `fn` once the page has nothing better to do — a cover is never worth a
 *  frame of the document the reader just opened. The timeout is the ceiling:
 *  a viewer that never idles still gets its picture. */
export function whenIdle(fn: () => void, timeout = 4000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(fn, 1500)
  return () => window.clearTimeout(id)
}

/** The viewer's half: picture a document it has just opened. Called only while
 *  the grid is the chosen view (Settings.recentsView). */
export function recordRecentThumb(path: string, pdf: PDFDocumentProxy, locked: boolean): () => void {
  let cancelled = false
  const cancelIdle = whenIdle(() => {
    takeRecentThumb(pdf, locked)
      .then((thumb) => {
        if (!cancelled) bridge.setRecentThumb(path, thumb)
      })
      .catch(() => {
        /* closed or re-read mid-render: the next open takes it */
      })
  })
  return () => {
    cancelled = true
    cancelIdle()
  }
}

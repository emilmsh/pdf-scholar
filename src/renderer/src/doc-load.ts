// Reading a document's existing annotations into the overlay's record shape.
// Shared between the main viewer's load/reload paths and the split view's
// secondary document session (useSplitDocSession) — one reader, so the two
// can never disagree about what a page carries.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { fromPdfJsAnnotation } from './annotations'
import type { PageAnnotation, PdfJsAnnotationData } from './annotations'

/** One page's annotations as the file has them now */
export async function collectPageAnnotations(
  doc: PDFDocumentProxy,
  pageNumber: number
): Promise<PageAnnotation[]> {
  const page = await doc.getPage(pageNumber)
  const pageHeight = page.getViewport({ scale: 1 }).height
  const raw = (await page.getAnnotations()) as PdfJsAnnotationData[]
  return raw
    .map((r) => fromPdfJsAnnotation(r, pageHeight))
    .filter((r): r is PageAnnotation => r !== null)
}

export async function collectAnnotations(
  doc: PDFDocumentProxy
): Promise<Map<number, PageAnnotation[]>> {
  const map = new Map<number, PageAnnotation[]>()
  for (let i = 1; i <= doc.numPages; i++) {
    const records = await collectPageAnnotations(doc, i)
    if (records.length > 0) map.set(i, records)
  }
  return map
}

/** The annotation state after a reload that followed OUR OWN write to one page.
 *
 *  A full re-read walks every page through pdf.js, and that walk IS what a
 *  reload costs: 640 ms on a 103-page paper carrying 744 link annots, against
 *  2 ms for the one page that changed — the whole visible delay between
 *  dropping a moved note and seeing it land (issue #19). So only `pageNumber`
 *  is re-read from the file.
 *
 *  The other pages keep the records they have, with one adjustment a full
 *  re-read would also have made: a session record that has reached the file
 *  becomes file-painted. The reload swaps in a pdf.js document that now
 *  carries every landed write, so a mark still drawn by the overlay too would
 *  be painted twice. A record still waiting for its object number is not in
 *  that document yet and stays with the overlay — on the reloaded page too,
 *  where a full re-read would have dropped it. */
export function mergePageReload(
  prev: ReadonlyMap<number, PageAnnotation[]>,
  pageNumber: number,
  fresh: PageAnnotation[]
): ReadonlyMap<number, PageAnnotation[]> {
  const next = new Map<number, PageAnnotation[]>()
  for (const [page, list] of prev) {
    if (page === pageNumber) continue
    next.set(
      page,
      list.map((r) => (r.source === 'session' && r.fileId !== null ? { ...r, source: 'file' } : r))
    )
  }
  const inFlight = (prev.get(pageNumber) ?? []).filter((r) => r.fileId === null)
  const list = [...fresh, ...inFlight]
  if (list.length > 0) next.set(pageNumber, list)
  return next
}

/** How a reload updates the annotation state: every page re-read when no
 *  page is named (another window wrote, a draft was discarded), one page when
 *  the reload follows this window's own write to it. Returns a state updater
 *  so the caller applies it against whatever state is current by then. */
export async function reloadedAnnotations(
  doc: PDFDocumentProxy,
  pageNumber?: number
): Promise<(prev: ReadonlyMap<number, PageAnnotation[]>) => ReadonlyMap<number, PageAnnotation[]>> {
  if (pageNumber === undefined) {
    const all = await collectAnnotations(doc)
    return () => all
  }
  const fresh = await collectPageAnnotations(doc, pageNumber)
  return (prev) => mergePageReload(prev, pageNumber, fresh)
}

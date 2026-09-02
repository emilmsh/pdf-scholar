// Reading a document's existing annotations into the overlay's record shape.
// Shared between the main viewer's load/reload paths and the split view's
// secondary document session (useSplitDocSession) — one reader, so the two
// can never disagree about what a page carries.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { fromPdfJsAnnotation } from './annotations'
import type { PageAnnotation, PdfJsAnnotationData } from './annotations'

export async function collectAnnotations(
  doc: PDFDocumentProxy
): Promise<Map<number, PageAnnotation[]>> {
  const map = new Map<number, PageAnnotation[]>()
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const raw = (await page.getAnnotations()) as PdfJsAnnotationData[]
    const records = raw
      .map((r) => fromPdfJsAnnotation(r, pageHeight))
      .filter((r): r is PageAnnotation => r !== null)
    if (records.length > 0) map.set(i, records)
  }
  return map
}

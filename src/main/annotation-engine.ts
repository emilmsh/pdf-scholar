// AnnotationEngine: writes standard PDF annotations into files via mupdf
// (WASM). pdf.js renders, mupdf writes — see ROADMAP.md. All mupdf usage in
// the app must stay inside this module so the writer can be swapped.
//
// Coordinates: MuPDF page space has its origin at the page's TOP-LEFT with y
// growing DOWNWARD (verified in scripts/spike-mupdf-annot.mjs) — the same
// direction as pdf.js viewport space, so requests need no y-flip.
// Annotations are identified across sessions by their PDF object number.
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { PDFAnnotation, PDFDocument, PDFPage } from 'mupdf'
import type {
  AnnotateRequest,
  AnnotateResult,
  DeleteAnnotationRequest,
  ModifyAnnotationRequest,
  PageRect
} from '../shared/types'

// mupdf is ESM-only; the main bundle is CJS, so load it lazily via dynamic import
type Mupdf = typeof import('mupdf')
let mupdfPromise: Promise<Mupdf> | null = null
function getMupdf(): Promise<Mupdf> {
  return (mupdfPromise ??= import('mupdf'))
}

const TYPE_MAP = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  note: 'Text'
} as const

type Quad = [number, number, number, number, number, number, number, number]

function rectToQuad(r: PageRect): Quad {
  // Quad corner order: upper-left, upper-right, lower-left, lower-right
  return [r.x, r.y, r.x + r.w, r.y, r.x, r.y + r.h, r.x + r.w, r.y + r.h]
}

/** Open the PDF, run the operation, save incrementally with atomic replace */
async function withPdf(
  path: string,
  op: (pdf: PDFDocument) => AnnotateResult | { ok: true; id: number }
): Promise<AnnotateResult> {
  try {
    const mupdf = await getMupdf()
    const data = await readFile(path)
    const doc = mupdf.Document.openDocument(data, 'application/pdf')
    try {
      if (doc.needsPassword()) return { error: 'PDF-en er passordbeskyttet' }
      const pdf = doc.asPDF()
      if (!pdf) return { error: 'Filen er ikke en PDF' }

      const result = op(pdf)
      if ('error' in result) return result

      const buffer = pdf.saveToBuffer(pdf.canBeSavedIncrementally() ? 'incremental' : 'garbage=2')
      const bytes = buffer.asUint8Array()
      // Atomic replace so a crash mid-write can't corrupt the original
      const tmp = `${path}.pdfx-tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, path)
      buffer.destroy()
      return result
    } finally {
      doc.destroy()
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function findAnnotation(page: PDFPage, id: number): PDFAnnotation | null {
  for (const annot of page.getAnnotations()) {
    if (annot.getObject().asIndirect() === id) return annot
  }
  return null
}

export function applyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  if (req.quads.length === 0) {
    return Promise.resolve({ error: 'Annotasjonen har ingen posisjon' })
  }
  return withPdf(req.path, (pdf) => {
    const page = pdf.loadPage(req.pageIndex) as PDFPage
    const annot = page.createAnnotation(TYPE_MAP[req.type])
    if (req.type === 'note') {
      const q = req.quads[0]
      annot.setRect([q.x, q.y, q.x + Math.max(q.w, 20), q.y + Math.max(q.h, 20)])
      annot.setIcon('Note')
      annot.setIsOpen(false)
    } else {
      annot.setQuadPoints(req.quads.map(rectToQuad))
    }
    annot.setColor(req.color)
    if (req.opacity < 1) annot.setOpacity(req.opacity)
    if (req.contents) annot.setContents(req.contents)
    annot.setAuthor(req.author ?? 'PDFX')
    annot.setCreationDate(new Date())
    annot.update() // required: generates the appearance stream
    return { ok: true, id: annot.getObject().asIndirect() }
  })
}

export function updateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  return withPdf(req.path, (pdf) => {
    const page = pdf.loadPage(req.pageIndex) as PDFPage
    const annot = findAnnotation(page, req.id)
    if (!annot) return { error: 'Fant ikke annotasjonen i filen' }
    if (req.color) annot.setColor(req.color)
    if (req.opacity !== undefined) annot.setOpacity(req.opacity)
    if (req.contents !== undefined) annot.setContents(req.contents)
    annot.setModificationDate(new Date())
    annot.update()
    return { ok: true, id: req.id }
  })
}

export function deleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  return withPdf(req.path, (pdf) => {
    const page = pdf.loadPage(req.pageIndex) as PDFPage
    const annot = findAnnotation(page, req.id)
    if (!annot) return { error: 'Fant ikke annotasjonen i filen' }
    page.deleteAnnotation(annot)
    return { ok: true, id: req.id }
  })
}

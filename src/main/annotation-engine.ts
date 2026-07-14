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
  note: 'Text',
  ink: 'Ink',
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
  arrow: 'Line',
  freetext: 'FreeText'
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
    } else if (req.type === 'ink') {
      if (!req.strokes || req.strokes.length === 0) return { error: 'Streken er tom' }
      annot.setInkList(req.strokes)
      annot.setBorderWidth(req.width ?? 2)
    } else if (req.type === 'square' || req.type === 'circle') {
      const q = req.quads[0]
      annot.setRect([q.x, q.y, q.x + q.w, q.y + q.h])
      annot.setBorderWidth(req.width ?? 2)
    } else if (req.type === 'line' || req.type === 'arrow') {
      const [a, b] = req.strokes?.[0] ?? []
      if (!a || !b) return { error: 'Linjen mangler endepunkter' }
      // Line annots have no settable /Rect — mupdf derives bounds from /L
      annot.setLine(a, b)
      annot.setBorderWidth(req.width ?? 2)
      if (req.type === 'arrow') annot.setLineEndingStyles('None', 'ClosedArrow')
    } else if (req.type === 'freetext') {
      const q = req.quads[0]
      annot.setRect([q.x, q.y, q.x + q.w, q.y + q.h])
      // Text color lives in the default appearance; /C would set a background
      annot.setDefaultAppearance('Helv', req.fontSize ?? 12, req.color)
    } else {
      annot.setQuadPoints(req.quads.map(rectToQuad))
    }
    if (req.type !== 'freetext') annot.setColor(req.color)
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
    if (req.color) {
      if (annot.getType() === 'FreeText') {
        const da = annot.getDefaultAppearance()
        annot.setDefaultAppearance(da.font || 'Helv', da.size || 12, req.color)
      } else {
        annot.setColor(req.color)
      }
    }
    if (req.opacity !== undefined) annot.setOpacity(req.opacity)
    if (req.contents !== undefined) annot.setContents(req.contents)
    // Note drag: our page space matches MuPDF's (top-left, y down). Line
    // annots have no settable /Rect — but only notes are moved this way.
    if (req.rect && annot.getType() !== 'Line') {
      annot.setRect([req.rect.x, req.rect.y, req.rect.x + req.rect.w, req.rect.y + req.rect.h])
    }
    // Move: translate whatever geometry this annot actually has. getRect/setRect
    // THROW on Line annots in mupdf 1.28 ("Line annotations have no Rect
    // property") — branch on type BEFORE touching the rect. Verified in
    // scripts/spike-annot-move.mjs (endpoint order + /LE arrowheads survive).
    if (req.translate) {
      const { dx, dy } = req.translate
      const type = annot.getType()
      if (type === 'Line') {
        const [a, b] = annot.getLine()
        annot.setLine([a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy])
      } else if (type === 'Ink') {
        annot.setInkList(
          annot.getInkList().map((s) => s.map(([x, y]) => [x + dx, y + dy] as [number, number]))
        )
      } else {
        const r = annot.getRect()
        annot.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
      }
    }
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

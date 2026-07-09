// AnnotationEngine: writes standard PDF annotations into files via mupdf
// (WASM). pdf.js renders, mupdf writes — see ROADMAP.md. All mupdf usage in
// the app must stay inside this module so the writer can be swapped.
//
// Coordinates: MuPDF page space has its origin at the page's TOP-LEFT with y
// growing DOWNWARD (verified in scripts/spike-mupdf-annot.mjs) — the same
// direction as pdf.js viewport space, so requests need no y-flip.
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { PDFPage } from 'mupdf'
import type { AnnotateRequest, AnnotateResult, PageRect } from '../shared/types'

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
  note: 'Text'
} as const

type Quad = [number, number, number, number, number, number, number, number]

function rectToQuad(r: PageRect): Quad {
  // Quad corner order: upper-left, upper-right, lower-left, lower-right
  return [r.x, r.y, r.x + r.w, r.y, r.x, r.y + r.h, r.x + r.w, r.y + r.h]
}

export async function applyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  try {
    if (req.quads.length === 0) return { error: 'Annotasjonen har ingen posisjon' }
    const mupdf = await getMupdf()
    const data = await readFile(req.path)
    const doc = mupdf.Document.openDocument(data, 'application/pdf')
    try {
      if (doc.needsPassword()) return { error: 'PDF-en er passordbeskyttet' }
      const pdf = doc.asPDF()
      if (!pdf) return { error: 'Filen er ikke en PDF' }

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

      const buffer = pdf.saveToBuffer(pdf.canBeSavedIncrementally() ? 'incremental' : 'garbage=2')
      const bytes = buffer.asUint8Array()
      // Atomic replace so a crash mid-write can't corrupt the original
      const tmp = `${req.path}.pdfx-tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, req.path)
      buffer.destroy()
      return { ok: true }
    } finally {
      doc.destroy()
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

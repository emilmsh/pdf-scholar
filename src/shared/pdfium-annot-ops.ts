// The platform-neutral half of the annotation write engine: everything that
// operates on an ALREADY-OPEN PDFium document. Shared by the desktop engine
// (src/main/annotation-engine-embedpdf.ts) and the browser engine
// (src/renderer/src/annotation-engine-browser.ts).
//
// It exists because those two files used to hold ~130 identical lines each. That
// cost was not theoretical: the link-/AP guard bugfix (b787c46) had to be
// written into both, and only the desktop copy was ever covered by a test —
// while the browser copy runs the same PDFium write path in two of the three
// shipping targets. Now `npm run test:engine` exercises this module through the
// desktop entry points, so both targets are tested by one suite.
//
// What deliberately stays with each caller, because it genuinely differs:
//   - loading the wasm binary (node readFile vs fetch of a bundled URL)
//   - the document's lifetime (a DocCache with a debounced flush to a draft file
//     vs an in-memory Map that lives as long as the viewer is mounted)
//   - routing >150 MB files to the incremental appender (desktop only)
//   - the oversize message, which names a different remedy per platform
import type {
  AnnotateRequest,
  AnnotateResult,
  DeleteAnnotationRequest,
  FileError,
  ModifyAnnotationRequest
} from './types'
import type { PdfAnnotationObject, PdfDocumentObject } from '@embedpdf/models'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import { buildAnnotation, rgbToHex, toRect } from './annotation-build'
import { ENGINE_ERRORS } from './engine-errors'
import { snapshotApLessLinks, stripGeneratedLinkAPs } from './link-ap-guard'

/** wasm32 heap exhaustion: every open/serialize round-trips the whole file
 *  through the WASM heap, so very large documents can exceed what it can grow to
 *  (~2 GB). An emscripten abort also KILLS the wasm instance, which is why both
 *  callers reset their engine singleton when this matches. */
export const OOM_RE = /realloc|malloc|out of memory|cannot enlarge memory|oom|aborted/i

/** Files above this size must be REFUSED at write time, not accepted: the
 *  in-memory create would succeed and report ok, but every later serialize would
 *  abort (measured: a 413 MB file needs ~2.36 GB ≈ 5.7× its size, over the 2 GB
 *  wasm32 cap) — silently losing annotations the user believes were saved.
 *  300 MB leaves headroom under the ~350 MB theoretical ceiling. */
export const WASM_SAFE_LIMIT = 300 * 1024 * 1024

/** The raw FPDF functions we reach for. PdfiumNative does not surface the fork's
 *  EPDF object-number extensions in its high-level model API, so the ops below
 *  go through the pointer bridge for those. */
export interface RawPdfium {
  FPDFPage_GetAnnotCount(pagePtr: number): number
  FPDFPage_GetAnnot(pagePtr: number, index: number): number
  FPDFPage_CloseAnnot(annotPtr: number): void
  FPDFAnnot_GetSubtype(annotPtr: number): number
  FPDFAnnot_HasKey(annotPtr: number, key: string): boolean
  FPDFAnnot_SetAP(annotPtr: number, appearanceMode: number, value: number): boolean
  EPDFAnnot_GetObjectNumber(annotPtr: number): number
  EPDFPage_RemoveAnnotByObjectNumber(pagePtr: number, objNum: number): boolean
}

/** An open document, as both callers hold it */
export interface OpenDoc {
  engine: PdfiumNative
  doc: PdfDocumentObject
  docId: string
}

/** Raw-pointer bridge: run `fn` with the FPDF page handle for pageIndex.
 *  Reaches through PdfiumNative's TS-private cache. */
export function withPageHandle<T>(
  engine: PdfiumNative,
  docId: string,
  pageIndex: number,
  fn: (pagePtr: number, raw: RawPdfium) => T
): T {
  const anyEngine = engine as unknown as {
    cache: { getContext(id: string): { borrowPage<R>(idx: number, f: (ctx: { pagePtr: number }) => R): R } }
    pdfiumModule: RawPdfium
  }
  const raw = anyEngine.pdfiumModule
  return anyEngine.cache.getContext(docId).borrowPage(pageIndex, (ctx) => fn(ctx.pagePtr, raw))
}

/** Bracket an engine op so it can't leak PDFium-synthesized link borders:
 *  getPageAnnotations gives border-only Link annots (hyperref's green/red
 *  citation boxes) a generated /AP, which the next save would bake into the
 *  file — see ./link-ap-guard.ts. The strip runs in `finally` but never masks
 *  the op's own error. Wrap any NEW op that loads page annotations in this. */
export async function withLinkApGuard<T>(
  engine: PdfiumNative,
  docId: string,
  pageIndex: number,
  fn: () => Promise<T>
): Promise<T> {
  const apLess = withPageHandle(engine, docId, pageIndex, (pagePtr, raw) =>
    snapshotApLessLinks(pagePtr, raw)
  )
  try {
    return await fn()
  } finally {
    try {
      withPageHandle(engine, docId, pageIndex, (pagePtr, raw) =>
        stripGeneratedLinkAPs(pagePtr, raw, apLess)
      )
    } catch {
      /* op failed hard (e.g. OOM killed the instance) — nothing left to strip */
    }
  }
}

/** index -> PDF object number for every annotation on the page (in /Annots order) */
export function rawObjectNumbers(engine: PdfiumNative, docId: string, pageIndex: number): number[] {
  return withPageHandle(engine, docId, pageIndex, (pagePtr, raw) => {
    const out: number[] = []
    const count = raw.FPDFPage_GetAnnotCount(pagePtr)
    for (let i = 0; i < count; i++) {
      const annotPtr = raw.FPDFPage_GetAnnot(pagePtr, i)
      out.push(raw.EPDFAnnot_GetObjectNumber(annotPtr))
      raw.FPDFPage_CloseAnnot(annotPtr)
    }
    return out
  })
}

/** Find the high-level model for a PDF object number. Uses /Annots-order index
 *  alignment between the raw annot list and getPageAnnotations, guarded by a
 *  count check so silent misalignment is impossible. */
async function findByObjectNumber(
  { engine, doc, docId }: OpenDoc,
  pageIndex: number,
  id: number
): Promise<PdfAnnotationObject | FileError> {
  const page = doc.pages[pageIndex]
  const models = await engine.getPageAnnotations(doc, page).toPromise()
  const objNums = rawObjectNumbers(engine, docId, pageIndex)
  const index = objNums.indexOf(id)
  if (index === -1) return ENGINE_ERRORS.notFound
  if (models.length !== objNums.length) {
    // The model API filtered something — index alignment is unsafe rather than
    // merely wrong, so refuse instead of guessing.
    return ENGINE_ERRORS.asymmetric(models.length, objNums.length)
  }
  return models[index]
}

/** True when the request carries no geometry the engine could place. Callers
 *  check this BEFORE opening anything, so the appender path shares the rule. */
export function hasNoPosition(req: AnnotateRequest): boolean {
  return req.quads.length === 0 && req.type !== 'ink' && req.type !== 'line' && req.type !== 'arrow'
}

/** Create an annotation on an open document. Returns its PDF object number,
 *  which stays stable through saveAsCopy — the renderer's id contract. */
export function applyOn(open: OpenDoc, req: AnnotateRequest): Promise<AnnotateResult> {
  const { engine, doc, docId } = open
  return withLinkApGuard(engine, docId, req.pageIndex, async () => {
    const spec = buildAnnotation(req)
    if ('error' in spec) return spec
    await engine.createPageAnnotation(doc, doc.pages[req.pageIndex], spec).toPromise()
    // The new annotation is last in /Annots order (covered by test:engine's
    // create-then-recolor-by-id case).
    const objNums = rawObjectNumbers(engine, docId, req.pageIndex)
    const id = objNums[objNums.length - 1]
    if (!id) return ENGINE_ERRORS.noObjectNumber
    return { ok: true, id }
  })
}

/** Recolour / retext / move an existing annotation, addressed by object number */
export function updateOn(open: OpenDoc, req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  const { engine, doc, docId } = open
  return withLinkApGuard(engine, docId, req.pageIndex, async () => {
    const model = await findByObjectNumber(open, req.pageIndex, req.id)
    if ('error' in model) return model
    const m = model as PdfAnnotationObject & {
      strokeColor?: string
      fontColor?: string
      linePoints?: { start: { x: number; y: number }; end: { x: number; y: number } }
      inkList?: { points: { x: number; y: number }[] }[]
    }
    if (req.color) {
      const hex = rgbToHex(req.color)
      if (m.type === PdfAnnotationSubtype.FREETEXT) m.fontColor = hex
      else m.strokeColor = hex
    }
    if (req.opacity !== undefined) (m as { opacity?: number }).opacity = req.opacity
    if (req.contents !== undefined) m.contents = req.contents
    if (req.rect && m.type !== PdfAnnotationSubtype.LINE) m.rect = toRect(req.rect)
    if (req.translate) {
      // A move is per-subtype: a Line's endpoints and an Ink's stroke list do
      // not follow a plain rect shift, and setRect alone would leave the
      // geometry behind while the box moved.
      const { dx, dy } = req.translate
      if (m.type === PdfAnnotationSubtype.LINE && m.linePoints) {
        m.linePoints = {
          start: { x: m.linePoints.start.x + dx, y: m.linePoints.start.y + dy },
          end: { x: m.linePoints.end.x + dx, y: m.linePoints.end.y + dy }
        }
      } else if (m.type === PdfAnnotationSubtype.INK && m.inkList) {
        m.inkList = m.inkList.map((s) => ({ points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }))
      }
      m.rect = {
        origin: { x: m.rect.origin.x + dx, y: m.rect.origin.y + dy },
        size: m.rect.size
      }
    }
    ;(m as { modified?: Date }).modified = new Date()
    const ok = await engine.updatePageAnnotation(doc, doc.pages[req.pageIndex], m).toPromise()
    return ok ? { ok: true, id: req.id } : ENGINE_ERRORS.updateRejected
  })
}

/** Remove an annotation by object number */
export function deleteOn(open: OpenDoc, req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  const { engine, docId } = open
  return withLinkApGuard(engine, docId, req.pageIndex, async () => {
    const removed = withPageHandle(engine, docId, req.pageIndex, (pagePtr, raw) =>
      raw.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, req.id)
    )
    return removed ? { ok: true, id: req.id } : ENGINE_ERRORS.notFound
  })
}

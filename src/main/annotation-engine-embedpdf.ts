// AnnotationEngine: writes standard PDF annotations via @embedpdf/pdfium (MIT)
// + @embedpdf/engines (MIT, BSD-3 PDFium fork). THE production write engine —
// it replaced the original mupdf (AGPL) engine on 2026-07-16 so the app can be
// distributed under MIT. mupdf remains a devDependency purely as an
// independent verifier in scripts/test-engine-*.mjs and engine-bench.mjs.
//
// Facts proven in scripts/spike-embedpdf-annot.mjs / spike-embedpdf-objnum.mjs:
// - Model space is top-left, y-down — identical to our PageRect space (no flip).
// - All 11 PDFX types create with appearance streams (/AP verified by mupdf).
// - PDF object numbers are exposed via the fork's EPDF extensions and are
//   STABLE through saveAsCopy — so the renderer's numeric-id contract holds.
// - saveAsCopy is a full rewrite (no incremental save): ~0.4 s on a 20 MB doc,
//   measured in scripts/engine-bench.mjs. Acceptable; writes are async in main.
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type {
  AnnotateRequest,
  AnnotateResult,
  DeleteAnnotationRequest,
  ModifyAnnotationRequest
} from '../shared/types'
import type { PdfAnnotationObject, PdfDocumentObject } from '@embedpdf/models'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import { DocCache } from './doc-cache'
import { appendAnnotation, appendDeleteAnnotation, appendUpdateAnnotation } from './incremental-appender'
import { buildAnnotation, rgbToHex, toRect } from '../shared/annotation-build'
import { snapshotApLessLinks, stripGeneratedLinkAPs } from '../shared/link-ap-guard'

/** Files at/above this size never touch the WASM engine: annotations are
 *  written by the incremental appender (src/main/incremental-appender.ts),
 *  which appends objects + an xref section with plain Node fs — no doc cache,
 *  no flush, the file on disk is current the moment the call resolves. Env
 *  override exists so tests can force the appender onto small corpora. */
const APPENDER_THRESHOLD = (() => {
  const env = Number(process.env.PDFX_APPENDER_THRESHOLD)
  return Number.isFinite(env) && env > 0 ? env : 150 * 1024 * 1024
})()

/** Route to the appender? Checked BEFORE any WASM/cache involvement. On stat
 *  failure fall to the engine path, which surfaces its own read error. */
async function isAppenderFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size >= APPENDER_THRESHOLD
  } catch {
    return false
  }
}

// Lazy singleton: WASM init is ~50 ms and the module is ESM-only (dynamic
// import from the CJS main bundle, mirroring the mupdf loader).
let enginePromise: Promise<PdfiumNative> | null = null
function getEngine(): Promise<PdfiumNative> {
  return (enginePromise ??= (async () => {
    const [{ init }, { PdfiumNative: Native }] = await Promise.all([
      import('@embedpdf/pdfium'),
      import('@embedpdf/engines/pdfium')
    ])
    // createRequire survives both the CJS main bundle and plain-Node ESM tests
    const wasmPath = createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')
    const wasmBinary = await readFile(wasmPath)
    const pdfium = await init({ wasmBinary })
    return new Native(pdfium)
  })())
}


/** Bounding box of a set of strokes, padded — PDFium wants a rect supplied */
/** Raw-pointer bridge: run `fn` with the FPDF page handle for pageIndex.
 *  Reaches through PdfiumNative's TS-private cache — the fork's EPDF object-
 *  number functions are not surfaced in the high-level model API (yet). */
interface RawBridge {
  pdfium: {
    FPDFPage_GetAnnotCount(pagePtr: number): number
    FPDFPage_GetAnnot(pagePtr: number, index: number): number
    FPDFPage_CloseAnnot(annotPtr: number): void
    FPDFAnnot_GetSubtype(annotPtr: number): number
    FPDFAnnot_HasKey(annotPtr: number, key: string): boolean
    FPDFAnnot_SetAP(annotPtr: number, appearanceMode: number, value: number): boolean
    EPDFAnnot_GetObjectNumber(annotPtr: number): number
    EPDFPage_RemoveAnnotByObjectNumber(pagePtr: number, objNum: number): boolean
  }
}

function withPageHandle<T>(engine: PdfiumNative, docId: string, pageIndex: number, fn: (pagePtr: number, raw: RawBridge['pdfium']) => T): T {
  const anyEngine = engine as unknown as {
    cache: { getContext(id: string): { borrowPage<R>(idx: number, f: (ctx: { pagePtr: number }) => R): R } }
    pdfiumModule: RawBridge['pdfium']
  }
  const raw = anyEngine.pdfiumModule
  return anyEngine.cache.getContext(docId).borrowPage(pageIndex, (ctx) => fn(ctx.pagePtr, raw))
}

/** Bracket an engine op so it can't leak PDFium-synthesized link borders:
 *  getPageAnnotations gives border-only Link annots (hyperref's green/red
 *  citation boxes) a generated /AP, which the next flush would bake into the
 *  file — see src/shared/link-ap-guard.ts. The strip runs in `finally` but
 *  never masks the op's own error. */
async function withLinkApGuard<T>(
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
function rawObjectNumbers(engine: PdfiumNative, docId: string, pageIndex: number): number[] {
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

// wasm32 heap exhaustion: every open/serialize round-trips the whole file
// through the WASM heap, so very large documents can exceed what it can grow
// to (~2 GB). An emscripten abort also KILLS the wasm instance.
const OOM_RE = /realloc|malloc|out of memory|cannot enlarge memory|oom|aborted/i
const OVERSIZE_MSG =
  'Dokumentet er for stort til å annoteres (minnegrense i skrivemotoren). Les og marker tekst går fint — lagring av annoteringer i så store filer støttes ikke ennå.'

/** Files above this size must be REFUSED at write time, not accepted into the
 *  cache: the in-memory create would succeed and report ok to the renderer,
 *  but every later saveAsCopy flush would abort (measured: a 413 MB file needs
 *  ~2.36 GB ≈ 5.7× its size, over the 2 GB wasm32 cap) — silently losing the
 *  annotations the user believes were saved. 300 MB leaves headroom under the
 *  ~350 MB theoretical ceiling. The incremental appender routes large files
 *  BEFORE this guard (APPENDER_THRESHOLD = 150 MB < this), so in production
 *  it is a dead backstop — it only bites if the threshold env override is
 *  raised above it. It must stay: falling into the cache path with an
 *  oversize file is silent data loss wearing an "ok". */
const WASM_SAFE_LIMIT = 300 * 1024 * 1024

interface CachedDoc {
  engine: PdfiumNative
  doc: PdfDocumentObject
  docId: string
}

// Document-open cache: consecutive annotation writes mutate ONE in-memory doc
// and the draft file catches up via a debounced flush — instead of a full
// open/saveAsCopy cycle per annotation. Unlike mupdf, the doc handle stays
// open across flushes: saveAsCopy does not mutate the document, and object
// numbers are stable through it (spike-embedpdf-objnum.mjs), so the ids the
// renderer holds keep matching both the cached doc and the file on disk.
const cache = new DocCache<CachedDoc>({
  open: async (path) => {
    const engine = await getEngine()
    const data = await readFile(path)
    const docId = randomUUID()
    const doc = await engine
      .openDocumentBuffer({
        id: docId,
        content: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      })
      .toPromise()
    return { engine, doc, docId }
  },
  flush: async ({ engine, doc }, path) => {
    const saved = await engine.saveAsCopy(doc).toPromise()
    // Atomic replace so a crash mid-write can't corrupt the draft
    const tmp = `${path}.pdfx-tmp`
    await writeFile(tmp, Buffer.from(saved))
    await rename(tmp, path)
  },
  close: async ({ engine, doc }) => {
    await engine.closeDocument(doc).toPromise()
  },
  isFatal: (err) => OOM_RE.test(err instanceof Error ? err.message : String(err)),
  // An emscripten abort kills the whole wasm instance, so EVERY cached doc is
  // dead — drop them all and reset the engine singleton so the next (smaller)
  // write re-initializes a fresh one (pre-cache behavior, kept).
  dropAllOnFatal: true,
  onFatal: () => {
    enginePromise = null
  }
})

/** Run the op against the cached doc; a debounced flush persists it */
async function withPdf(
  path: string,
  op: (engine: PdfiumNative, doc: PdfDocumentObject, docId: string) => Promise<AnnotateResult>
): Promise<AnnotateResult> {
  try {
    // Honest failure beats optimistic loss: refuse oversize files up front —
    // an in-memory write that can never flush is data loss wearing an "ok".
    if ((await stat(path)).size > WASM_SAFE_LIMIT) return { error: OVERSIZE_MSG }
    return await cache.mutate(
      path,
      (cached) => op(cached.engine, cached.doc, cached.docId),
      (result) => !('error' in result)
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/password/i.test(msg)) return { error: 'PDF-en er passordbeskyttet' }
    if (OOM_RE.test(msg)) return { error: OVERSIZE_MSG }
    return { error: msg }
  }
}

/** Flush pending annotation writes for `path` (if any) and release the cached
 *  doc. MUST be called before anything reads or copies the file's bytes. */
export const flushAnnotations = (path: string): Promise<void> => cache.flushAndEvict(path)

/** Discard cached changes without writing (the draft is being thrown away). */
export const dropAnnotations = (path: string): Promise<void> => cache.drop(path)

/** Flush + release every cached doc (app quit). Logs failures, never rejects. */
export const flushAllAnnotations = (): Promise<void> => cache.flushAll()

/** Find the high-level model for a PDF object number. Uses /Annots-order index
 *  alignment between the raw annot list and getPageAnnotations, guarded by a
 *  count check so silent misalignment is impossible. */
async function findByObjectNumber(
  engine: PdfiumNative,
  doc: PdfDocumentObject,
  docId: string,
  pageIndex: number,
  id: number
): Promise<PdfAnnotationObject | { error: string }> {
  const page = doc.pages[pageIndex]
  const models = await engine.getPageAnnotations(doc, page).toPromise()
  const objNums = rawObjectNumbers(engine, docId, pageIndex)
  const index = objNums.indexOf(id)
  if (index === -1) return { error: 'Fant ikke annotasjonen i filen' }
  if (models.length !== objNums.length) {
    // The model API filtered something — index alignment is unsafe. Try /NM-id
    // order-preserving intersection instead of guessing.
    return { error: `Annotasjonslisten er usymmetrisk (${models.length} vs ${objNums.length}) — kan ikke identifisere trygt` }
  }
  return models[index]
}

export async function applyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  if (req.quads.length === 0 && req.type !== 'ink' && req.type !== 'line' && req.type !== 'arrow') {
    return { error: 'Annotasjonen har ingen posisjon' }
  }
  // Large files bypass the WASM engine entirely (appender writes to disk
  // synchronously; flushAnnotations/dropAnnotations are natural no-ops since
  // the path never enters the doc cache). The appender NEVER falls back here:
  // above WASM_SAFE_LIMIT that fallback would be silent data loss.
  if (await isAppenderFile(req.path)) return appendAnnotation(req)
  return withPdf(req.path, (engine, doc, docId) =>
    withLinkApGuard(engine, docId, req.pageIndex, async () => {
      const spec = buildAnnotation(req)
      if ('error' in spec) return spec
      const page = doc.pages[req.pageIndex]
      await engine.createPageAnnotation(doc, page, spec).toPromise()
      // The new annotation is last in /Annots order; its object number is stable
      // through saveAsCopy (proven in spike-embedpdf-objnum.mjs).
      const objNums = rawObjectNumbers(engine, docId, req.pageIndex)
      const id = objNums[objNums.length - 1]
      if (!id) return { error: 'Fikk ikke objektnummer for annotasjonen' }
      return { ok: true, id }
    })
  )
}

export async function updateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  if (await isAppenderFile(req.path)) return appendUpdateAnnotation(req)
  return withPdf(req.path, (engine, doc, docId) =>
    withLinkApGuard(engine, docId, req.pageIndex, async () => {
      const model = await findByObjectNumber(engine, doc, docId, req.pageIndex, req.id)
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
      return ok ? { ok: true, id: req.id } : { error: 'Oppdateringen ble avvist av motoren' }
    })
  )
}

export async function deleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  if (await isAppenderFile(req.path)) return appendDeleteAnnotation(req)
  return withPdf(req.path, (engine, _doc, docId) =>
    withLinkApGuard(engine, docId, req.pageIndex, async () => {
      const removed = withPageHandle(engine, docId, req.pageIndex, (pagePtr, raw) =>
        raw.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, req.id)
      )
      return removed ? { ok: true, id: req.id } : { error: 'Fant ikke annotasjonen i filen' }
    })
  )
}

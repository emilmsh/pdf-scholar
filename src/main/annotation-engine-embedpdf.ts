// AnnotationEngine: writes standard PDF annotations via @embedpdf/pdfium (MIT)
// + @embedpdf/engines (MIT, BSD-3 PDFium fork). THE production write engine —
// it replaced the original mupdf (AGPL) engine on 2026-07-16 so the app can be
// distributed under MIT. mupdf remains a devDependency purely as an
// independent verifier in scripts/test-engine-*.mjs and engine-bench.mjs.
//
// Facts held true by scripts/test-engine-embedpdf.mjs (`npm run test:engine`,
// run on all three OSes in CI) — it exercises each of these through the
// production entry points below and verifies the result with mupdf:
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
  FileError,
  ModifyAnnotationRequest
} from '../shared/types'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import { DocCache } from './doc-cache'
import { appendAnnotation, appendDeleteAnnotation, appendUpdateAnnotation } from './incremental-appender'
import type { OpenDoc } from '../shared/pdfium-annot-ops'
import {
  applyOn,
  deleteOn,
  ENGINE_ERRORS,
  hasNoPosition,
  OOM_RE,
  updateOn,
  WASM_SAFE_LIMIT
} from '../shared/pdfium-annot-ops'

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

/** Names the desktop remedy (the appender) rather than the browser's, which is
 *  why this one string stays per-platform while the rest live in ENGINE_ERRORS. */
const OVERSIZE: FileError = {
  code: 'doc-too-large',
  error:
    'Dokumentet er for stort til å annoteres (minnegrense i skrivemotoren). Les og marker tekst går fint — lagring av annoteringer i så store filer støttes ikke ennå.'
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

// Document-open cache: consecutive annotation writes mutate ONE in-memory doc
// and the draft file catches up via a debounced flush — instead of a full
// open/saveAsCopy cycle per annotation. The doc handle stays open across
// flushes: saveAsCopy does not mutate the document, and object numbers are
// stable through it, so the ids the renderer holds keep matching both the
// cached doc and the file on disk.
const cache = new DocCache<OpenDoc>({
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
  op: (open: OpenDoc) => Promise<AnnotateResult>
): Promise<AnnotateResult> {
  try {
    // Honest failure beats optimistic loss: refuse oversize files up front —
    // an in-memory write that can never flush is data loss wearing an "ok".
    if ((await stat(path)).size > WASM_SAFE_LIMIT) return OVERSIZE
    return await cache.mutate(path, op, (result) => !('error' in result))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/password/i.test(msg)) return ENGINE_ERRORS.passwordProtected
    if (OOM_RE.test(msg)) return OVERSIZE
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


// The three entry points. Everything platform-specific happens here — the
// appender routing and the doc cache; the write itself is the shared op.

export async function applyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  if (hasNoPosition(req)) return ENGINE_ERRORS.noPosition
  // Large files bypass the WASM engine entirely (the appender writes to disk
  // synchronously; flushAnnotations/dropAnnotations are natural no-ops since
  // the path never enters the doc cache). The appender NEVER falls back here:
  // above WASM_SAFE_LIMIT that fallback would be silent data loss.
  if (await isAppenderFile(req.path)) return appendAnnotation(req)
  return withPdf(req.path, (open) => applyOn(open, req))
}

export async function updateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  if (await isAppenderFile(req.path)) return appendUpdateAnnotation(req)
  return withPdf(req.path, (open) => updateOn(open, req))
}

export async function deleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  if (await isAppenderFile(req.path)) return appendDeleteAnnotation(req)
  return withPdf(req.path, (open) => deleteOn(open, req))
}

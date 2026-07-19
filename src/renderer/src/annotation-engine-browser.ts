// Browser twin of the desktop annotation engine (src/main/annotation-engine-
// embedpdf.ts). Same EmbedPDF pdfium WASM, same shared buildAnnotation, same
// object-number contract — but the "draft" lives as an open in-memory document
// instead of a file on disk. This is what platform parity means here: the
// renderer's annotate/update/delete calls behave identically on both platforms;
// only the persistence target differs (file handle / download vs. draft file).
//
// Lifecycle: the viewer registers the original bytes when a document mounts
// (registerBrowserDoc) and releases them on unmount. The engine document opens
// lazily on the first write, so reading never pays the WASM cost.
// currentBytes() serializes the live doc (saveAsCopy) — the source for save,
// print and canvas reloads after file-annotation edits.
import type {
  AnnotateRequest,
  AnnotateResult,
  DeleteAnnotationRequest,
  ModifyAnnotationRequest
} from '../../shared/types'
import { buildAnnotation, rgbToHex, toRect } from '../../shared/annotation-build'
import type { PdfAnnotationObject, PdfDocumentObject } from '@embedpdf/models'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

// Mirrors the desktop WASM_SAFE_LIMIT rationale: an oversize doc would accept
// in-memory writes whose serialization can never complete (wasm32 heap cap) —
// honest refusal up front beats silent loss at save time. The desktop routes
// such files to the incremental appender; porting that appender to the browser
// is future work, so here it is a hard limit.
const WASM_SAFE_LIMIT = 300 * 1024 * 1024
const OVERSIZE_MSG =
  'Dokumentet er for stort til å annoteres i nettleseren (minnegrense i skrivemotoren). Les og marker tekst går fint.'
const OOM_RE = /realloc|malloc|out of memory|cannot enlarge memory|oom|aborted/i

let enginePromise: Promise<PdfiumNative> | null = null

async function getEngine(): Promise<PdfiumNative> {
  return (enginePromise ??= (async () => {
    const [{ init }, { PdfiumNative: Native }] = await Promise.all([
      import('@embedpdf/pdfium'),
      import('@embedpdf/engines/pdfium')
    ])
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
    const pdfium = await init({ wasmBinary })
    return new Native(pdfium)
  })())
}

interface BrowserDoc {
  bytes: Uint8Array
  open: Promise<{ engine: PdfiumNative; doc: PdfDocumentObject; docId: string }> | null
}

const docs = new Map<string, BrowserDoc>()

/** Make `path`'s original bytes available for annotation editing (viewer mount).
 *  Cheap — the engine document opens lazily on the first write. */
export function registerBrowserDoc(path: string, bytes: Uint8Array): void {
  docs.set(path, { bytes, open: null })
}

/** Release the live document and its bytes (viewer unmount / tab close). */
export async function releaseBrowserDoc(path: string): Promise<void> {
  const entry = docs.get(path)
  docs.delete(path)
  if (entry?.open) {
    try {
      const { engine, doc } = await entry.open
      await engine.closeDocument(doc).toPromise()
    } catch {
      /* already dead — nothing to release */
    }
  }
}

function openEntry(entry: BrowserDoc): NonNullable<BrowserDoc['open']> {
  return (entry.open ??= (async () => {
    const engine = await getEngine()
    const copy = entry.bytes.slice()
    const docId = crypto.randomUUID()
    const doc = await engine
      .openDocumentBuffer({
        id: docId,
        content: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
      })
      .toPromise()
    return { engine, doc, docId }
  })())
}

async function withDoc(
  path: string,
  op: (engine: PdfiumNative, doc: PdfDocumentObject, docId: string) => Promise<AnnotateResult>
): Promise<AnnotateResult> {
  const entry = docs.get(path)
  if (!entry) return { error: 'Dokumentet er ikke åpent for redigering' }
  if (entry.bytes.length > WASM_SAFE_LIMIT) return { error: OVERSIZE_MSG }
  try {
    const { engine, doc, docId } = await openEntry(entry)
    return await op(engine, doc, docId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // An emscripten abort kills the whole WASM instance — reset so the next
    // operation re-initializes a fresh engine instead of reusing a corpse.
    if (OOM_RE.test(msg)) {
      enginePromise = null
      entry.open = null
      return { error: OVERSIZE_MSG }
    }
    if (/password/i.test(msg)) return { error: 'PDF-en er passordbeskyttet' }
    return { error: msg }
  }
}

// ---------- Raw-pointer bridge (identical to the desktop engine) ----------

interface RawPdfium {
  FPDFPage_GetAnnotCount(pagePtr: number): number
  FPDFPage_GetAnnot(pagePtr: number, index: number): number
  FPDFPage_CloseAnnot(annotPtr: number): void
  EPDFAnnot_GetObjectNumber(annotPtr: number): number
  EPDFPage_RemoveAnnotByObjectNumber(pagePtr: number, objNum: number): boolean
}

function withPageHandle<T>(
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
    return { error: `Annotasjonslisten er usymmetrisk (${models.length} vs ${objNums.length}) — kan ikke identifisere trygt` }
  }
  return models[index]
}

// ---------- The three engine operations (logic mirrors the desktop) ----------

export async function browserApplyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  if (req.quads.length === 0 && req.type !== 'ink' && req.type !== 'line' && req.type !== 'arrow') {
    return { error: 'Annotasjonen har ingen posisjon' }
  }
  return withDoc(req.path, async (engine, doc, docId) => {
    const spec = buildAnnotation(req)
    if ('error' in spec) return spec
    await engine.createPageAnnotation(doc, doc.pages[req.pageIndex], spec).toPromise()
    const objNums = rawObjectNumbers(engine, docId, req.pageIndex)
    const id = objNums[objNums.length - 1]
    if (!id) return { error: 'Fikk ikke objektnummer for annotasjonen' }
    return { ok: true, id }
  })
}

export async function browserUpdateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  return withDoc(req.path, async (engine, doc, docId) => {
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
}

export async function browserDeleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  return withDoc(req.path, async (engine, _doc, docId) => {
    const removed = withPageHandle(engine, docId, req.pageIndex, (pagePtr, raw) =>
      raw.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, req.id)
    )
    return removed ? { ok: true, id: req.id } : { error: 'Fant ikke annotasjonen i filen' }
  })
}

/** Serialize the live document — original bytes plus every annotation edit.
 *  Returns the registered original bytes untouched when nothing was edited,
 *  and null when the path was never registered. */
export async function browserCurrentBytes(path: string): Promise<Uint8Array | null> {
  const entry = docs.get(path)
  if (!entry) return null
  if (!entry.open) return entry.bytes // no edits — serializing would be a no-op
  try {
    const { engine, doc } = await entry.open
    const saved = await engine.saveAsCopy(doc).toPromise()
    return new Uint8Array(saved as ArrayBuffer)
  } catch {
    return null
  }
}

// Dev-only handle so the engine can be exercised from the automated preview
// (real annotations need UI gestures; this drives the same exported functions).
if (import.meta.env.DEV) {
  ;(window as unknown as { __browserEngine?: unknown }).__browserEngine = {
    apply: browserApplyAnnotation,
    update: browserUpdateAnnotation,
    remove: browserDeleteAnnotation,
    currentBytes: browserCurrentBytes
  }
}

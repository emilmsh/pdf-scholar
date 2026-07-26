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
  FileError,
  ModifyAnnotationRequest
} from '../../shared/types'
import type { OpenDoc } from '../../shared/pdfium-annot-ops'
import {
  applyOn,
  deleteOn,
  ENGINE_ERRORS,
  hasNoPosition,
  OOM_RE,
  updateOn,
  WASM_SAFE_LIMIT
} from '../../shared/pdfium-annot-ops'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

// Mirrors the desktop WASM_SAFE_LIMIT rationale: an oversize doc would accept
// in-memory writes whose serialization can never complete (wasm32 heap cap) —
// honest refusal up front beats silent loss at save time. The desktop routes
// such files to the incremental appender; porting that appender to the browser
// is future work, so here it is a hard limit.
const OVERSIZE: FileError = {
  code: 'doc-too-large-browser',
  error:
    'Dokumentet er for stort til å annoteres i nettleseren (minnegrense i skrivemotoren). Les og marker tekst går fint.'
}
/** No desktop equivalent: on the desktop main owns the draft and can always
 *  create one, while here the bytes only exist while the viewer is mounted. */
const NOT_OPEN: FileError = { code: 'doc-not-open', error: 'Dokumentet er ikke åpent for redigering' }

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
  open: Promise<OpenDoc> | null
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
  op: (open: OpenDoc) => Promise<AnnotateResult>
): Promise<AnnotateResult> {
  const entry = docs.get(path)
  if (!entry) return NOT_OPEN
  if (entry.bytes.length > WASM_SAFE_LIMIT) return OVERSIZE
  try {
    return await op(await openEntry(entry))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // An emscripten abort kills the whole WASM instance — reset so the next
    // operation re-initializes a fresh engine instead of reusing a corpse.
    if (OOM_RE.test(msg)) {
      enginePromise = null
      entry.open = null
      return OVERSIZE
    }
    if (/password/i.test(msg)) return ENGINE_ERRORS.passwordProtected
    return { error: msg }
  }
}

// The three entry points. The writes themselves are the shared ops; only the
// document's lifetime differs from the desktop's.

export function browserApplyAnnotation(req: AnnotateRequest): Promise<AnnotateResult> {
  if (hasNoPosition(req)) return Promise.resolve(ENGINE_ERRORS.noPosition)
  return withDoc(req.path, (open) => applyOn(open, req))
}

export function browserUpdateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  return withDoc(req.path, (open) => updateOn(open, req))
}

export function browserDeleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  return withDoc(req.path, (open) => deleteOn(open, req))
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

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
  DocSignature,
  FileError,
  ModifyAnnotationRequest,
  SetFormFieldRequest
} from './types'
import type {
  PdfAnnotationObject,
  PdfDocumentObject,
  PdfSignatureObject,
  PdfStandardFont
} from '@embedpdf/models'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import { buildAnnotation, hexToRgb, linePad, quadsBBox, rgbToHex, strokesBBox, toRect } from './annotation-build'
import { ENGINE_ERRORS } from './engine-errors'
import { snapshotApLessLinks, stripGeneratedLinkAPs } from './link-ap-guard'
import { decodePressures, encodePressures, inkPressureApContent } from './ink-outline'

/** wasm32 heap exhaustion: every open/serialize round-trips the whole file
 *  through the WASM heap, so very large documents can exceed what it can grow to
 *  (~2 GB). An emscripten abort also KILLS the wasm instance, which is why both
 *  callers reset their engine singleton when this matches. */
export const OOM_RE = /realloc|malloc|out of memory|cannot enlarge memory|oom|aborted/i

/** FPDF_ERR_PASSWORD — "password required or incorrect" in PDFium's error enum. */
const FPDF_ERR_PASSWORD = 4

/** Did this throw mean "the document is encrypted and the password was missing
 *  or wrong"?
 *
 *  Must be asked of the REASON, not the message: PDFium reports a locked file as
 *  the generic `FPDF_LoadMemDocument failed` and carries the real verdict in
 *  `reason.code`. All three callers used to match /password/i on the message
 *  instead, which never fired — so a locked file surfaced as raw engine prose
 *  rather than the named failure it already had a code for. The text match is
 *  kept as a second net in case a future engine version words it differently. */
export function isPasswordError(err: unknown): boolean {
  const reason = (err as { reason?: { code?: number } } | null | undefined)?.reason
  if (reason?.code === FPDF_ERR_PASSWORD) return true
  return /password/i.test(err instanceof Error ? err.message : String(err))
}

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
  FPDFAnnot_GetRect(annotPtr: number, rectPtr: number): boolean
  FPDFAnnot_SetRect(annotPtr: number, rectPtr: number): boolean
  FPDFAnnot_SetStringValue(annotPtr: number, key: string, valuePtr: number): boolean
  FPDFAnnot_GetStringValue(annotPtr: number, key: string, bufPtr: number, buflen: number): number
  FPDFAnnot_HasKey(annotPtr: number, key: string): boolean
  EPDFAnnot_GetObjectNumber(annotPtr: number): number
  EPDFPage_RemoveAnnotByObjectNumber(pagePtr: number, objNum: number): boolean
  // ---- AcroForm field filling; every one of these needs the FORM HANDLE that
  // PageContext.withFormHandle opens, not the document or the page ----
  FORM_SetFocusedAnnot(formHandle: number, annotPtr: number): boolean
  FORM_ForceToKillFocus(formHandle: number): boolean
  FORM_SelectAllText(formHandle: number, pagePtr: number): boolean
  FORM_ReplaceSelection(formHandle: number, pagePtr: number, textPtr: number): void
  FORM_OnChar(formHandle: number, pagePtr: number, charCode: number, modifier: number): boolean
  FORM_SetIndexSelected(
    formHandle: number,
    pagePtr: number,
    index: number,
    selected: boolean
  ): boolean
  FPDFAnnot_GetFormFieldFlags(formHandle: number, annotPtr: number): number
  FPDFAnnot_GetFormFieldValue(
    formHandle: number,
    annotPtr: number,
    bufPtr: number,
    buflen: number
  ): number
  FPDFAnnot_IsChecked(formHandle: number, annotPtr: number): boolean
  FPDFAnnot_IsOptionSelected(formHandle: number, annotPtr: number, index: number): boolean
  /** The EmbedPDF fork's own: re-bake the field's appearance stream after a
   *  value change, so the new text/tick is VISIBLE in other readers too. */
  EPDFAnnot_GenerateFormFieldAP(annotPtr: number): boolean
  /** The underlying emscripten module — heap access for wide-string params,
   *  and FS_RECTF structs */
  pdfium: {
    wasmExports: { malloc(size: number): number; free(ptr: number): void }
    HEAPU8: Uint8Array
    stringToUTF16(str: string, outPtr: number, maxBytes: number): void
    UTF16ToString(ptr: number): string
    getValue(ptr: number, type: 'float' | 'i32'): number
    setValue(ptr: number, value: number, type: 'float' | 'i32'): void
  }
}

/** A view's bytes as a standalone ArrayBuffer. A Uint8Array that came over IPC
 *  (or out of a larger pool) can be a WINDOW onto a bigger buffer, and handing
 *  `.buffer` straight to the engine would embed everything around it. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** An open document, as both callers hold it */
export interface OpenDoc {
  engine: PdfiumNative
  doc: PdfDocumentObject
  docId: string
}

/** The page context borrowPage hands out. `withFormHandle` really is on it —
 *  it opens a form-fill environment, runs `fn`, and always tears it down —
 *  it was simply missing from this type until form filling needed it. */
interface PageCtx {
  pagePtr: number
  withFormHandle<T>(fn: (formHandle: number) => T): T
}

interface EngineInternals {
  cache: {
    getContext(id: string): {
      docPtr: number
      borrowPage<R>(idx: number, f: (ctx: PageCtx) => R): R
    }
  }
  pdfiumModule: RawPdfium
}

/** Raw-pointer bridge: run `fn` with the FPDF page handle for pageIndex.
 *  Reaches through PdfiumNative's TS-private cache. */
export function withPageHandle<T>(
  engine: PdfiumNative,
  docId: string,
  pageIndex: number,
  fn: (pagePtr: number, raw: RawPdfium) => T
): T {
  const anyEngine = engine as unknown as EngineInternals
  const raw = anyEngine.pdfiumModule
  return anyEngine.cache.getContext(docId).borrowPage(pageIndex, (ctx) => fn(ctx.pagePtr, raw))
}

/** The same, plus a form-fill handle — everything about AcroForm fields is
 *  addressed through one (the flags, the value, the tick state, the edit
 *  control). The handle is opened and torn down around `fn`, never cached.
 *
 *  MUST be called inside withLinkApGuard: merely opening the environment makes
 *  PDFium synthesize /AP for AP-less annotations on the page, border-only
 *  hyperref Links included — measured with an empty callback, and the generated
 *  appearance survived into the saved file. Same failure the guard exists for,
 *  reached by a different door. */
function withFormAndPage<T>(
  engine: PdfiumNative,
  docId: string,
  pageIndex: number,
  fn: (pagePtr: number, formHandle: number, raw: RawPdfium) => T
): T {
  const anyEngine = engine as unknown as EngineInternals
  const raw = anyEngine.pdfiumModule
  return anyEngine.cache
    .getContext(docId)
    .borrowPage(pageIndex, (p) => p.withFormHandle((h) => fn(p.pagePtr, h, raw)))
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

/** Allocate a UTF-16LE copy of `s` on the wasm heap for the duration of `fn` —
 *  FPDF_WIDESTRING parameters (SetAP, SetStringValue) take a raw pointer. */
function withWideString<T>(raw: RawPdfium, s: string, fn: (ptr: number) => T): T {
  const bytes = (s.length + 1) * 2
  const ptr = raw.pdfium.wasmExports.malloc(bytes)
  raw.pdfium.stringToUTF16(s, ptr, bytes)
  try {
    return fn(ptr)
  } finally {
    raw.pdfium.wasmExports.free(ptr)
  }
}

/** Run `fn` with the open annot handle for a PDF object number; null if absent. */
function withAnnotByObjNum<T>(
  pagePtr: number,
  raw: RawPdfium,
  objNum: number,
  fn: (annotPtr: number) => T
): T | null {
  const count = raw.FPDFPage_GetAnnotCount(pagePtr)
  for (let i = 0; i < count; i++) {
    const annotPtr = raw.FPDFPage_GetAnnot(pagePtr, i)
    if (raw.EPDFAnnot_GetObjectNumber(annotPtr) === objNum) {
      try {
        return fn(annotPtr)
      } finally {
        raw.FPDFPage_CloseAnnot(annotPtr)
      }
    }
    raw.FPDFPage_CloseAnnot(annotPtr)
  }
  return null
}

/** The annotation-dict key holding per-stroke pen pressures (encodePressures
 *  format). PDFX-private; other readers render the baked /AP and ignore it. */
const PRESSURES_KEY = 'PDFX_Pressures'

/** Overwrite an Ink annotation's /AP with the variable-width filled outline a
 *  pressure-sensitive pen stroke really has, and store the pressures so a
 *  later move/reshape can re-bake. The InkList centerline (written by the
 *  normal create/update path) stays untouched, so other editors still see a
 *  standard Ink.
 *
 *  Coordinates: model space is top-left y-down and otherwise identical to PDF
 *  space, so the AP content (PDF space, y-up) is a pure flip about the page
 *  height (verified against FPDFAnnot_GetRect in the 2026-08-07 spike). The
 *  appearance BBox is the annot's /Rect (SetAP copies it), which carries ≥ a
 *  full stroke-width of padding — the create/reshape paths bbox with
 *  strokesBBox(strokes, width) and EmbedPDF pads another width/2 — while the
 *  outline never needs more than 0.7 × width, so the fill cannot clip. The
 *  guard below re-checks that instead of trusting it.
 *
 *  Returns false when the annot is missing or the fill would clip — the
 *  caller must not pretend the calligraphy was saved. */
export function bakeInkPressureAP(
  open: OpenDoc,
  pageIndex: number,
  id: number,
  strokes: [number, number][][],
  pressures: number[][],
  baseWidth: number,
  color: [number, number, number],
  opacity: number
): boolean {
  const { engine, doc, docId } = open
  const pageH = doc.pages[pageIndex]?.size.height
  if (!pageH) return false
  return withPageHandle(engine, docId, pageIndex, (pagePtr, raw) => {
    const ok = withAnnotByObjNum(pagePtr, raw, id, (annotPtr) => {
      // FS_RECTF: 4 × float32 — left, top, right, bottom (PDF space, y-up)
      const rectPtr = raw.pdfium.wasmExports.malloc(16)
      let rect: { left: number; top: number; right: number; bottom: number }
      try {
        if (!raw.FPDFAnnot_GetRect(annotPtr, rectPtr)) return false
        rect = {
          left: raw.pdfium.getValue(rectPtr, 'float'),
          top: raw.pdfium.getValue(rectPtr + 4, 'float'),
          right: raw.pdfium.getValue(rectPtr + 8, 'float'),
          bottom: raw.pdfium.getValue(rectPtr + 12, 'float')
        }
      } finally {
        raw.pdfium.wasmExports.free(rectPtr)
      }
      // Would the widest part of the outline (max half-width 0.7 × width, caps
      // included) fall outside the appearance BBox? Then it would clip.
      const reach = 0.7 * baseWidth + 0.1
      const bbox = strokesBBox(strokes, reach)
      if (
        bbox.x < rect.left - 0.01 ||
        bbox.x + bbox.w > rect.right + 0.01 ||
        pageH - bbox.y > rect.top + 0.01 ||
        pageH - (bbox.y + bbox.h) < rect.bottom - 0.01
      ) {
        return false
      }
      const map = (x: number, y: number): [number, number] => [x, pageH - y]
      const content = inkPressureApContent(strokes, pressures, baseWidth, color, opacity, map)
      const set = withWideString(raw, content, (ptr) =>
        raw.FPDFAnnot_SetAP(annotPtr, 0 /* FPDF_ANNOT_APPEARANCEMODE_NORMAL */, ptr)
      )
      if (!set) return false
      withWideString(raw, encodePressures(pressures), (ptr) =>
        raw.FPDFAnnot_SetStringValue(annotPtr, PRESSURES_KEY, ptr)
      )
      return true
    })
    return ok === true
  })
}

/** Pressures stored on an Ink annotation, or null when it never had any. */
export function readInkPressures(
  open: OpenDoc,
  pageIndex: number,
  id: number
): number[][] | null {
  const { engine, docId } = open
  return withPageHandle(engine, docId, pageIndex, (pagePtr, raw) =>
    withAnnotByObjNum(pagePtr, raw, id, (annotPtr) => {
      const bytes = raw.FPDFAnnot_GetStringValue(annotPtr, PRESSURES_KEY, 0, 0)
      if (bytes <= 2) return null // empty or absent (2 = bare terminator)
      const bufPtr = raw.pdfium.wasmExports.malloc(bytes)
      try {
        raw.FPDFAnnot_GetStringValue(annotPtr, PRESSURES_KEY, bufPtr, bytes)
        return decodePressures(raw.pdfium.UTF16ToString(bufPtr))
      } finally {
        raw.pdfium.wasmExports.free(bufPtr)
      }
    })
  )
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
    // A stamp's pixels ride in the CONTEXT argument, not the annotation model:
    // PDFium decodes the PNG itself and writes it into the appearance stream as
    // an image XObject. buildAnnotation has already refused an imageless stamp.
    const context =
      req.type === 'stamp' && req.image
        ? { data: toArrayBuffer(req.image), mimeType: 'image/png' as const }
        : undefined
    await engine
      .createPageAnnotation(doc, doc.pages[req.pageIndex], spec, context as never)
      .toPromise()
    // The new annotation is last in /Annots order (covered by test:engine's
    // create-then-recolor-by-id case).
    const objNums = rawObjectNumbers(engine, docId, req.pageIndex)
    const id = objNums[objNums.length - 1]
    if (!id) return ENGINE_ERRORS.noObjectNumber
    // A pressure stroke's whole point is the varying width — if that can't be
    // baked into the file, the honest outcome is no annotation, not a uniform
    // one that silently loses the calligraphy the user saw while drawing.
    if (req.type === 'ink' && req.pressures && req.strokes) {
      const baked = bakeInkPressureAP(
        open,
        req.pageIndex,
        id,
        req.strokes,
        req.pressures,
        req.width ?? 2,
        req.color,
        req.opacity
      )
      if (!baked) {
        withPageHandle(engine, docId, req.pageIndex, (pagePtr, raw) =>
          raw.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, id)
        )
        return ENGINE_ERRORS.pressureBakeFailed
      }
    }
    return { ok: true, id }
  })
}

/** ASCII out of one of PDFium's raw signature buffers, trimmed of the NULs and
 *  padding PDF strings routinely carry. Returns '' for anything unreadable —
 *  a garbled field must not become a garbled sentence in the UI. */
function bufferText(buf: ArrayBuffer | undefined): string {
  if (!buf || buf.byteLength === 0) return ''
  let out = ''
  for (const byte of new Uint8Array(buf)) {
    if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte)
  }
  return out.trim()
}

/** The document's digital signatures, as much as can be read without doing any
 *  cryptography. See DocSignature: this reports PRESENCE, never validity. */
export async function readSignaturesOn(open: OpenDoc): Promise<DocSignature[]> {
  const found = await open.engine.getSignatures(open.doc).toPromise()
  return (found as PdfSignatureObject[]).map((s) => ({
    time: typeof s.time === 'string' ? s.time.trim() : bufferText(s.time as never),
    reason: typeof s.reason === 'string' ? s.reason.trim() : bufferText(s.reason as never),
    subFilter: bufferText(s.subFilter),
    // Any non-zero DocMDP means the signature also locks the document.
    certifying: typeof s.docMDP === 'number' && s.docMDP > 0
  }))
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
      strokeWidth?: number
      linePoints?: { start: { x: number; y: number }; end: { x: number; y: number } }
      inkList?: { points: { x: number; y: number }[] }[]
      segmentRects?: { origin: { x: number; y: number }; size: { width: number; height: number } }[]
    }
    if (req.color) {
      const hex = rgbToHex(req.color)
      if (m.type === PdfAnnotationSubtype.FREETEXT) m.fontColor = hex
      else m.strokeColor = hex
    }
    if (req.opacity !== undefined) (m as { opacity?: number }).opacity = req.opacity
    if (req.contents !== undefined) m.contents = req.contents
    // Re-set a text box in another of the Standard 14. Nothing to bake by hand:
    // the same field buildAnnotation fills at create time, and the engine
    // regenerates the appearance from the model below — so PDFium writes the
    // new face the way it wrote the old one, with no font data embedded. Guarded
    // on the subtype because fontFamily is meaningless on every other one.
    if (req.font !== undefined && m.type === PdfAnnotationSubtype.FREETEXT) {
      ;(m as { fontFamily?: PdfStandardFont }).fontFamily = req.font
    }
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
    // A RESIZE sends the new geometry outright. The bbox is recomputed with the
    // same padding rules buildAnnotation uses at create time (annotation-build),
    // so a re-shaped mark and a freshly drawn one end up with the same /Rect —
    // otherwise the second one would look subtly different in other readers.
    if (req.quads && req.quads.length > 0) {
      m.segmentRects = req.quads.map(toRect)
      m.rect = toRect(quadsBBox(req.quads))
    }
    if (req.strokes && req.strokes.length > 0) {
      const width = m.strokeWidth ?? 2
      if (m.type === PdfAnnotationSubtype.LINE) {
        const [a, b] = req.strokes[0] ?? []
        if (!a || !b) return ENGINE_ERRORS.lineNoEndpoints
        m.linePoints = { start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }
        m.rect = toRect(strokesBBox([[a, b]], linePad(width)))
      } else if (m.type === PdfAnnotationSubtype.INK) {
        m.inkList = req.strokes.map((s) => ({ points: s.map(([x, y]) => ({ x, y })) }))
        m.rect = toRect(strokesBBox(req.strokes, width))
      }
    }
    ;(m as { modified?: Date }).modified = new Date()
    // A pressure ink's pressures are read BEFORE the engine update: the update
    // rewrites the annotation from the model, and a private dictionary key has
    // no seat in that model.
    const pressures =
      m.type === PdfAnnotationSubtype.INK
        ? req.pressures ?? readInkPressures(open, req.pageIndex, req.id)
        : null
    const ok = await engine.updatePageAnnotation(doc, doc.pages[req.pageIndex], m).toPromise()
    if (!ok) return ENGINE_ERRORS.updateRejected
    // The engine regenerated the appearance uniformly — re-bake the varying
    // width from the (possibly shifted/re-shaped) centerline.
    if (pressures && m.type === PdfAnnotationSubtype.INK && m.inkList) {
      const strokes = m.inkList.map((s) => s.points.map((p) => [p.x, p.y] as [number, number]))
      const baked = bakeInkPressureAP(
        open,
        req.pageIndex,
        req.id,
        strokes,
        pressures,
        m.strokeWidth ?? 2,
        hexToRgb(m.strokeColor ?? '#000000'),
        (m as { opacity?: number }).opacity ?? 1
      )
      if (!baked) return ENGINE_ERRORS.pressureBakeFailed
    }
    return { ok: true, id: req.id }
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

// ---------- AcroForm field filling ----------

const FPDF_ANNOT_WIDGET = 20
/** /Ff bit 1 — the ReadOnly field flag */
const FPDF_FORMFLAG_READONLY = 1
/** The character PDFium's form-fill environment reads as "toggle this button".
 *  There is no set-to-true call: a check box and a radio button are flipped by
 *  a keystroke on the focused widget, exactly as a user would. */
const FORM_CHAR_TOGGLE = 13 // Return

/** The field's /V as PDFium hands it back, '' when absent or unreadable. */
function formFieldValue(raw: RawPdfium, formHandle: number, annotPtr: number): string {
  const bytes = raw.FPDFAnnot_GetFormFieldValue(formHandle, annotPtr, 0, 0)
  if (bytes <= 2) return '' // empty or absent (2 = bare terminator)
  const buf = raw.pdfium.wasmExports.malloc(bytes)
  try {
    raw.FPDFAnnot_GetFormFieldValue(formHandle, annotPtr, buf, bytes)
    return raw.pdfium.UTF16ToString(buf)
  } finally {
    raw.pdfium.wasmExports.free(buf)
  }
}

/** Put a value in one AcroForm field, addressed by the widget's PDF object
 *  number. The whole document is untouched apart from that field.
 *
 *  Three deliberate departures from the engine's own setFormFieldValue:
 *
 *  1. The RAW path, not the high-level one. `getPageAnnoWidgets` MINTS an /NM
 *     uuid into every widget that lacks one (measured) — dirtying a document
 *     the user only wanted to read, and setting up a second identity space
 *     beside the object numbers every other write here uses.
 *  2. The read-only refusal. PDFium does not enforce /Ff bit 1: setting a value
 *     on a locked field returns success and writes it. The gate has to be at
 *     this boundary, not in a UI that could be bypassed by any other caller.
 *  3. The value is READ BACK. PDFium reports success for writes it did not
 *     make — unchecking a radio button returns true and leaves /V alone, which
 *     is right for PDF (a radio group is only ever unset by picking a sibling)
 *     and wrong as a return value. Verifying is preferred over special-casing
 *     radios: it also catches a comb field truncating text, a maxlen, a
 *     read-only parent, and whatever the next engine version decides to lie
 *     about. */
export function setFormFieldOn(open: OpenDoc, req: SetFormFieldRequest): Promise<AnnotateResult> {
  const { engine, docId } = open
  return withLinkApGuard(engine, docId, req.pageIndex, async () =>
    withFormAndPage(engine, docId, req.pageIndex, (pagePtr, formHandle, raw) => {
      const outcome = withAnnotByObjNum(pagePtr, raw, req.id, (annotPtr): AnnotateResult => {
        if (raw.FPDFAnnot_GetSubtype(annotPtr) !== FPDF_ANNOT_WIDGET) {
          return ENGINE_ERRORS.formFieldNotFound
        }
        if (raw.FPDFAnnot_GetFormFieldFlags(formHandle, annotPtr) & FPDF_FORMFLAG_READONLY) {
          return ENGINE_ERRORS.formFieldReadOnly
        }
        if (!raw.FORM_SetFocusedAnnot(formHandle, annotPtr)) {
          return ENGINE_ERRORS.formFieldNotWritten
        }
        const v = req.value
        try {
          if (v.kind === 'text') {
            // Select-all + replace, i.e. what a user does. There is no
            // "set the text" call — the field is an edit control.
            if (!raw.FORM_SelectAllText(formHandle, pagePtr)) return ENGINE_ERRORS.formFieldNotWritten
            withWideString(raw, v.text, (ptr) => raw.FORM_ReplaceSelection(formHandle, pagePtr, ptr))
          } else if (v.kind === 'checked') {
            // A toggle, so only send it when the state actually differs —
            // otherwise the keystroke would flip it the wrong way.
            if (!!raw.FPDFAnnot_IsChecked(formHandle, annotPtr) !== v.checked) {
              raw.FORM_OnChar(formHandle, pagePtr, FORM_CHAR_TOGGLE, 0)
            }
          } else {
            raw.FORM_SetIndexSelected(formHandle, pagePtr, v.index, v.selected ?? true)
          }
        } finally {
          // Killing focus is what COMMITS the edit into /V; without it the
          // value lives only in the form-fill environment we are about to
          // tear down. In `finally` so an early return can't skip it.
          raw.FORM_ForceToKillFocus(formHandle)
        }
        // Re-bake the appearance, or the field would read correctly in a parser
        // and show blank in every viewer.
        raw.EPDFAnnot_GenerateFormFieldAP(annotPtr)
        const landed =
          v.kind === 'text'
            ? formFieldValue(raw, formHandle, annotPtr) === v.text
            : v.kind === 'checked'
              ? !!raw.FPDFAnnot_IsChecked(formHandle, annotPtr) === v.checked
              : !!raw.FPDFAnnot_IsOptionSelected(formHandle, annotPtr, v.index) ===
                (v.selected ?? true)
        return landed ? { ok: true, id: req.id } : ENGINE_ERRORS.formFieldNotWritten
      })
      return outcome ?? ENGINE_ERRORS.formFieldNotFound
    })
  )
}

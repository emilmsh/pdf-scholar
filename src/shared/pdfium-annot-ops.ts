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
  ModifyAnnotationRequest,
  PageRect
} from './types'
import type { PdfAnnotationObject, PdfDocumentObject } from '@embedpdf/models'
import { PdfAnnotationSubtype } from '@embedpdf/models'
import type { PdfiumNative } from '@embedpdf/engines/pdfium'
import { buildAnnotation, hexToRgb, linePad, quadsBBox, rgbToHex, strokesBBox, toRect } from './annotation-build'
import { ENGINE_ERRORS } from './engine-errors'
import { snapshotApLessLinks, stripGeneratedLinkAPs } from './link-ap-guard'
import { decodePressures, encodePressures, inkPressureApContent } from './ink-outline'
import { HAND_ASCENT, HAND_LINE_HEIGHT, HAND_NOTE_KEY, handFontBytes } from './hand-note'

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
  FPDFAnnot_GetRect(annotPtr: number, rectPtr: number): boolean
  FPDFAnnot_SetRect(annotPtr: number, rectPtr: number): boolean
  FPDFAnnot_SetStringValue(annotPtr: number, key: string, valuePtr: number): boolean
  FPDFAnnot_GetStringValue(annotPtr: number, key: string, bufPtr: number, buflen: number): number
  FPDFAnnot_HasKey(annotPtr: number, key: string): boolean
  EPDFAnnot_GetObjectNumber(annotPtr: number): number
  EPDFPage_RemoveAnnotByObjectNumber(pagePtr: number, objNum: number): boolean
  // ---- handwritten notes (Stamp + embedded font); see ./hand-note.ts ----
  FPDFAnnot_AppendObject(annotPtr: number, objPtr: number): boolean
  FPDFAnnot_GetObjectCount(annotPtr: number): number
  FPDFAnnot_RemoveObject(annotPtr: number, index: number): boolean
  FPDFText_LoadFont(docPtr: number, dataPtr: number, size: number, fontType: number, cid: boolean): number
  FPDFFont_Close(fontPtr: number): void
  FPDFPageObj_CreateTextObj(docPtr: number, fontPtr: number, fontSize: number): number
  FPDFText_SetText(objPtr: number, textPtr: number): boolean
  FPDFPageObj_SetFillColor(objPtr: number, r: number, g: number, b: number, a: number): boolean
  FPDFPageObj_Transform(objPtr: number, a: number, b: number, c: number, d: number, e: number, f: number): void
  FPDFPageObj_Destroy(objPtr: number): void
  FPDFPage_GenerateContent(pagePtr: number): boolean
  /** The underlying emscripten module — heap access for wide-string params,
   *  FS_RECTF structs and the font bytes we hand to FPDFText_LoadFont */
  pdfium: {
    wasmExports: { malloc(size: number): number; free(ptr: number): void }
    HEAPU8: Uint8Array
    stringToUTF16(str: string, outPtr: number, maxBytes: number): void
    UTF16ToString(ptr: number): string
    getValue(ptr: number, type: 'float' | 'i32'): number
    setValue(ptr: number, value: number, type: 'float' | 'i32'): void
  }
}

/** An open document, as both callers hold it */
export interface OpenDoc {
  engine: PdfiumNative
  doc: PdfDocumentObject
  docId: string
}

interface EngineInternals {
  cache: {
    getContext(id: string): {
      docPtr: number
      borrowPage<R>(idx: number, f: (ctx: { pagePtr: number }) => R): R
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

/** The same, plus the FPDF_DOCUMENT handle — fonts and page objects are
 *  created against the document, not the page. */
function withDocAndPage<T>(
  engine: PdfiumNative,
  docId: string,
  pageIndex: number,
  fn: (docPtr: number, pagePtr: number, raw: RawPdfium) => T
): T {
  const anyEngine = engine as unknown as EngineInternals
  const raw = anyEngine.pdfiumModule
  const ctx = anyEngine.cache.getContext(docId)
  return ctx.borrowPage(pageIndex, (p) => fn(ctx.docPtr, p.pagePtr, raw))
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

// ---------- handwritten notes (Stamp + embedded font) ----------

const FPDF_FONT_TRUETYPE = 2

/** Draw `lines` into an open Stamp annotation in the embedded handwriting
 *  font. The caller has already wrapped the text (the renderer measures with
 *  the very same font, so screen and file break lines identically).
 *
 *  Coordinates are the annotation's FORM space, not the page's: PDFium gives
 *  the appearance a BBox of [0 0 w h] and clips to it, so an object placed at
 *  absolute page coordinates is silently clipped away entirely (which is
 *  exactly what happened the first time). Origin is the box's bottom-left,
 *  y up — hence `box.h - <distance down from the top>`. A happy consequence:
 *  the glyphs are relative to the box, so moving the note is just a new
 *  /Rect and the appearance still lands correctly. */
function drawHandLines(
  raw: RawPdfium,
  docPtr: number,
  annotPtr: number,
  lines: string[],
  box: PageRect,
  fontSize: number,
  color: [number, number, number]
): boolean {
  const bytes = handFontBytes()
  const fontData = raw.pdfium.wasmExports.malloc(bytes.length)
  raw.pdfium.HEAPU8.set(bytes, fontData)
  const font = raw.FPDFText_LoadFont(docPtr, fontData, bytes.length, FPDF_FONT_TRUETYPE, true)
  raw.pdfium.wasmExports.free(fontData)
  if (!font) return false
  const [r, g, b] = color.map((v) => Math.round(v * 255))
  try {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '') continue
      const obj = raw.FPDFPageObj_CreateTextObj(docPtr, font, fontSize)
      if (!obj) return false
      const ok = withWideString(raw, lines[i], (ptr) => raw.FPDFText_SetText(obj, ptr))
      if (!ok) {
        raw.FPDFPageObj_Destroy(obj)
        return false
      }
      raw.FPDFPageObj_SetFillColor(obj, r, g, b, 255)
      // Distance of this baseline BELOW the box's top, flipped into the
      // form's y-up space
      const down = fontSize * (HAND_ASCENT + i * HAND_LINE_HEIGHT)
      raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 0, box.h - down)
      if (!raw.FPDFAnnot_AppendObject(annotPtr, obj)) {
        raw.FPDFPageObj_Destroy(obj)
        return false
      }
    }
  } finally {
    raw.FPDFFont_Close(font)
  }
  return true
}

/** Everything needed to draw a handwritten note again, kept in the annotation
 *  itself. Without this a move went through the generic model update, which
 *  rebuilds the appearance from a model that knows nothing about our text
 *  objects — measured: the /AP fell from 499 bytes to 42 and the note went
 *  blank. Storing the state means ANY note can be re-baked, including one
 *  reopened from a file the renderer no longer has state for. */
const HAND_LINES_KEY = 'PDFX_HandLines'
const HAND_SIZE_KEY = 'PDFX_HandSize'
const HAND_COLOR_KEY = 'PDFX_HandColor'

/** Stamp the note as ours AND record what it takes to draw it again. */
function writeHandState(
  raw: RawPdfium,
  annotPtr: number,
  lines: string[],
  fontSize: number,
  color: [number, number, number]
): void {
  withWideString(raw, '1', (p) => raw.FPDFAnnot_SetStringValue(annotPtr, HAND_NOTE_KEY, p))
  withWideString(raw, lines.join('\n'), (p) =>
    raw.FPDFAnnot_SetStringValue(annotPtr, HAND_LINES_KEY, p)
  )
  withWideString(raw, String(fontSize), (p) =>
    raw.FPDFAnnot_SetStringValue(annotPtr, HAND_SIZE_KEY, p)
  )
  withWideString(raw, rgbToHex(color), (p) =>
    raw.FPDFAnnot_SetStringValue(annotPtr, HAND_COLOR_KEY, p)
  )
}

function readAnnotString(raw: RawPdfium, annotPtr: number, key: string): string | null {
  const bytes = raw.FPDFAnnot_GetStringValue(annotPtr, key, 0, 0)
  if (bytes <= 2) return null
  const buf = raw.pdfium.wasmExports.malloc(bytes)
  try {
    raw.FPDFAnnot_GetStringValue(annotPtr, key, buf, bytes)
    return raw.pdfium.UTF16ToString(buf)
  } finally {
    raw.pdfium.wasmExports.free(buf)
  }
}

interface HandState {
  lines: string[]
  fontSize: number
  color: [number, number, number]
  box: PageRect
}

/** The stored state of a handwritten note, or null if this annotation is not
 *  one of ours (a foreign image stamp, or any other subtype). */
function readHandNote(open: OpenDoc, pageIndex: number, id: number): HandState | null {
  const { engine, doc, docId } = open
  const pageH = doc.pages[pageIndex]?.size.height
  if (!pageH) return null
  return withPageHandle(engine, docId, pageIndex, (pagePtr, raw) =>
    withAnnotByObjNum(pagePtr, raw, id, (annotPtr): HandState | null => {
      if (!raw.FPDFAnnot_HasKey(annotPtr, HAND_NOTE_KEY)) return null
      const linesRaw = readAnnotString(raw, annotPtr, HAND_LINES_KEY)
      if (linesRaw === null) return null
      const rectPtr = raw.pdfium.wasmExports.malloc(16)
      let box: PageRect
      try {
        if (!raw.FPDFAnnot_GetRect(annotPtr, rectPtr)) return null
        const left = raw.pdfium.getValue(rectPtr, 'float')
        const top = raw.pdfium.getValue(rectPtr + 4, 'float')
        const right = raw.pdfium.getValue(rectPtr + 8, 'float')
        const bottom = raw.pdfium.getValue(rectPtr + 12, 'float')
        box = { x: left, y: pageH - top, w: right - left, h: top - bottom }
      } finally {
        raw.pdfium.wasmExports.free(rectPtr)
      }
      const size = Number(readAnnotString(raw, annotPtr, HAND_SIZE_KEY))
      const hex = readAnnotString(raw, annotPtr, HAND_COLOR_KEY)
      return {
        lines: linesRaw.split('\n'),
        fontSize: Number.isFinite(size) && size > 0 ? size : 14,
        color: hex ? hexToRgb(hex) : [0, 0, 0],
        box
      }
    })
  )
}

/** Write the FS_RECTF for a page-space box (PDF space, y-up) */
function setAnnotRect(raw: RawPdfium, annotPtr: number, box: PageRect, pageH: number): void {
  const ptr = raw.pdfium.wasmExports.malloc(16)
  raw.pdfium.setValue(ptr, box.x, 'float')
  raw.pdfium.setValue(ptr + 4, pageH - box.y, 'float')
  raw.pdfium.setValue(ptr + 8, box.x + box.w, 'float')
  raw.pdfium.setValue(ptr + 12, pageH - (box.y + box.h), 'float')
  raw.FPDFAnnot_SetRect(annotPtr, ptr)
  raw.pdfium.wasmExports.free(ptr)
}

/** Create a handwritten note. Returns its PDF object number, like every other
 *  create — the renderer's id contract does not change for this subtype.
 *
 *  The empty Stamp is made through the MODEL api rather than the raw
 *  FPDFPage_CreateAnnot: the raw one leaves the annotation dict inline in
 *  /Annots, where it has no object number at all (measured: 0), and the whole
 *  id contract rests on having one. The model path gives it a real indirect
 *  object; the glyphs are then appended to that. */
async function createHandNote(open: OpenDoc, req: AnnotateRequest): Promise<AnnotateResult> {
  const { engine, doc, docId } = open
  const pageH = doc.pages[req.pageIndex]?.size.height
  const box = req.quads[0]
  if (!pageH || !box) return ENGINE_ERRORS.noPosition
  const lines = req.lines ?? []
  if (lines.length === 0) return ENGINE_ERRORS.handNoteEmpty

  await engine
    .createPageAnnotation(doc, doc.pages[req.pageIndex], {
      id: crypto.randomUUID(),
      pageIndex: req.pageIndex,
      author: req.author ?? '',
      contents: req.contents ?? lines.join('\n'),
      created: new Date(),
      type: PdfAnnotationSubtype.STAMP,
      rect: toRect(box),
      opacity: req.opacity
    } as PdfAnnotationObject)
    .toPromise()
  const objNums = rawObjectNumbers(engine, docId, req.pageIndex)
  const id = objNums[objNums.length - 1]
  if (!id) return ENGINE_ERRORS.noObjectNumber

  const drawn = withDocAndPage(engine, docId, req.pageIndex, (docPtr, pagePtr, raw) => {
    const ok = withAnnotByObjNum(pagePtr, raw, id, (annotPtr) => {
      setAnnotRect(raw, annotPtr, box, pageH)
      if (!drawHandLines(raw, docPtr, annotPtr, lines, box, req.fontSize ?? 14, req.color)) {
        return false
      }
      writeHandState(raw, annotPtr, lines, req.fontSize ?? 14, req.color)
      return true
    })
    if (ok === true) raw.FPDFPage_GenerateContent(pagePtr)
    return ok === true
  })
  if (!drawn) {
    // Never leave a blank stamp behind: an invisible annotation the user
    // cannot see but can still hit is worse than a named failure.
    withPageHandle(engine, docId, req.pageIndex, (pagePtr, raw) =>
      raw.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, id)
    )
    return ENGINE_ERRORS.handNoteFailed
  }
  return { ok: true, id }
}

/** Re-draw an existing handwritten note: strip its objects and lay the lines
 *  down again at the new box. Used for a move, a resize and an edit alike —
 *  all three change where the glyphs go, and re-baking is the only way to
 *  move text that is baked into an appearance. */
function rebakeHandNote(
  open: OpenDoc,
  pageIndex: number,
  id: number,
  lines: string[],
  box: PageRect,
  fontSize: number,
  color: [number, number, number],
  contents: string | undefined
): boolean {
  const { engine, doc, docId } = open
  const pageH = doc.pages[pageIndex]?.size.height
  if (!pageH) return false
  return withDocAndPage(engine, docId, pageIndex, (docPtr, pagePtr, raw) => {
    const ok = withAnnotByObjNum(pagePtr, raw, id, (annotPtr) => {
      for (let i = raw.FPDFAnnot_GetObjectCount(annotPtr) - 1; i >= 0; i--) {
        raw.FPDFAnnot_RemoveObject(annotPtr, i)
      }
      setAnnotRect(raw, annotPtr, box, pageH)
      if (!drawHandLines(raw, docPtr, annotPtr, lines, box, fontSize, color)) return false
      if (contents !== undefined) {
        withWideString(raw, contents, (p) => raw.FPDFAnnot_SetStringValue(annotPtr, 'Contents', p))
      }
      writeHandState(raw, annotPtr, lines, fontSize, color)
      return true
    })
    if (ok === true) raw.FPDFPage_GenerateContent(pagePtr)
    return ok === true
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
    // A handwritten note is a Stamp built object-by-object, not a model the
    // high-level create path knows how to make (see ./hand-note.ts).
    if (req.type === 'handnote') return createHandNote(open, req)
    const spec = buildAnnotation(req)
    if ('error' in spec) return spec
    await engine.createPageAnnotation(doc, doc.pages[req.pageIndex], spec).toPromise()
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

/** Recolour / retext / move an existing annotation, addressed by object number */
export function updateOn(open: OpenDoc, req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  const { engine, doc, docId } = open
  return withLinkApGuard(engine, docId, req.pageIndex, async () => {
    // A handwritten note's glyphs are baked into its appearance, so EVERY
    // change to one — move, resize, recolour, edit — is the same operation:
    // lay the lines down again. It must never reach the generic model update
    // below, which rebuilds the appearance from a model that knows nothing
    // about our text objects and leaves the note blank (measured: the /AP fell
    // from 499 bytes to 42). The state to redraw from is stored on the
    // annotation, so this works even for a note reopened from a file.
    const hand = readHandNote(open, req.pageIndex, req.id)
    if (hand || req.hand) {
      const base = hand ?? {
        lines: req.hand!.lines,
        fontSize: req.hand!.fontSize,
        color: req.hand!.color,
        box: req.hand!.box
      }
      let box = req.hand?.box ?? req.rect ?? req.quads?.[0] ?? base.box
      if (!req.hand && !req.rect && !req.quads && req.translate) {
        box = { ...box, x: box.x + req.translate.dx, y: box.y + req.translate.dy }
      }
      const done = rebakeHandNote(
        open,
        req.pageIndex,
        req.id,
        req.hand?.lines ?? base.lines,
        box,
        req.hand?.fontSize ?? base.fontSize,
        req.hand?.color ?? req.color ?? base.color,
        req.contents
      )
      return done ? { ok: true, id: req.id } : ENGINE_ERRORS.handNoteFailed
    }
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

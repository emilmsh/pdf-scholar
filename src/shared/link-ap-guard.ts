// Link appearance-stream guard, shared by both annotation engines (desktop
// src/main/annotation-engine-embedpdf.ts and browser src/renderer/src/
// annotation-engine-browser.ts).
//
// Why it exists: EmbedPDF's getPageAnnotations makes PDFium synthesize /AP
// appearance streams for Link annotations that define a border but ship
// without one (hyperref's `/Border[0 0 1] /C[0 1 0]` citation boxes — green
// for cites, red for internal refs). Those PDFs render border-free in pdf.js
// precisely BECAUSE the appearance is missing; once a save persists the
// synthesized streams, every viewer paints the boxes forever after. Proven in
// the 2026-07-20 investigation: open+saveAsCopy and createPageAnnotation are
// innocent, getPageAnnotations alone generates /AP for every link on the page.
//
// The guard brackets every engine op on a page: snapshot which links have no
// /AP before, clear exactly those afterwards. Links that legitimately shipped
// with an /AP are never touched, and /Border + /C stay intact so other
// viewers keep their original behavior.

/** The raw FPDF functions the guard needs — a subset of each engine's
 *  raw-pointer bridge (see RawBridge / RawPdfium in the engine files). */
export interface LinkApRaw {
  FPDFPage_GetAnnotCount(pagePtr: number): number
  FPDFPage_GetAnnot(pagePtr: number, index: number): number
  FPDFPage_CloseAnnot(annotPtr: number): void
  FPDFAnnot_GetSubtype(annotPtr: number): number
  FPDFAnnot_HasKey(annotPtr: number, key: string): boolean
  FPDFAnnot_SetAP(annotPtr: number, appearanceMode: number, value: number): boolean
  EPDFAnnot_GetObjectNumber(annotPtr: number): number
}

const FPDF_ANNOT_LINK = 2
const FPDF_ANNOT_APPEARANCEMODE_NORMAL = 0

/** Object numbers of every Link annotation on the page that has NO /AP.
 *  Take this snapshot BEFORE any engine call that loads the page's
 *  annotation models. */
export function snapshotApLessLinks(pagePtr: number, raw: LinkApRaw): Set<number> {
  const out = new Set<number>()
  const count = raw.FPDFPage_GetAnnotCount(pagePtr)
  for (let i = 0; i < count; i++) {
    const annotPtr = raw.FPDFPage_GetAnnot(pagePtr, i)
    if (raw.FPDFAnnot_GetSubtype(annotPtr) === FPDF_ANNOT_LINK && !raw.FPDFAnnot_HasKey(annotPtr, 'AP')) {
      out.add(raw.EPDFAnnot_GetObjectNumber(annotPtr))
    }
    raw.FPDFPage_CloseAnnot(annotPtr)
  }
  return out
}

/** Remove the /AP that PDFium synthesized during the bracketed op from every
 *  link in the snapshot (identified by object number, so index shifts from
 *  create/delete don't matter). Returns how many were stripped. */
export function stripGeneratedLinkAPs(pagePtr: number, raw: LinkApRaw, apLess: Set<number>): number {
  if (apLess.size === 0) return 0
  let stripped = 0
  const count = raw.FPDFPage_GetAnnotCount(pagePtr)
  for (let i = 0; i < count; i++) {
    const annotPtr = raw.FPDFPage_GetAnnot(pagePtr, i)
    if (
      raw.FPDFAnnot_GetSubtype(annotPtr) === FPDF_ANNOT_LINK &&
      apLess.has(raw.EPDFAnnot_GetObjectNumber(annotPtr)) &&
      raw.FPDFAnnot_HasKey(annotPtr, 'AP') &&
      raw.FPDFAnnot_SetAP(annotPtr, FPDF_ANNOT_APPEARANCEMODE_NORMAL, 0)
    ) {
      stripped++
    }
    raw.FPDFPage_CloseAnnot(annotPtr)
  }
  return stripped
}

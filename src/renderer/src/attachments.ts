// The files a document carries, read through pdf.js: the list behind the
// sidebar's «Vedlegg» section and the toolbar's «N vedlegg» chip, and the
// bytes behind «Åpne» / «Lagre». What may be DONE with a file is decided in
// src/shared/attachments.ts; this module only finds them and reads them out.
//
// Two places hold attachments, and both are listed — the way Acrobat's panel
// lists them, with a page for the second kind:
//  • the catalog's /EmbeddedFiles name tree — attached to the document itself
//    (a court filing's exhibits, a portfolio's files, an invoice's XML);
//  • FileAttachment annotations — the paperclip icon on a page.
// A paperclip that is only a PICTURE (an image stamp, which is what the filing
// that prompted this used) carries no file at all; there is nothing to find,
// and nothing here pretends otherwise.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { cleanAttachmentName } from '../../shared/attachments'

/** pdf.js AnnotationType.FILEATTACHMENT, as a literal so this module (and
 *  test:attachments, which runs pdf.js's legacy build in Node) needs no
 *  runtime import of pdf.js. */
const FILE_ATTACHMENT = 17

export interface DocAttachment {
  /** What pdf.js reads the bytes back by: the name-tree key, or the
   *  `attachmentRef:…` id it gives the file behind an annotation */
  id: string
  /** Cleaned (shared/attachments.ts): what is shown and what a saved copy is
   *  called — the two are the same string on purpose, so the name a reader
   *  checked is the name that lands on disk */
  name: string
  description: string
  /** 1-based page of the paperclip; null = attached to the document */
  page: number | null
}

/** The slice of pdf.js's FileAttachment annotation data read here */
interface FileAttachmentData {
  fileId?: string
  file?: { filename?: string; description?: string }
  contentsObj?: { str?: string }
  pageIndex?: number
}

/** Every attachment in the document: the document's own first, in the name
 *  tree's order (which the format keeps sorted), then the paperclips by page.
 *  Empty for the overwhelming majority of documents. `fallbackName` names an
 *  entry whose name cleans down to nothing, in the reader's language. */
export async function collectAttachments(
  doc: PDFDocumentProxy,
  fallbackName: string
): Promise<DocAttachment[]> {
  const out: DocAttachment[] = []
  const named = await doc.getAttachments().catch(() => null)
  for (const [id, a] of named ?? []) {
    out.push({
      id,
      name: cleanAttachmentName(a.filename, fallbackName),
      description: (a.description ?? '').trim(),
      page: null
    })
  }
  // Walks every page's annotation list in the worker, but only the FIRST walk
  // costs anything: the viewer has just read every page's annotations for its
  // own overlay (collectAnnotations), and pdf.js keeps them parsed per page.
  const onPages = ((await doc
    .getAnnotationsByType(new Set([FILE_ATTACHMENT]), new Set())
    .catch(() => null)) ?? []) as FileAttachmentData[]
  const pinned: DocAttachment[] = []
  for (const a of onPages) {
    if (!a.fileId) continue // no embedded stream — a reference to a file elsewhere
    pinned.push({
      id: a.fileId,
      name: cleanAttachmentName(a.file?.filename ?? '', fallbackName),
      // Acrobat writes the comment into the annotation's /Contents and leaves
      // the file spec's /Desc empty — either can be the description
      description: (a.file?.description || a.contentsObj?.str || '').trim(),
      page: (a.pageIndex ?? 0) + 1
    })
  }
  // The worker resolves pages in parallel, so the order it answers in is not
  // page order. Stable sort keeps a page's own order.
  pinned.sort((x, y) => (x.page ?? 0) - (y.page ?? 0))
  return [...out, ...pinned]
}

/** The attachment's bytes, or null when the entry holds none.
 *
 *  `doc` is whichever pdf.js document is showing NOW — every annotation write
 *  re-opens the file, so the one the list was read from may be gone. A name-
 *  tree id means the same thing in any of them. An annotation's id is only
 *  known to a worker once that page's annotations are parsed, so that one page
 *  is parsed first (cheap, and a no-op when the viewer already did). */
export async function readAttachment(
  doc: PDFDocumentProxy,
  att: DocAttachment
): Promise<Uint8Array | null> {
  try {
    if (att.page !== null) await (await doc.getPage(att.page)).getAnnotations()
    const data = await doc.getAttachmentContent(att.id)
    return data && data.length > 0 ? data : null
  } catch {
    return null
  }
}

/** True when the document asks to be opened on its attachments (/PageMode
 *  /UseAttachments — Acrobat's «Vedlegg-panel og side» initial view). A
 *  document that sets it is saying its attachments are the content. */
export async function opensOnAttachments(doc: PDFDocumentProxy): Promise<boolean> {
  try {
    return (await doc.getPageMode()) === 'UseAttachments'
  } catch {
    return false
  }
}

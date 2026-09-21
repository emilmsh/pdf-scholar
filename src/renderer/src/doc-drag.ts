// The document dragged OUT of the browser shell as a file.
//
// The desktop drags a tab as a file (PLATFORMS.md §22: a native OS drag with the
// document's path, so Explorer copies it and an upload field takes it). The
// extension has no tab strip — each document IS a browser tab — so the sidebar's
// document row stands in for the tab. A web page cannot start an OS file drag,
// but Chromium reads one non-standard drag type, `DownloadURL`, and turns the
// drop into a file wherever a file can land: the desktop, a folder, another
// program's upload field. The payload is `mime:filename:url`; the URL is a
// `blob:` of the bytes we hold, so the same gesture works for a PDF opened from
// the web, from file:// and from the picker, online or not.
//
// What travels is the document as LAST SAVED (or as loaded, before any save) —
// the same as the desktop, where Explorer gets the file on disk and an unsaved
// draft stays behind. The blob must exist before the drag starts: dragstart is
// synchronous and the browser engine's serialisation is not, so the live
// document (with unsaved marks) cannot ride along.
//
// The same private MIME as the tab strip's is set too, so a pages column that
// accepts tabs reads this as «open this document beside mine», and another PDF
// Scholar tab in the same browser opens the document on drop (ExtensionApp).
// No text/plain: this drag ends over other programs, and the path pasted into
// a text field there was half of the double effect the desktop drag had.
import { TAB_DRAG_MIME } from './drag-types'

/** Chromium's drag type that makes a drop outside the page produce a file. */
export const DOWNLOAD_URL_TYPE = 'DownloadURL'

/** The subset of DataTransfer the payload needs — so a Node test can hand in a
 *  plain object. */
export interface DragDataSink {
  effectAllowed: string
  setData(type: string, value: string): void
}

/** The file name a drop will produce. The `DownloadURL` payload is
 *  colon-separated, so a colon in the name would split it; a path separator
 *  would try to leave the drop folder. Neither belongs in a file name, and a
 *  name that ends up empty gets a plain one. Whatever survives reads as a PDF. */
export function documentDragName(name: string): string {
  const clean = name.replace(/[:/\\]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return 'document.pdf'
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`
}

/** Fill a dragstart's DataTransfer for the open document. `url` is what the
 *  drop target will fetch — a blob: URL of the document's bytes. */
export function setDocumentDragData(dt: DragDataSink, doc: { path: string; name: string; url: string }): void {
  // A copy, never a move: the source keeps its document whatever takes the drop.
  dt.effectAllowed = 'copy'
  dt.setData(DOWNLOAD_URL_TYPE, `application/pdf:${documentDragName(doc.name)}:${doc.url}`)
  dt.setData(TAB_DRAG_MIME, doc.path)
}

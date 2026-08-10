// Opening a document in pdf.js, shared by the viewer and the detached
// assistant window (which loads the SAME bytes to extract text and render
// page images, but never mounts a page). Extracted from PdfViewer.tsx
// verbatim — behaviour notes travel with the code.
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import PdfWorkerCtor from 'pdfjs-dist/build/pdf.worker.mjs?worker'

// One worker per open document (not a shared global port) so the document can
// be re-opened after the annotation engine rewrites the file on disk.
export interface DocResources {
  task: PDFDocumentLoadingTask
  port: Worker
}

// pdf.js side-loads binary companions from URLs: wasm image decoders (scanned
// pages are JBIG2/JPX — without wasmUrl they render BLANK), CJK CMaps, the 14
// standard fonts and a CMYK ICC profile. config/vite.pdfjs-assets.ts ships the dirs
// next to index.html in every target, so resolving against the page URL works
// under http (dev), file:// (packaged app) and chrome-extension:// (extension)
// — pdf.js falls back to XHR for the non-http schemes.
const pdfjsAssetUrl = (dir: string): string => new URL(`${dir}/`, document.baseURI).href

export function openDocument(data: Uint8Array, password?: string): DocResources {
  const port = new PdfWorkerCtor()
  const task = getDocument({
    data,
    // Only sent when we actually hold one. A document with an owner password but
    // no user password opens freely, and offering pdf.js a password it did not
    // ask for makes it reject the file as "Incorrect Password".
    ...(password === undefined ? {} : { password }),
    worker: PDFWorker.create({ port }),
    wasmUrl: pdfjsAssetUrl('wasm'),
    cMapUrl: pdfjsAssetUrl('cmaps'),
    standardFontDataUrl: pdfjsAssetUrl('standard_fonts'),
    iccUrl: pdfjsAssetUrl('iccs')
  })
  return { task, port }
}

/** pdf.js signals both "locked" and "wrong password" as PasswordException,
 *  separated by `code` (1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD). Neither is
 *  a broken file, so neither may take the re-read-and-retry path meant for
 *  half-written ones — the bytes are whole, they are just encrypted. */
export function isPasswordException(err: unknown): boolean {
  return (err as { name?: string } | null | undefined)?.name === 'PasswordException'
}

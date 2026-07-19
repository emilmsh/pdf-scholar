// PDFium raster spike — renders page bitmaps through the EmbedPDF engine we
// already ship for annotation WRITING, instead of pdf.js. Behind a flag while
// we evaluate a full renderer migration (motivation: PDFium draws small text
// with near-black cores where pdf.js renders it grey, so highlights stay crisp
// — measured on the attention.pdf test doc, 2026-07-19).
//
// Enable with `?pdfium=1` in the URL (dev:web) or
// `localStorage.setItem('pdfx-pdfium-render', '1')` + reload (Electron).
//
// Scope of the spike: ONLY the canvas raster swaps engine. pdf.js still owns
// the text layer, links, search, outline and page metadata — so this module is
// a pure bitmap source, keyed by the same document path the annotation engines
// use. PDFium runs in a Web Worker (createPdfiumEngine spawns it from an
// inline blob — bundler-agnostic, and rasterising never blocks the UI thread,
// matching pdf.js's worker model).
import type { PdfDocumentObject, PdfTask, Rotation } from '@embedpdf/models'
import { PdfErrorCode } from '@embedpdf/models'
import type { ImageDataLike } from '@embedpdf/models'
import type { ViewRotation } from '../../shared/types'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

/** Read once at module load — flipping the flag requires a reload anyway,
 *  and a constant lets PdfPage branch without re-checking per render. */
export const PDFIUM_RENDER = (() => {
  try {
    return (
      new URLSearchParams(window.location.search).get('pdfium') === '1' ||
      window.localStorage.getItem('pdfx-pdfium-render') === '1'
    )
  } catch {
    return false
  }
})()

type Engine = ReturnType<typeof import('@embedpdf/engines/pdfium-worker-engine').createPdfiumEngine>

// Dynamic import so the worker-engine bundle (it inlines its whole worker as a
// string) never reaches users with the flag off — the flag guard in
// registerPdfiumDoc means this only ever runs on the spike path.
let enginePromise: Promise<Engine> | null = null

function getEngine(): Promise<Engine> {
  return (enginePromise ??= import('@embedpdf/engines/pdfium-worker-engine').then(
    ({ createPdfiumEngine }) =>
      // The worker fetches the wasm itself, so the URL must be absolute — a
      // relative one would resolve against the worker's blob: origin and 404.
      createPdfiumEngine(new URL(wasmUrl, document.baseURI).href)
  ))
}

interface Entry {
  bytes: Uint8Array
  open: Promise<PdfDocumentObject> | null
}

const docs = new Map<string, Entry>()

/** Make `path`'s bytes available as a PDFium raster source (viewer mount, and
 *  again on reload with fresh bytes so baked annotation edits show up). The
 *  engine document opens lazily on the first render. No-op when the flag is
 *  off, so callers don't need to guard. */
export function registerPdfiumDoc(path: string, bytes: Uint8Array): void {
  if (!PDFIUM_RENDER) return
  void releasePdfiumDoc(path) // re-registration (reload) must close the old doc
  docs.set(path, { bytes, open: null })
}

/** Close the engine document and drop the bytes (viewer unmount / tab close). */
export async function releasePdfiumDoc(path: string): Promise<void> {
  const entry = docs.get(path)
  docs.delete(path)
  if (entry?.open) {
    try {
      const doc = await entry.open
      await (await getEngine()).closeDocument(doc).toPromise()
    } catch {
      /* already dead — nothing to release */
    }
  }
}

function openEntry(entry: Entry): NonNullable<Entry['open']> {
  return (entry.open ??= (async () => {
    const copy = entry.bytes.slice()
    return (await getEngine())
      .openDocumentBuffer({
        id: crypto.randomUUID(),
        content: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
      })
      .toPromise()
  })())
}

export interface PdfiumRenderHandle {
  /** Resolves to the rendered bitmap, or null when cancelled/unregistered. */
  promise: Promise<ImageData | null>
  cancel(): void
}

/**
 * Render one page to an ImageData at `scale × dpr` device pixels.
 *
 * Rotation: PDFium applies the page's intrinsic /Rotate itself (page sizes it
 * reports are already post-/Rotate), so only the USER rotation is passed —
 * unlike pdf.js where the viewport takes `page.rotate + rotation`.
 */
export function renderPdfiumPage(
  path: string,
  pageIndex: number,
  opts: { scale: number; dpr: number; rotation: ViewRotation; withAnnotations: boolean }
): PdfiumRenderHandle {
  let cancelled = false
  let task: PdfTask<ImageDataLike> | null = null
  const promise = (async (): Promise<ImageData | null> => {
    const entry = docs.get(path)
    if (!entry) return null
    const doc = await openEntry(entry)
    if (cancelled) return null
    task = (await getEngine()).renderPageRaw(doc, doc.pages[pageIndex], {
      scaleFactor: opts.scale,
      dpr: opts.dpr,
      rotation: (opts.rotation / 90) as Rotation,
      withAnnotations: opts.withAnnotations
    })
    const img = await task.toPromise()
    if (cancelled) return null
    return new ImageData(img.data, img.width, img.height)
  })().catch((err: unknown) => {
    if (cancelled) return null // aborts surface as rejections — swallow our own
    throw err
  })
  return {
    promise,
    cancel: () => {
      cancelled = true
      try {
        task?.abort({ code: PdfErrorCode.Cancelled, message: 'render cancelled' })
      } catch {
        /* already settled */
      }
    }
  }
}

// Text for scanned pages: a page whose PDF carries no text is rendered and
// read by Tesseract on this machine, and its words stand in for the text the
// page lacks — in the text layer (select, copy, highlight), in search and in
// what the assistant reads. Nothing leaves the machine and nothing is written
// into the file: the words live as long as the document is open (Chrome's
// way, not Acrobat's — Emil, 2026-10-23).
//
// One engine per window, in its own worker (ocr.worker.ts), reading one page
// at a time; the pages a reader is looking at go before a whole-document pass
// for search or the assistant. The engine is shut down after a minute without
// work — its language models hold well over 100 MB.
//
// The words are kept per document and carried across the swap every write
// makes (carryOcr) — a highlight on a scanned page must not cost the page its
// text for the seconds a re-read takes. A disk reload opens a new viewer and
// starts afresh, which is right: the pages may be other pages now.
import { useSyncExternalStore } from 'react'
import { AnnotationMode } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import OcrWorker from './ocr.worker?worker'
import type { OcrReply, OcrRequest } from './ocr.worker'
import wasmUrl from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm?url'
import engUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url'
import norUrl from '@tesseract.js-data/nor/4.0.0_best_int/nor.traineddata.gz?url'
import chiSimUrl from '@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz?url'
import { getLanguage } from './i18n'
import { ocrLanguages, ocrScale, parseTsv, toTextContent } from './ocr-text'
import { setTextFallback } from './search'

const MODEL_URLS: Record<string, string> = { eng: engUrl, nor: norUrl, chi_sim: chiSimUrl }

/** How a request ranks in the queue: the pages on screen first, then a
 *  whole-document pass (search, the assistant). */
export const OCR_PRIORITY = { visible: 2, document: 1 } as const

const IDLE_MS = 60_000

// ---------- Engine ----------

interface Engine {
  worker: Worker
  langs: string
  ready: Promise<boolean>
}

let engine: Engine | null = null
/** The engine failed to start once (no wasm, a missing model): every page
 *  then simply has no text, as before, rather than retrying per page. */
let unavailable = false
let idleTimer = 0
let nextJobId = 1
const waiting = new Map<number, { resolve(tsv: string): void; reject(err: Error): void }>()

/** A packaged asset as bytes. XHR, not fetch: the desktop app runs from
 *  file://, which fetch refuses and XHR reads (pdf.js does the same). */
function loadBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => {
      // file:// answers 0 on success
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response) resolve(xhr.response as ArrayBuffer)
      else reject(new Error(`${url}: HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error(`${url}: not readable`))
    xhr.send()
  })
}

function stopEngine(): void {
  window.clearTimeout(idleTimer)
  engine?.worker.terminate()
  engine = null
  for (const w of waiting.values()) w.reject(new Error('OCR engine stopped'))
  waiting.clear()
}

function startEngine(langs: string[]): Engine {
  const worker = new OcrWorker()
  const send = (msg: OcrRequest, transfer: Transferable[] = []): void => worker.postMessage(msg, transfer)
  const ready = new Promise<boolean>((resolve) => {
    worker.addEventListener('message', (e: MessageEvent<OcrReply>) => {
      const msg = e.data
      if (msg.type === 'ready') resolve(true)
      else if (msg.type === 'failed') {
        console.warn('[pdfx] OCR unavailable:', msg.message)
        resolve(false)
      } else {
        const w = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.type === 'result') w?.resolve(msg.tsv)
        else w?.reject(new Error(msg.message))
      }
    })
    worker.addEventListener('error', (e) => {
      console.warn('[pdfx] OCR worker error:', e.message)
      resolve(false)
      for (const w of waiting.values()) w.reject(new Error(e.message))
      waiting.clear()
    })
    Promise.all([loadBytes(wasmUrl), ...langs.map((code) => loadBytes(MODEL_URLS[code]))]).then(
      ([wasm, ...models]) =>
        send({ type: 'init', wasm, langs: models.map((data, i) => ({ code: langs[i], data })) }, [wasm, ...models]),
      (err: unknown) => {
        console.warn('[pdfx] OCR assets missing:', err)
        resolve(false)
      }
    )
  })
  return { worker, langs: langs.join('+'), ready }
}

/** The running engine for the interface language, started on first use. A
 *  language switch takes effect between pages. */
async function readyEngine(): Promise<Engine | null> {
  if (unavailable) return null
  const langs = ocrLanguages(getLanguage())
  if (engine && engine.langs !== langs.join('+')) stopEngine()
  engine ??= startEngine(langs)
  const current = engine
  if (await current.ready) return current
  unavailable = true
  if (engine === current) stopEngine()
  return null
}

async function recognize(rgba: ArrayBuffer, width: number, height: number, dpi: number): Promise<string | null> {
  const current = await readyEngine()
  if (!current) return null
  const id = nextJobId++
  return new Promise<string>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    current.worker.postMessage({ type: 'recognize', id, width, height, rgba, dpi } satisfies OcrRequest, [rgba])
  })
}

/** The page drawn for reading: at OCR_DPI, white paper, WITHOUT annotations —
 *  a reader's highlight is not part of the page's words, and a sticky note's
 *  icon would read as a letter.
 *
 *  With the print intent: a display render paces itself on
 *  requestAnimationFrame, which stops in a minimised window or a background
 *  tab — and a long book's reading would stop with it, holding every page
 *  behind it. Print runs straight through. (It also draws what a page shows
 *  in print rather than on screen, which for a scan is the same picture.) */
async function renderForOcr(page: PDFPageProxy): Promise<{
  rgba: ArrayBuffer
  width: number
  height: number
  dpi: number
  toPdf(x: number, y: number): number[]
}> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: ocrScale(base.width, base.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  try {
    await page.render({
      canvas,
      viewport,
      intent: 'print',
      annotationMode: AnnotationMode.DISABLE,
      background: '#ffffff'
    }).promise
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return {
      rgba: image.data.buffer as ArrayBuffer,
      width: image.width,
      height: image.height,
      dpi: Math.round(72 * viewport.scale),
      toPdf: (x, y) => viewport.convertToPdfPoint(x, y)
    }
  } finally {
    // Let go of the backing store now, not at the next collection
    canvas.width = canvas.height = 0
  }
}

// ---------- Queue ----------

interface OcrDoc {
  /** The pdf.js document pages are read from — swapped by carryOcr */
  pdf: PDFDocumentProxy
  jobs: Map<number, PageJob>
  /** Pages asked for and pages finished since the queue last ran dry */
  total: number
  done: number
  listeners: Set<() => void>
  snapshot: OcrProgress | null
}

interface PageJob {
  doc: OcrDoc
  pageNumber: number
  priority: number
  /** Callers still waiting with a way to give up (a page scrolled away, a
   *  search closed); a job nobody waits for anymore leaves the queue */
  interest: number
  state: 'queued' | 'running' | 'done'
  promise: Promise<TextContent | null>
  settle(content: TextContent | null): void
}

export interface OcrProgress {
  done: number
  total: number
}

const docs = new WeakMap<PDFDocumentProxy, OcrDoc>()
const queue: PageJob[] = []
let running: PageJob | null = null

function docFor(pdf: PDFDocumentProxy): OcrDoc {
  let doc = docs.get(pdf)
  if (!doc) {
    doc = { pdf, jobs: new Map(), total: 0, done: 0, listeners: new Set(), snapshot: null }
    docs.set(pdf, doc)
  }
  return doc
}

function notify(doc: OcrDoc): void {
  if (doc.done >= doc.total) {
    doc.done = doc.total = 0
  }
  doc.snapshot = doc.total > 0 ? { done: doc.done, total: doc.total } : null
  for (const cb of doc.listeners) cb()
}

function pump(): void {
  if (running) return
  if (queue.length === 0) {
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(stopEngine, IDLE_MS)
    return
  }
  window.clearTimeout(idleTimer)
  let best = 0
  for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[best].priority) best = i
  const job = queue.splice(best, 1)[0]
  running = job
  job.state = 'running'
  void readPage(job).then((content) => {
    running = null
    job.state = 'done'
    job.settle(content)
    job.doc.done++
    notify(job.doc)
    pump()
  })
}

async function readPage(job: PageJob): Promise<TextContent | null> {
  // Twice at most: a write elsewhere can swap (and destroy) the document
  // under a page being read; the second try reads the new one
  for (let attempt = 0; attempt < 2; attempt++) {
    const pdf = job.doc.pdf
    try {
      const page = await pdf.getPage(job.pageNumber)
      const raster = await renderForOcr(page)
      const tsv = await recognize(raster.rgba, raster.width, raster.height, raster.dpi)
      if (tsv === null) return null
      return toTextContent(parseTsv(tsv), raster.toPdf)
    } catch (err) {
      if (job.doc.pdf !== pdf) continue
      console.warn(`[pdfx] OCR failed on page ${job.pageNumber}:`, err)
      return null
    }
  }
  return null
}

/**
 * The recognised text of a page whose PDF has none, or null when it cannot be
 * had (the engine would not start, the page would not render). Asking twice
 * reads the page once. A caller with a `signal` may give up: a page nobody is
 * waiting for any more leaves the queue before it is read.
 */
export function ocrTextContent(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  opts: { priority?: number; signal?: AbortSignal } = {}
): Promise<TextContent | null> {
  const { priority = OCR_PRIORITY.document, signal } = opts
  if (signal?.aborted) return Promise.reject(new DOMException('OCR request aborted', 'AbortError'))
  const doc = docFor(pdf)
  let job = doc.jobs.get(pageNumber)
  if (!job) {
    let settle!: (content: TextContent | null) => void
    const promise = new Promise<TextContent | null>((resolve) => (settle = resolve))
    job = { doc, pageNumber, priority, interest: 0, state: 'queued', promise, settle }
    doc.jobs.set(pageNumber, job)
    queue.push(job)
    doc.total++
    notify(doc)
  }
  const current = job
  if (current.state === 'queued') current.priority = Math.max(current.priority, priority)
  pump()
  if (current.state === 'done') return current.promise
  // A caller without a signal holds its interest for good: the job is never
  // dropped from under it
  current.interest++
  if (!signal) return current.promise
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      current.interest--
      if (current.interest === 0 && current.state === 'queued') {
        const at = queue.indexOf(current)
        if (at >= 0) queue.splice(at, 1)
        current.doc.jobs.delete(pageNumber)
        current.doc.total--
        notify(current.doc)
      }
      reject(new DOMException('OCR request aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    current.promise.then((content) => {
      signal.removeEventListener('abort', onAbort)
      resolve(content)
    })
  })
}

/** Keep a document's recognised pages when the viewer swaps in a re-read of
 *  the same file (after one of its own writes) — the pages are the same
 *  pictures; only the annotations changed. */
export function carryOcr(from: PDFDocumentProxy | null, to: PDFDocumentProxy): void {
  const doc = from && docs.get(from)
  if (!doc || from === to) return
  doc.pdf = to
  docs.set(to, doc)
}

/** How far the pages asked for have come, or null while nothing is waiting */
export function useOcrProgress(pdf: PDFDocumentProxy | null): OcrProgress | null {
  return useSyncExternalStore(
    (cb) => {
      if (!pdf) return () => {}
      const doc = docFor(pdf)
      doc.listeners.add(cb)
      return () => doc.listeners.delete(cb)
    },
    () => (pdf ? (docs.get(pdf)?.snapshot ?? null) : null)
  )
}

/** Hand search.ts the OCR fallback for pages without text. Called once at
 *  startup by EVERY entry point — main.tsx (desktop, dev:web) and
 *  extension-main.tsx — or search and the assistant read a scan as empty
 *  while its text layer, which asks ocrTextContent directly, looks fine.
 *  search.ts stays free of the engine so its tests run in plain Node. */
export function installOcr(): void {
  setTextFallback(ocrTextContent)
}

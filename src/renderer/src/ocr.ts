// Text where the PDF has none: a page that is only a picture (a scan) is
// rendered and read by Tesseract on this machine, and so are the images on a
// page that has text of its own (a figure, a screenshot, a table pasted in as
// a picture — ocr-image.ts). The words stand in for the text the PDF lacks —
// in the text layer (select, copy, highlight), in search and in what the
// assistant reads. Nothing leaves the machine and nothing is written into the
// file (Chrome's way, not Acrobat's — Emil, 2026-10-23).
//
// Up to two engines per window, each in its own worker (ocr.worker.ts),
// reading a page at a time: two read a document twice as fast, and on the
// machine it was measured on a third added 5 % (test bench, 2026-10-23). The
// second starts only when a second page is waiting, so a page on screen costs
// one engine. The pages a reader is looking at go before a whole-document
// pass for search. Engines stop after a minute without work — each holds its
// language models, well over 100 MB.
//
// What may wait and what may not (Emil, 2026-10-23: no slowness): a scanned
// page has no text without OCR, so whoever needs its text waits for it. The
// words in images are extra — only search waits for them, and it shows what
// it has found meanwhile; the assistant, the export and the markup take the
// images' words that are already read and never start a reading of their own.
// An image's pixels are the ones pdf.js decoded to draw the page: nothing is
// drawn again on the main thread for them.
//
// Automatic or on request (settings.ocrAuto): with it off, nothing is read
// until the reader asks for THIS document (enableOcr) — the toolbar, the
// search bar and the assistant offer it as soon as a page with no text is
// seen (an image on a page of text is no reason to offer it). A document read
// before needs no asking.
//
// What was read is kept: per pdf.js document for the session — carried across
// the swap every write makes (carryOcr), so a highlight does not cost a page
// its words — and between sessions in ocr-store.ts, unless the document is
// password-protected (allowOcrStore is the opt-in).
import { useSyncExternalStore } from 'react'
import { AnnotationMode, OPS } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import OcrWorker from './ocr.worker?worker'
import type { OcrReply, OcrRequest } from './ocr.worker'
import wasmUrl from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm?url'
import engUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url'
import norUrl from '@tesseract.js-data/nor/4.0.0_best_int/nor.traineddata.gz?url'
import chiSimUrl from '@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz?url'
import { getLanguage } from './i18n'
import { hasVisibleText, ocrLanguages, ocrScale, parseTsv, toTextContent } from './ocr-text'
import type { OcrParagraph } from './ocr-text'
import { imageCandidates, imageTextContent, imageUpscale, imageWords, mergeImageText, regionToPdf } from './ocr-image'
import type { ImageCandidate, ImageRegionText, PixelFormat } from './ocr-image'
import { pageImageRects } from './image-regions'
import type { OpsTable } from './image-regions'
import { loadOcrPages, ocrDocKey, saveOcrPage, storedPageMatches } from './ocr-store'
import type { StoredOcrPage } from './ocr-store'
import { setTextFallback } from './search'
import type { TextFallback } from './search'

const MODEL_URLS: Record<string, string> = { eng: engUrl, nor: norUrl, chi_sim: chiSimUrl }

/** How a request ranks in the queue: the pages on screen first, then a
 *  whole-document pass (search, the assistant). */
export const OCR_PRIORITY = { visible: 2, document: 1 } as const

const IDLE_MS = 60_000

/** Engines at most: two, on a machine with the cores for it */
const MAX_ENGINES = (navigator.hardwareConcurrency ?? 2) >= 4 ? 2 : 1

// ---------- Engines ----------

interface Engine {
  worker: Worker
  langs: string
  ready: Promise<boolean>
  busy: boolean
  waiting: Map<number, { resolve(tsv: string): void; reject(err: Error): void }>
}

let engines: Engine[] = []
/** An engine failed to start once (no wasm, a missing model): every page then
 *  simply has no text, as before, rather than retrying per page. */
let unavailable = false
let idleTimer = 0
let nextJobId = 1
/** The wasm and models, fetched once for every engine that starts */
let assets: { langs: string; bytes: Promise<ArrayBuffer[]> } | null = null

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

function stopEngine(engine: Engine): void {
  engine.worker.terminate()
  for (const w of engine.waiting.values()) w.reject(new Error('OCR engine stopped'))
  engine.waiting.clear()
  engines = engines.filter((e) => e !== engine)
}

function stopEngines(): void {
  window.clearTimeout(idleTimer)
  for (const e of [...engines]) stopEngine(e)
  assets = null
}

function startEngine(langs: string[]): Engine {
  const key = langs.join('+')
  if (assets?.langs !== key) {
    assets = { langs: key, bytes: Promise.all([loadBytes(wasmUrl), ...langs.map((code) => loadBytes(MODEL_URLS[code]))]) }
  }
  const bytes = assets.bytes
  const worker = new OcrWorker()
  const engine: Engine = { worker, langs: key, ready: Promise.resolve(false), busy: false, waiting: new Map() }
  engine.ready = new Promise<boolean>((resolve) => {
    worker.addEventListener('message', (e: MessageEvent<OcrReply>) => {
      const msg = e.data
      if (msg.type === 'ready') resolve(true)
      else if (msg.type === 'failed') {
        console.warn('[pdfx] OCR unavailable:', msg.message)
        resolve(false)
      } else {
        const w = engine.waiting.get(msg.id)
        engine.waiting.delete(msg.id)
        if (msg.type === 'result') w?.resolve(msg.tsv)
        else w?.reject(new Error(msg.message))
      }
    })
    worker.addEventListener('error', (e) => {
      console.warn('[pdfx] OCR worker error:', e.message)
      resolve(false)
      for (const w of engine.waiting.values()) w.reject(new Error(e.message))
      engine.waiting.clear()
    })
    bytes.then(
      ([wasm, ...models]) => {
        // Copies: each engine's worker takes its own, and the next one to
        // start needs the originals
        const msg: OcrRequest = {
          type: 'init',
          wasm: wasm.slice(0),
          langs: models.map((data, i) => ({ code: langs[i], data: data.slice(0) }))
        }
        worker.postMessage(msg, [msg.wasm, ...msg.langs.map((l) => l.data)])
      },
      (err: unknown) => {
        console.warn('[pdfx] OCR assets missing:', err)
        resolve(false)
      }
    )
  })
  engines.push(engine)
  return engine
}

/** A free engine for the interface language, starting one when every engine
 *  is busy and there is room for another; null when the pages must wait. An
 *  idle engine on another language set goes — a language switch takes effect
 *  between pages. */
function freeEngine(): Engine | null {
  const langs = ocrLanguages(getLanguage())
  const key = langs.join('+')
  for (const e of [...engines]) if (!e.busy && e.langs !== key) stopEngine(e)
  const idle = engines.find((e) => !e.busy && e.langs === key)
  if (idle) return idle
  return engines.length < MAX_ENGINES ? startEngine(langs) : null
}

interface Pixels {
  format: PixelFormat
  data: ArrayBuffer
  width: number
  height: number
  upscale: number
  dpi: number
}

async function recognize(engine: Engine, px: Pixels): Promise<string | null> {
  if (!(await engine.ready)) {
    unavailable = true
    stopEngine(engine)
    return null
  }
  const id = nextJobId++
  return new Promise<string>((resolve, reject) => {
    engine.waiting.set(id, { resolve, reject })
    engine.worker.postMessage({ type: 'recognize', id, ...px } satisfies OcrRequest, [px.data])
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
async function renderForOcr(page: PDFPageProxy): Promise<Pixels & { scale: number }> {
  const base = page.getViewport({ scale: 1 })
  const scale = ocrScale(base.width, base.height)
  const viewport = page.getViewport({ scale })
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
      format: 'rgba',
      data: image.data.buffer as ArrayBuffer,
      width: image.width,
      height: image.height,
      upscale: 1,
      dpi: Math.round(72 * scale),
      scale
    }
  } finally {
    // Let go of the backing store now, not at the next collection
    canvas.width = canvas.height = 0
  }
}

/** Recognised paragraphs → text content, through the viewport the raster was
 *  drawn in (the page's own rotation at `scale`) */
function contentOf(page: PDFPageProxy, paragraphs: OcrParagraph[], scale: number): TextContent {
  const viewport = page.getViewport({ scale })
  return toTextContent(paragraphs, (x, y) => viewport.convertToPdfPoint(x, y))
}

// ---------- Image pixels, as pdf.js decoded them ----------

interface DecodedImage {
  width: number
  height: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
  bitmap?: ImageBitmap
}

interface PdfObjects {
  get(id: string, callback: (data: unknown) => void): void
}

/** An image XObject's decoded data, from the page's objects (or the
 *  document's, for an image shared across pages). They arrive with the
 *  page's operator list, which drawing the page has already fetched. */
function objectData(page: PDFPageProxy, objId: string): Promise<DecodedImage | null> {
  const holder = page as unknown as { objs: PdfObjects; commonObjs: PdfObjects }
  const objs = objId.startsWith('g_') ? holder.commonObjs : holder.objs
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 5000)
    try {
      objs.get(objId, (data) => {
        window.clearTimeout(timer)
        resolve((data as DecodedImage | null) ?? null)
      })
    } catch {
      window.clearTimeout(timer)
      resolve(null)
    }
  })
}

/** An image's pixels, copied off pdf.js's (which it keeps for drawing) and in
 *  a form the worker turns into grey. A bitmap is the one case drawn here —
 *  one drawImage of the picture itself, never the page. */
async function imagePixels(page: PDFPageProxy, c: ImageCandidate): Promise<Pixels | null> {
  const img = (c.src.inline as DecodedImage | undefined) ?? (c.src.objId ? await objectData(page, c.src.objId) : null)
  if (!img || !img.width || !img.height) return null
  const upscale = imageUpscale(c)
  const dpi = c.px.w / ((c.x1 - c.x0) / 72)
  if (img.bitmap) {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, img.width, img.height)
      ctx.drawImage(img.bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, img.width, img.height).data
      return { format: 'rgba', data: data.buffer as ArrayBuffer, width: img.width, height: img.height, upscale, dpi }
    } finally {
      canvas.width = canvas.height = 0
    }
  }
  const format: PixelFormat | null = img.kind === 1 ? 'bw1' : img.kind === 2 ? 'rgb' : img.kind === 3 ? 'rgba' : null
  if (!format || !img.data) return null
  return { format, data: new Uint8Array(img.data).buffer, width: img.width, height: img.height, upscale, dpi }
}

// ---------- Documents and the queue ----------

type JobKind = 'page' | 'images'

interface OcrDoc {
  /** The pdf.js document pages are read from — swapped by carryOcr */
  pdf: PDFDocumentProxy
  /** Whole scanned pages, and the images of pages with text, by page number */
  jobs: Map<number, PageJob>
  imageJobs: Map<number, PageJob>
  /** Jobs queued and finished since the queue last ran dry — all of them, and
   *  the scanned pages alone (what the assistant waits for) */
  total: number
  done: number
  pageTotal: number
  pageDone: number
  listeners: Set<() => void>
  progress: OcrProgress | null
  pageProgress: OcrProgress | null
  /** The reader asked for this document (or it was read before) — what lets
   *  OCR run with the automatic setting off */
  enabled: boolean
  /** A page with no text of its own has been seen */
  textless: boolean
  /** May what is read be kept between sessions (not for a locked document) */
  persist: boolean
  /** The records kept from an earlier session, per store key (the key follows
   *  the interface language, which decides the models) */
  stored: { key: string; pages: Promise<StoredRecords> } | null
}

interface StoredRecords {
  pages: Map<number, StoredOcrPage>
  images: Map<number, StoredOcrPage>
}

interface PageJob {
  doc: OcrDoc
  kind: JobKind
  pageNumber: number
  priority: number
  /** Callers still waiting with a way to give up (a page scrolled away, a
   *  search closed); a job nobody waits for anymore leaves the queue */
  interest: number
  state: 'checking' | 'queued' | 'running' | 'done'
  /** An images job: what to read, and the page text its words must not repeat */
  candidates?: ImageCandidate[]
  own?: TextContent
  promise: Promise<TextContent | null>
  settle(content: TextContent | null): void
}

export interface OcrProgress {
  done: number
  total: number
}

const docs = new WeakMap<PDFDocumentProxy, OcrDoc>()
const persistable = new WeakSet<PDFDocumentProxy>()
const queue: PageJob[] = []
let running = 0

let autoMode = true
const modeListeners = new Set<() => void>()

/** settings.ocrAuto: read scanned pages and images as they are met, or only
 *  on request */
export function setOcrAuto(on: boolean): void {
  if (autoMode === on) return
  autoMode = on
  for (const cb of modeListeners) cb()
}

/** May this document's OCR be kept between sessions. Called by whoever opens
 *  it, before any page is read — and never for a password-protected one. */
export function allowOcrStore(pdf: PDFDocumentProxy): void {
  persistable.add(pdf)
}

const allowed = (doc: OcrDoc): boolean => autoMode || doc.enabled

function docFor(pdf: PDFDocumentProxy): OcrDoc {
  let doc = docs.get(pdf)
  if (!doc) {
    doc = {
      pdf,
      jobs: new Map(),
      imageJobs: new Map(),
      total: 0,
      done: 0,
      pageTotal: 0,
      pageDone: 0,
      listeners: new Set(),
      progress: null,
      pageProgress: null,
      enabled: false,
      textless: false,
      persist: persistable.has(pdf),
      stored: null
    }
    docs.set(pdf, doc)
    // A document whose scanned pages were read before is enabled without asking
    const d = doc
    void storedRecords(d).then((records) => {
      if (records.pages.size > 0 && !d.enabled) {
        d.enabled = true
        notify(d)
      }
    })
  }
  return doc
}

function storedRecords(doc: OcrDoc): Promise<StoredRecords> {
  if (!doc.persist) return Promise.resolve({ pages: new Map(), images: new Map() })
  const key = ocrDocKey(doc.pdf.fingerprints[0] ?? '', ocrLanguages(getLanguage()))
  if (doc.stored?.key !== key) {
    doc.stored = {
      key,
      pages: loadOcrPages(key, doc.pdf.numPages).then((list) => {
        const records: StoredRecords = { pages: new Map(), images: new Map() }
        for (const r of list) (r.kind === 'images' ? records.images : records.pages).set(r.pageNumber, r)
        return records
      })
    }
  }
  return doc.stored.pages
}

async function storedContent(doc: OcrDoc, kind: JobKind, pageNumber: number): Promise<TextContent | null> {
  const records = await storedRecords(doc)
  const record = (kind === 'images' ? records.images : records.pages).get(pageNumber)
  if (!record) return null
  try {
    const page = await doc.pdf.getPage(pageNumber)
    if (!storedPageMatches(record, page.view, page.rotate)) return null
    if (kind === 'images') return imageTextContent(record.regions ?? [])
    return contentOf(page, record.paragraphs, record.scale)
  } catch {
    return null
  }
}

/** Keep a record between sessions (and for the rest of this one) */
function keep(doc: OcrDoc, pdf: PDFDocumentProxy, page: PDFPageProxy, kind: JobKind, fields: Partial<StoredOcrPage>): void {
  if (!doc.persist) return
  const key = ocrDocKey(pdf.fingerprints[0] ?? '', ocrLanguages(getLanguage()))
  const record: StoredOcrPage = {
    id: kind === 'images' ? `${key}#${page.pageNumber}#images` : `${key}#${page.pageNumber}`,
    docKey: key,
    pageNumber: page.pageNumber,
    view: [...page.view],
    rotate: page.rotate,
    scale: 0,
    paragraphs: [],
    ...(kind === 'images' ? { kind: 'images' as const } : {}),
    ...fields
  }
  void saveOcrPage(record, pdf.numPages)
  void doc.stored?.pages.then((m) => {
    if (doc.stored?.key === key) (kind === 'images' ? m.images : m.pages).set(page.pageNumber, record)
  })
}

function notify(doc: OcrDoc): void {
  if (doc.done >= doc.total) doc.done = doc.total = 0
  if (doc.pageDone >= doc.pageTotal) doc.pageDone = doc.pageTotal = 0
  doc.progress = doc.total > 0 ? { done: doc.done, total: doc.total } : null
  const pages = doc.pageTotal > 0 ? { done: doc.pageDone, total: doc.pageTotal } : null
  // Kept identical while nothing changed — a hook reads it as its snapshot
  if (pages?.done !== doc.pageProgress?.done || pages?.total !== doc.pageProgress?.total) doc.pageProgress = pages
  for (const cb of doc.listeners) cb()
}

function pump(): void {
  window.clearTimeout(idleTimer)
  if (unavailable) {
    for (const job of queue.splice(0)) finish(job, null)
    return
  }
  while (queue.length > 0) {
    const engine = freeEngine()
    if (!engine) break
    let best = 0
    for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[best].priority) best = i
    const job = queue.splice(best, 1)[0]
    job.state = 'running'
    engine.busy = true
    running++
    void (job.kind === 'images' ? readImages(job, engine) : readPage(job, engine)).then((content) => {
      engine.busy = false
      running--
      finish(job, content)
      pump()
    })
  }
  if (queue.length === 0 && running === 0) idleTimer = window.setTimeout(stopEngines, IDLE_MS)
}

function finish(job: PageJob, content: TextContent | null): void {
  const counted = job.state === 'running' || job.state === 'queued'
  job.state = 'done'
  job.settle(content)
  if (counted) {
    job.doc.done++
    if (job.kind === 'page') job.doc.pageDone++
    notify(job.doc)
  }
}

async function readPage(job: PageJob, engine: Engine): Promise<TextContent | null> {
  const doc = job.doc
  // Twice at most: a write elsewhere can swap (and destroy) the document
  // under a page being read; the second try reads the new one
  for (let attempt = 0; attempt < 2; attempt++) {
    const pdf = doc.pdf
    try {
      const page = await pdf.getPage(job.pageNumber)
      const raster = await renderForOcr(page)
      const tsv = await recognize(engine, raster)
      if (tsv === null) return null
      const paragraphs = parseTsv(tsv)
      keep(doc, pdf, page, 'page', { scale: raster.scale, paragraphs })
      return contentOf(page, paragraphs, raster.scale)
    } catch (err) {
      if (doc.pdf !== pdf) continue
      console.warn(`[pdfx] OCR failed on page ${job.pageNumber}:`, err)
      return null
    }
  }
  return null
}

/** The images of a page with text of its own, one after another on one
 *  engine: each one's words through ocr-image's filters, then all of them as
 *  one block of text content. Kept even when nothing was found. */
async function readImages(job: PageJob, engine: Engine): Promise<TextContent | null> {
  const doc = job.doc
  for (let attempt = 0; attempt < 2; attempt++) {
    const pdf = doc.pdf
    try {
      const page = await pdf.getPage(job.pageNumber)
      const regions: ImageRegionText[] = []
      for (const c of job.candidates ?? []) {
        const px = await imagePixels(page, c)
        if (!px) continue
        const tsv = await recognize(engine, px)
        if (tsv === null) return null
        const region = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w: px.width * px.upscale, h: px.height * px.upscale }
        const paragraphs = imageWords(parseTsv(tsv), regionToPdf(region), job.own ?? { items: [] })
        regions.push({ ...region, paragraphs })
      }
      keep(doc, pdf, page, 'images', { regions })
      return imageTextContent(regions)
    } catch (err) {
      if (doc.pdf !== pdf) continue
      console.warn(`[pdfx] OCR of the images on page ${job.pageNumber} failed:`, err)
      return null
    }
  }
  return null
}

// Finding a page's images asks pdf.js for its operator list — free for a page
// that has been drawn (the same list), real work in pdf.js's worker for one
// that has not. One page at a time, the pages on screen first, so a
// whole-document pass never crowds out the drawing of the page being read.
const detections: { priority: number; run(): Promise<void> }[] = []
let detecting = false

function detect<T>(priority: number, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    detections.push({ priority, run: () => work().then(resolve, reject) })
    void drainDetections()
  })
}

async function drainDetections(): Promise<void> {
  if (detecting) return
  detecting = true
  while (detections.length > 0) {
    let best = 0
    for (let i = 1; i < detections.length; i++) if (detections[i].priority > detections[best].priority) best = i
    await detections.splice(best, 1)[0].run().catch(() => {})
  }
  detecting = false
}

/** The job for one page, created on first ask: what an earlier session kept
 *  comes back at once; otherwise it joins the queue — unless OCR is on
 *  request and this document has not been asked for (a scanned page then
 *  marks the document as one to offer it for), or an images job finds no
 *  image worth reading (done, empty, and kept so). */
function jobFor(doc: OcrDoc, kind: JobKind, pageNumber: number, priority: number, own?: TextContent): PageJob {
  const jobs = kind === 'images' ? doc.imageJobs : doc.jobs
  const existing = jobs.get(pageNumber)
  if (existing) {
    if (existing.state === 'queued' || existing.state === 'checking') {
      existing.priority = Math.max(existing.priority, priority)
    }
    return existing
  }
  let settle!: (content: TextContent | null) => void
  const promise = new Promise<TextContent | null>((resolve) => (settle = resolve))
  const job: PageJob = { doc, kind, pageNumber, priority, interest: 0, state: 'checking', promise, settle }
  jobs.set(pageNumber, job)
  const drop = (): void => {
    jobs.delete(pageNumber)
    job.settle(null)
  }
  void (async () => {
    const stored = await storedContent(doc, kind, pageNumber)
    if (stored) {
      finish(job, stored)
      return
    }
    // Nobody waits any more (gave up during the check), or OCR is not wanted
    // for this document yet: no job — a later ask starts over
    if (job.interest === 0 || !allowed(doc)) {
      if (kind === 'page' && !allowed(doc) && !doc.textless) {
        doc.textless = true
        notify(doc)
      }
      drop()
      return
    }
    if (kind === 'images') {
      const found = await detect(job.priority, async () => {
        const page = await doc.pdf.getPage(pageNumber)
        const rects = await pageImageRects(page, OPS as unknown as OpsTable)
        return { page, candidates: imageCandidates(rects, own ?? (await page.getTextContent())) }
      }).catch(() => null)
      if (!found) {
        drop()
        return
      }
      if (found.candidates.length === 0) {
        // Nothing to read here — and nothing to look for next time either
        keep(doc, doc.pdf, found.page, 'images', { regions: [] })
        finish(job, { items: [], styles: {}, lang: null })
        return
      }
      if (job.interest === 0) {
        drop()
        return
      }
      job.candidates = found.candidates
      job.own = own ?? (await found.page.getTextContent())
    }
    job.state = 'queued'
    queue.push(job)
    doc.total++
    if (kind === 'page') doc.pageTotal++
    notify(doc)
    pump()
  })()
  return job
}

/** Wait for a job on behalf of one caller; with a `signal` the caller may give
 *  up, and a job nobody waits for any more leaves the queue unread */
function waitFor(job: PageJob, signal?: AbortSignal): Promise<TextContent | null> {
  if (signal?.aborted) return Promise.reject(new DOMException('OCR request aborted', 'AbortError'))
  if (job.state === 'done') return job.promise
  // A caller without a signal holds its interest for good: the job is never
  // dropped from under it
  job.interest++
  if (!signal) return job.promise
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      job.interest--
      if (job.interest === 0 && job.state === 'queued') {
        const at = queue.indexOf(job)
        if (at >= 0) queue.splice(at, 1)
        ;(job.kind === 'images' ? job.doc.imageJobs : job.doc.jobs).delete(job.pageNumber)
        job.doc.total--
        if (job.kind === 'page') job.doc.pageTotal--
        notify(job.doc)
      }
      reject(new DOMException('OCR request aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void job.promise.then((content) => {
      signal.removeEventListener('abort', onAbort)
      resolve(content)
    })
  })
}

/**
 * The recognised text of a page whose PDF has none, or null when it cannot be
 * had (OCR is on request and not asked for, the engine would not start, the
 * page would not render). Asking twice reads the page once.
 */
export function ocrTextContent(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  opts: { priority?: number; signal?: AbortSignal } = {}
): Promise<TextContent | null> {
  const doc = docFor(pdf)
  return waitFor(jobFor(doc, 'page', pageNumber, opts.priority ?? OCR_PRIORITY.document), opts.signal)
}

/**
 * The words in the images of a page that has text of its own (`own`, the
 * page's getTextContent), as text content to append to it — empty when no
 * image holds readable words. With `wait: false` only what is already read
 * comes back (this session or an earlier one) and nothing new is started:
 * the assistant and the export never wait for figures.
 */
export async function ocrImageContent(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  own: TextContent,
  opts: { priority?: number; signal?: AbortSignal; wait?: boolean } = {}
): Promise<TextContent | null> {
  const doc = docFor(pdf)
  if (opts.wait === false) {
    const job = doc.imageJobs.get(pageNumber)
    if (job?.state === 'done') return job.promise
    return storedContent(doc, 'images', pageNumber)
  }
  return waitFor(jobFor(doc, 'images', pageNumber, opts.priority ?? OCR_PRIORITY.document, own), opts.signal)
}

/** Whether the words in a page's images are already read this session —
 *  PdfPage then adds them at once instead of after its pause */
export function imageTextRead(pdf: PDFDocumentProxy, pageNumber: number): boolean {
  return docs.get(pdf)?.imageJobs.get(pageNumber)?.state === 'done'
}

/** search.ts's fallback: a scanned page's words in place of its empty text,
 *  or the page's own text with its images' words after it */
const fallback: TextFallback = async (pdf, pageNumber, own, opts) => {
  if (pdf.isPureXfa) return null
  const rest = { ...(opts.priority === undefined ? {} : { priority: opts.priority }), ...(opts.signal ? { signal: opts.signal } : {}) }
  if (!hasVisibleText(own)) return ocrTextContent(pdf, pageNumber, rest)
  const images = await ocrImageContent(pdf, pageNumber, own, { ...rest, wait: opts.images === 'wait' })
  return images && images.items.length > 0 ? mergeImageText(own, images) : null
}

/** The reader asks for this document's text (OCR on request): from now on
 *  its pages are read like with the automatic setting on */
export function enableOcr(pdf: PDFDocumentProxy): void {
  const doc = docFor(pdf)
  if (doc.enabled) return
  doc.enabled = true
  notify(doc)
}

/** Keep a document's recognised pages when the viewer swaps in a re-read of
 *  the same file (after one of its own writes) — the pages are the same
 *  pictures; only the annotations changed. */
export function carryOcr(from: PDFDocumentProxy | null, to: PDFDocumentProxy): void {
  const doc = from && docs.get(from)
  if (!doc || from === to) return
  doc.pdf = to
  docs.set(to, doc)
  if (doc.persist) persistable.add(to)
}

/** Subscribe to a document's OCR state and to the setting */
function useOcrState<T>(pdf: PDFDocumentProxy | null, read: (doc: OcrDoc) => T, none: T): T {
  return useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb)
      const doc = pdf ? docFor(pdf) : null
      doc?.listeners.add(cb)
      return () => {
        modeListeners.delete(cb)
        doc?.listeners.delete(cb)
      }
    },
    () => (pdf ? read(docFor(pdf)) : none)
  )
}

/** How far the reading asked for has come — scanned pages and images — or
 *  null while nothing is waiting. `scannedOnly`: the scanned pages alone,
 *  which is what the assistant waits for. */
export function useOcrProgress(pdf: PDFDocumentProxy | null, scannedOnly = false): OcrProgress | null {
  return useOcrState(pdf, (doc) => (scannedOnly ? doc.pageProgress : doc.progress), null)
}

/** Whether pages of this document are read now (the setting, or asked for) */
export function useOcrAllowed(pdf: PDFDocumentProxy | null): boolean {
  return useOcrState(pdf, allowed, false)
}

/** Whether to offer «Gjenkjenn tekst»: OCR is on request, this document has a
 *  page with no text, and nobody has asked for it yet */
export function useOcrOffer(pdf: PDFDocumentProxy | null): boolean {
  return useOcrState(pdf, (doc) => !allowed(doc) && doc.textless, false)
}

/** Hand search.ts the OCR fallback. Called once at startup by EVERY entry
 *  point — main.tsx (desktop, dev:web) and extension-main.tsx — or search and
 *  the assistant read a scan as empty while its text layer, which asks this
 *  module directly, looks fine. search.ts stays free of the engine so its
 *  tests run in plain Node. */
export function installOcr(): void {
  setTextFallback(fallback)
}

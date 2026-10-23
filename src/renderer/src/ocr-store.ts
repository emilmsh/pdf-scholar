// What OCR read, kept between sessions: a scanned paper opened again has its
// text at once instead of a minute later (Emil, 2026-10-23). Kept in this
// app's own IndexedDB — the renderer's storage on every target, so desktop,
// extension and web keep it the same way — and never written into the PDF.
//
// A document is known by pdf.js's fingerprint (the PDF's own /ID[0], which
// survives our saves — test:doc-identity) and the language set it was read
// with; each page record also carries the page's size and rotation, and a
// record that no longer matches the page is ignored. A password-protected
// document is never stored (ocr.ts decides): its text would sit in the clear
// on disk, the same line the library's first-page pictures hold.
//
// The pure half (keys, matching, what to evict) is tested in test:ocr; the
// IndexedDB half is a thin wrapper that fails soft — no storage, no cache.
import type { OcrParagraph } from './ocr-text'
import type { ImageRegionText } from './ocr-image'

/** Documents kept. A scanned article is a few hundred kB of words; the oldest
 *  read goes first once this many are stored. */
export const OCR_STORE_MAX_DOCS = 150

export interface StoredOcrPage {
  /** `${docKey}#${pageNumber}`, and `…#images` for the words in a page's images */
  id: string
  docKey: string
  pageNumber: number
  /** The page box and rotation it was read on — a mismatch means another page */
  view: number[]
  rotate: number
  /** The raster scale the word boxes are in (ocr-text.ts ocrScale) */
  scale: number
  paragraphs: OcrParagraph[]
  /** 'images': the words read in the images of a page that has text of its
   *  own (ocr-image.ts) — kept even when there were none, so the page is not
   *  read again; absent: the whole page was read (a scan) */
  kind?: 'images'
  regions?: ImageRegionText[]
}

export interface StoredOcrDoc {
  docKey: string
  numPages: number
  /** When it was last read from or written to (ms) — the eviction order */
  used: number
}

export const ocrDocKey = (fingerprint: string, langs: string[]): string => `${fingerprint}|${langs.join('+')}`

/** Whether a stored page is still the page in hand: same box (to a tenth of
 *  a point) and the same rotation */
export function storedPageMatches(stored: Pick<StoredOcrPage, 'view' | 'rotate'>, view: number[], rotate: number): boolean {
  return (
    stored.rotate === rotate &&
    stored.view.length === view.length &&
    stored.view.every((v, i) => Math.abs(v - view[i]) < 0.1)
  )
}

/** The documents to drop so at most `max` remain, the least recently used
 *  first. A tie on the time is broken by key so the choice is stable. */
export function docsToEvict(docs: StoredOcrDoc[], max: number): string[] {
  if (docs.length <= max) return []
  return [...docs]
    .sort((a, b) => a.used - b.used || (a.docKey < b.docKey ? -1 : 1))
    .slice(0, docs.length - max)
    .map((d) => d.docKey)
}

// ---------- IndexedDB ----------

const DB = 'pdfx-ocr'
const DOCS = 'docs'
const PAGES = 'pages'

let dbPromise: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        d.createObjectStore(DOCS, { keyPath: 'docKey' })
        d.createObjectStore(PAGES, { keyPath: 'id' }).createIndex('docKey', 'docKey')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

const result = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

/** Every stored record of a document — none when it was never read, was read
 *  as a document of another length, or storage is unavailable */
export async function loadOcrPages(docKey: string, numPages: number): Promise<StoredOcrPage[]> {
  let out: StoredOcrPage[] = []
  try {
    const d = await db()
    if (!d) return out
    const tx = d.transaction([DOCS, PAGES], 'readwrite')
    const doc = await result(tx.objectStore(DOCS).get(docKey) as IDBRequest<StoredOcrDoc | undefined>)
    if (!doc || doc.numPages !== numPages) return out
    out = await result(tx.objectStore(PAGES).index('docKey').getAll(docKey) as IDBRequest<StoredOcrPage[]>)
    tx.objectStore(DOCS).put({ ...doc, used: Date.now() } satisfies StoredOcrDoc)
    await done(tx)
  } catch {
    /* a cache: nothing to lose */
  }
  return out
}

/** Keep one read page, then trim the store to OCR_STORE_MAX_DOCS */
export async function saveOcrPage(page: StoredOcrPage, numPages: number): Promise<void> {
  try {
    const d = await db()
    if (!d) return
    const tx = d.transaction([DOCS, PAGES], 'readwrite')
    const docs = tx.objectStore(DOCS)
    const pages = tx.objectStore(PAGES)
    const prior = await result(docs.get(page.docKey) as IDBRequest<StoredOcrDoc | undefined>)
    // Another length under the same key is another document: start it over
    if (prior && prior.numPages !== numPages) {
      for (const key of await result(pages.index('docKey').getAllKeys(page.docKey))) pages.delete(key)
    }
    docs.put({ docKey: page.docKey, numPages, used: Date.now() } satisfies StoredOcrDoc)
    pages.put(page)
    const all = await result(docs.getAll() as IDBRequest<StoredOcrDoc[]>)
    for (const key of docsToEvict(all, OCR_STORE_MAX_DOCS)) {
      docs.delete(key)
      for (const pageKey of await result(pages.index('docKey').getAllKeys(key))) pages.delete(pageKey)
    }
    await done(tx)
  } catch {
    /* a cache: the page is simply read again next time */
  }
}

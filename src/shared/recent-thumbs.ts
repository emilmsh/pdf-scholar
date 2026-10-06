// The library's grid view (issue #28): «Nylig lest» as first-page pictures.
//
// The picture is page 1 of a document the reader has OPENED here — taken from
// the pdf.js document the viewer already holds, never by reading files when the
// library is shown, which would cost a parse per entry on every visit. An entry
// that has no picture yet (opened before the grid was chosen) is drawn once by
// the grid itself, from bytes read without readFile's side effects. Everything
// here is rule, not storage: the stores are src/main/recent-thumbs.ts (files
// beside the state file) and the extension's IndexedDB half
// (src/renderer/src/extension-recent-thumbs.ts). Electron-free on purpose, so
// scripts/test-recent-thumbs.mjs can import it.
import type { RecentThumb } from './types'

/** Long side of the stored picture, px. A grid cell is ~140 CSS px wide; at a
 *  device pixel ratio of 2 (a Surface) that is ~280 px across and ~360 down for
 *  a portrait page — so 360 keeps a cover crisp there without storing more. */
export const RECENT_THUMB_SIDE = 360

/** JPEG quality. A page of text at this size is 15–35 KB. */
export const RECENT_THUMB_QUALITY = 0.8

/** Largest picture a store accepts. Ten times what a real cover weighs: the
 *  bytes come from a renderer, and main writes them to disk. */
export const RECENT_THUMB_MAX_IMAGE_BYTES = 512 * 1024

/** Largest file the grid reads back to draw a missing picture. The picture is
 *  page 1; reading a 300 MB scanned book for it is not worth the wait. */
export const RECENT_THUMB_READ_MAX_BYTES = 50 * 1024 * 1024

/** The scale that renders a page `width`×`height` (PDF points) with its long
 *  side at `side` px. A page with no usable size draws at 1 rather than at
 *  infinity. */
export function thumbScale(width: number, height: number, side = RECENT_THUMB_SIDE): number {
  const long = Math.max(width, height)
  return Number.isFinite(long) && long > 0 ? side / long : 1
}

/** A RecentThumb as a store may keep it, or null for anything else. The input
 *  crossed a process boundary (desktop) or came out of a database a future
 *  version may have written (extension), so nothing is taken on trust:
 *  - the picture must be a JPEG and small, since main writes it to disk;
 *  - a LOCKED document never keeps a picture, even when one is handed over —
 *    that is the whole point of the flag;
 *  - the page count is a whole number of pages, 0 meaning «not known». */
export function sanitizeRecentThumb(input: unknown): RecentThumb | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<Record<keyof RecentThumb, unknown>>
  const { pages, taken } = raw
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0 || pages > 1_000_000) {
    return null
  }
  if (typeof taken !== 'number' || !Number.isFinite(taken) || taken <= 0) return null
  if (raw.locked === true) return { pages, locked: true, taken }
  const image = raw.image
  if (image === undefined) return { pages, taken }
  if (!(image instanceof Uint8Array) || !isSmallJpeg(image)) return null
  return { image, pages, taken }
}

function isSmallJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 3 &&
    bytes.byteLength <= RECENT_THUMB_MAX_IMAGE_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
}

/** Paths whose stored pictures should go: every one no longer in the recents.
 *  The recents list is the only owner a picture has, so this is all the
 *  housekeeping the store ever needs. */
export function staleThumbPaths(stored: Iterable<string>, recents: Iterable<string>): string[] {
  const keep = new Set(recents)
  return [...stored].filter((path) => !keep.has(path))
}

/** Whether the EXTENSION may read a recents entry back to draw its picture:
 *  only a local file. A URL would be downloaded again — slow, possibly behind a
 *  login, and a request to someone's server the reader never asked for — and a
 *  picked (fsa:) file needs a permission only a click can grant. Desktop
 *  recents are all local files and need no such rule. */
export function thumbReadableInExtension(path: string): boolean {
  return /^file:/i.test(path)
}

export interface ReadingProgress {
  page: number
  pages: number
  /** 0–1, for the line under the picture */
  fraction: number
}

/** Where the reader is, from a saved reading position and the page count the
 *  picture was taken with — null when either is unknown. A page past the end
 *  (the document lost pages since) reads as the last page, not as 140 %. */
export function readingProgress(
  page: number | undefined,
  pages: number | undefined
): ReadingProgress | null {
  if (typeof page !== 'number' || typeof pages !== 'number') return null
  if (!Number.isFinite(page) || !Number.isInteger(pages) || pages < 1 || page < 1) return null
  const at = Math.min(Math.round(page), pages)
  return { page: at, pages, fraction: at / pages }
}

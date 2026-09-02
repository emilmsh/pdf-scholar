// Zotero-awareness: how a PDF's own path maps to the Zotero item it belongs to,
// and the localhost plumbing around that mapping.
//
// Zotero lays every *stored* attachment out as <data-dir>/storage/<KEY>/<file>,
// where <KEY> is the attachment item's 8-char key — the path alone identifies
// the item, no lookup needed. («Linked» attachments live wherever the user put
// them, carry no key in the path, and are deliberately not detected.) Everything
// beyond the key — the parent item, its title, a formatted citation — comes from
// Zotero's local HTTP API on 127.0.0.1:23119, which serves the user's own
// database unauthenticated once enabled (Zotero Settings → Advanced → "Allow
// other applications on this computer to communicate with Zotero"; 403 when
// off). The zotero:// URI scheme is registered by the Zotero client itself, so
// «Vis i Zotero» works even with that API switched off.
//
// Everything here is pure parsing/URL-building, plus the two-request client with
// fetch INJECTED — so scripts/test-zotero.mjs proves the whole mapping without
// Electron, a network, or Zotero installed.

import type { FileError, ZoteroErrorCode, ZoteroInfo } from './types'

/** Item keys are 8 chars of uppercase A–Z / 0–9. Kept case-SENSITIVE on
 *  purpose: it is the cheapest guard against a random `/storage/whatever/`
 *  path reading as Zotero's. */
export function isZoteroKey(s: string): boolean {
  return /^[A-Z0-9]{8}$/.test(s)
}

/** The attachment key a Zotero storage path carries, or null for every other
 *  path. Accepts Windows and POSIX separators and the extension's file:// URL
 *  form (percent-decoded first). The key must be the file's immediate parent
 *  directory under a `storage` segment — Zotero's invariant. */
export function zoteroKeyFromPath(path: string): string | null {
  let p = path
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(p)
    } catch {
      // Malformed escapes: match against the raw form instead of failing
    }
  }
  // `storage` matches case-insensitively (Windows filesystems are), the key is
  // then re-checked case-sensitively by isZoteroKey.
  const m = /[\\/]storage[\\/]([A-Za-z0-9]{8})[\\/][^\\/]+$/i.exec(p)
  const key = m?.[1]
  return key !== undefined && isZoteroKey(key) ? key : null
}

/** zotero://select — reveal the item in the Zotero client. Null for anything
 *  that is not a valid key, so a caller can never be talked into building an
 *  arbitrary URL out of renderer input. */
export function zoteroSelectUrl(key: string): string | null {
  return isZoteroKey(key) ? `zotero://select/library/items/${key}` : null
}

// ---------- Local-API response parsing ----------

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The parent item an attachment hangs under (from GET /items/<KEY>), or null
 *  for a standalone attachment — or for JSON that isn't the shape we expect,
 *  which degrades to «cite the attachment item itself». */
export function parseAttachmentItem(json: unknown): { parentKey: string | null } {
  const parent = str(obj(obj(json)?.data)?.parentItem)
  return { parentKey: isZoteroKey(parent) ? parent : null }
}

export interface ParsedZoteroItem {
  title: string
  /** Creator family names, in order. The renderer formats the summary («A &
   *  B», «A mfl.») because only it knows the UI language. */
  creators: string[]
  year: string
  citation: string
  bib: string
}

/** Metadata + both citation forms out of GET /items/<KEY>?include=data,bib,
 *  citation&style=…. Missing or malformed fields become empty, never throw —
 *  the caller shows what there is. */
export function parseZoteroItem(json: unknown): ParsedZoteroItem {
  const root = obj(json)
  const data = obj(root?.data)
  const creators: string[] = []
  const rawCreators = data?.creators
  if (Array.isArray(rawCreators)) {
    for (const c of rawCreators) {
      const co = obj(c)
      // Two-field (lastName/firstName) and single-field (name) creators both occur
      const name = str(co?.lastName) || str(co?.name)
      if (name) creators.push(name)
    }
  }
  const year = /(\d{4})/.exec(str(data?.date))?.[1] ?? ''
  return {
    title: str(data?.title),
    creators,
    year,
    citation: htmlToText(str(root?.citation)),
    bib: htmlToText(str(root?.bib))
  }
}

/** Zotero's `bib`/`citation` come as CSL HTML (`<div class="csl-entry">…`).
 *  This flattens exactly that constrained output to plain text: tags dropped,
 *  the entities Zotero emits decoded, whitespace collapsed. Not a general
 *  HTML parser and not meant to be one. */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&#(\d+);/g, (_, d: string) => fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCodePoint(parseInt(h, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // &amp; last, so «&amp;lt;» decodes to the literal «&lt;» and stops
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const fromCodePoint = (cp: number): string => {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** What an HTTP outcome from the local API MEANS. null status = the request
 *  never got an answer (connection refused, timeout): Zotero isn't running.
 *  403 is Zotero deciding: the API toggle is off. Anything else non-OK reads
 *  as «this key isn't in the library» — a 404 literally, and rarer statuses
 *  land on the same harmless hint (the FileError text keeps the detail). */
export function zoteroCodeForStatus(status: number | null): ZoteroErrorCode {
  if (status === null) return 'zotero-off'
  if (status === 403) return 'zotero-api-disabled'
  return 'zotero-item-unknown'
}

// ---------- The client (fetch injected; one instance per platform) ----------

export const ZOTERO_LOCAL_API = 'http://127.0.0.1:23119/api/users/0'
/** Fixed for now: style belongs to the destination manuscript, not the reader.
 *  Kept a parameter of the request (not baked into parsing) so a picker is a
 *  UI-only change later. */
const ZOTERO_CITATION_STYLE = 'apa'

export interface ZoteroFetchOutcome {
  /** HTTP status, or null when no response arrived at all */
  status: number | null
  /** Parsed body for a 200, else null */
  json: unknown
}
export type ZoteroFetchJson = (url: string) => Promise<ZoteroFetchOutcome>

export interface ZoteroClient {
  /** ZoteroInfo for a storage-path file; null = not such a path (show no
   *  Zotero UI); FileError with a zotero-* code = it IS Zotero's file but the
   *  local API said no. Successes are cached for the session; failures are
   *  not, so the next menu open retries (the user may have started Zotero). */
  info(path: string): Promise<ZoteroInfo | FileError | null>
  /** zotero://select URL for the file — the parent item when a completed
   *  info() has resolved it, else the attachment key straight from the path
   *  (which is why this works with the local API off). Null off storage paths. */
  selectUrl(path: string): string | null
}

export function createZoteroClient(fetchJson: ZoteroFetchJson): ZoteroClient {
  const cache = new Map<string, ZoteroInfo>()
  return {
    async info(path) {
      const key = zoteroKeyFromPath(path)
      if (!key) return null
      const hit = cache.get(key)
      if (hit) return hit
      const att = await fetchJson(`${ZOTERO_LOCAL_API}/items/${key}`)
      if (att.status !== 200) return zoteroError(att.status)
      const { parentKey } = parseAttachmentItem(att.json)
      const item = await fetchJson(
        `${ZOTERO_LOCAL_API}/items/${parentKey ?? key}?include=data,bib,citation&style=${ZOTERO_CITATION_STYLE}`
      )
      if (item.status !== 200) return zoteroError(item.status)
      const info: ZoteroInfo = { attachmentKey: key, parentKey, ...parseZoteroItem(item.json) }
      cache.set(key, info)
      return info
    },
    selectUrl(path) {
      const key = zoteroKeyFromPath(path)
      if (!key) return null
      return zoteroSelectUrl(cache.get(key)?.parentKey ?? key)
    }
  }
}

function zoteroError(status: number | null): FileError {
  return {
    error:
      status === null
        ? 'Zotero local API unreachable at 127.0.0.1:23119'
        : `Zotero local API answered HTTP ${status}`,
    code: zoteroCodeForStatus(status)
  }
}

/** The one fetch used at runtime — by main (Electron) and by the extension's
 *  viewer page, so the two platforms behave identically by construction. A
 *  refused connection fails instantly; the timeout only guards a hung Zotero.
 *  Tests inject their own ZoteroFetchJson and never reach this. */
export async function httpZoteroFetch(url: string): Promise<ZoteroFetchOutcome> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return { status: res.status, json: res.ok ? await res.json().catch(() => null) : null }
  } catch {
    return { status: null, json: null }
  }
}

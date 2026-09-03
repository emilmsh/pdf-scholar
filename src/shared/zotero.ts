// Zotero-awareness: how a PDF's own path maps to the Zotero item it belongs to,
// and the localhost plumbing around that mapping.
//
// Zotero lays every *stored* attachment out as <data-dir>/storage/<KEY>/<file>,
// where <KEY> is the attachment item's 8-char key — the path alone identifies
// the item, no lookup needed. «Linked» attachments (ZotFile-style libraries, a
// base directory on a synced drive) live wherever the user put them and carry
// no key in the path, so for those the library's own attachment list is asked:
// fetched once per session in pages of 100 and indexed by filename, the file
// on disk is matched to the record whose path ends the same way (2026-09-03 —
// Emil's whole library is linked, and v0.44.0 showed it no Zotero UI at all).
// Everything beyond the key — the parent item, its title, a formatted citation
// — comes from Zotero's local HTTP API on 127.0.0.1:23119, which serves the
// user's own database unauthenticated once enabled (Zotero Settings → Advanced
// → "Allow other applications on this computer to communicate with Zotero";
// 403 when off). The zotero:// URI scheme is registered by the Zotero client
// itself, so «Vis i Zotero» works even with that API switched off — for a
// storage path; a linked file needs the lookup first.
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

// ---------- Paths of linked attachments ----------

/** A path as segments, most significant last: file:// URLs decoded, both
 *  separators, Zotero's `attachments:` (relative to its linked-attachment
 *  base directory) and `storage:` prefixes dropped, empty segments skipped. */
export function pathSegments(path: string): string[] {
  let p = path
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(p)
    } catch {
      // Malformed escapes: segment the raw form
    }
    p = p.replace(/^file:\/*/i, '')
  }
  p = p.replace(/^(attachments|storage):/i, '')
  return p.split(/[\\/]+/).filter((s) => s.length > 0)
}

/** The file's own name — the one thing a linked attachment's Zotero record
 *  and its path on disk are guaranteed to share. */
export function pathBasename(path: string): string {
  const segs = pathSegments(path)
  return segs[segs.length - 1] ?? ''
}

/** How many trailing segments two paths share, case-insensitively (Windows
 *  filesystems are). 0 when even the filename differs; the basename alone is
 *  1. Decides between records that share a filename — the one that also shares
 *  the folder above wins. */
export function pathTailMatch(a: string, b: string): number {
  const x = pathSegments(a)
  const y = pathSegments(b)
  let n = 0
  while (n < x.length && n < y.length) {
    if (x[x.length - 1 - n]!.toLowerCase() !== y[y.length - 1 - n]!.toLowerCase()) break
    n += 1
  }
  return n
}

export interface LinkedAttachment {
  key: string
  parentKey: string | null
  /** Zotero's own path field: `attachments:rel/path.pdf` or an absolute path */
  path: string
}

/** One page of GET /items?itemType=attachment: how many records it held (the
 *  pager stops on a short page) and the linked-file ones among them, since
 *  stored attachments are matched by path and never need this list. */
export function parseAttachmentList(json: unknown): { count: number; linked: LinkedAttachment[] } {
  if (!Array.isArray(json)) return { count: 0, linked: [] }
  const linked: LinkedAttachment[] = []
  for (const it of json) {
    const d = obj(obj(it)?.data)
    if (!d || str(d.linkMode) !== 'linked_file') continue
    const key = str(d.key)
    const path = str(d.path)
    if (!isZoteroKey(key) || !path) continue
    const parent = str(d.parentItem)
    linked.push({ key, parentKey: isZoteroKey(parent) ? parent : null, path })
  }
  return { count: json.length, linked }
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
  /** ZoteroInfo for a file Zotero knows; null = not Zotero's file as far as
   *  can be told (show no Zotero UI); FileError with a zotero-* code = it IS
   *  Zotero's file but the local API said no. A storage path is Zotero's by
   *  construction, so there a refused connection is a named failure; a linked
   *  file can only be recognised THROUGH the API, so with Zotero off it reads
   *  as «not Zotero's» — nothing shows, and the next call asks again.
   *  Successes are cached for the session; failures never are. */
  info(path: string): Promise<ZoteroInfo | FileError | null>
  /** zotero://select URL for the file — the parent item when a completed
   *  info() has resolved it, else the attachment key straight from the path
   *  (which is why this works with the local API off). Null off storage paths
   *  until info() has resolved a linked file. */
  selectUrl(path: string): string | null
}

/** The local API caps a page at 100 — the web API's limit, mirrored. */
export const ZOTERO_PAGE = 100
/** A miss against an index older than this rebuilds it first — the file may
 *  have been added to Zotero since. Hits never wait. */
const INDEX_STALE_MS = 5 * 60_000

export function createZoteroClient(fetchJson: ZoteroFetchJson): ZoteroClient {
  const cache = new Map<string, ZoteroInfo>()
  /** Linked files, resolved: keyed by the path as the caller gave it */
  const linkedByPath = new Map<string, ZoteroInfo>()
  /** Every linked attachment in the library, by lower-cased filename */
  let index: { byName: Map<string, LinkedAttachment[]>; builtAt: number } | null = null

  /** Page through the attachment list. Returns the HTTP status that stopped
   *  it (200 = complete; anything else leaves the old index, if any, in place). */
  async function buildIndex(): Promise<number | null> {
    const byName = new Map<string, LinkedAttachment[]>()
    for (let start = 0; ; start += ZOTERO_PAGE) {
      const page = await fetchJson(
        `${ZOTERO_LOCAL_API}/items?itemType=attachment&limit=${ZOTERO_PAGE}&start=${start}&format=json`
      )
      if (page.status !== 200) return page.status
      const { count, linked } = parseAttachmentList(page.json)
      for (const a of linked) {
        const name = pathBasename(a.path).toLowerCase()
        if (!name) continue
        const list = byName.get(name)
        if (list) list.push(a)
        else byName.set(name, [a])
      }
      if (count < ZOTERO_PAGE) break
    }
    index = { byName, builtAt: Date.now() }
    return 200
  }

  /** The library record a linked file on disk belongs to, or null */
  async function findLinked(path: string): Promise<LinkedAttachment | null> {
    const name = pathBasename(path).toLowerCase()
    if (!name) return null
    if (!index && (await buildIndex()) !== 200) return null
    let candidates = index!.byName.get(name) ?? []
    if (candidates.length === 0 && Date.now() - index!.builtAt > INDEX_STALE_MS) {
      await buildIndex() // a failure keeps the old index — still a miss below
      candidates = index!.byName.get(name) ?? []
    }
    let best: LinkedAttachment | null = null
    let bestScore = 0
    for (const c of candidates) {
      const score = pathTailMatch(path, c.path)
      if (score > bestScore) {
        best = c
        bestScore = score
      }
    }
    return best
  }

  async function fetchInfo(attachmentKey: string, parentKey: string | null): Promise<ZoteroInfo | FileError> {
    const item = await fetchJson(
      `${ZOTERO_LOCAL_API}/items/${parentKey ?? attachmentKey}?include=data,bib,citation&style=${ZOTERO_CITATION_STYLE}`
    )
    if (item.status !== 200) return zoteroError(item.status)
    return { attachmentKey, parentKey, ...parseZoteroItem(item.json) }
  }

  return {
    async info(path) {
      const key = zoteroKeyFromPath(path)
      if (key) {
        const hit = cache.get(key)
        if (hit) return hit
        const att = await fetchJson(`${ZOTERO_LOCAL_API}/items/${key}`)
        if (att.status !== 200) return zoteroError(att.status)
        const { parentKey } = parseAttachmentItem(att.json)
        const info = await fetchInfo(key, parentKey)
        if (!('error' in info)) cache.set(key, info)
        return info
      }
      // Not a storage path: maybe a linked attachment. The path says nothing,
      // so the library is asked — nothing shows unless it answers with a match.
      const linkedHit = linkedByPath.get(path)
      if (linkedHit) return linkedHit
      const att = await findLinked(path)
      if (!att) return null
      const info = await fetchInfo(att.key, att.parentKey)
      if (!('error' in info)) linkedByPath.set(path, info)
      return info
    },
    selectUrl(path) {
      const key = zoteroKeyFromPath(path)
      if (key) return zoteroSelectUrl(cache.get(key)?.parentKey ?? key)
      const linked = linkedByPath.get(path)
      return linked ? zoteroSelectUrl(linked.parentKey ?? linked.attachmentKey) : null
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

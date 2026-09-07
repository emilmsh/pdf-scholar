// DOI-awareness: the reserve for a document that is NOT in a Zotero library.
//
// Most published papers print their DOI on the first page (a footer line, the
// «Cite as» box, the arXiv stamp) or carry it in the PDF's metadata. Once we
// have it, doi.org resolves it to a formatted reference by content negotiation
// — the same Crossref/DataCite data a citation manager would import, formatted
// by the registrar's own citeproc in any CSL style — without an account, a
// third-party site or a key. Three GETs, all to https://doi.org/<doi> with a
// different Accept header, redirected by doi.org to the registration agency:
//   application/vnd.citationstyles.csl+json  → title / authors / year
//   text/x-bibliography; style=apa           → the full reference
//   application/x-bibtex                     → the BibTeX entry
// The in-text citation is not a format the agencies serve, so APA's rule is
// applied here from the CSL fields (one author, two, three-or-more, no date).
//
// The Zotero section stays the better source when the library HAS the item —
// the user's own corrected metadata beats a publisher's deposit — so the
// renderer shows this section only when no Zotero record was resolved (also
// for a Zotero storage path while Zotero is off; the file may be in the
// library, but a citation the user can copy right now beats a hint to start
// Zotero). Nothing here fetches on its own: the lookup is a click, because it
// is the app's one network call outside the AI providers and the update check,
// and the row names the destination.
//
// Pure parsing and URL-building, plus a client with fetch INJECTED — so
// scripts/test-doi.mjs proves the flow without a network.

import type { DoiErrorCode, DoiInfo, FileError } from './types'

/** A DOI as the handbook defines it: the `10.` prefix, a 4–9 digit registrant
 *  code, a slash, and a suffix that may hold nearly any printable character.
 *  Matched inside running text, so the suffix stops at whitespace, quotes and
 *  angle brackets (the natural delimiters in a PDF's text layer and in XMP). */
const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>]+)/g

/** Strict form for a value about to become part of a URL: the same shape,
 *  whole-string, no whitespace anywhere. Guards the renderer→platform hop the
 *  same way isZoteroKey does for zotero:// — a caller can never be talked into
 *  fetching an arbitrary URL out of renderer input. */
export function isDoi(s: string): boolean {
  return /^10\.\d{4,9}\/[^\s"'<>]+$/.test(s)
}

/** The first DOI found in a piece of text, or null. Trailing punctuation the
 *  sentence added («…0040-x.», «(doi: …)») is not part of the identifier and
 *  is stripped, as is a closing bracket without its opener — a suffix like
 *  `10.1000/abc(12)` keeps its balanced parentheses. */
export function findDoi(text: string): string | null {
  DOI_IN_TEXT.lastIndex = 0
  const m = DOI_IN_TEXT.exec(text)
  if (!m) return null
  return normalizeDoi(m[1]!)
}

/** Strip the decorations a DOI acquires in print: trailing sentence
 *  punctuation and unbalanced closing brackets. Never changes case — DOIs are
 *  case-insensitive and doi.org accepts them as printed. */
export function normalizeDoi(raw: string): string {
  let d = raw
  for (;;) {
    const before = d
    d = d.replace(/[.,;:]+$/, '')
    if (d.endsWith(')') && count(d, '(') < count(d, ')')) d = d.slice(0, -1)
    if (d.endsWith(']') && count(d, '[') < count(d, ']')) d = d.slice(0, -1)
    if (d.endsWith('}') && count(d, '{') < count(d, '}')) d = d.slice(0, -1)
    if (d === before) return d
  }
}

const count = (s: string, ch: string): number => s.split(ch).length - 1

/** The document's DOI from the texts a reader has at hand, checked in order:
 *  the metadata values first (an explicit statement by whoever produced the
 *  file), then the first pages' text — where the FIRST match wins, because a
 *  paper's own DOI is printed before any it cites. Null when nothing matches;
 *  the renderer shows no DOI UI at all then. */
export function doiFromTexts(texts: readonly string[]): string | null {
  for (const t of texts) {
    const d = findDoi(t)
    if (d && isDoi(d)) return d
  }
  return null
}

/** https://doi.org/<doi>, each path segment percent-encoded so a suffix with
 *  `#`, `?` or `%` cannot change the request. Null for anything that is not a
 *  DOI, so the platform half refuses garbage without knowing why. */
export function doiUrl(doi: string): string | null {
  if (!isDoi(doi)) return null
  return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`
}

// ---------- CSL JSON ----------

export interface ParsedCsl {
  title: string
  /** Family names in order (a corporate author's single `literal` name
   *  counts as one) */
  creators: string[]
  year: string
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Title, creators and year out of a CSL JSON item — the shape Crossref and
 *  DataCite both serve. Missing or malformed fields become empty, never throw.
 *  The year is `issued.date-parts[0][0]`, falling back to any four-digit run
 *  in `issued.raw`/`created` (DataCite records can lack `issued`). */
export function parseCslJson(json: unknown): ParsedCsl {
  const root = obj(json)
  const creators: string[] = []
  const authors = root?.author
  if (Array.isArray(authors)) {
    for (const a of authors) {
      const ao = obj(a)
      const name = str(ao?.family) || str(ao?.literal) || str(ao?.name)
      if (name) creators.push(name)
    }
  }
  // Crossref may serve `title` as a one-element array (older records)
  const rawTitle = root?.title
  const title = Array.isArray(rawTitle) ? str(rawTitle[0]) : str(rawTitle)
  return { title: title.replace(/\s+/g, ' ').trim(), creators, year: yearOf(root) }
}

function yearOf(root: Record<string, unknown> | null): string {
  for (const field of ['issued', 'published', 'published-print', 'published-online', 'created']) {
    const date = obj(root?.[field])
    const parts = date?.['date-parts']
    if (Array.isArray(parts)) {
      const first = Array.isArray(parts[0]) ? parts[0][0] : undefined
      if (typeof first === 'number' && first > 0) return String(first)
      if (typeof first === 'string' && /^\d{4}$/.test(first)) return first
    }
    const raw = /(\d{4})/.exec(str(date?.raw))?.[1]
    if (raw) return raw
  }
  return ''
}

/** APA 7 in-text citation from the CSL fields: «(Pfaffman, 2007)», «(Vaswani &
 *  Shazeer, 2017)», «(Vaswani et al., 2017)». With no author the title stands
 *  in, as APA has it; with no date, «n.d.». Empty only when there is neither
 *  an author nor a title — nothing to cite by. */
export function apaInText(item: ParsedCsl): string {
  const who =
    item.creators.length === 0
      ? item.title
      : item.creators.length === 1
        ? item.creators[0]!
        : item.creators.length === 2
          ? `${item.creators[0]} & ${item.creators[1]}`
          : `${item.creators[0]} et al.`
  if (!who) return ''
  return `(${who}, ${item.year || 'n.d.'})`
}

// ---------- The client ----------

/** Fixed, like Zotero's: the style belongs to the destination manuscript, not
 *  the reader. A request parameter so a picker stays a UI-only change. */
const DOI_CITATION_STYLE = 'apa'

export const ACCEPT_CSL_JSON = 'application/vnd.citationstyles.csl+json'
export const ACCEPT_BIBLIOGRAPHY = `text/x-bibliography; style=${DOI_CITATION_STYLE}`
export const ACCEPT_BIBTEX = 'application/x-bibtex'

export interface DoiFetchOutcome {
  /** HTTP status of the FINAL response (redirects followed), or null when no
   *  response arrived at all */
  status: number | null
  /** Body as text for a 200; the caller parses JSON where it expects it */
  text: string
}
export type DoiFetch = (url: string, accept: string) => Promise<DoiFetchOutcome>

export interface DoiClient {
  /** The formatted reference for a DOI. Successes are cached for the session;
   *  failures never are (the next click asks again — the network may be back). */
  cite(doi: string): Promise<DoiInfo | FileError>
}

/** What the outcome MEANS. null = nothing answered (offline, DNS, timeout).
 *  404 from the agency = the DOI is not registered, or has no metadata to
 *  serve (a DOI printed with a typo lands here too). Anything else non-OK is
 *  reported as the same «unknown» with the status kept in the text. */
export function doiCodeForStatus(status: number | null): DoiErrorCode {
  return status === null ? 'doi-offline' : 'doi-unknown'
}

export function createDoiClient(fetchDoi: DoiFetch): DoiClient {
  const cache = new Map<string, DoiInfo>()
  return {
    async cite(doi) {
      const url = doiUrl(doi)
      if (!url) return { error: `not a DOI: ${doi}`, code: 'doi-unknown' }
      const hit = cache.get(doi)
      if (hit) return hit
      // All three at once: the metadata the hint line shows, and the two
      // texts the copy rows hand over. The reference and the BibTeX are
      // optional — a registrar that serves CSL JSON but not a format leaves
      // that row disabled rather than failing the lookup.
      const [csl, bib, bibtex] = await Promise.all([
        fetchDoi(url, ACCEPT_CSL_JSON),
        fetchDoi(url, ACCEPT_BIBLIOGRAPHY),
        fetchDoi(url, ACCEPT_BIBTEX)
      ])
      if (csl.status !== 200) return doiError(csl.status)
      let json: unknown = null
      try {
        json = JSON.parse(csl.text)
      } catch {
        return { error: 'doi.org served CSL JSON that does not parse', code: 'doi-unknown' }
      }
      const parsed = parseCslJson(json)
      const info: DoiInfo = {
        doi,
        ...parsed,
        citation: apaInText(parsed),
        bib: bib.status === 200 ? bib.text.replace(/\s+/g, ' ').trim() : '',
        bibtex: bibtex.status === 200 ? bibtex.text.trim() : ''
      }
      cache.set(doi, info)
      return info
    }
  }
}

function doiError(status: number | null): FileError {
  return {
    error: status === null ? 'doi.org unreachable' : `doi.org answered HTTP ${status}`,
    code: doiCodeForStatus(status)
  }
}

/** The one fetch used at runtime — by main (Electron), the extension's viewer
 *  page and the web preview alike: doi.org and both agencies answer with
 *  `Access-Control-Allow-Origin: *`, so the same call works from a page. The
 *  timeout is for the internet, not localhost. Tests inject their own DoiFetch
 *  and never reach this. */
export async function httpDoiFetch(url: string, accept: string): Promise<DoiFetchOutcome> {
  try {
    const res = await fetch(url, {
      headers: { Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return { status: res.status, text: '' }
    return { status: res.status, text: await res.text().catch(() => '') }
  } catch {
    return { status: null, text: '' }
  }
}

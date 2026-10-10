// The abstract behind a citation (issue #31, part 2). The link preview shows
// the reference-list entry a citation points at; this turns that entry's text
// into the cited paper's abstract — on a click in the preview, never on its
// own, because it is a network call and the app is offline unless you ask.
//
// Keyless and free, all four sources (measured 2026-10-10, see
// docs/agent-notes/sitat-sammendrag.md — together about 80 % of the works we
// can identify, about two in three citations end to end):
//   arXiv       export.arxiv.org      every arXiv paper; CC0; ≤ 1 request / 3 s
//   Europe PMC  www.ebi.ac.uk         biomedicine, fast
//   Crossref    api.crossref.org      only where the publisher deposited one
//                                     (Elsevier never does), but also the
//                                     matcher for an entry without a DOI
//   OpenAlex    api.openalex.org      a lookup BY DOI is free without a key
//                                     (its search is not, so we never search it)
// Semantic Scholar is deliberately absent: its keyless pool refused most
// calls, and its licence restricts the data.
//
// The chain:
//   1. the entry's own identifiers — a DOI (39 % of entries print one) or an
//      arXiv id (6 %; also `CoRR abs/…` and the 10.48550 DOI);
//   2. otherwise Crossref's `query.bibliographic` with the entry text — and a
//      hit is only believed when its title is IN the entry and its year agrees
//      (`acceptMatch`). The score alone is not safe: at 60 it still matched
//      4 % wrong, typically a «Commentary on …» or a review of a book with the
//      same title. A wrong abstract is worse than none.
//   3. the abstract: Europe PMC, Crossref and OpenAlex in parallel by DOI (an
//      arXiv paper by its 10.48550 DOI), the first in that order that has
//      one; the arXiv API only when they have none.
// A work found WITHOUT an abstract is a success with `abstract: ''` — books,
// working papers and paywalled Elsevier papers often end there, and the UI
// says so calmly rather than as an error.
//
// Pure parsing plus a client with fetch (and the clock) INJECTED, so
// scripts/test-abstract.mjs proves the flow without a network.

import type { AbstractErrorCode, CitationAbstract, FileError } from './types'
import { findDoi, isDoi } from './doi'
import type { DoiFetch } from './doi'

// ---------- The entry's own identifiers ----------

/** Join an entry's lines the way a reader reads them. A DOI or URL broken
 *  at a line end («…/10.1016/j.» + «jfineco.2015.06.010») is joined with no
 *  space; a word hyphenated across lines («trans-» + «duction») loses its
 *  hyphen; everything else gets a space. */
export function joinEntryLines(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let out = ''
  for (const line of lines) {
    if (!out) {
      out = line
      continue
    }
    const lastToken = /\S+$/.exec(out)?.[0] ?? ''
    if (/(10\.\d{4,9}\/|https?:\/\/|doi\.org\/|arxiv\.org\/)\S*[/.\-_]$/i.test(lastToken)) out += line
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line
    else out += ' ' + line
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** arXiv identifiers as references print them: `arXiv:1706.03762v5`,
 *  `arxiv.org/abs/…`, CoRR's `abs/1409.0473`, the 10.48550 DOI, and the old
 *  `hep-th/9901001` scheme. */
export function findArxivId(text: string): string | null {
  const patterns = [
    /arxiv[:\s]+(\d{4}\.\d{4,5})(?:v\d+)?/i,
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i,
    /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i,
    /\babs\/(\d{4}\.\d{4,5})\b/i,
    /arxiv[:\s]+([a-z-]+(?:\.[a-z]{2})?\/\d{7})/i,
    /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7})/i
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[1]!
  }
  return null
}

export function isArxivId(s: string): boolean {
  return /^(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})$/i.test(s)
}

/** The years an entry mentions (a reference can carry two: «1997/2003») */
export function yearsIn(text: string): number[] {
  return [...text.matchAll(/(?<![\d/.])(1[89]\d{2}|20\d{2})(?![\d/])/g)].map((m) => Number(m[1]))
}

// ---------- Is this hit the cited work? ----------

const norm = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Titles that are ABOUT another work: a hit like this is only right when the
 *  entry says so itself. */
const RESPONSE_TITLE = /^(commentary|comment|review|reply|rejoinder|response|erratum|corrigendum|correction|retraction|discussion)\b/

/** Does a candidate (title + year) describe the work this entry cites?
 *  Either the whole title is in the entry and the year is within −6/+4 of one
 *  the entry names (a preprint or working paper cited years before — or after
 *  — its journal version), or nearly all of the title's words are and the
 *  year is within one. Tuned on 106 real entries: no wrong matches, 91 % of
 *  the right ones kept (docs/agent-notes/sitat-sammendrag.md). */
export function acceptMatch(entry: string, title: string, year: number | null): boolean {
  const e = norm(entry)
  const t = norm(title)
  if (t.length < 8) return false
  const responseWord = RESPONSE_TITLE.exec(t)?.[1]
  if (responseWord && !new RegExp(`\\b${responseWord}\\b`).test(e)) return false
  const years = yearsIn(entry)
  const yearIn = (lo: number, hi: number): boolean =>
    year === null ? years.length === 0 : years.some((y) => year - y >= lo && year - y <= hi)
  if (` ${e} `.includes(` ${t} `) && yearIn(-6, 4)) return true
  const words = t.split(' ').filter((w) => w.length > 2)
  if (words.length < 3) return false
  const entryWords = new Set(e.split(' '))
  const found = words.filter((w) => entryWords.has(w)).length
  return found / words.length >= 0.85 && yearIn(-1, 1)
}

// ---------- Reading each source's answer ----------

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const first = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : str(v))

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Markup (Crossref's JATS, Europe PMC's HTML) to plain paragraphs: block
 *  ends become paragraph breaks, every other tag goes, a leading «Abstract»
 *  heading goes, and the text is capped — an abstract, not a paper. */
export function plainAbstract(markup: string): string {
  const text = decodeEntities(
    markup
      .replace(/<\/(?:jats:)?(?:p|sec|title|h\d|div)>|<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (paras.length && /^abstract[.:]?$/i.test(paras[0]!)) paras.shift()
  if (paras.length && /^abstract[.:]?\s+/i.test(paras[0]!)) paras[0] = paras[0]!.replace(/^abstract[.:]?\s+/i, '')
  const out = paras.join('\n\n')
  return out.length > 6000 ? out.slice(0, 6000).replace(/\s+\S*$/, '') + ' …' : out
}

/** OpenAlex keeps abstracts as an inverted index (word → positions) */
export function invertedIndexText(index: unknown): string {
  const o = obj(index)
  if (!o) return ''
  const words: string[] = []
  for (const [word, positions] of Object.entries(o)) {
    if (!Array.isArray(positions)) continue
    for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 20000) words[p] = word
  }
  return words.filter((w) => w !== undefined).join(' ').trim()
}

interface Meta {
  title: string
  year: string
  venue: string
}
interface Found extends Meta {
  abstract: string
}

function crossrefMeta(item: Record<string, unknown> | null): Meta {
  const parts = obj(item?.issued)?.['date-parts'] ?? obj(item?.published)?.['date-parts']
  const y = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null
  return {
    title: plainAbstract(first(item?.title)).replace(/\n+/g, ' '),
    year: typeof y === 'number' ? String(y) : '',
    venue: first(item?.['container-title'])
  }
}

export function parseCrossrefWork(json: unknown): Found | null {
  const item = obj(obj(json)?.message)
  if (!item) return null
  return { ...crossrefMeta(item), abstract: plainAbstract(str(item.abstract)) }
}

export function parseEuropePmc(json: unknown): Found | null {
  const results = obj(obj(json)?.resultList)?.result
  const r = Array.isArray(results) ? obj(results[0]) : null
  if (!r) return null
  return {
    title: plainAbstract(str(r.title)).replace(/\n+/g, ' ').replace(/\.$/, ''),
    year: str(r.pubYear),
    venue: str(obj(obj(r.journalInfo)?.journal)?.title),
    abstract: plainAbstract(str(r.abstractText))
  }
}

export function parseOpenAlex(json: unknown): Found | null {
  const w = obj(json)
  if (!w) return null
  const year = w.publication_year
  return {
    title: str(w.title) || str(w.display_name),
    year: typeof year === 'number' ? String(year) : '',
    venue: str(obj(obj(w.primary_location)?.source)?.display_name),
    abstract: invertedIndexText(w.abstract_inverted_index)
  }
}

/** The first <entry> of an arXiv Atom feed. Parsed by pattern rather than a
 *  DOM, because main has none; the feed's shape is fixed and ours to read. */
export function parseArxivAtom(xml: string): Found | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1]
  if (!entry) return null
  const tag = (name: string): string =>
    decodeEntities(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const abstract = tag('summary')
  // A missing id answers with an «Error» entry rather than a 404
  if (!abstract || /^error$/i.test(tag('title'))) return null
  return { title: tag('title'), year: tag('published').slice(0, 4), venue: 'arXiv', abstract }
}

// ---------- The client ----------

export const ARXIV_MIN_INTERVAL_MS = 3000
const ACCEPT_JSON = 'application/json'

export interface AbstractClientOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface AbstractClient {
  /** The abstract behind a reference-list entry's text. Successes — also a
   *  work found without an abstract — and «could not identify» are cached for
   *  the session (Crossref asks for exactly that); «nothing answered» never
   *  is, so the next click asks again. */
  lookup(entry: string): Promise<CitationAbstract | FileError>
}

const fail = (code: AbstractErrorCode, error: string): FileError => ({ error, code })

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A DOI as a URL path: each segment encoded, the slashes kept */
const doiPath = (doi: string): string => doi.split('/').map(encodeURIComponent).join('/')

export function createAbstractClient(fetchUrl: DoiFetch, opts: AbstractClientOptions = {}): AbstractClient {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const cache = new Map<string, CitationAbstract | FileError>()
  /** arXiv's terms: one request every three seconds, one at a time. A chain
   *  of promises keeps every caller in line. */
  let arxivQueue: Promise<unknown> = Promise.resolve()
  let arxivLast = -Infinity

  const arxiv = (id: string): Promise<{ status: number | null; found: Found | null }> => {
    const run = arxivQueue.then(async () => {
      const wait = arxivLast + ARXIV_MIN_INTERVAL_MS - now()
      if (wait > 0) await sleep(wait)
      arxivLast = now()
      const res = await fetchUrl(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
        'application/atom+xml'
      )
      return { status: res.status, found: res.status === 200 ? parseArxivAtom(res.text) : null }
    })
    arxivQueue = run.catch(() => undefined)
    return run
  }

  /** Crossref's reference matcher, believed only through acceptMatch */
  const match = async (entry: string): Promise<{ status: number | null; doi: string | null; meta: Meta | null }> => {
    const res = await fetchUrl(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(entry.slice(0, 600))}` +
        '&rows=3&select=DOI,title,issued,published,container-title,score',
      ACCEPT_JSON
    )
    if (res.status !== 200) return { status: res.status, doi: null, meta: null }
    const items = obj(obj(json(res.text))?.message)?.items
    if (!Array.isArray(items)) return { status: res.status, doi: null, meta: null }
    for (const raw of items) {
      const item = obj(raw)
      const doi = str(item?.DOI)
      const score = typeof item?.score === 'number' ? item.score : 0
      if (!isDoi(doi) || score < 40) continue
      const meta = crossrefMeta(item)
      if (acceptMatch(entry, meta.title, meta.year ? Number(meta.year) : null)) return { status: 200, doi, meta }
    }
    return { status: 200, doi: null, meta: null }
  }

  /** Europe PMC, Crossref and OpenAlex at once for a DOI; the first in that
   *  order with an abstract wins, the richest metadata fills the rest. */
  const byDoi = async (doi: string): Promise<{ answered: boolean; found: Found | null; source: CitationAbstract['source'] }> => {
    const [epmc, cr, oa] = await Promise.all([
      fetchUrl(
        `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}` +
          '&resultType=core&format=json&pageSize=1',
        ACCEPT_JSON
      ),
      fetchUrl(`https://api.crossref.org/works/${doiPath(doi)}`, ACCEPT_JSON),
      fetchUrl(
        `https://api.openalex.org/works/doi:${doiPath(doi)}?select=title,display_name,publication_year,primary_location,abstract_inverted_index`,
        ACCEPT_JSON
      )
    ])
    const answers: [CitationAbstract['source'], Found | null][] = [
      ['europepmc', epmc.status === 200 ? parseEuropePmc(json(epmc.text)) : null],
      ['crossref', cr.status === 200 ? parseCrossrefWork(json(cr.text)) : null],
      ['openalex', oa.status === 200 ? parseOpenAlex(json(oa.text)) : null]
    ]
    const answered = [epmc, cr, oa].some((r) => r.status !== null)
    const withAbstract = answers.find(([, f]) => f && f.abstract)
    const meta = answers.find(([s, f]) => s === 'crossref' && f?.title)?.[1] ?? answers.find(([, f]) => f?.title)?.[1] ?? null
    if (withAbstract) {
      const [source, f] = withAbstract
      return { answered, source, found: { ...f!, title: meta?.title || f!.title, year: meta?.year || f!.year, venue: meta?.venue || f!.venue } }
    }
    return { answered, source: '', found: meta ? { ...meta, abstract: '' } : null }
  }

  const resolve = async (raw: string): Promise<CitationAbstract | FileError> => {
    const entry = joinEntryLines(raw)
    if (entry.length < 12) return fail('abstract-unidentified', 'entry too short to identify')
    let doi = findDoi(entry)
    if (doi && !isDoi(doi)) doi = null
    let arxivId = findArxivId(entry)
    if (doi && /^10\.48550\/arxiv\./i.test(doi)) arxivId ??= doi.replace(/^10\.48550\/arxiv\./i, '')
    let via: CitationAbstract['via'] = doi ? 'doi' : 'arxiv'
    let matchedMeta: Meta | null = null
    let anyAnswer = false

    if (!doi && !arxivId) {
      const m = await match(entry)
      if (m.status === null) return fail('abstract-offline', 'Crossref did not answer')
      anyAnswer = true
      if (!m.doi) return fail('abstract-unidentified', 'no Crossref match passed the title/year check')
      doi = m.doi
      matchedMeta = m.meta
      via = 'match'
    }

    // By DOI first — for an arXiv paper without one, its 10.48550 DOI, which
    // OpenAlex answers in a fraction of a second. The arXiv API itself is the
    // fallback: it is the only source with EVERY arXiv abstract, but it asks
    // for one request per three seconds and answered 429 or took 10 s often
    // enough in testing (2026-10-10) that it must not stand in front.
    const lookupDoi = doi ?? `10.48550/arXiv.${arxivId!}`
    const d = await byDoi(lookupDoi)
    anyAnswer ||= d.answered
    if (!d.found?.abstract && arxivId) {
      const a = await arxiv(arxivId)
      anyAnswer ||= a.status !== null
      if (a.found) {
        return {
          ...a.found,
          title: matchedMeta?.title || d.found?.title || a.found.title,
          venue: d.found?.venue || a.found.venue,
          doi: doi ?? '',
          arxiv: arxivId,
          source: 'arxiv',
          via
        }
      }
    }
    if (!anyAnswer) return fail('abstract-offline', 'none of the sources answered')
    const meta = d.found ?? matchedMeta
    return {
      title: matchedMeta?.title || meta?.title || '',
      year: meta?.year || matchedMeta?.year || '',
      venue: meta?.venue || matchedMeta?.venue || '',
      abstract: d.found?.abstract ?? '',
      doi: doi ?? '',
      arxiv: arxivId ?? '',
      source: d.found?.abstract ? d.source : '',
      via
    }
  }

  return {
    async lookup(raw) {
      if (typeof raw !== 'string' || raw.length > 4000) return fail('abstract-unidentified', 'not an entry')
      const key = joinEntryLines(raw)
      const hit = cache.get(key)
      if (hit) return hit
      const result = await resolve(raw)
      if (!('code' in result && result.code === 'abstract-offline')) cache.set(key, result)
      return result
    }
  }
}

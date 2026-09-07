// The citation styles the save menu's reference sections offer.
//
// Both sources take a CSL style id as a request parameter — Zotero's local API
// (`&style=`) formats with the styles INSTALLED in that Zotero, doi.org
// (`text/x-bibliography; style=`) with the whole CSL repository. The list is
// therefore the intersection that is safe by default: styles Zotero 7 ships
// installed, which the CSL repository carries by the same id. A style Zotero
// happens to lack (the user removed a bundled one) is answered with a 400;
// the client then falls back to APA and says so on the hint row.
//
// The in-text form is where the two sources differ: Zotero serves it
// (`include=citation`), the registrars behind doi.org do not — so for the DOI
// reserve it is derived here from the CSL fields, per style family. Numeric
// and note styles have no in-text form worth inventing (a number depends on
// the bibliography's order, a footnote on the manuscript), so those leave the
// citation row disabled for a DOI-cited document.

export const CITATION_STYLES = [
  { id: 'apa', label: 'APA 7', inText: 'author-comma-year' },
  { id: 'chicago-author-date', label: 'Chicago (author-date)', inText: 'author-year' },
  { id: 'chicago-note-bibliography', label: 'Chicago (notes)', inText: 'none' },
  { id: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)', inText: 'author-comma-year' },
  { id: 'ieee', label: 'IEEE', inText: 'none' },
  { id: 'modern-language-association', label: 'MLA 9', inText: 'author' },
  { id: 'nature', label: 'Nature', inText: 'none' },
  { id: 'vancouver', label: 'Vancouver', inText: 'none' }
] as const

export type CitationStyleId = (typeof CITATION_STYLES)[number]['id']
type InTextForm = (typeof CITATION_STYLES)[number]['inText']

export const DEFAULT_CITATION_STYLE: CitationStyleId = 'apa'

/** The guard between renderer input and a URL parameter: only a curated id
 *  passes, so neither client can be handed an arbitrary string. */
export function isCitationStyle(s: unknown): s is CitationStyleId {
  return typeof s === 'string' && CITATION_STYLES.some((c) => c.id === s)
}

/** A stored or requested style, or the default when it is not one of ours
 *  (an older state file, garbage over IPC). */
export function citationStyleOrDefault(s: unknown): CitationStyleId {
  return isCitationStyle(s) ? s : DEFAULT_CITATION_STYLE
}

export interface InTextFields {
  title: string
  /** Family names, in order */
  creators: string[]
  year: string
}

/** The in-text citation for a style family, from CSL-level fields:
 *  APA/Harvard «(Vaswani & Shazeer, 2017)» / «(Vaswani et al., 2017)»,
 *  Chicago author-date «(Vaswani and Shazeer 2017)», MLA «(Vaswani and
 *  Shazeer)». Three or more authors shorten to «et al.» in every family
 *  (Chicago allows three names; the short form is also correct there). With
 *  no author the title stands in; with no date, «n.d.» where a date belongs.
 *  Empty for numeric/note styles, and when there is nothing to cite by. */
export function inTextCitation(item: InTextFields, style: CitationStyleId): string {
  const form: InTextForm = CITATION_STYLES.find((c) => c.id === style)?.inText ?? 'none'
  if (form === 'none') return ''
  const and = form === 'author-comma-year' ? '&' : 'and'
  const n = item.creators.length
  const who =
    n === 0
      ? item.title
      : n === 1
        ? item.creators[0]!
        : n === 2
          ? `${item.creators[0]} ${and} ${item.creators[1]}`
          : `${item.creators[0]} et al.`
  if (!who) return ''
  const year = item.year || 'n.d.'
  switch (form) {
    case 'author-comma-year':
      return `(${who}, ${year})`
    case 'author-year':
      return `(${who} ${year})`
    case 'author':
      return `(${who})`
  }
}

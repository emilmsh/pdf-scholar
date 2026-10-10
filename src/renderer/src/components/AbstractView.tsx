// What «Sammendrag» found, drawn the same way wherever it was asked for: the
// link preview's footer button (a citation in the text) and the selection
// menu (an entry selected in the reference list itself). The lookup is
// src/shared/abstract.ts behind PdfxApi.citationAbstract; this is only the
// reading of its answer.

import { forwardRef } from 'react'
import { errorText, t } from '../i18n'
import { bridge } from '../bridge'
import { doiUrl } from '../../../shared/doi'
import type { CitationAbstract, FileError } from '../../../shared/types'

export type AbstractState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; result: CitationAbstract }
  | { state: 'error'; error: FileError }

const SOURCE_NAMES: Record<Exclude<CitationAbstract['source'], ''>, string> = {
  arxiv: 'arXiv',
  europepmc: 'Europe PMC',
  crossref: 'Crossref',
  openalex: 'OpenAlex'
}

/** Title, venue · year, the abstract's paragraphs — or the calm «found it,
 *  no abstract», or the named failure with a retry when nothing answered.
 *  A work identified by MATCHING the reference text (not by a printed DOI)
 *  says so, so a wrong match can be seen for what it is. */
export const AbstractBody = forwardRef<
  HTMLDivElement,
  { abs: AbstractState; onRetry(): void; maxHeight?: number | undefined; className?: string }
>(function AbstractBody({ abs, onRetry, maxHeight, className }, ref) {
  if (abs.state !== 'done' && abs.state !== 'error') return null
  const result = abs.state === 'done' ? abs.result : null
  return (
    <div
      ref={ref}
      className={`link-preview-abstract${className ? ` ${className}` : ''}`}
      aria-live="polite"
      style={{ maxHeight }}
    >
      {result ? (
        <>
          {result.title && <div className="lpa-title">{result.title}</div>}
          {(result.year || result.venue) && (
            <div className="lpa-meta">{[result.venue, result.year].filter(Boolean).join(' · ')}</div>
          )}
          {result.abstract ? (
            result.abstract.split(/\n{2,}/).map((p, i) => (
              <p key={i} className="lpa-text">
                {p}
              </p>
            ))
          ) : (
            <p className="lpa-none">{t('linkPreview.abstractNone')}</p>
          )}
          {result.via === 'match' && <p className="lpa-note">{t('linkPreview.abstractMatched')}</p>}
        </>
      ) : (
        abs.state === 'error' && (
          <p className="lpa-none">
            {errorText(abs.error)}
            {abs.error.code === 'abstract-offline' && (
              <button type="button" className="lpa-retry" onClick={onRetry}>
                {t('linkPreview.retry')}
              </button>
            )}
          </p>
        )
      )}
    </div>
  )
})

/** «Fra Europe PMC · DOI» — where the abstract came from, and the paper */
export function AbstractSource({ abs }: { abs: AbstractState }): React.JSX.Element | null {
  const result = abs.state === 'done' ? abs.result : null
  if (!result?.source) return null
  const url = result.doi ? doiUrl(result.doi) : null
  return (
    <span className="lpa-source">
      {t('linkPreview.abstractFrom', { source: SOURCE_NAMES[result.source] })}
      {url && (
        <>
          {' · '}
          <a
            href={url}
            onClick={(e) => {
              e.preventDefault()
              bridge.openExternal(url)
            }}
          >
            DOI
          </a>
        </>
      )}
    </span>
  )
}

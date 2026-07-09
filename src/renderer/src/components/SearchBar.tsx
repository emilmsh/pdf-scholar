import { useEffect, useRef } from 'react'
import type { SearchMatch, SearchOptions } from '../search'

interface Props {
  query: string
  options: SearchOptions
  matches: SearchMatch[]
  index: number
  busy: boolean
  onQueryChange(query: string): void
  onOptionsChange(options: SearchOptions): void
  onNext(): void
  onPrev(): void
  onPick(index: number): void
  onClose(): void
}

export default function SearchBar({
  query,
  options,
  matches,
  index,
  busy,
  onQueryChange,
  onOptionsChange,
  onNext,
  onPrev,
  onPick,
  onClose
}: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    listRef.current
      ?.querySelector('.search-result.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const count = matches.length
  const status = busy
    ? 'Søker …'
    : query.trim() === ''
      ? ''
      : count === 0
        ? 'Ingen treff'
        : `${index + 1} av ${count}`

  return (
    <div className="search-bar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="search-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="Søk i dokumentet …"
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && e.shiftKey) onPrev()
            else if (e.key === 'Enter') onNext()
            else if (e.key === 'Escape') onClose()
          }}
          aria-label="Søk i dokumentet"
        />
        <span className="search-status">{status}</span>
        <button className="tb-btn" onClick={onPrev} disabled={count === 0} title="Forrige (Shift+Enter)">
          ↑
        </button>
        <button className="tb-btn" onClick={onNext} disabled={count === 0} title="Neste (Enter)">
          ↓
        </button>
        <button
          className={`tb-btn search-opt${options.matchCase ? ' is-active' : ''}`}
          onClick={() => onOptionsChange({ ...options, matchCase: !options.matchCase })}
          title="Skill mellom store og små bokstaver"
        >
          Aa
        </button>
        <button
          className={`tb-btn search-opt${options.wholeWords ? ' is-active' : ''}`}
          onClick={() => onOptionsChange({ ...options, wholeWords: !options.wholeWords })}
          title="Bare hele ord"
        >
          |ab|
        </button>
        <button className="tb-btn" onClick={onClose} title="Lukk (Esc)">
          ✕
        </button>
      </div>

      {count > 0 && (
        <div className="search-results" ref={listRef}>
          {matches.map((m, i) => (
            <button
              key={`${m.pageNumber}-${m.start}`}
              className={`search-result${i === index ? ' active' : ''}`}
              onClick={() => onPick(i)}
            >
              <span className="search-result-page">s. {m.pageNumber}</span>
              <span className="search-result-snippet">
                {m.snippet.slice(0, m.snippetOffset)}
                <mark>{m.snippet.slice(m.snippetOffset, m.snippetOffset + (m.end - m.start))}</mark>
                {m.snippet.slice(m.snippetOffset + (m.end - m.start))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

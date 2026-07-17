import { useEffect, useRef } from 'react'
import type { SearchMatch, SearchOptions } from '../search'
import { t, useLang } from '../i18n'

export interface SemanticHitView {
  label: string
  pageNumber: number | null
}

interface Props {
  query: string
  options: SearchOptions
  matches: SearchMatch[]
  index: number
  busy: boolean
  /** Search mode: exact text or AI-semantic */
  mode: 'text' | 'ai'
  onModeChange(mode: 'text' | 'ai'): void
  /** AI-mode state (only meaningful when mode === 'ai') */
  aiStatus: 'idle' | 'running' | 'done' | 'noKey' | 'error'
  aiHits: SemanticHitView[]
  aiIndex: number
  aiNote: string | null
  aiCost: string | null
  onAiSearch(): void
  onAiPick(index: number): void
  onOpenAiSettings(): void
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
  mode,
  onModeChange,
  aiStatus,
  aiHits,
  aiIndex,
  aiNote,
  aiCost,
  onAiSearch,
  onAiPick,
  onOpenAiSettings,
  onQueryChange,
  onOptionsChange,
  onNext,
  onPrev,
  onPick,
  onClose
}: Props): React.JSX.Element {
  useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isAi = mode === 'ai'

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    listRef.current
      ?.querySelector('.search-result.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [index, aiIndex])

  const count = matches.length
  const textStatus = busy
    ? t('search.searching')
    : query.trim() === ''
      ? ''
      : count === 0
        ? t('search.noMatches')
        : t('search.count', { index: index + 1, count })
  const aiStatusText =
    aiStatus === 'running'
      ? t('search.aiSearching')
      : aiStatus === 'done'
        ? aiHits.length > 0
          ? t('search.aiHits', { count: aiHits.length }) + (aiCost ? ` · ${t('search.aiCost', { cost: aiCost })}` : '')
          : t('search.aiNoHits')
        : aiStatus === 'error'
          ? t('search.searchError')
          : ''

  return (
    <div className="search-bar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="search-row">
        <div className="search-mode" role="tablist">
          <button
            className={`search-mode-btn${!isAi ? ' is-active' : ''}`}
            onClick={() => onModeChange('text')}
            title={t('search.modeTextTip')}
          >
            {t('search.modeText')}
          </button>
          <button
            className={`search-mode-btn${isAi ? ' is-active' : ''}`}
            onClick={() => onModeChange('ai')}
            title={t('search.modeAiTip')}
          >
            ✦ {t('search.modeAi')}
          </button>
        </div>
        {/* The option toggles live INSIDE the field (VS Code-style) so they
            don't shrink the visible query text by taking their own row slots */}
        <div className="search-field">
          <input
            ref={inputRef}
            value={query}
            placeholder={isAi ? t('search.aiPlaceholder') : t('search.placeholder')}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isAi) {
                if (e.key === 'Enter') onAiSearch()
                else if (e.key === 'Escape') onClose()
              } else {
                if (e.key === 'Enter' && e.shiftKey) onPrev()
                else if (e.key === 'Enter') onNext()
                else if (e.key === 'Escape') onClose()
              }
            }}
            aria-label={isAi ? t('search.aiPlaceholder') : t('search.placeholder')}
          />
          {!isAi && (
            <>
              <button
                className={`search-field-opt${options.matchCase ? ' is-active' : ''}`}
                onClick={() => onOptionsChange({ ...options, matchCase: !options.matchCase })}
                title={t('search.matchCaseTip')}
              >
                Aa
              </button>
              <button
                className={`search-field-opt${options.wholeWords ? ' is-active' : ''}`}
                onClick={() => onOptionsChange({ ...options, wholeWords: !options.wholeWords })}
                title={t('search.wholeWordsTip')}
              >
                |ab|
              </button>
            </>
          )}
        </div>
        <span className="search-status">{isAi ? aiStatusText : textStatus}</span>
        {!isAi && (
          <>
            <button className="tb-btn" onClick={onPrev} disabled={count === 0} title={t('search.prevTip')}>
              ↑
            </button>
            <button className="tb-btn" onClick={onNext} disabled={count === 0} title={t('search.nextTip')}>
              ↓
            </button>
          </>
        )}
        {isAi && aiStatus !== 'running' && (
          <button className="tb-btn" onClick={onAiSearch} disabled={query.trim() === ''} title={t('search.modeAiTip')}>
            ✦
          </button>
        )}
        <button className="tb-btn" onClick={onClose} title={t('search.closeTip')}>
          ✕
        </button>
      </div>

      {!isAi && count > 0 && (
        <div className="search-results" ref={listRef}>
          {matches.map((m, i) => (
            <button
              key={`${m.pageNumber}-${m.start}`}
              className={`search-result${i === index ? ' active' : ''}`}
              onClick={() => onPick(i)}
            >
              <span className="search-result-page">{t('app.pageAbbrev')} {m.pageNumber}</span>
              <span className="search-result-snippet">
                {m.snippet.slice(0, m.snippetOffset)}
                <mark>{m.snippet.slice(m.snippetOffset, m.snippetOffset + (m.end - m.start))}</mark>
                {m.snippet.slice(m.snippetOffset + (m.end - m.start))}
              </span>
            </button>
          ))}
        </div>
      )}

      {isAi && aiStatus === 'noKey' && (
        <div className="search-ai-note">
          {t('search.aiNoKey')}{' '}
          <button className="search-ai-link" onClick={onOpenAiSettings}>
            {t('search.aiOpenSettings')}
          </button>
        </div>
      )}
      {isAi && aiStatus === 'error' && aiNote && <div className="search-ai-note">{aiNote}</div>}
      {isAi && aiStatus === 'done' && aiHits.length === 0 && aiNote && (
        <div className="search-ai-note">{aiNote}</div>
      )}
      {isAi && aiHits.length > 0 && (
        <div className="search-results" ref={listRef}>
          {aiHits.map((h, i) => (
            <button
              key={i}
              className={`search-result${i === aiIndex ? ' active' : ''}`}
              onClick={() => onAiPick(i)}
            >
              {h.pageNumber !== null && (
                <span className="search-result-page">{t('app.pageAbbrev')} {h.pageNumber}</span>
              )}
              <span className="search-result-snippet">{h.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

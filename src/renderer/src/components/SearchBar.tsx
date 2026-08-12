import { useEffect, useRef, useState } from 'react'
import type { SearchMatch, SearchOptions } from '../search'
import { clearSearchHistory, loadSearchHistory } from '../search-history'
import { t, useLang } from '../i18n'
import { bubblesWhileTyping, withShortcut } from '../keymap'

export interface SemanticHitView {
  label: string
  pageNumber: number | null
}

interface Props {
  /** Bumped by the viewer on every open request so the input refocuses even
   *  when the bar is already mounted (Ctrl+F with a fresh selection) */
  focusToken: number
  query: string
  options: SearchOptions
  matches: SearchMatch[]
  index: number
  busy: boolean
  /** Search mode: exact text or AI-semantic */
  mode: 'text' | 'ai'
  onModeChange(mode: 'text' | 'ai'): void
  /** AI-mode state (only meaningful when mode === 'ai') */
  aiStatus: 'idle' | 'running' | 'done' | 'noKey' | 'noText' | 'error'
  aiHits: SemanticHitView[]
  aiIndex: number
  aiNote: string | null
  /** Display name of the model that will answer — the search must say which
   *  model it is about to spend the user's key on (same transparency rule as
   *  every other AI surface). Empty when no model is configured yet. */
  aiModelName: string
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
  focusToken,
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
  aiModelName,
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

  // Recent queries, offered while the field is focused and empty. Read straight
  // from the MRU module rather than threaded down as props: nothing outside this
  // bar cares about the list, and the parent has no state to keep in step.
  const [history, setHistory] = useState<string[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  /** Only while there is nothing typed — once you are typing, the results ARE
   *  the useful list, and a dropdown over them would be in the way. */
  const historyVisible = !isAi && historyOpen && query.trim() === '' && history.length > 0

  const pickHistory = (q: string): void => {
    setHistoryOpen(false)
    setHistoryIndex(-1)
    onQueryChange(q)
    inputRef.current?.focus()
  }

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    setHistory(loadSearchHistory())
    setHistoryOpen(true)
    setHistoryIndex(-1)
  }, [focusToken])

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
          ? t('search.aiHits', { count: aiHits.length })
          : t('search.aiNoHits')
        : aiStatus === 'error'
          ? t('search.searchError')
          : aiStatus === 'noText'
            ? t('search.aiNoText')
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
            onChange={(e) => {
              onQueryChange(e.target.value)
              // Emptying the field is how you ask for the list again after
              // picking from it — the same move as clearing any combobox.
              if (e.target.value.trim() === '') {
                setHistory(loadSearchHistory())
                setHistoryOpen(true)
                setHistoryIndex(-1)
              }
            }}
            onFocus={() => {
              setHistory(loadSearchHistory())
              setHistoryOpen(true)
              setHistoryIndex(-1)
            }}
            onKeyDown={(e) => {
              if (bubblesWhileTyping(e)) return // an app shortcut (find reselects, F3 steps)
              e.stopPropagation()
              if (isAi) {
                if (e.key === 'Enter') onAiSearch()
                else if (e.key === 'Escape') onClose()
                return
              }
              // While the history list is showing, the arrows and Enter belong to
              // it, and Escape dismisses it before the bar itself — the same
              // priority every other transient surface in the app follows.
              if (historyVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setHistoryIndex((i) => {
                  const next = i + step
                  if (next < 0) return -1
                  return next >= history.length ? history.length - 1 : next
                })
                return
              }
              if (historyVisible && e.key === 'Escape') {
                setHistoryOpen(false)
                return
              }
              if (e.key === 'Enter' && historyVisible && historyIndex >= 0) {
                pickHistory(history[historyIndex])
                return
              }
              if (e.key === 'Enter' && e.shiftKey) onPrev()
              else if (e.key === 'Enter') onNext()
              else if (e.key === 'Escape') onClose()
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
        {/* Which model answers, always visible in AI mode — switching it
            happens in the assistant's model menu, the tooltip says so */}
        {isAi && aiModelName && (
          <span className="search-ai-model" title={t('search.aiModelTip')}>
            {aiModelName}
          </span>
        )}
        <span className="search-status">{isAi ? aiStatusText : textStatus}</span>
        {!isAi && (
          <>
            <button className="tb-btn" onClick={onPrev} disabled={count === 0} title={withShortcut(t('search.prevTip'), 'search.prev')}>
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

      {historyVisible && (
        <div className="search-history">
          {history.map((q, i) => (
            <button
              key={q}
              className={`search-history-row${i === historyIndex ? ' active' : ''}`}
              // mousedown would blur the field before the click lands, and the
              // bar closes on focus loss — keep the focus, act on click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickHistory(q)}
            >
              {q}
            </button>
          ))}
          <button
            className="search-history-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              clearSearchHistory()
              setHistory([])
              setHistoryIndex(-1)
            }}
          >
            {t('search.historyClear')}
          </button>
        </div>
      )}

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
      {/* With hits the note is the excerpt disclaimer (huge documents are
          searched via a page excerpt); with none it is the model's answer */}
      {isAi && aiStatus === 'done' && aiNote && <div className="search-ai-note">{aiNote}</div>}
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SearchMatch, SearchOptions } from '../search'
import { clearSearchHistory, loadSearchHistory } from '../search-history'
import { loadSearchListOpen, saveSearchListOpen } from '../search-list-pref'
import { IconList } from './icons'
import { t, useLang } from '../i18n'
import { bubblesWhileTyping, withShortcut } from '../keymap'

/** Where the reader last dragged the bar, as an offset from its home in the
 *  top-right corner — kept for the SESSION (a module variable, not storage):
 *  a position measured against one window size is wrong in the next one, but
 *  within a sitting the bar should stay where it was put when it reopens. */
let barOffset = { dx: 0, dy: 0 }

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
  /** AI-mode state (only meaningful when mode === 'ai'). 'off' = the dead-man
   *  switch is on; 'confirm' = the search is staged awaiting the note's Send */
  aiStatus: 'idle' | 'running' | 'done' | 'noKey' | 'noText' | 'error' | 'off' | 'confirm'
  aiHits: SemanticHitView[]
  aiIndex: number
  aiNote: string | null
  /** Display name of the model that will answer — the search must say which
   *  model it is about to spend the user's key on (same transparency rule as
   *  every other AI surface). Empty when no model is configured yet. */
  aiModelName: string
  /** confirmed=true only from the staged note's own Send button */
  onAiSearch(confirmed?: boolean): void
  /** Dismiss a staged ('confirm') search without sending it */
  onAiCancel(): void
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
  onAiCancel,
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

  // The TEXT results list folds away to one row (the default — the open list
  // covered the hit it pointed at); unfolding is remembered across sessions.
  // The AI list never folds: it has no ↑ ↓ to step with, so the rows ARE the
  // only way to reach a hit (Emil, 2026-10-04).
  const [listOpen, setListOpen] = useState(loadSearchListOpen)
  const toggleList = (): void =>
    setListOpen((open) => {
      saveSearchListOpen(!open)
      return !open
    })
  const hasList = !isAi && matches.length > 0

  // Draggable by the grip at its left end (Emil, 2026-10-04: folded or not,
  // the bar can still sit over the one thing you need to see). The bar keeps
  // its CSS home (absolute, top-right of the viewer) and moves by a translate,
  // clamped so it never leaves the viewer — not the window: the assistant
  // panel beside the pages is not somewhere to park a search bar. gotoMatch
  // measures the bar live, so hits land clear of it wherever it is.
  const barRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(barOffset)
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null)
  /** Time of the previous grip press — two presses within a beat put the bar
   *  back home. Detected on pointerdown rather than dblclick because the
   *  press calls preventDefault, which suppresses the compat mouse events
   *  (and dblclick with them); this way a double-tap works too. */
  const lastGripDownRef = useRef(0)
  const clampOffset = (dx: number, dy: number): { dx: number; dy: number } => {
    const el = barRef.current
    const host = el?.parentElement
    if (!el || !host) return { dx, dy }
    const h = host.getBoundingClientRect()
    // The bar's HOME rect from its offset geometry, which ignores the
    // translate it carries (reading the client rect and subtracting the
    // offset would trust the translate to have been applied already)
    const home = {
      left: h.left + el.offsetLeft,
      top: h.top + el.offsetTop,
      right: h.left + el.offsetLeft + el.offsetWidth,
      bottom: h.top + el.offsetTop + el.offsetHeight
    }
    const m = 8
    return {
      dx: Math.max(h.left + m - home.left, Math.min(dx, h.right - m - home.right)),
      dy: Math.max(h.top + m - home.top, Math.min(dy, h.bottom - m - home.bottom))
    }
  }
  // A remembered offset from a wider window is pulled back inside this one
  useLayoutEffect(() => {
    const c = clampOffset(offset.dx, offset.dy)
    if (c.dx !== offset.dx || c.dy !== offset.dy) {
      barOffset = c
      setOffset(c)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const gripProps = {
    onPointerDown: (e: React.PointerEvent): void => {
      const now = performance.now()
      if (now - lastGripDownRef.current < 350) {
        // Double-click/-tap on the grip: back to the top-right home (Emil,
        // 2026-10-04 — a way back without one more control on the bar)
        lastGripDownRef.current = 0
        barOffset = { dx: 0, dy: 0 }
        setOffset(barOffset)
        e.preventDefault()
        return
      }
      lastGripDownRef.current = now
      dragRef.current = { x: e.clientX, y: e.clientY, dx: offset.dx, dy: offset.dy }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events have no active pointer to capture */
      }
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      const next = clampOffset(d.dx + e.clientX - d.x, d.dy + e.clientY - d.y)
      barOffset = next
      setOffset(next)
    },
    onPointerUp: (): void => {
      dragRef.current = null
    }
  }

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
          ? aiIndex >= 0
            ? t('search.count', { index: aiIndex + 1, count: aiHits.length })
            : t('search.aiHits', { count: aiHits.length })
          : t('search.aiNoHits')
        : aiStatus === 'error'
          ? t('search.searchError')
          : aiStatus === 'noText'
            ? t('search.aiNoText')
            : ''

  return (
    <div
      className="search-bar"
      ref={barRef}
      // The `translate` property, not `transform`: the bar's entrance
      // animation owns transform, and the two compose instead of competing
      style={offset.dx || offset.dy ? { translate: `${offset.dx}px ${offset.dy}px` } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="search-row">
        <span className="search-grip" title={t('search.dragTip')} {...gripProps} />
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
        {/* The fold toggle sits right after the field, away from ↑ ↓: a
            chevron next to the step arrows read as a third arrow (Emil,
            2026-10-04), so it is a list glyph, lit while the list is open */}
        {hasList && (
          <button
            className={`tb-btn search-list-toggle${listOpen ? ' is-open' : ''}`}
            onClick={toggleList}
            title={t(listOpen ? 'search.listHide' : 'search.listShow')}
            aria-expanded={listOpen}
          >
            <IconList size={15} />
          </button>
        )}
        <span className="search-status">{isAi ? aiStatusText : textStatus}</span>
        {/* ↑ ↓ step whichever list is showing — the AI passages too */}
        <button
          className="tb-btn"
          onClick={onPrev}
          disabled={isAi ? aiHits.length === 0 : count === 0}
          title={withShortcut(t('search.prevTip'), 'search.prev')}
        >
          ↑
        </button>
        <button
          className="tb-btn"
          onClick={onNext}
          disabled={isAi ? aiHits.length === 0 : count === 0}
          title={isAi ? withShortcut(t('search.nextTipAi'), 'search.next') : t('search.nextTip')}
        >
          ↓
        </button>
        {isAi && aiStatus !== 'running' && (
          <button className="tb-btn" onClick={() => onAiSearch()} disabled={query.trim() === ''} title={t('search.modeAiTip')}>
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

      {!isAi && count > 0 && listOpen && (
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
      {isAi && aiStatus === 'off' && (
        <div className="search-ai-note">
          {t('search.aiOff')}{' '}
          <button className="search-ai-link" onClick={onOpenAiSettings}>
            {t('search.aiOpenSettings')}
          </button>
        </div>
      )}
      {/* «Bekreft hver forespørsel»: the staged search says what would be sent
          and to which model, and waits for its own Send */}
      {isAi && aiStatus === 'confirm' && (
        <div className="search-ai-note">
          {t('ai.confirmSearch', { name: aiModelName })}{' '}
          <button className="search-ai-link" onClick={() => onAiSearch(true)}>
            {t('ai.confirmGo')}
          </button>
          {' · '}
          <button className="search-ai-link" onClick={onAiCancel}>
            {t('app.cancel')}
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

// The composer's «Samtaler» picker (issue #46): which earlier conversations
// go along with this conversation's questions as context. Nothing is picked
// for the reader — no suggestion is ticked, no attachment is made without
// «Legg ved» — and the note says plainly what leaves and to whom: the
// questions and answers of what is ticked, which may quote other documents,
// to the model named. The rules for what the model is told live in
// src/shared/conversation-context.ts.
//
// A bubble like the panel's others: Esc and a click outside close it
// (Emil: every bubble closes that way), the search runs where the store is.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationHit } from '../chat-store'
import { listAllConversations, searchAllConversations } from '../chat-store'
import type { AttachedConversation } from '../../../shared/conversation-context'
import { MAX_ATTACHED, sameConversation } from '../../../shared/conversation-context'
import { locale, t } from '../i18n'

interface Props {
  /** The document this panel is on, and its open conversation (never offered) */
  docPath: string
  activeId: string | null
  attached: AttachedConversation[]
  /** Who the attached text goes to, for the note */
  receiverName: string
  onApply(list: AttachedConversation[]): void
  onClose(): void
}

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })

export default function ConversationPicker({ docPath, activeId, attached, receiverName, onApply, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ConversationHit[] | null>(null)
  const [picked, setPicked] = useState<AttachedConversation[]>(attached)
  const rootRef = useRef<HTMLDivElement>(null)

  // The list, or the search's hits, a moment after typing stops
  useEffect(() => {
    let stale = false
    const id = window.setTimeout(
      () => {
        const load = query.trim()
          ? searchAllConversations(query)
          : listAllConversations().then((l) => l.map((c) => ({ ...c, snippet: null })))
        void load.then((h) => {
          if (!stale) setHits(h)
        })
      },
      query.trim() ? 150 : 0
    )
    return () => {
      stale = true
      window.clearTimeout(id)
    }
  }, [query])

  // Esc and a click outside close it, like every bubble in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  const rows = useMemo(
    () => (hits ?? []).filter((h) => !(h.docPath === docPath && h.id === activeId)),
    [hits, docPath, activeId]
  )
  const isPicked = (h: { docPath: string; id: string }): boolean => picked.some((p) => sameConversation(p, h))
  const full = picked.length >= MAX_ATTACHED

  const toggle = (h: ConversationHit): void => {
    setPicked((list) =>
      list.some((p) => sameConversation(p, h))
        ? list.filter((p) => !sameConversation(p, h))
        : list.length >= MAX_ATTACHED
          ? list
          : [...list, { docPath: h.docPath, docName: h.docName, id: h.id, title: h.title }]
    )
  }

  return (
    <div className="ai-conv-picker" ref={rootRef} role="dialog" aria-label={t('ai.attachConvsTitle')}>
      <div className="ai-conv-picker-head">{t('ai.attachConvsTitle')}</div>
      <p className="ai-conv-picker-note">{t('ai.attachConvsNote', { name: receiverName || t('ai.attachConvsModel') })}</p>
      <input
        className="ai-history-search"
        type="search"
        placeholder={t('ai.historySearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="ai-conv-picker-list">
        {hits === null ? null : rows.length === 0 ? (
          <p className="ai-history-empty">{t(query.trim() ? 'ai.historyNoHits' : 'ai.attachConvsNone')}</p>
        ) : (
          rows.map((h) => {
            const on = isPicked(h)
            return (
              <label key={`${h.docPath}\u0000${h.id}`} className={`ai-conv-pick${on ? ' is-on' : ''}`}>
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(h)} />
                <span className="ai-conv-pick-text">
                  <span className="ai-history-title">{h.title}</span>
                  <span className="ai-history-doc">
                    {h.docPath === docPath ? t('ai.attachConvsThisDoc') : h.docName}
                  </span>
                  <span className="ai-history-meta">
                    {formatDate(h.updatedAt)} · {t('ai.historyMessages', { count: String(h.messageCount) })}
                  </span>
                  {h.snippet && <span className="ai-history-snippet">{h.snippet}</span>}
                </span>
              </label>
            )
          })
        )}
      </div>
      <div className="ai-conv-picker-foot">
        <span className="ai-conv-picker-count">
          {t('ai.attachConvsCount', { count: String(picked.length), max: String(MAX_ATTACHED) })}
        </span>
        <button className="btn-secondary" onClick={onClose}>
          {t('app.cancel')}
        </button>
        <button className="btn-primary" onClick={() => onApply(picked)}>
          {t('ai.attachConvsApply')}
        </button>
      </div>
    </div>
  )
}

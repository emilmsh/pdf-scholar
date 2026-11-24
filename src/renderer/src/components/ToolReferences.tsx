// What an AI tool outside the app pointed at and read (shared/tool-bridge.ts),
// in the assistant panel: the list a reader takes at their own pace (Emil,
// 2026-11-24). A tool that only moved the reader to a passage would leave
// nothing behind once they looked elsewhere; here each claim keeps its page
// chip, the same pill as a source in the assistant's own answers, and it can
// be pressed again whenever.
//
// Two pieces, both hosted by AiPanel: the sessions as rows at the top of the
// history view, and one session's list in place of the conversation. A
// session spans documents (reading literature hops between papers), so the
// list shows this document's references first and every document's on a
// switch; a reference into another document opens it on the passage.
//
// What a tool READ is listed too, quietly, between the references: «Leste
// teksten, s. 1–15», «Leste markeringen din». The reader should be able to
// see what left, not only what was shown.
import { useCallback, useEffect, useState } from 'react'
import type { McpClient } from '../../../shared/mcp'
import type { ToolEntry, ToolSession, ToolSessionMeta } from '../../../shared/tool-bridge'
import { bridge } from '../bridge'
import { locale, t, useLang } from '../i18n'
import { pathKey } from '../tool-bridge'

const clientName = (client: McpClient): string =>
  client === 'claude' ? 'Claude' : client === 'codex' ? 'Codex' : t('tool.clientOther')

const refCount = (n: number): string => t(n === 1 ? 'tool.refsOne' : 'tool.refsMany', { count: String(n) })

const day = (ms: number): string => new Date(ms).toLocaleDateString(locale())

/** The sessions of AI tools, as rows for the history view. Draws nothing
 *  while there are none — a reader who never turned «Les sammen» on never
 *  sees a heading about it. */
export function ToolSessionRows({
  docPath,
  onOpen
}: {
  docPath: string
  onOpen(sessionId: string): void
}): React.JSX.Element | null {
  useLang()
  const [sessions, setSessions] = useState<ToolSessionMeta[]>([])

  useEffect(() => {
    let live = true
    const load = (): void => {
      void bridge.toolSessions().then((list) => live && setSessions(list))
    }
    load()
    const off = bridge.onToolSessionsChanged(load)
    return () => {
      live = false
      off()
    }
  }, [])

  // The ones that pointed into this document first; a session that only read
  // has nothing to come back to and is not listed
  const here = pathKey(docPath)
  const listed = sessions
    .filter((s) => s.references > 0)
    .sort((a, b) => Number(b.documents.some((d) => pathKey(d) === here)) - Number(a.documents.some((d) => pathKey(d) === here)))
  if (listed.length === 0) return null

  return (
    <div className="tool-sessions">
      <div className="ai-history-heading">{t('tool.sessionsHeading')}</div>
      {listed.map((s) => (
        <div key={s.id} className="ai-history-item" onClick={() => onOpen(s.id)}>
          <span className="ai-history-title">{s.title || t('tool.sessionUntitled')}</span>
          <span className="ai-history-meta">
            {clientName(s.client)} · {day(s.updatedAt)} · {refCount(s.references)}
            {s.documents.length > 1 ? ` · ${t('tool.docsMany', { count: String(s.documents.length) })}` : ''}
          </span>
          <button
            className="ai-history-delete"
            title={t('tool.deleteTip')}
            onClick={(e) => {
              e.stopPropagation()
              void bridge.removeToolSession(s.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function quietLine(e: Exclude<ToolEntry, { kind: 'reference' }>): string {
  if (e.kind === 'read') {
    return e.from === e.to
      ? t('tool.readPage', { page: String(e.from) })
      : t('tool.readPages', { from: String(e.from), to: String(e.to) })
  }
  if (!e.docPath) return t('tool.sawWithheld')
  return t(e.selection ? 'tool.sawSelection' : 'tool.sawOpen')
}

/** One session's list, in place of the conversation */
export function ToolSessionView({
  sessionId,
  docPath,
  onBack,
  onShow
}: {
  sessionId: string
  docPath: string
  onBack(): void
  /** Go to a reference: here when it is in this document, else in its own */
  onShow(entry: Extract<ToolEntry, { kind: 'reference' }>): void
}): React.JSX.Element {
  useLang()
  /** undefined = loading; null = gone (deleted from another window) */
  const [session, setSession] = useState<ToolSession | null | undefined>(undefined)
  /** null = not chosen yet: this document's when it has any, else every one */
  const [onlyHere, setOnlyHere] = useState<boolean | null>(null)

  const load = useCallback(() => {
    void bridge.toolSession(sessionId).then(setSession)
  }, [sessionId])

  useEffect(() => {
    setSession(undefined)
    setOnlyHere(null)
    load()
    return bridge.onToolSessionsChanged((change) => {
      if (change.sessionId === sessionId) load()
    })
  }, [sessionId, load])

  const here = pathKey(docPath)
  const mine = (e: ToolEntry): boolean => e.docPath !== undefined && pathKey(e.docPath) === here
  const entries = session?.entries ?? []
  const hasHere = entries.some((e) => e.kind === 'reference' && mine(e))
  const elsewhere = entries.some((e) => e.kind === 'reference' && !mine(e))
  const filtered = onlyHere ?? hasHere
  const shown = filtered ? entries.filter(mine) : entries

  return (
    <div className="ai-history tool-session">
      <button className="tool-session-back" onClick={onBack}>
        ‹ {t('tool.back')}
      </button>
      {session === undefined ? null : session === null ? (
        <p className="ai-history-empty">{t('tool.gone')}</p>
      ) : (
        <>
          <div className="tool-session-title">{session.title || t('tool.sessionUntitled')}</div>
          <div className="ai-history-meta tool-session-meta">
            {clientName(session.client)} · {day(session.startedAt || session.updatedAt)}
          </div>
          {hasHere && elsewhere && (
            <label className="theme-menu-toggle ai-history-scope">
              <span>{t('tool.onlyThisDoc')}</span>
              <input type="checkbox" checked={filtered} onChange={(e) => setOnlyHere(e.target.checked)} />
            </label>
          )}
          {shown.length === 0 ? (
            <p className="ai-history-empty">{t('tool.emptyHere')}</p>
          ) : (
            shown.map((e) =>
              e.kind === 'reference' ? (
                <div key={e.id} className={`tool-ref${e.found ? '' : ' is-missing'}`}>
                  {/* The number the tool wrote beside its claim («… [3]»):
                      what tells the reader which sentence this card backs */}
                  <span className="tool-ref-n">[{e.n}]</span>
                  {e.claim && <p className="tool-ref-claim">{e.claim}</p>}
                  <p className="tool-ref-quote">
                    «{e.quote.length > 260 ? `${e.quote.slice(0, 259)}…` : e.quote}»
                  </p>
                  <div className="tool-ref-foot">
                    <button
                      className="ai-chip"
                      title={t(mine(e) ? 'ai.chipTip' : 'tool.openElsewhereTip')}
                      onClick={() => onShow(e)}
                    >
                      {t('app.pageAbbrev')} {e.page}
                    </button>
                    {!filtered && <span className="ai-history-doc">{e.docName}</span>}
                    {!e.found ? (
                      <span className="tool-ref-flag">{t('tool.notFound')}</span>
                    ) : !e.whole ? (
                      <span className="tool-ref-flag is-part">{t('tool.partly')}</span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p key={e.id} className="tool-ref-quiet">
                  {quietLine(e)}
                  {!filtered && e.docName ? ` · ${e.docName}` : ''}
                </p>
              )
            )
          )}
        </>
      )}
    </div>
  )
}

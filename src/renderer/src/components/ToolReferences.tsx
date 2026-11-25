// What AI tools outside the app pointed at and read (shared/tool-bridge.ts),
// in the assistant panel: the list a reader takes at their own pace (Emil,
// 2026-11-24). A tool that only moved the reader to a passage would leave
// nothing behind once they looked elsewhere; here each claim keeps its page
// chip, the same pill as a source in the assistant's own answers, and it can
// be pressed again whenever.
//
// ONE list of references, not a list of sessions to go into (Emil,
// 2026-11-25). The first shape — a row per session of the tool in the history
// view, each opening its own list — put twenty rows named «Henvisninger» above
// the reader's own conversations in a day, and made them guess which session a
// passage was in. The question asked in a reader is «what has the tool pointed
// at in THIS document», so that is what opens: this document's references,
// newest first. The session is something to GROUP by, like the document, and
// the same three choices as the Sources pane of the Claude Code plugin (Show
// your work): what is shown, how it is grouped, how it is sorted.
//
// On disk nothing changed: references are still kept per session
// (main/tool-sessions.ts), which is what gives each its number and lets a
// whole session be deleted — from its heading, when grouped by session.
//
// What a tool READ is listed too, quietly, among the references: «Leste
// teksten, s. 1–15», «Leste markeringen din». The reader should be able to
// see what left, not only what was shown.
import { useCallback, useEffect, useState } from 'react'
import type { McpClient } from '../../../shared/mcp'
import type { ToolEntry, ToolReference, ToolSession, ToolSessionMeta } from '../../../shared/tool-bridge'
import { bridge } from '../bridge'
import { locale, t, useLang } from '../i18n'
import { pathKey } from '../tool-bridge'

const clientName = (client: McpClient): string =>
  client === 'claude' ? 'Claude' : client === 'codex' ? 'Codex' : t('tool.clientOther')

const refCount = (n: number): string => t(n === 1 ? 'tool.refsOne' : 'tool.refsMany', { count: String(n) })

const day = (ms: number): string => new Date(ms).toLocaleDateString(locale())

/** The history view's ONE row for everything AI tools have pointed at. Draws
 *  nothing while there is nothing — a reader who never turned «Les sammen» on
 *  never sees a word about it. */
export function ToolReferencesRow({ onOpen }: { onOpen(): void }): React.JSX.Element | null {
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

  // A session that only read has nothing to come back to
  const references = sessions.reduce((sum, s) => sum + s.references, 0)
  if (references === 0) return null
  const latest = Math.max(...sessions.map((s) => s.updatedAt))

  return (
    <div className="tool-sessions">
      {/* Says what it is, and on hover what it is NOT: a reader looking for
          their own conversations should not have to wonder (Emil, 2026-11-24) */}
      <div className="ai-history-item tool-sessions-row" title={t('tool.sessionsTip')} onClick={onOpen}>
        <span className="ai-history-title">{t('tool.sessionsHeading')}</span>
        <span className="ai-history-meta">
          {refCount(references)} · {day(latest)}
        </span>
      </div>
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

/** What is shown, how it is grouped, how it is sorted */
const SHOWS = ['here', 'all', 'missing'] as const
const GROUPS = ['none', 'session', 'doc'] as const
const SORTS = ['newest', 'page'] as const
type Show = (typeof SHOWS)[number]
type Group = (typeof GROUPS)[number]
type Sort = (typeof SORTS)[number]

const oneOf = <T extends string>(all: readonly T[], value: string, otherwise: T): T =>
  (all as readonly string[]).includes(value) ? (value as T) : otherwise

/** An entry with the session it is kept in */
type Row = { entry: ToolEntry; session: ToolSession }

/** A session as a heading says it: the topic its tool gave, else the tool and the day */
const sessionName = (s: ToolSession): string =>
  `${s.title ? `${s.title} · ` : ''}${clientName(s.client)} · ${day(s.startedAt || s.updatedAt)}`

/** Every reference AI tools have left, as one list in place of the conversation */
export function ToolReferencesView({
  docPath,
  onBack,
  onShow
}: {
  docPath: string
  onBack(): void
  /** Go to a reference: here when it is in this document, else in its own */
  onShow(entry: ToolReference): void
}): React.JSX.Element {
  useLang()
  /** undefined = loading */
  const [sessions, setSessions] = useState<ToolSession[] | undefined>(undefined)
  /** null = not chosen yet: this document's when it has any, else every one */
  const [show, setShow] = useState<Show | null>(null)
  const [group, setGroup] = useState<Group>('none')
  const [sort, setSort] = useState<Sort>('newest')

  const load = useCallback(() => {
    void bridge
      .toolSessions()
      .then((metas) => Promise.all(metas.map((m) => bridge.toolSession(m.id))))
      .then((all) => setSessions(all.filter((s): s is ToolSession => s !== null)))
  }, [])

  useEffect(() => {
    load()
    return bridge.onToolSessionsChanged(load)
  }, [load])

  const here = pathKey(docPath)
  const mine = (e: ToolEntry): boolean => e.docPath !== undefined && pathKey(e.docPath) === here
  const rows: Row[] = (sessions ?? []).flatMap((session) => session.entries.map((entry) => ({ entry, session })))
  const hasHere = rows.some((r) => r.entry.kind === 'reference' && mine(r.entry))
  const showing: Show = show ?? (hasHere ? 'here' : 'all')

  // What a tool read is listed where the list is told in time; a list by
  // page, and one of what was not found, is of references alone
  const kept = rows.filter(({ entry }) =>
    showing === 'missing'
      ? entry.kind === 'reference' && !entry.found
      : (showing === 'all' || mine(entry)) && (entry.kind === 'reference' || sort === 'newest')
  )
  const byName = (a: Row, b: Row): number =>
    (a.entry.docName ?? '').localeCompare(b.entry.docName ?? '', locale(), { numeric: true })
  const pageOf = (e: ToolEntry): number => (e.kind === 'reference' ? e.page : e.kind === 'read' ? e.from : 0)
  const sorted = [...kept].sort((a, b) =>
    sort === 'page' ? byName(a, b) || pageOf(a.entry) - pageOf(b.entry) || a.entry.at - b.entry.at : b.entry.at - a.entry.at
  )

  type Section = { key: string; title: string; session?: ToolSession; rows: Row[] }
  const sections: Section[] = []
  if (group === 'none') sections.push({ key: 'all', title: '', rows: sorted })
  else {
    for (const row of sorted) {
      const key = group === 'session' ? row.session.id : pathKey(row.entry.docPath ?? '')
      let section = sections.find((s) => s.key === key)
      if (!section) {
        section =
          group === 'session'
            ? { key, title: sessionName(row.session), session: row.session, rows: [] }
            : { key, title: row.entry.docName ?? t('tool.noDocument'), rows: [] }
        sections.push(section)
      }
      section.rows.push(row)
    }
  }

  const references = rows.filter((r) => r.entry.kind === 'reference').length
  const showsDoc = showing !== 'here' && group !== 'doc'
  const pick = <T extends string>(
    label: string,
    value: T,
    all: readonly T[],
    name: (v: T) => string,
    set: (v: T) => void,
    key: string
  ): React.JSX.Element => (
    <label className="convs-sort tool-refs-pick">
      {label}{' '}
      <select data-pick={key} value={value} onChange={(e) => set(oneOf(all, e.target.value, value))}>
        {all.map((v) => (
          <option key={v} value={v}>
            {name(v)}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div className="ai-history tool-session">
      <button className="tool-session-back" onClick={onBack}>
        ‹ {t('tool.back')}
      </button>
      <div className="tool-session-title">{t('tool.sessionsHeading')}</div>
      {sessions === undefined ? null : references === 0 ? (
        <p className="ai-history-empty">{t('tool.emptyShown')}</p>
      ) : (
        <>
          <div className="tool-refs-controls">
            {pick(t('tool.show'), showing, SHOWS, (v) => t(`tool.show_${v}` as const), setShow, 'show')}
            {pick(t('tool.group'), group, GROUPS, (v) => t(`tool.group_${v}` as const), setGroup, 'group')}
            {pick(t('tool.sort'), sort, SORTS, (v) => t(`tool.sort_${v}` as const), setSort, 'sort')}
          </div>
          {sorted.length === 0 ? (
            <p className="ai-history-empty">{t(showing === 'here' ? 'tool.emptyHere' : 'tool.emptyShown')}</p>
          ) : (
            sections.map((section) => (
              <div key={section.key} className="tool-refs-section">
                {section.title && (
                  <div className="tool-refs-heading">
                    <span className="tool-refs-heading-name">
                      {section.title} ({section.rows.filter((r) => r.entry.kind === 'reference').length})
                    </span>
                    {section.session && (
                      <button
                        className="ai-history-delete"
                        title={t('tool.deleteTip')}
                        onClick={() => void bridge.removeToolSession(section.key)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
                {section.rows.map(({ entry: e }) =>
                  e.kind === 'reference' ? (
                    <div key={e.id} className={`tool-ref${e.found ? '' : ' is-missing'}`}>
                      {/* The number the tool wrote beside its claim («… [3]»)
                          is the session's own, so it stands only where the
                          session does: under its heading. In one list across
                          sessions several cards would be «[1]». */}
                      {group === 'session' && <span className="tool-ref-n">[{e.n}]</span>}
                      {e.claim && <p className="tool-ref-claim">{e.claim}</p>}
                      <p className="tool-ref-quote">«{e.quote.length > 260 ? `${e.quote.slice(0, 259)}…` : e.quote}»</p>
                      <div className="tool-ref-foot">
                        <button
                          className="ai-chip"
                          title={t(mine(e) ? 'ai.chipTip' : 'tool.openElsewhereTip')}
                          onClick={() => onShow(e)}
                        >
                          {t('app.pageAbbrev')} {e.page}
                        </button>
                        {showsDoc && <span className="ai-history-doc">{e.docName}</span>}
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
                      {showsDoc && e.docName ? ` · ${e.docName}` : ''}
                    </p>
                  )
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  )
}

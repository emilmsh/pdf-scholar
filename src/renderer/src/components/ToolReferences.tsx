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

const day = (ms: number): string => new Date(ms).toLocaleDateString(locale())

/** How many references outside AI tools have left, and how many of them the
 *  reader has not had the list open for since (the tab's badge). «Seen» is a
 *  count, not a set: deleting a session lowers the total and the badge is
 *  clamped at zero, which is all a badge needs. */
const SEEN_KEY = 'pdfx.toolRefsSeen'
const readSeen = (): number => {
  try {
    const n = Number(localStorage.getItem(SEEN_KEY))
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Whether the right panel should carry the «Henvisninger» tab at all, and
 *  what its badge says. The tab is there while «Les sammen» is on OR any
 *  reference is kept — a reader who never turned it on never sees a word
 *  about it, and one who turned it off can still go back to what was left. */
export function useToolReferences(): { references: number; live: boolean; unread: number; markSeen(): void } {
  const [references, setReferences] = useState(0)
  const [live, setLive] = useState(false)
  const [seen, setSeen] = useState(readSeen)

  useEffect(() => {
    let on = true
    const load = (): void => {
      // A session that only read has nothing to come back to
      void bridge.toolSessions().then((list: ToolSessionMeta[]) => {
        if (on) setReferences(list.reduce((sum, s) => sum + s.references, 0))
      })
      void bridge.mcpPolicy().then((p) => on && setLive(p?.live === true))
      setSeen(readSeen())
    }
    load()
    const off = bridge.onToolSessionsChanged(load)
    // The switch lives in a dialog of its own; it is turned on there and
    // then the reader comes back to the window
    window.addEventListener('focus', load)
    return () => {
      on = false
      off()
      window.removeEventListener('focus', load)
    }
  }, [])

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, String(references))
    } catch {
      /* a badge that comes back is no harm */
    }
    setSeen(references)
  }, [references])

  return { references, live, unread: Math.max(0, references - seen), markSeen }
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

/** Every reference AI tools have left, as one list: the right panel's
 *  «Henvisninger» tab, beside the assistant rather than inside its history
 *  (Emil, 2026-11-26 — what a tool outside the app pointed at is not one of
 *  the reader's conversations with the app's own assistant) */
export function ToolReferencesView({
  docPath,
  onShow
}: {
  docPath: string
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
  /** The groups folded away, by their key. A grouping's keys are its own
   *  (session ids, document paths), so changing the grouping starts open */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (key: string): void =>
    setFolded((was) => {
      const next = new Set(was)
      if (!next.delete(key)) next.add(key)
      return next
    })

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
    <label className="convs-sort tool-refs-pick" title={label}>
      <select
        data-pick={key}
        aria-label={label}
        value={value}
        onChange={(e) => set(oneOf(all, e.target.value, value))}
      >
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
                    {/* A group folds like one in a file manager: the whole
                        heading is the handle, the chevron says which way */}
                    <button
                      type="button"
                      className="tool-refs-fold"
                      aria-expanded={!folded.has(section.key)}
                      onClick={() => fold(section.key)}
                    >
                      <span
                        className={`outline-chevron${folded.has(section.key) ? '' : ' expanded'}`}
                        aria-hidden="true"
                      >
                        ›
                      </span>
                      <span className="tool-refs-heading-name">
                        {section.title} ({section.rows.filter((r) => r.entry.kind === 'reference').length})
                      </span>
                    </button>
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
                {(section.title && folded.has(section.key) ? [] : section.rows).map(({ entry: e }) =>
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

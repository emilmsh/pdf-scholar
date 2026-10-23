// The library's «Samtaler» view (issue #46): every conversation the store
// keeps, by document — searched, read in place, opened in its document,
// tidied and exported. The rules (grouping, what each tidying takes) live in
// src/shared/chat-library.ts; this is the surface.
//
// Reading happens HERE, not in a box: a conversation opens as the page's own
// content and the page scrolls (Emil, 2026-10-10: rich content in a small
// scrolling box inside the page is a keyhole). The list keeps the library's
// one-box layout, like «Nylig lest» as a list.
//
// Tidying is one-off and counted: each action says what it will take before
// it takes anything, and asks once more, since none of them can be undone.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AiCitation, GoneDocument } from '../../../shared/types'
import type { ConversationHit, ConversationMeta, StoredConversation } from '../chat-store'
import {
  CONVERSATION_HANDOFF_EVENT,
  loadConversations,
  notifyChangedHere,
  requestConversationOpen,
  saveConversations,
  searchAllConversations
} from '../chat-store'
import { withoutImages } from '../../../shared/chat-history'
import type { ConversationFilter, ConversationSort, Selection } from '../../../shared/chat-library'
import {
  AGE_CHOICES,
  KEEP_CHOICES,
  SORTS,
  applyFilter,
  customNumber,
  formatBytes,
  monthsBefore,
  sortGroups,
  sortOrDefault,
  selectBeyondNewest,
  selectOlderThan,
  selectionImages,
  selectionSize,
  selectWithImages,
  storageTotals
} from '../../../shared/chat-library'
import { libraryJson, libraryMarkdown } from '../chat-export'
import { bridge } from '../bridge'
import { errorText, locale, t } from '../i18n'
import { AssistantBody } from './ai-markdown'
import { IconArrowLeft, IconDocument, IconExternal } from './icons'

interface Props {
  /** Every conversation's summary, newest first (the library loads it) */
  conversations: ConversationMeta[]
  /** Show one document's conversations only — the library's «Vis samtaler»
   *  on a recents entry; null for all. The view's own chip clears it. */
  docFilter: string | null
  onDocFilterChange(path: string | null): void
  /** Reload after a change made here */
  onChanged(): void
  /** Open a document (a tab here, the one document of the extension) */
  onOpenDocument(path: string): Promise<void> | void
  /** The recents may have changed (a forgotten document leaves them) */
  onRecentsMaybeChanged(): void
  /** The view's own state the library head shows */
  tidyOpen: boolean
  onTidyOpenChange(open: boolean): void
  /** True while a conversation is open for reading — the page scrolls then */
  onReadingChange(reading: boolean): void
}

/** What waits for the second click */
type Pending =
  | { kind: 'delete'; key: 'older' | 'keep'; sel: Selection }
  | { kind: 'images'; key: 'images'; sel: Selection }
  | { kind: 'forget'; key: 'gone'; docs: GoneDocument[] }

const recentLocation = (path: string): string => (path.startsWith('fsa:') ? t('doc.pickedHint') : path)

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })

const SORT_KEY = 'pdfx-conversations-sort'
function loadSort(): ConversationSort {
  try {
    return sortOrDefault(localStorage.getItem(SORT_KEY))
  } catch {
    return 'updated'
  }
}

/** The «Egendefinert» choice in the age and keep menus */
const CUSTOM = -1

const ageLabel = (months: number): string =>
  months % 12 === 0 ? t('lib.ageYears', { n: String(months / 12) }) : t('lib.ageMonths', { n: String(months) })

export default function ConversationsLibrary({
  conversations,
  docFilter,
  onDocFilterChange,
  onChanged,
  onOpenDocument,
  onRecentsMaybeChanged,
  tidyOpen,
  onTidyOpenChange,
  onReadingChange
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [reading, setReading] = useState<{ docPath: string; docName: string; conv: StoredConversation } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [gone, setGone] = useState<GoneDocument[] | null>(null)
  const [age, setAge] = useState<number>(12)
  const [keep, setKeep] = useState<number>(100)
  const [ageCustom, setAgeCustom] = useState('')
  const [keepCustom, setKeepCustom] = useState('')
  const [sort, setSortState] = useState<ConversationSort>(loadSort)
  const [filter, setFilter] = useState<Omit<ConversationFilter, 'doc'>>({ missing: false, images: false })
  /** The search's hits, from where the store is (null = no query) */
  const [hits, setHits] = useState<ConversationHit[] | null>(null)
  const setSort = (s: ConversationSort): void => {
    setSortState(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      /* remembered for this visit only */
    }
  }
  const goneSet = useMemo(() => new Set((gone ?? []).map((d) => d.path)), [gone])

  useEffect(() => onReadingChange(reading !== null), [reading, onReadingChange])
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(id)
  }, [notice])

  // The search runs where the store is, a moment after typing stops
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    let stale = false
    const id = window.setTimeout(() => {
      void searchAllConversations(query).then((h) => {
        if (!stale) setHits(h)
      })
    }, 150)
    return () => {
      stale = true
      window.clearTimeout(id)
    }
  }, [query, conversations])

  const groups = useMemo(() => {
    const base: ConversationHit[] = hits ?? conversations.map((c) => ({ ...c, snippet: null }))
    return sortGroups(applyFilter(base, { ...filter, doc: docFilter }, goneSet), sort)
  }, [hits, conversations, filter, docFilter, goneSet, sort])
  const totals = useMemo(() => storageTotals(conversations), [conversations])
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of conversations) if (!m.has(c.docPath)) m.set(c.docPath, c.docName)
    return m
  }, [conversations])

  // The documents whose file is gone: looked for when the view opens and
  // whenever the conversations change — the tag on a group, the «Filen
  // mangler» filter and the tidying's first row all read this one answer
  useEffect(() => {
    let stale = false
    void bridge.goneDocuments().then((list) => {
      if (!stale) setGone(list)
    })
    return () => {
      stale = true
    }
  }, [conversations])

  /** The age and count in force — a custom one only once it is a number */
  const ageMonths = age === CUSTOM ? customNumber(ageCustom, 1, 600) : age
  const keepCount = keep === CUSTOM ? customNumber(keepCustom, 0, 1_000_000) : keep
  const olderSel = useMemo<Selection>(
    () => (ageMonths === null ? new Map() : selectOlderThan(conversations, monthsBefore(Date.now(), ageMonths))),
    [conversations, ageMonths]
  )
  const keepSel = useMemo<Selection>(
    () => (keepCount === null ? new Map() : selectBeyondNewest(conversations, keepCount)),
    [conversations, keepCount]
  )
  const imageSel = useMemo(() => selectWithImages(conversations), [conversations])

  // ---------- Opening and reading ----------

  const openInDocument = useCallback(
    async (docPath: string, id: string, citation?: AiCitation): Promise<void> => {
      requestConversationOpen(docPath, id, citation)
      await onOpenDocument(docPath)
      // A tab that already shows the document looks for the handoff now
      window.dispatchEvent(new Event(CONVERSATION_HANDOFF_EVENT))
    },
    [onOpenDocument]
  )

  const read = useCallback(async (c: ConversationMeta): Promise<void> => {
    const conv = (await loadConversations(c.docPath)).find((x) => x.id === c.id)
    if (conv) {
      setReading({ docPath: c.docPath, docName: c.docName, conv })
      window.scrollTo?.(0, 0)
    }
  }, [])

  // ---------- Changing the store ----------

  /** Rewrite each selected document's list through `change`, then reload */
  const rewrite = useCallback(
    async (sel: Selection, change: (list: StoredConversation[], ids: Set<string>) => StoredConversation[]) => {
      for (const [path, ids] of sel) {
        const list = await loadConversations(path)
        await saveConversations(path, nameOf.get(path) ?? '', change(list, ids))
        notifyChangedHere(path)
      }
      onChanged()
    },
    [nameOf, onChanged]
  )

  const deleteOne = useCallback(
    async (docPath: string, id: string): Promise<void> => {
      await rewrite(new Map([[docPath, new Set([id])]]), (list, ids) => list.filter((c) => !ids.has(c.id)))
      if (reading?.conv.id === id && reading.docPath === docPath) setReading(null)
    },
    [rewrite, reading]
  )

  const carryOut = useCallback(async (): Promise<void> => {
    if (!pending) return
    setWorking(true)
    try {
      if (pending.kind === 'delete') {
        const size = selectionSize(pending.sel)
        await rewrite(pending.sel, (list, ids) => list.filter((c) => !ids.has(c.id)))
        setNotice(t('lib.deleted', { conversations: String(size.conversations) }))
      } else if (pending.kind === 'images') {
        const { images } = selectionImages(conversations, pending.sel)
        await rewrite(pending.sel, (list, ids) =>
          list.map((c) => (ids.has(c.id) ? withoutImages([c])[0] : c))
        )
        setNotice(t('lib.imagesRemoved', { images: String(images) }))
      } else {
        await bridge.forgetDocuments(pending.docs.map((d) => d.path))
        notifyChangedHere(null)
        onChanged()
        onRecentsMaybeChanged()
        setNotice(t('lib.forgotten', { documents: String(pending.docs.length) }))
      }
    } finally {
      setPending(null)
      setWorking(false)
    }
  }, [pending, rewrite, conversations, onChanged, onRecentsMaybeChanged])

  // ---------- Export ----------

  const exportAs = useCallback(
    async (kind: 'md' | 'json'): Promise<void> => {
      setWorking(true)
      try {
        const paths = [...new Set(conversations.map((c) => c.docPath))]
        const docs = []
        for (const path of paths) {
          const list = await loadConversations(path)
          if (list.length) docs.push({ path, name: nameOf.get(path) ?? '', conversations: list })
        }
        const stamp = new Date().toISOString().slice(0, 10)
        const content = kind === 'md' ? libraryMarkdown(docs) : libraryJson(docs, await bridge.getVersion())
        const name = `${t('lib.exportFileName')} ${stamp}.${kind}`
        const result = await bridge.saveTextFile(name, content)
        if (result && 'error' in result) setNotice(errorText(result))
        else if (result) setNotice(t('lib.exported', { name: result.path.split(/[\\/]/).pop() ?? result.path }))
      } finally {
        setWorking(false)
      }
    },
    [conversations, nameOf]
  )

  // ---------- Rendering ----------

  const countLine = (sel: Selection): string => {
    const s = selectionSize(sel)
    return s.conversations === 0
      ? t('lib.none')
      : t('lib.count', { conversations: String(s.conversations), documents: String(s.documents) })
  }

  const confirmText = (p: Pending): string => {
    if (p.kind === 'forget') return t('lib.confirmForget', { documents: String(p.docs.length) })
    const s = selectionSize(p.sel)
    if (p.kind === 'images') {
      const { images } = selectionImages(conversations, p.sel)
      return t('lib.confirmImages', { images: String(images), conversations: String(s.conversations) })
    }
    return t('lib.confirmDelete', { conversations: String(s.conversations), documents: String(s.documents) })
  }

  /** One tidying row: what it is, what it would take, its button — or, once
   *  clicked, the confirmation in its place */
  const tidyRow = (
    key: string,
    label: React.ReactNode,
    count: string,
    action: string,
    next: Pending | null,
    hint?: string
  ): React.JSX.Element => {
    const isPending = pending !== null && pending.key === key
    return (
      <div className="convs-tidy-row" key={key} title={hint}>
        <div className="convs-tidy-label">{label}</div>
        {isPending ? (
          <div className="convs-tidy-confirm" role="alert">
            <span>{confirmText(pending)}</span>
            <button className="btn-danger" disabled={working} onClick={() => void carryOut()}>
              {action}
            </button>
            <button className="btn-secondary" disabled={working} onClick={() => setPending(null)}>
              {t('app.cancel')}
            </button>
          </div>
        ) : (
          <>
            <span className="convs-tidy-count">{count}</span>
            <button className="btn-secondary" disabled={!next || working} onClick={() => next && setPending(next)}>
              {action}
            </button>
          </>
        )}
      </div>
    )
  }

  if (reading) {
    const c = reading.conv
    return (
      <div className="convs is-reading">
        <div className="convs-reader-head">
          <button className="btn-secondary" onClick={() => setReading(null)}>
            <IconArrowLeft />
            {t('lib.back')}
          </button>
          <button className="btn-primary" onClick={() => void openInDocument(reading.docPath, c.id)}>
            <IconExternal size={14} />
            {t('lib.openInDoc')}
          </button>
        </div>
        <h3 className="convs-reader-title">{c.title}</h3>
        <p className="convs-reader-meta">
          {reading.docName} · {formatDate(c.updatedAt)} ·{' '}
          {t('ai.historyMessages', { count: String(c.messages.length) })}
        </p>
        <div className="convs-reader-body ai-messages">
          {c.messages.map((m, i) =>
            m.role === 'user' ? (
              <div className="ai-msg ai-user" key={i}>
                {m.images && m.images.length > 0 && (
                  <div className="ai-msg-images">
                    {m.images.map((img, j) => (
                      <img key={j} src={`data:${img.mediaType};base64,${img.dataBase64}`} alt={t('ai.imageAlt')} />
                    ))}
                  </div>
                )}
                {!!m.imagesWithheld && (
                  <div className="ai-msg-withheld">{t('ai.imagesWithheld', { count: String(m.imagesWithheld) })}</div>
                )}
                {m.display ?? m.text}
              </div>
            ) : (
              <div className="ai-msg ai-assistant" key={i}>
                {m.error ? (
                  <p className="ai-error">{errorText({ error: m.error, code: m.errorCode })}</p>
                ) : (
                  // A citation chip opens the document on this conversation;
                  // the passage itself is found there (this view has no pages)
                  <AssistantBody parts={m.parts} doc={null} onCitation={(cite) => void openInDocument(reading.docPath, c.id, cite)} />
                )}
              </div>
            )
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="convs">
      <input
        className="convs-search"
        type="search"
        placeholder={t('ai.historySearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="convs-totals">
        {t('lib.totals', { conversations: String(totals.conversations), documents: String(totals.documents) })}
        {totals.imageBytes > 0 && ` · ${t('lib.totalsImages', { size: formatBytes(totals.imageBytes, locale()) })}`}
      </p>

      {/* Order and the two filters there are: a gone file, images kept.
          A document filter from the library shows as a chip of its own. */}
      {conversations.length > 0 && (
        <div className="convs-controls">
          <label className="convs-sort">
            {t('lib.sort')}{' '}
            <select value={sort} onChange={(e) => setSort(sortOrDefault(e.target.value))}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`lib.sort_${s}` as const)}
                </option>
              ))}
            </select>
          </label>
          <div className="convs-filters" role="group" aria-label={t('lib.filters')}>
            {docFilter !== null && (
              <button className="convs-chip is-on" onClick={() => onDocFilterChange(null)} title={t('lib.filterDocClear')}>
                {nameOf.get(docFilter) ?? docFilter} ✕
              </button>
            )}
            <button
              className={`convs-chip${filter.missing ? ' is-on' : ''}`}
              aria-pressed={filter.missing}
              disabled={!filter.missing && goneSet.size === 0}
              onClick={() => setFilter((f) => ({ ...f, missing: !f.missing }))}
            >
              {t('lib.filterMissing')}
            </button>
            <button
              className={`convs-chip${filter.images ? ' is-on' : ''}`}
              aria-pressed={filter.images}
              disabled={!filter.images && totals.images === 0}
              onClick={() => setFilter((f) => ({ ...f, images: !f.images }))}
            >
              {t('lib.filterImages')}
            </button>
          </div>
        </div>
      )}

      {tidyOpen && (
        <div className="convs-tidy">
          {tidyRow(
            'gone',
            t('lib.gone'),
            gone === null
              ? t('lib.goneChecking')
              : gone.length === 0
                ? t('lib.goneNone')
                : t('lib.goneCount', {
                    documents: String(gone.length),
                    conversations: String(gone.reduce((n, d) => n + d.conversations, 0))
                  }),
            t('lib.forget'),
            gone && gone.length > 0 ? { kind: 'forget', key: 'gone', docs: gone } : null,
            t('lib.goneHint')
          )}
          {tidyRow(
            'older',
            <label>
              {t('lib.older')}{' '}
              <select value={age} onChange={(e) => { setAge(Number(e.target.value)); setPending(null) }}>
                {AGE_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {ageLabel(m)}
                  </option>
                ))}
                <option value={CUSTOM}>{t('lib.custom')}</option>
              </select>
              {age === CUSTOM && (
                <>
                  {' '}
                  <input
                    className="convs-custom"
                    inputMode="numeric"
                    aria-label={t('lib.customMonths')}
                    value={ageCustom}
                    onChange={(e) => { setAgeCustom(e.target.value); setPending(null) }}
                  />{' '}
                  {t('lib.months')}
                </>
              )}
            </label>,
            countLine(olderSel),
            t('lib.delete'),
            selectionSize(olderSel).conversations > 0 ? { kind: 'delete', key: 'older', sel: olderSel } : null
          )}
          {tidyRow(
            'keep',
            <label>
              {t('lib.keep')}{' '}
              <select value={keep} onChange={(e) => { setKeep(Number(e.target.value)); setPending(null) }}>
                {KEEP_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value={CUSTOM}>{t('lib.custom')}</option>
              </select>
              {keep === CUSTOM && (
                <>
                  {' '}
                  <input
                    className="convs-custom"
                    inputMode="numeric"
                    aria-label={t('lib.customCount')}
                    value={keepCustom}
                    onChange={(e) => { setKeepCustom(e.target.value); setPending(null) }}
                  />
                </>
              )}
            </label>,
            countLine(keepSel),
            t('lib.delete'),
            selectionSize(keepSel).conversations > 0 ? { kind: 'delete', key: 'keep', sel: keepSel } : null
          )}
          {tidyRow(
            'images',
            t('lib.images'),
            (() => {
              const s = selectionSize(imageSel)
              const im = selectionImages(conversations, imageSel)
              return s.conversations === 0
                ? t('lib.none')
                : t('lib.imagesCount', {
                    images: String(im.images),
                    conversations: String(s.conversations),
                    size: formatBytes(im.bytes, locale())
                  })
            })(),
            t('lib.remove'),
            selectionSize(imageSel).conversations > 0 ? { kind: 'images', key: 'images', sel: imageSel } : null
          )}
          <div className="convs-tidy-row convs-export">
            <div className="convs-tidy-label">{t('lib.export')}</div>
            <span className="convs-tidy-count">{t('lib.exportHint')}</span>
            <button className="btn-secondary" disabled={working || conversations.length === 0} onClick={() => void exportAs('md')}>
              Markdown
            </button>
            <button className="btn-secondary" disabled={working || conversations.length === 0} onClick={() => void exportAs('json')}>
              JSON
            </button>
          </div>
          <button className="convs-tidy-close" onClick={() => onTidyOpenChange(false)}>
            {t('app.close')}
          </button>
        </div>
      )}

      <div className="recents-box convs-box">
        {conversations.length === 0 ? (
          <p className="convs-empty">{t('lib.empty')}</p>
        ) : groups.length === 0 ? (
          <p className="convs-empty">{t('ai.historyNoHits')}</p>
        ) : (
          groups.map((g) => (
            <section className="convs-group" key={g.docPath}>
              <div className="convs-doc">
                <IconDocument />
                <span className="convs-doc-name">
                  {g.docName}
                  {goneSet.has(g.docPath) && (
                    <span className="conv-gone-tag" title={t('lib.fileMissingTip')}>{t('lib.fileMissing')}</span>
                  )}
                </span>
                <span className="convs-doc-path">{recentLocation(g.docPath)}</span>
              </div>
              <ul>
                {g.items.map((c: ConversationHit) => (
                  <li key={c.id} className="recent-item convs-item">
                    <button className="convs-row" onClick={() => void read(c)}>
                      <span className="convs-title">{c.title}</span>
                      <span className="convs-meta">
                        {formatDate(c.updatedAt)} · {t('ai.historyMessages', { count: String(c.messageCount) })}
                      </span>
                      {c.snippet && <span className="convs-snippet">{c.snippet}</span>}
                    </button>
                    <span className="recent-actions">
                      <button
                        className="recent-action"
                        title={t('lib.openInDoc')}
                        aria-label={t('lib.openInDoc')}
                        onClick={() => void openInDocument(c.docPath, c.id)}
                      >
                        <IconExternal size={14} />
                      </button>
                      <button
                        className="recent-action"
                        title={t('ai.historyDeleteTip')}
                        aria-label={t('ai.historyDeleteTip')}
                        onClick={() => void deleteOne(c.docPath, c.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {notice && (
        <div className="toast app-toast" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}

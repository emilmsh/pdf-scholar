import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { annotTypeLabel, colorLabel, HIGHLIGHT_COLORS } from '../annotations'
import type { PageAnnotation } from '../annotations'
import type { DocBookmark } from '../../../shared/types'
import { t, useLang } from '../i18n'
import { bridge } from '../bridge'
import {
  IconBookmark,
  IconChevronDown,
  IconCopy,
  IconDocument,
  IconFolderOpen,
  IconMarginNotes,
  IconNote,
  IconPen,
  IconShapes,
  IconText,
  IconTextMarkup
} from './icons'
import { useDismissable } from '../useDismissable'
import { MarginCard } from './MarginNotes'

const THUMB_WIDTH = 132

/** Render a source path/URL as something a human recognises: a Windows file://
 *  URL becomes `C:\Users\…\paper.pdf`, a picked file shows just its name, an
 *  http(s) URL is shown decoded. (Shared shape with the old toolbar button.) */
function prettyPath(path: string): string {
  if (path.startsWith('fsa:')) return path.slice(4)
  if (path.startsWith('file://')) {
    let p = decodeURIComponent(path.replace(/^file:\/\//, ''))
    p = p.replace(/^\/([A-Za-z]:)/, '$1') // file:///C:/… → C:/…
    if (/^[A-Za-z]:/.test(p)) p = p.replace(/\//g, '\\') // Windows backslashes
    return p
  }
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export type ExportFormat = 'markdown' | 'html' | 'text' | 'docx'

export interface OutlineNode {
  title: string
  dest: unknown
  url?: string | null
  items: OutlineNode[]
}

interface PageSize {
  w: number
  h: number
}

interface Props {
  open: boolean
  pdf: PDFDocumentProxy | null
  sizes: PageSize[]
  currentPage: number
  annotations: ReadonlyMap<number, PageAnnotation[]>
  /** localId → marked-up text (computed lazily by the viewer) */
  excerpts: ReadonlyMap<string, string>
  onJumpToPage(page: number): void
  onJumpToDest(dest: unknown): void
  onJumpToAnnot(pageNumber: number, record: PageAnnotation): void
  onDeleteAnnot(pageNumber: number, record: PageAnnotation): void
  /** Delete every annotation in the document (one undoable action) */
  onDeleteAllAnnots(): void
  /** Selected annotation — its card gets the ring and is scrolled into view */
  selectedAnnotId: string | null
  /** Commit a comment edited in a card (the margin view's own handler) */
  onCommentChange(pageNumber: number, localId: string, text: string): void
  // ---------- Margin view controls (this tab is their one home) ----------
  marginOn: boolean
  marginSide: 'left' | 'right'
  onToggleMargin(): void
  onMarginSideChange(side: 'left' | 'right'): void
  /** Export a copy with wider pages and the comments baked into the margin */
  onExportMargin(): void
  /** Page bookmarks for the open file, already in page order */
  bookmarks: readonly DocBookmark[]
  /** Bookmark the page, or remove the bookmark it already has */
  onToggleBookmark(page: number): void
  onRenameBookmark(page: number, label: string): void
  onExport(format: ExportFormat): void
  /** Open the AI panel with the "summarize my annotations" question */
  onAskAi(): void
  /** Browser/extension only: the open document's display name + source path,
   *  and a callback to open another file. When onOpenFile is supplied the
   *  sidebar shows a file-identity header above the tab switcher (name, full
   *  path on hover, click/right-click menu). Desktop leaves onOpenFile
   *  undefined, so the header never appears there. */
  docName?: string | undefined
  docPath?: string | undefined
  /** Desktop passes undefined here explicitly (the file identity lives in the
   *  tab bar there), so the prop must accept it rather than requiring absence. */
  onOpenFile?: (() => void) | undefined
}

type Tab = 'thumbs' | 'outline' | 'marks' | 'annots'

function Sidebar({
  open,
  pdf,
  sizes,
  currentPage,
  annotations,
  excerpts,
  onJumpToPage,
  onJumpToDest,
  onJumpToAnnot,
  onDeleteAnnot,
  onDeleteAllAnnots,
  selectedAnnotId,
  onCommentChange,
  marginOn,
  marginSide,
  onToggleMargin,
  onMarginSideChange,
  onExportMargin,
  bookmarks,
  onToggleBookmark,
  onRenameBookmark,
  onExport,
  onAskAi,
  docName,
  docPath,
  onOpenFile
}: Props): React.JSX.Element {
  useLang()
  // Contents is the scholar's default view; fall back to thumbnails when the
  // document has no outline (unless the user already picked a tab)
  const [tab, setTab] = useState<Tab>('outline')
  const userPickedRef = useRef(false)
  const pickTab = (next: Tab): void => {
    userPickedRef.current = true
    setTab(next)
  }
  const [outline, setOutline] = useState<OutlineNode[] | null>(null)
  const [visibleThumbs, setVisibleThumbs] = useState<ReadonlySet<number>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)

  // Document-identity header (browser/extension): filename + path menu
  const [docMenuOpen, setDocMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const docRef = useRef<HTMLDivElement>(null)

  // The «Kopiert» confirmation is per-opening, so it resets when the menu shuts
  useEffect(() => {
    if (!docMenuOpen) setCopied(false)
  }, [docMenuOpen])
  const closeDocMenu = useCallback(() => setDocMenuOpen(false), [])
  useDismissable(docRef, docMenuOpen, closeDocMenu)

  const copyPath = (): void => {
    if (!docPath) return
    void navigator.clipboard?.writeText(prettyPath(docPath)).then(
      () => setCopied(true),
      () => {}
    )
  }

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf
      .getOutline()
      .then((items) => {
        if (cancelled) return
        const nodes = (items as OutlineNode[] | null) ?? []
        setOutline(nodes)
        if (nodes.length === 0 && !userPickedRef.current) setTab('thumbs')
      })
      .catch(() => {
        setOutline([])
        if (!userPickedRef.current) setTab('thumbs')
      })
    return () => {
      cancelled = true
    }
  }, [pdf])

  // Lazy-render thumbnails: only pages near the sidebar viewport get a canvas
  useEffect(() => {
    const list = listRef.current
    if (!list || !open || tab !== 'thumbs') return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbs((prev) => {
          const next = new Set(prev)
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.thumb)
            if (entry.isIntersecting) next.add(page)
            else next.delete(page)
          }
          return next
        })
      },
      { root: list, rootMargin: '400px 0px' }
    )
    for (const el of list.querySelectorAll('[data-thumb]')) observer.observe(el)
    return () => observer.disconnect()
  }, [open, tab, sizes.length])

  // Keep the active thumbnail in view
  useEffect(() => {
    if (!open || tab !== 'thumbs') return
    listRef.current
      ?.querySelector(`[data-thumb="${currentPage}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [currentPage, open, tab])

  return (
    <div className={`sidebar${open ? ' open' : ''}`}>
      {docName && onOpenFile && (
        <div className="sidebar-doc" ref={docRef}>
          <button
            className={`sidebar-doc-head${docMenuOpen ? ' is-open' : ''}`}
            title={docPath ? prettyPath(docPath) : docName}
            onClick={() => setDocMenuOpen((o) => !o)}
            onContextMenu={(e) => {
              e.preventDefault()
              setDocMenuOpen(true)
            }}
          >
            <IconDocument size={15} />
            <span className="sidebar-doc-name">{docName}</span>
            <IconChevronDown size={13} />
          </button>
          {docMenuOpen && (
            <div className="sidebar-doc-menu" role="menu">
              <div className="sidebar-doc-menu-name">{docName}</div>
              {docPath && (
                <div
                  className="sidebar-doc-menu-path"
                  title={docPath.startsWith('fsa:') ? undefined : prettyPath(docPath)}
                >
                  {docPath.startsWith('fsa:') ? t('doc.pickedHint') : prettyPath(docPath)}
                </div>
              )}
              {docPath && !docPath.startsWith('fsa:') && (
                <button className="sidebar-doc-menu-item" onClick={copyPath}>
                  <IconCopy size={14} />
                  {copied ? t('doc.copied') : t('doc.copyPath')}
                </button>
              )}
              <button
                className="sidebar-doc-menu-item"
                onClick={() => {
                  setDocMenuOpen(false)
                  onOpenFile()
                }}
              >
                <IconFolderOpen size={15} />
                {t('doc.openFile')}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="sidebar-tabs">
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => pickTab('outline')}>
          {t('side.contents')}
        </button>
        <button className={tab === 'thumbs' ? 'active' : ''} onClick={() => pickTab('thumbs')}>
          {t('side.pages')}
        </button>
        <button
          className={tab === 'marks' ? 'active' : ''}
          onClick={() => pickTab('marks')}
          title={t('side.bookmarksTip')}
        >
          {t('side.bookmarks')}
        </button>
        <button className={tab === 'annots' ? 'active' : ''} onClick={() => pickTab('annots')}>
          {t('side.annots')}
        </button>
      </div>

      {tab === 'thumbs' && (
        <div className="thumb-list" ref={listRef}>
          {pdf &&
            sizes.map((size, i) => {
              const page = i + 1
              return (
                <button
                  key={page}
                  data-thumb={page}
                  className={`thumb${page === currentPage ? ' current' : ''}`}
                  onClick={() => onJumpToPage(page)}
                >
                  <Thumbnail
                    pdf={pdf}
                    pageNumber={page}
                    width={THUMB_WIDTH}
                    aspect={size.h / size.w}
                    active={visibleThumbs.has(page)}
                  />
                  <span>{page}</span>
                </button>
              )
            })}
        </div>
      )}

      {tab === 'outline' && (
        <div className="outline-list">
          {outline === null && <p className="sidebar-empty">{t('side.loading')}</p>}
          {outline?.length === 0 && <p className="sidebar-empty">{t('side.noOutline')}</p>}
          {outline && outline.length > 0 && (
            <OutlineLevel nodes={outline} depth={0} onJump={onJumpToDest} />
          )}
        </div>
      )}

      {tab === 'marks' && (
        <BookmarkList
          bookmarks={bookmarks}
          currentPage={currentPage}
          onJumpToPage={onJumpToPage}
          onToggle={onToggleBookmark}
          onRename={onRenameBookmark}
        />
      )}

      {tab === 'annots' && (
        <AnnotationList
          annotations={annotations}
          excerpts={excerpts}
          onJump={onJumpToAnnot}
          onDelete={onDeleteAnnot}
          onDeleteAll={onDeleteAllAnnots}
          onExport={onExport}
          onAskAi={onAskAi}
          selectedAnnotId={selectedAnnotId}
          onCommentChange={onCommentChange}
          marginOn={marginOn}
          marginSide={marginSide}
          onToggleMargin={onToggleMargin}
          onMarginSideChange={onMarginSideChange}
          onExportMargin={onExportMargin}
        />
      )}
    </div>
  )
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

/** Type filter for the Merknader list — grouped the way the toolbar groups
 *  the tools, so the chips read as "the thing I made with that button". */
const TYPE_FILTERS: {
  key: string
  types: ReadonlySet<PageAnnotation['type']>
  Icon: (p: { size?: number }) => React.JSX.Element
  labelKey: 'tb.markup' | 'tb.note' | 'tb.textTool' | 'tb.pen' | 'tb.shapes'
}[] = [
  {
    key: 'markup',
    types: new Set(['highlight', 'underline', 'strikeout', 'squiggly']),
    Icon: IconTextMarkup,
    labelKey: 'tb.markup'
  },
  { key: 'note', types: new Set(['note']), Icon: IconNote, labelKey: 'tb.note' },
  { key: 'text', types: new Set(['freetext']), Icon: IconText, labelKey: 'tb.textTool' },
  { key: 'draw', types: new Set(['ink']), Icon: IconPen, labelKey: 'tb.pen' },
  {
    key: 'shape',
    types: new Set(['square', 'circle', 'line', 'arrow']),
    Icon: IconShapes,
    labelKey: 'tb.shapes'
  }
]

function BookmarkList({
  bookmarks,
  currentPage,
  onJumpToPage,
  onToggle,
  onRename
}: {
  bookmarks: readonly DocBookmark[]
  currentPage: number
  onJumpToPage(page: number): void
  onToggle(page: number): void
  onRename(page: number, label: string): void
}): React.JSX.Element {
  /** Page whose label is being edited, or null. The draft lives here rather than
   *  in the row so committing does not depend on the row surviving a re-sort. */
  const [editing, setEditing] = useState<{ page: number; draft: string } | null>(null)
  const marked = bookmarks.some((b) => b.page === currentPage)

  const commit = (): void => {
    if (editing) onRename(editing.page, editing.draft.trim())
    setEditing(null)
  }

  return (
    <div className="bookmark-list">
      <button
        className={`bookmark-add${marked ? ' is-marked' : ''}`}
        onClick={() => onToggle(currentPage)}
        title={t('side.bookmarkToggleTip')}
      >
        <IconBookmark size={14} filled={marked} />
        {marked
          ? t('side.bookmarkRemoveHere', { page: currentPage })
          : t('side.bookmarkAddHere', { page: currentPage })}
      </button>

      {bookmarks.length === 0 && <p className="sidebar-empty">{t('side.noBookmarks')}</p>}

      {bookmarks.map((b) => (
        <div key={b.page} className={`bookmark-row${b.page === currentPage ? ' current' : ''}`}>
          {editing?.page === b.page ? (
            <input
              className="bookmark-rename"
              autoFocus
              value={editing.draft}
              placeholder={t('side.bookmarkNamePlaceholder')}
              onChange={(e) => setEditing({ page: b.page, draft: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <>
              <button
                className="bookmark-main"
                onClick={() => onJumpToPage(b.page)}
                // Double-click to rename, matching the page pill; the pencil is
                // the discoverable path to the same thing.
                onDoubleClick={() => setEditing({ page: b.page, draft: b.label })}
              >
                <span className="bookmark-page">{t('app.pageAbbrev')} {b.page}</span>
                <span className="bookmark-label">{b.label || t('side.bookmarkUnnamed')}</span>
              </button>
              <button
                className="bookmark-edit"
                title={t('side.bookmarkRename')}
                onClick={() => setEditing({ page: b.page, draft: b.label })}
              >
                ✎
              </button>
              <button
                className="bookmark-delete"
                title={t('side.bookmarkDelete')}
                onClick={() => onToggle(b.page)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function AnnotationList({
  annotations,
  excerpts,
  onJump,
  onDelete,
  onDeleteAll,
  onExport,
  onAskAi,
  selectedAnnotId,
  onCommentChange,
  marginOn,
  marginSide,
  onToggleMargin,
  onMarginSideChange,
  onExportMargin
}: {
  annotations: ReadonlyMap<number, PageAnnotation[]>
  excerpts: ReadonlyMap<string, string>
  onJump(pageNumber: number, record: PageAnnotation): void
  onDelete(pageNumber: number, record: PageAnnotation): void
  onDeleteAll(): void
  onExport(format: ExportFormat): void
  onAskAi(): void
  selectedAnnotId: string | null
  onCommentChange(pageNumber: number, localId: string, text: string): void
  marginOn: boolean
  marginSide: 'left' | 'right'
  onToggleMargin(): void
  onMarginSideChange(side: 'left' | 'right'): void
  onExportMargin(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Colours and types are MULTI-select: any of the picked colours, any of the
  // picked types (pen AND text is a real thing to want). Empty = no filter.
  // Across the two rows they still narrow together, as does the search field.
  const [colorFilter, setColorFilter] = useState<[number, number, number][]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  /** null = everything; true = only rows with a comment; false = only without */
  const [withComment, setWithComment] = useState<boolean | null>(null)
  const [clearAsk, setClearAsk] = useState(false)
  const clearAskRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeClearAsk = useCallback(() => setClearAsk(false), [])
  useDismissable(clearAskRef, clearAsk, closeClearAsk)

  // The comment fields grow to their text after every render (edits, undo,
  // new annotations) — cards never scroll internally.
  useLayoutEffect(() => {
    const host = listRef.current
    if (!host) return
    for (const ta of host.querySelectorAll('textarea')) {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
    }
  })

  // Selecting an annotation on the page brings its card into view here — the
  // same wayfinding as clicking a card, in the other direction.
  useEffect(() => {
    if (!selectedAnnotId) return
    listRef.current
      ?.querySelector(`[data-card="${CSS.escape(selectedAnnotId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedAnnotId])

  const flat = useMemo(() => {
    const rows: { pageNumber: number; record: PageAnnotation }[] = []
    for (const [pageNumber, list] of annotations) {
      for (const record of list) rows.push({ pageNumber, record })
    }
    rows.sort(
      (a, b) =>
        a.pageNumber - b.pageNumber || (a.record.quads[0]?.y ?? 0) - (b.record.quads[0]?.y ?? 0)
    )
    return rows
  }, [annotations])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const typeGroups = TYPE_FILTERS.filter((g) => typeFilter.includes(g.key))
    return flat.filter(({ record }) => {
      if (colorFilter.length && !colorFilter.some((c) => colorDistance(record.color, c) <= 0.06))
        return false
      if (typeGroups.length && !typeGroups.some((g) => g.types.has(record.type))) return false
      if (withComment !== null && !!(record.contents ?? '').trim() !== withComment) return false
      if (!needle) return true
      const haystack = `${record.contents ?? ''} ${excerpts.get(record.id) ?? ''}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [flat, query, colorFilter, typeFilter, withComment, excerpts])

  // The margin VIEW controls live HERE — the tab is the one home for
  // everything comment-related (toolbar keeps only the quick on/off toggle).
  // Rendered even with zero annotations: turning the margin on first is a
  // valid start. Exports — both kinds — live together in the export section.
  const marginControls = (
    <div className="annot-margin">
      <label className="theme-menu-toggle">
        <input type="checkbox" checked={marginOn} onChange={onToggleMargin} />
        <IconMarginNotes size={15} />
        {t('tb.marginNotes')}
      </label>
      {marginOn && (
        <div className="theme-auto-row">
          <span className="theme-auto-label">{t('margin.sideLabel')}</span>
          <div className="theme-auto-choices">
            {(['left', 'right'] as const).map((s) => (
              <button
                key={s}
                className={`theme-chip${marginSide === s ? ' selected' : ''}`}
                onClick={() => onMarginSideChange(s)}
              >
                {t(s === 'left' ? 'margin.sideLeft' : 'margin.sideRight')}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  // With zero annotations everything still RENDERS — a new user learns what
  // the tab can do by seeing it — but the actions that need marks to act on
  // are disabled rather than gone.
  const empty = flat.length === 0

  let lastPage = 0
  return (
    <div className="annot-list" ref={listRef}>
      {marginControls}
      <div className="annot-export">
        {/* Exports first (the tab's most-wanted actions), then the AI helper,
            then the destructive odd-one-out. Four equal formats in a 2×2 grid,
            each with a one-line tooltip — the labels are file formats, and
            «PDF (marg)» in particular is a different KIND of export (the
            document itself, with the comments printed beside it), which no
            three-word label can carry. TXT was dropped: Markdown IS plain
            text, and Word covers the paste-into-a-document case. */}
        <div className="annot-export-head">
          <span>{t('side.export')}</span>
        </div>
        <div className="annot-export-grid">
          <button disabled={empty} onClick={() => onExport('markdown')} title={t('side.exportMdTip')}>
            MD
          </button>
          <button disabled={empty} onClick={() => onExport('html')} title={t('side.exportHtmlTip')}>
            HTML
          </button>
          <button disabled={empty} onClick={() => onExport('docx')} title={t('side.exportDocxTip')}>
            Word
          </button>
          <button disabled={empty} onClick={onExportMargin} title={t('side.exportMarginTip')}>
            {t('side.exportMarginBtn')}
          </button>
        </div>
        <button className="annot-ask-ai" disabled={empty} onClick={onAskAi} title={t('side.askAiTip')}>
          <span className="annot-ask-ai-glyph">✦</span>
          {t('ai.annotsBtn')}
        </button>
        <button
          className="annot-clear-all"
          disabled={empty}
          onClick={() => setClearAsk(true)}
          title={t('side.clearAllTip')}
        >
          {t('side.clearAll', { count: flat.length })}
        </button>
      </div>

      <div className="annot-filter">
        <div className="annot-export-head">
          <span>{t('side.filterHead')}</span>
        </div>
        <input
          value={query}
          placeholder={t('side.searchAnnots')}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('side.searchAnnots')}
        />
        <div className="annot-filter-colors">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.hex}
              className={`annot-filter-dot${
                colorFilter.some((p) => colorDistance(c.rgb, p) < 0.001) ? ' active' : ''
              }`}
              style={{ background: c.hex }}
              title={t('side.filterOn', { name: colorLabel(c).toLowerCase() })}
              onClick={() =>
                setColorFilter((prev) =>
                  prev.some((p) => colorDistance(c.rgb, p) < 0.001)
                    ? prev.filter((p) => colorDistance(c.rgb, p) >= 0.001)
                    : [...prev, c.rgb]
                )
              }
            />
          ))}
          {/* Type chips share the row's grammar: click to add to the filter,
              click again to take it back out */}
          <span className="annot-filter-sep" />
          {TYPE_FILTERS.map(({ key, Icon, labelKey }) => (
            <button
              key={key}
              className={`annot-filter-type${typeFilter.includes(key) ? ' active' : ''}`}
              title={t('side.filterOn', { name: t(labelKey).toLowerCase() })}
              onClick={() =>
                setTypeFilter((prev) =>
                  prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
                )
              }
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <div className="annot-filter-content">
          {([true, false] as const).map((wants) => (
            <button
              key={String(wants)}
              className={`theme-chip${withComment === wants ? ' selected' : ''}`}
              onClick={() => setWithComment((prev) => (prev === wants ? null : wants))}
            >
              {t(wants ? 'side.filterWithComment' : 'side.filterWithoutComment')}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <p className="sidebar-empty">{t('side.noAnnots')}</p>
      ) : (
        filtered.length === 0 && <p className="sidebar-empty">{t('side.noMatches')}</p>
      )}
      {filtered.map(({ pageNumber, record }) => {
        const header = pageNumber !== lastPage
        lastPage = pageNumber
        const excerpt = excerpts.get(record.id)
        // Context line: what the card is anchored to — the marked text when
        // there is one, else the type. Notes carry no excerpt (the comment IS
        // the content). The comment itself lives in the card's editable field.
        const context =
          record.type === 'note'
            ? `${annotTypeLabel('note')}${record.author ? ` — ${record.author}` : ''}`
            : `${excerpt ? `«${excerpt}»` : annotTypeLabel(record.type)}${record.author ? ` — ${record.author}` : ''}`
        return (
          <div key={record.id}>
            {header && <div className="annot-list-page">{t('side.page', { page: pageNumber })}</div>}
            <MarginCard
              key={`${record.id}:${record.contents ?? ''}`}
              a={record}
              pageNumber={pageNumber}
              context={context}
              selected={selectedAnnotId === record.id}
              onCommit={onCommentChange}
              onSelect={() => onJump(pageNumber, record)}
              onDelete={() => onDelete(pageNumber, record)}
              extraProps={{ onClick: () => onJump(pageNumber, record) }}
            />
          </div>
        )
      })}

      {/* Same modal treatment as reset-to-defaults: it throws away work, and the
          detail line says both how much and that Ctrl+Z takes it back. */}
      {clearAsk && (
        <div className="confirm-overlay">
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" ref={clearAskRef}>
            <p className="confirm-message">{t('side.clearAllConfirm', { count: flat.length })}</p>
            <p className="confirm-detail">{t('side.clearAllConfirmDetail')}</p>
            <div className="confirm-actions">
              <button className="btn-secondary" onClick={() => setClearAsk(false)}>
                {t('app.cancel')}
              </button>
              <button
                className="btn-primary"
                autoFocus
                onClick={() => {
                  setClearAsk(false)
                  onDeleteAll()
                }}
              >
                {t('side.clearAllAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function OutlineLevel({
  nodes,
  depth,
  onJump
}: {
  nodes: OutlineNode[]
  depth: number
  onJump(dest: unknown): void
}): React.JSX.Element {
  return (
    <>
      {nodes.map((node, i) => (
        <OutlineRow key={`${depth}-${i}`} node={node} depth={depth} onJump={onJump} />
      ))}
    </>
  )
}

function OutlineRow({
  node,
  depth,
  onJump
}: {
  node: OutlineNode
  depth: number
  onJump(dest: unknown): void
}): React.JSX.Element {
  // Collapsed by default: subheadings appear when the parent is clicked
  const [expanded, setExpanded] = useState(false)
  const hasChildren = node.items.length > 0
  return (
    <div>
      <div className="outline-row" style={{ paddingLeft: 10 + depth * 16 }}>
        {hasChildren ? (
          <button
            className={`outline-chevron${expanded ? ' expanded' : ''}`}
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? t('side.collapse') : t('side.expand')}
          >
            ›
          </button>
        ) : (
          <span className="outline-chevron-spacer" />
        )}
        <button
          className="outline-title"
          title={node.url ? node.url : node.title}
          onClick={() => {
            // Clicking a parent heading reveals its subheadings (and navigates)
            if (hasChildren) setExpanded(true)
            // Some PDFs (e.g. journal front-matter) build the outline out of
            // EXTERNAL LINKS rather than internal destinations — open those in
            // the browser instead of silently doing nothing.
            if (node.dest) onJump(node.dest)
            else if (node.url) bridge.openExternal(node.url)
          }}
        >
          {node.title}
        </button>
      </div>
      {hasChildren && expanded && (
        <OutlineLevel nodes={node.items} depth={depth + 1} onJump={onJump} />
      )}
    </div>
  )
}

function Thumbnail({
  pdf,
  pageNumber,
  width,
  aspect,
  active
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  width: number
  aspect: number
  active: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!active) {
      host.replaceChildren()
      return
    }
    let cancelled = false
    let task: { cancel(): void } | null = null
    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const scale = width / page.getViewport({ scale: 1 }).width
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const render = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      })
      task = render
      await render.promise
      if (!cancelled) host.replaceChildren(canvas)
    })().catch(() => {})
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, pageNumber, width, active])

  return <div className="thumb-canvas" ref={hostRef} style={{ width, height: width * aspect }} />
}

export default memo(Sidebar)

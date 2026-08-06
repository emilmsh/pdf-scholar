import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { annotTypeLabel, colorLabel, HIGHLIGHT_COLORS } from '../annotations'
import type { PageAnnotation } from '../annotations'
import type { DocBookmark } from '../../../shared/types'
import { t, useLang } from '../i18n'
import { shortcutLabel } from '../keymap'
import { bridge } from '../bridge'
import { IconBookmark, IconChevronDown, IconCopy, IconDocument, IconFolderOpen } from './icons'
import { useDismissable } from '../useDismissable'

const THUMB_WIDTH = 132

/** The clear-all warning names the key that brings the annotations back, so it
 *  has to read the LIVE binding — and fall back to a keyless wording when the
 *  reader unbound undo, because the reassurance is the point of the sentence. */
function clearAllDetail(): string {
  const keys = shortcutLabel('edit.undo')
  return keys
    ? t('side.clearAllConfirmDetail', { keys })
    : t('side.clearAllConfirmDetailNoKey')
}

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
        />
      )}
    </div>
  )
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

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
  onAskAi
}: {
  annotations: ReadonlyMap<number, PageAnnotation[]>
  excerpts: ReadonlyMap<string, string>
  onJump(pageNumber: number, record: PageAnnotation): void
  onDelete(pageNumber: number, record: PageAnnotation): void
  onDeleteAll(): void
  onExport(format: ExportFormat): void
  onAskAi(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [colorFilter, setColorFilter] = useState<[number, number, number] | null>(null)
  const [clearAsk, setClearAsk] = useState(false)
  const clearAskRef = useRef<HTMLDivElement | null>(null)
  const closeClearAsk = useCallback(() => setClearAsk(false), [])
  useDismissable(clearAskRef, clearAsk, closeClearAsk)

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
    return flat.filter(({ record }) => {
      if (colorFilter && colorDistance(record.color, colorFilter) > 0.06) return false
      if (!needle) return true
      const haystack = `${record.contents ?? ''} ${excerpts.get(record.id) ?? ''}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [flat, query, colorFilter, excerpts])

  if (flat.length === 0) {
    return <p className="sidebar-empty">{t('side.noAnnots')}</p>
  }

  let lastPage = 0
  return (
    <div className="annot-list">
      <div className="annot-export">
        <button className="annot-ask-ai" onClick={onAskAi} title={t('side.askAiTip')}>
          <span className="annot-ask-ai-glyph">✦</span>
          {t('ai.annotsBtn')}
        </button>
        <div className="annot-export-head">
          <span>{t('side.export')}</span>
        </div>
        <div className="annot-export-row">
          <button onClick={() => onExport('markdown')} title={t('side.exportMdTip')}>
            MD
          </button>
          <button onClick={() => onExport('html')} title={t('side.exportHtmlTip')}>
            HTML
          </button>
          <button onClick={() => onExport('text')} title={t('side.exportTxtTip')}>
            TXT
          </button>
          <button onClick={() => onExport('docx')} title={t('side.exportDocxTip')}>
            Word
          </button>
        </div>
        <button className="annot-clear-all" onClick={() => setClearAsk(true)} title={t('side.clearAllTip')}>
          {t('side.clearAll', { count: flat.length })}
        </button>
      </div>

      <div className="annot-filter">
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
                colorFilter && colorDistance(c.rgb, colorFilter) < 0.001 ? ' active' : ''
              }`}
              style={{ background: c.hex }}
              title={t('side.showOnly', { color: colorLabel(c).toLowerCase() })}
              onClick={() =>
                setColorFilter((prev) =>
                  prev && colorDistance(c.rgb, prev) < 0.001 ? null : c.rgb
                )
              }
            />
          ))}
        </div>
      </div>

      {filtered.length === 0 && <p className="sidebar-empty">{t('side.noMatches')}</p>}
      {filtered.map(({ pageNumber, record }) => {
        const header = pageNumber !== lastPage
        lastPage = pageNumber
        const excerpt = excerpts.get(record.id)
        const primary =
          record.type === 'note'
            ? record.contents || annotTypeLabel('note')
            : excerpt
              ? `«${excerpt}»`
              : annotTypeLabel(record.type)
        const comment = record.type !== 'note' ? record.contents : undefined
        return (
          <div key={record.id}>
            {header && <div className="annot-list-page">{t('side.page', { page: pageNumber })}</div>}
            <div className="annot-list-row">
              <button className="annot-list-main" onClick={() => onJump(pageNumber, record)}>
                <span
                  className="annot-list-dot"
                  style={{
                    background: `rgb(${record.color.map((v) => Math.round(v * 255)).join(',')})`
                  }}
                />
                <span className="annot-list-body">
                  <span className="annot-list-text">
                    {primary}
                    {record.author && <em> — {record.author}</em>}
                  </span>
                  {comment && <span className="annot-list-comment">{comment}</span>}
                </span>
              </button>
              <button
                className="annot-list-delete"
                title={t('side.deleteAnnot')}
                onClick={() => onDelete(pageNumber, record)}
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}

      {/* Same modal treatment as reset-to-defaults: it throws away work, and the
          detail line says both how much and which key takes it back. */}
      {clearAsk && (
        <div className="confirm-overlay">
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" ref={clearAskRef}>
            <p className="confirm-message">{t('side.clearAllConfirm', { count: flat.length })}</p>
            <p className="confirm-detail">{clearAllDetail()}</p>
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

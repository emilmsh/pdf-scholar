import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { annotTypeLabel, colorLabel, HIGHLIGHT_COLORS } from '../annotations'
import type { PageAnnotation } from '../annotations'
import { t, useLang } from '../i18n'

const THUMB_WIDTH = 132

export type ExportFormat = 'markdown' | 'html' | 'text'

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
  onExport(format: ExportFormat): void
  /** Open the AI panel with the "summarize my annotations" question */
  onAskAi(): void
}

type Tab = 'thumbs' | 'outline' | 'annots'

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
  onExport,
  onAskAi
}: Props): React.JSX.Element {
  useLang()
  const [tab, setTab] = useState<Tab>('thumbs')
  const [outline, setOutline] = useState<OutlineNode[] | null>(null)
  const [visibleThumbs, setVisibleThumbs] = useState<ReadonlySet<number>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf
      .getOutline()
      .then((items) => {
        if (!cancelled) setOutline((items as OutlineNode[] | null) ?? [])
      })
      .catch(() => setOutline([]))
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
      <div className="sidebar-tabs">
        <button className={tab === 'thumbs' ? 'active' : ''} onClick={() => setTab('thumbs')}>
          {t('side.pages')}
        </button>
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>
          {t('side.contents')}
        </button>
        <button className={tab === 'annots' ? 'active' : ''} onClick={() => setTab('annots')}>
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

      {tab === 'annots' && (
        <AnnotationList
          annotations={annotations}
          excerpts={excerpts}
          onJump={onJumpToAnnot}
          onDelete={onDeleteAnnot}
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

function AnnotationList({
  annotations,
  excerpts,
  onJump,
  onDelete,
  onExport,
  onAskAi
}: {
  annotations: ReadonlyMap<number, PageAnnotation[]>
  excerpts: ReadonlyMap<string, string>
  onJump(pageNumber: number, record: PageAnnotation): void
  onDelete(pageNumber: number, record: PageAnnotation): void
  onExport(format: ExportFormat): void
  onAskAi(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [colorFilter, setColorFilter] = useState<[number, number, number] | null>(null)

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
      <div className="annot-export-row">
        <span>{t('side.export')}</span>
        <button onClick={() => onExport('markdown')} title={t('side.exportMdTip')}>
          MD
        </button>
        <button onClick={() => onExport('html')} title={t('side.exportHtmlTip')}>
          HTML
        </button>
        <button onClick={() => onExport('text')} title={t('side.exportTxtTip')}>
          TXT
        </button>
        <button className="annot-ask-ai" onClick={onAskAi} title={t('ai.annotsTip')}>
          ✦
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
  const [expanded, setExpanded] = useState(depth === 0)
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
        <button className="outline-title" title={node.title} onClick={() => onJump(node.dest)}>
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

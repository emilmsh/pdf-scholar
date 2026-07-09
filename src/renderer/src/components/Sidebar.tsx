import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const THUMB_WIDTH = 132

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
  onJumpToPage(page: number): void
  onJumpToDest(dest: unknown): void
}

type Tab = 'thumbs' | 'outline'

function Sidebar({
  open,
  pdf,
  sizes,
  currentPage,
  onJumpToPage,
  onJumpToDest
}: Props): React.JSX.Element {
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
          Sider
        </button>
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>
          Innhold
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
          {outline === null && <p className="sidebar-empty">Laster …</p>}
          {outline?.length === 0 && <p className="sidebar-empty">Dokumentet har ingen innholdsfortegnelse.</p>}
          {outline && outline.length > 0 && (
            <OutlineLevel nodes={outline} depth={0} onJump={onJumpToDest} />
          )}
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
  const [expanded, setExpanded] = useState(depth === 0)
  const hasChildren = node.items.length > 0
  return (
    <div>
      <div className="outline-row" style={{ paddingLeft: 10 + depth * 16 }}>
        {hasChildren ? (
          <button
            className={`outline-chevron${expanded ? ' expanded' : ''}`}
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? 'Lukk' : 'Åpne'}
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

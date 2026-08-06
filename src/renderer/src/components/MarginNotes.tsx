// Margin view (flow): every note and every annotation comment on a page,
// rendered as always-visible cards in a tinted column beside the page — the
// text is readable on sight instead of hiding behind a click (a note bubble
// or a popover). Cards sit at their anchor's height unless the one above
// pushes them down (Word's comment-column rule); the stack is pushed back up
// if it would run off the paper, mirroring the export. The strip shows even
// on pages with no comments — it IS the margin, not a popup.
//
// This is deliberately the ONLY margin layout. The list job — search, filter,
// export, jump-navigation — lives in the sidebar's Merknader tab, which
// renders the same <MarginCard>; the margin does what only a margin can:
// show the comments in place, the way the export will print them.
//
// Card geometry is CSS px on purpose — zooming the document must not zoom the
// comments; they are chrome, not content.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ViewRotation } from '../../../shared/types'
import { MARGIN_NOTES_GAP, MARGIN_NOTES_W, pageRectToView, viewSize } from '../rotation'
import type { RowLayout } from '../rotation'
import { quadsUnion, rgbCss } from '../annotations'
import type { PageAnnotation } from '../annotations'
import { IconChevronDown } from './icons'
import { isFindHotkey } from '../platform'
import { t, useLang } from '../i18n'

/** Vertical gap between stacked cards, CSS px */
const CARD_GAP = 8
/** Cards keep this clear of the paper's top/bottom edges */
const EDGE_PAD = 8

export interface MarginViewConfig {
  side: 'left' | 'right'
}

/** Which annotations earn a card in the MARGIN: notes always (they ARE their
 *  text, even while still empty), anything else only when a comment was
 *  written. FreeText is excluded — its text is already visible on the page.
 *  (The Merknader tab lists every annotation instead; adding a comment there
 *  promotes it into the margin.) */
export function marginCardAnnotations(annotations: PageAnnotation[]): PageAnnotation[] {
  return annotations.filter(
    (a) => a.type === 'note' || (a.type !== 'freetext' && !!a.contents?.trim())
  )
}

/** Grow a textarea to its content — the cards never scroll internally */
function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}

/** One editable comment card — shared by the margin's flow strip and the
 *  sidebar's Merknader tab, so editing, deletion and the look can never
 *  drift apart between the two again. */
export function MarginCard({
  a,
  pageNumber,
  context,
  extraProps,
  selected,
  onCommit,
  onSelect,
  onDelete
}: {
  a: PageAnnotation
  pageNumber: number
  /** Muted context line above the comment (the tab shows the marked text
   *  excerpt / type label there; the margin needs none — the anchor is
   *  right beside the card) */
  context?: string | undefined
  /** Positioning/hover props from the host layout */
  extraProps?: React.HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: unknown }
  selected: boolean
  onCommit(pageNumber: number, localId: string, text: string): void
  onSelect(pageNumber: number, localId: string): void
  onDelete(pageNumber: number, localId: string): void
}): React.JSX.Element {
  return (
    <div
      // Contents in the key (set by the callers): an external text change
      // (undo/redo, popover edit) must refresh the uncontrolled textarea.
      data-card={a.id}
      className={`margin-note-card${selected ? ' is-selected' : ''}`}
      // The pages container owns drag/selection gestures on everything under
      // it — a click in a card is typing or navigation, not panning.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      {...extraProps}
      style={{ borderLeftColor: rgbCss(a.color, 1), ...extraProps?.style }}
    >
      {context && <div className="margin-card-context">{context}</div>}
      <textarea
        defaultValue={a.contents ?? ''}
        placeholder={t(a.type === 'note' ? 'menu.notePlaceholder' : 'popover.commentPlaceholder')}
        spellCheck={false}
        rows={1}
        onFocus={() => onSelect(pageNumber, a.id)}
        onKeyDown={(e) => {
          // Keep viewer shortcuts (H, W, Delete …) out of typed text; Esc and
          // Ctrl/Cmd+Enter both commit via the blur below. Find bubbles to
          // the window handler, same as the comment popover.
          if (isFindHotkey(e)) return
          e.stopPropagation()
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
            ;(e.target as HTMLTextAreaElement).blur()
          }
        }}
        onBlur={(e) => {
          const text = e.target.value.trim()
          if (text !== (a.contents ?? '').trim()) onCommit(pageNumber, a.id, text)
        }}
      />
      <button
        className="margin-note-delete"
        title={t('app.delete')}
        aria-label={t('app.delete')}
        onClick={(e) => {
          e.stopPropagation()
          onDelete(pageNumber, a.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

interface JumpArrowsProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  layout: RowLayout | null
  annots: ReadonlyMap<number, PageAnnotation[]>
  sizes: { w: number; h: number }[]
  scale: number
  rotation: ViewRotation
  side: 'left' | 'right'
  onJump(pageNumber: number, record: PageAnnotation): void
}

/** When the margin is on but NO card is in the viewport, two quiet arrows on
 *  the margin's side offer the nearest comment above/below — so an empty
 *  stretch of margin never becomes a dead end. Disappear the moment a card
 *  scrolls into view. */
export function MarginJumpArrows({
  scrollRef,
  layout,
  annots,
  sizes,
  scale,
  rotation,
  side,
  onJump
}: JumpArrowsProps): React.JSX.Element | null {
  useLang()
  type Target = { pageNumber: number; record: PageAnnotation }
  const [state, setState] = useState<{
    up: Target | null
    down: Target | null
    /** Viewport x of the margin strip's centre — the arrows sit ON the
     *  margin, not at an arbitrary pane edge */
    x: number
  } | null>(null)
  const lastKeyRef = useRef('')

  /** Every comment's anchor position in scroll-content coordinates */
  const items = useMemo(() => {
    const list: { pageNumber: number; record: PageAnnotation; y: number }[] = []
    if (!layout) return list
    for (const [pageNumber, anns] of annots) {
      const size = sizes[pageNumber - 1]
      const top = layout.tops[pageNumber - 1]
      if (!size || top === undefined) continue
      for (const record of marginCardAnnotations(anns)) {
        const u = pageRectToView(quadsUnion(record.quads), size.w, size.h, rotation)
        list.push({ pageNumber, record, y: top + u.y * scale })
      }
    }
    return list.sort((a, b) => a.y - b.y)
  }, [annots, layout, sizes, scale, rotation])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !layout) return
    let raf = 0
    const compute = (): void => {
      raf = 0
      const top = el.scrollTop + 8
      const bottom = el.scrollTop + el.clientHeight - 8
      let up: Target | null = null
      let down: Target | null = null
      let anyVisible = false
      for (const it of items) {
        if (it.y >= top && it.y <= bottom) {
          anyVisible = true
          break
        }
        if (it.y < top) up = it
        else if (!down) down = it
      }
      const hidden = anyVisible || (!up && !down)
      // Centre on the margin strip of the page at the viewport's middle: the
      // strip's x comes from the live layout, follows horizontal scroll, and
      // is clamped into view at zooms where the strip itself is off-screen —
      // computed per scroll frame, so no zoom level can leave it stale.
      let x = 0
      if (!hidden) {
        const mid = el.scrollTop + el.clientHeight / 2
        let page = 0
        for (let i = 0; i < layout.tops.length; i++) {
          if (layout.tops[i] <= mid) page = i
          else break
        }
        const stripCentre =
          side === 'right'
            ? layout.lefts[page] + layout.widths[page] + MARGIN_NOTES_W / 2
            : layout.lefts[page] - MARGIN_NOTES_W / 2
        x = Math.round(
          Math.min(Math.max(stripCentre - el.scrollLeft, 26), el.clientWidth - 26) / 4
        ) * 4
      }
      // Only re-render when the ANSWER changes, not on every scrolled pixel
      const key = hidden ? '' : `${up?.record.id ?? ''}|${down?.record.id ?? ''}|${x}`
      if (key === lastKeyRef.current) return
      lastKeyRef.current = key
      setState(hidden ? null : { up, down, x })
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    compute()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [items, scrollRef, layout, side])

  if (!state) return null
  return (
    <>
      {state.up && (
        <button
          className="margin-jump up"
          style={{ left: state.x - 15 }}
          title={t('margin.prevComment')}
          onClick={() => onJump(state.up!.pageNumber, state.up!.record)}
        >
          <IconChevronDown size={15} className="flip" />
        </button>
      )}
      {state.down && (
        <button
          className="margin-jump down"
          style={{ left: state.x - 15 }}
          title={t('margin.nextComment')}
          onClick={() => onJump(state.down!.pageNumber, state.down!.record)}
        >
          <IconChevronDown size={15} />
        </button>
      )}
    </>
  )
}

interface Props {
  pageNumber: number
  annotations: PageAnnotation[]
  scale: number
  rotation: ViewRotation
  /** Page-space dimensions (points), before the view rotation */
  pageW: number
  pageH: number
  view: MarginViewConfig
  selectedId: string | null
  /** Stable callbacks (PdfPage is memoised — identity churn re-renders canvases) */
  onCommit(pageNumber: number, localId: string, text: string): void
  onSelect(pageNumber: number, localId: string): void
  onDelete(pageNumber: number, localId: string): void
}

/** The per-page flow strip (rendered inside .pdf-page). Always visible while
 *  the margin view is on — an empty margin is still the margin. */
export default function MarginNotes({
  pageNumber,
  annotations,
  scale,
  rotation,
  pageW,
  pageH,
  view,
  selectedId,
  onCommit,
  onSelect,
  onDelete
}: Props): React.JSX.Element | null {
  useLang()
  const hostRef = useRef<HTMLDivElement>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const pageWCss = viewSize(pageW, pageH, rotation).w * scale
  const items = marginCardAnnotations(annotations)
    .map((a) => {
      const u = pageRectToView(quadsUnion(a.quads), pageW, pageH, rotation)
      return {
        a,
        anchor: { x: u.x * scale, y: u.y * scale, w: u.w * scale, h: u.h * scale }
      }
    })
    .sort((x, y) => x.anchor.y - y.anchor.y)

  /** Size each textarea to its text, then place the cards at their anchors,
   *  never overlapping, pushed back up when the stack would run off the
   *  paper. Runs after every render and on every keystroke — a page has a
   *  handful of cards, the pass is cheap. */
  const restack = (): void => {
    const host = hostRef.current
    if (!host) return
    const cards = Array.from(host.querySelectorAll<HTMLElement>('.margin-note-card'))
    let prevBottom = EDGE_PAD - CARD_GAP
    const placed: { el: HTMLElement; top: number }[] = []
    for (const card of cards) {
      const ta = card.querySelector('textarea')
      if (ta) autosize(ta)
      const top = Math.max(Number(card.dataset.anchor) || 0, prevBottom + CARD_GAP)
      placed.push({ el: card, top })
      prevBottom = top + card.offsetHeight
    }
    // Push the stack back up if it runs off the paper — same rule the export
    // applies, so the screen and the printed copy agree.
    let ceiling = host.clientHeight - EDGE_PAD
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]
      p.top = Math.max(EDGE_PAD, Math.min(p.top, ceiling - p.el.offsetHeight))
      ceiling = p.top - CARD_GAP
    }
    for (const p of placed) p.el.style.top = `${p.top}px`
  }
  const restackRef = useRef(restack)
  restackRef.current = restack
  useLayoutEffect(() => {
    restackRef.current()
  })

  /** Anchor coordinates in HOST space: the host hangs off the page's chosen
   *  edge, so the page content lies at negative x (right side) or beyond the
   *  host's width (left side). The SVG draws there — overflow is visible. */
  const anchorToHost = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } =>
    view.side === 'right' ? { ...r, x: r.x - pageWCss } : { ...r, x: r.x + MARGIN_NOTES_W }
  const cardEdgeX = view.side === 'right' ? MARGIN_NOTES_GAP - 2 : MARGIN_NOTES_W - MARGIN_NOTES_GAP + 2

  const active = items.filter(({ a }) => a.id === hoveredId || a.id === selectedId)

  return (
    <div className={`margin-notes side-${view.side}`} ref={hostRef}>
      {/* Leader lines + anchor outline for the hovered/selected cards — the
          answer to "where in the document does this comment point?" */}
      <svg className="margin-note-leads" aria-hidden="true">
        {active.map(({ a, anchor }) => {
          const ha = anchorToHost(anchor)
          const card = hostRef.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(a.id)}"]`)
          const cardY = card ? card.offsetTop + 12 : anchor.y + 12
          const tipX = view.side === 'right' ? ha.x + ha.w + 2 : ha.x - 2
          return (
            <g key={a.id} stroke={rgbCss(a.color, 1)} fill="none">
              <path d={`M ${cardEdgeX} ${cardY} L ${tipX} ${ha.y + Math.min(ha.h / 2, 10)}`} strokeWidth="1.5" opacity="0.75" />
              <rect
                x={ha.x - 2}
                y={ha.y - 2}
                width={ha.w + 4}
                height={ha.h + 4}
                rx="3"
                strokeWidth="1.5"
                opacity="0.9"
              />
            </g>
          )
        })}
      </svg>
      {items.map(({ a, anchor }) => (
        <MarginCard
          key={`${a.id}:${a.contents ?? ''}`}
          a={a}
          pageNumber={pageNumber}
          selected={selectedId === a.id}
          onCommit={onCommit}
          onSelect={onSelect}
          onDelete={onDelete}
          extraProps={{
            'data-anchor': anchor.y,
            style: { top: anchor.y },
            onPointerEnter: () => setHoveredId(a.id),
            onPointerLeave: () => setHoveredId((h) => (h === a.id ? null : h)),
            onInput: () => restackRef.current()
          }}
        />
      ))}
    </div>
  )
}

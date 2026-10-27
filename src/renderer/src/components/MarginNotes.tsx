// Margin view (flow): every note and every annotation comment on a page,
// rendered as always-visible cards in a tinted column beside the page — the
// text is readable on sight instead of hiding behind a click (a note bubble
// or a popover). Cards sit at their anchor's height unless the one above
// pushes them down (Word's comment-column rule); the stack is pushed back up
// if it would run off the paper, as far as the paper allows — comments taller
// than their page run on below it, the strip with them, and the next page's
// stack starts under them (src/shared/margin-stack.ts; the export lays the
// whole document out in one column instead). The strip shows even on pages
// with no comments — it IS the margin, not a popup.
//
// This is deliberately the ONLY margin layout. The list job — search, filter,
// export, jump-navigation — lives in the sidebar's Merknader tab, which
// renders the same <MarginCard>; the margin does what only a margin can:
// show the comments in place, the way the export will print them.
//
// Card geometry is CSS px on purpose — zooming the document must not zoom the
// comments; they are chrome, not content.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ViewRotation } from '../../../shared/types'
import { stackMarginCards } from '../../../shared/margin-stack'
import { MARGIN_NOTES_GAP, MARGIN_NOTES_W, pageRectToView, viewSize } from '../rotation'
import type { RowLayout } from '../rotation'
import { quadsUnion, rgbCss } from '../annotations'
import type { PageAnnotation } from '../annotations'
import { IconChevronDown } from './icons'
import { bubblesWhileTyping } from '../keymap'
import { t, useLang } from '../i18n'
import { inTextField } from './TextContextMenu'

/** Vertical gap between stacked cards, CSS px */
const CARD_GAP = 8
/** Cards keep this clear of the paper's top/bottom edges */
const EDGE_PAD = 8

// ---------- What runs on from one page to the next ----------
//
// A page's stack may overhang its bottom edge (margin-stack.ts). The pages are
// separate React trees that know nothing of each other, so each strip reports
// where its column ENDS, in the column's layout coordinates, and the page
// below starts its strip under that. Keyed by the column's .pages-inner — the
// split view has two columns, each with a document of its own. The viewers
// read the same store to keep an overhanging page mounted while its cards are
// near, and to let the scroll height reach the last card. Only overhanging
// pages have an entry; a page that fits reports none.

interface StackEntry {
  docKey: string
  /** The page's top in the column's layout */
  top: number
  /** Where the strip ends: the last card's foot plus the edge pad */
  bottom: number
}
const columnStacks = new WeakMap<Element, Map<string, StackEntry>>()
const stackListeners = new Set<() => void>()
const stackKey = (docKey: string, pageNumber: number): string => `${docKey}\u0000${pageNumber}`

function reportMarginStack(
  column: Element,
  docKey: string,
  pageNumber: number,
  entry: { top: number; bottom: number } | null
): void {
  const key = stackKey(docKey, pageNumber)
  let stacks = columnStacks.get(column)
  const prev = stacks?.get(key)
  if (!entry) {
    if (!prev) return
    stacks!.delete(key)
  } else {
    if (prev && prev.top === entry.top && prev.bottom === entry.bottom) return
    if (!stacks) {
      stacks = new Map()
      columnStacks.set(column, stacks)
    }
    stacks.set(key, { docKey, ...entry })
  }
  for (const fn of stackListeners) fn()
}

function subscribeMarginStacks(fn: () => void): () => void {
  stackListeners.add(fn)
  return () => {
    stackListeners.delete(fn)
  }
}

/** Where a page's strip may begin, relative to the page's top: under the
 *  lowest strip of the pages above it that runs past `pageTop`; 0 when none */
function marginStripStart(column: Element, docKey: string, pageTop: number): number {
  const stacks = columnStacks.get(column)
  if (!stacks) return 0
  let start = 0
  for (const e of stacks.values()) {
    if (e.docKey !== docKey || e.top >= pageTop) continue
    start = Math.max(start, e.bottom - pageTop)
  }
  return start
}

/** The foot of a page's strip in the column's layout, when it runs past the
 *  page — the viewer keeps the page mounted while that is in reach */
export function marginStackBottom(
  column: Element | null,
  docKey: string,
  pageNumber: number
): number | null {
  const e = column ? columnStacks.get(column)?.get(stackKey(docKey, pageNumber)) : undefined
  return e ? e.bottom : null
}

/** Every strip's foot forgotten — the viewer calls this when its layout
 *  changes, since the entries are in layout coordinates and a page scrolled
 *  out of the mounted range cannot re-report its own */
export function resetMarginStacks(column: Element | null): void {
  if (column) columnStacks.delete(column)
}

/** The lowest strip foot in a column (0 when nothing overhangs, or the view
 *  is off): the scroll height must reach it, or the last page's comments
 *  cannot be scrolled to */
export function useMarginColumnBottom(
  columnRef: React.RefObject<HTMLElement | null>,
  docKey: string,
  on: boolean
): number {
  const subscribe = useCallback((fn: () => void) => subscribeMarginStacks(fn), [])
  const read = useCallback((): number => {
    const stacks = on && columnRef.current ? columnStacks.get(columnRef.current) : undefined
    if (!stacks) return 0
    let bottom = 0
    for (const e of stacks.values()) if (e.docKey === docKey) bottom = Math.max(bottom, e.bottom)
    return bottom
  }, [columnRef, docKey, on])
  return useSyncExternalStore(subscribe, read)
}

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
          // Ctrl/Cmd+Enter both commit via the blur below. App shortcuts still
          // bubble to the window handler, same as the comment popover — and
          // asking the keymap means a REBOUND find gets through too, not just
          // Ctrl+F.
          if (bubblesWhileTyping(e)) return
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
  /** The document the column shows — the overhang store is per document */
  docKey: string
  pageNumber: number
  /** The page's top in the column's layout (CSS px): what the strips of the
   *  pages above and below are measured against */
  pageTop: number
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
  /** Right-click anywhere on the strip: the viewer shows a small menu there
   *  offering to hide the margin view — a choice, never an immediate close
   *  (Emil, 2026-09-02). Coordinates are viewport (clientX/Y). */
  onMenu(x: number, y: number): void
}

/** The per-page flow strip (rendered inside .pdf-page). Always visible while
 *  the margin view is on — an empty margin is still the margin. */
export default function MarginNotes({
  docKey,
  pageNumber,
  pageTop,
  annotations,
  scale,
  rotation,
  pageW,
  pageH,
  view,
  selectedId,
  onCommit,
  onSelect,
  onDelete,
  onMenu
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

  /** The strip's box, relative to the page: it starts at the page's top
   *  unless a page above runs on into this one, and ends at the page's
   *  bottom (`bottom` null) unless this page's own stack runs past it. With
   *  neither, no inline style at all — the CSS box, pixel for pixel. */
  const [strip, setStrip] = useState<{ top: number; bottom: number | null }>({ top: 0, bottom: null })

  /** Size each textarea to its text, then place the cards at their anchors,
   *  never overlapping, pushed back up when the stack would run off the
   *  paper — as far as the paper allows, the rest overhanging (margin-stack.ts).
   *  Runs after every render and on every keystroke — a page has a handful
   *  of cards, the pass is cheap. Card tops are in PAGE coordinates until the
   *  write, where the strip's own top comes off. */
  const restack = (): void => {
    const host = hostRef.current
    const page = host?.parentElement
    if (!host || !page) return
    const column = host.closest('.pages-inner')
    const cards = Array.from(host.querySelectorAll<HTMLElement>('.margin-note-card'))
    const items = cards.map((card) => {
      const ta = card.querySelector('textarea')
      if (ta) autosize(ta)
      return { anchor: Number(card.dataset.anchor) || 0, height: card.offsetHeight }
    })
    // Whole CSS px: the page tops are snapped to device pixels, so the
    // difference between two of them can be a fraction
    const start = column ? Math.round(marginStripStart(column, docKey, pageTop)) : 0
    const stack = stackMarginCards(items, page.clientHeight, {
      gap: CARD_GAP,
      edgePad: EDGE_PAD,
      floor: start + EDGE_PAD
    })
    cards.forEach((card, i) => {
      card.style.top = `${stack.tops[i] - start}px`
    })
    const bottom = stack.overhang > 0 ? stack.bottom + EDGE_PAD : null
    setStrip((s) => (s.top === start && s.bottom === bottom ? s : { top: start, bottom }))
    if (column) {
      reportMarginStack(
        column,
        docKey,
        pageNumber,
        bottom === null ? null : { top: pageTop, bottom: pageTop + bottom }
      )
    }
  }
  const restackRef = useRef(restack)
  restackRef.current = restack
  useLayoutEffect(() => {
    restackRef.current()
  })
  // A strip above this one moved its foot: restack under it. Deferred to a
  // microtask — still before the frame paints, but outside the reporting
  // page's own layout effect, so the pages never re-enter each other.
  useEffect(() => {
    let queued = false
    return subscribeMarginStacks(() => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        restackRef.current()
      })
    })
  }, [])

  /** Anchor coordinates in HOST space: the host hangs off the page's chosen
   *  edge, so the page content lies at negative x (right side) or beyond the
   *  host's width (left side) — and above the host when the strip starts
   *  below the page's top. The SVG draws there — overflow is visible. */
  const anchorToHost = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } =>
    view.side === 'right'
      ? { ...r, x: r.x - pageWCss, y: r.y - strip.top }
      : { ...r, x: r.x + MARGIN_NOTES_W, y: r.y - strip.top }
  const stripStyle: React.CSSProperties | undefined =
    strip.top === 0 && strip.bottom === null
      ? undefined
      : strip.bottom === null
        ? { top: strip.top }
        : { top: strip.top, bottom: 'auto', height: strip.bottom - strip.top }
  const cardEdgeX = view.side === 'right' ? MARGIN_NOTES_GAP - 2 : MARGIN_NOTES_W - MARGIN_NOTES_GAP + 2

  const active = items.filter(({ a }) => a.id === hoveredId || a.id === selectedId)

  return (
    <div
      className={`margin-notes side-${view.side}`}
      ref={hostRef}
      style={stripStyle}
      // Right-click on the strip (cards included — it is all "the margin")
      // asks the viewer to offer hiding the view. Inside a comment's textarea
      // the TEXT menu is wanted instead (paste!): the event is left to bubble,
      // the pages container yields text fields too (inTextField), and the
      // app-wide TextContextMenu picks it up — or the browser's own menu does,
      // on the web targets.
      onContextMenu={(e) => {
        if (inTextField(e.target)) return
        e.preventDefault()
        e.stopPropagation()
        onMenu(e.clientX, e.clientY)
      }}
    >
      {/* The host is pointer-events: none (the standing overlay rule), so the
          EMPTY stretches of strip need their own hit surface for the
          right-click above; everything else bubbles through untouched. */}
      <div className="margin-strip-hit" />
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
            style: { top: anchor.y - strip.top },
            onPointerEnter: () => setHoveredId(a.id),
            onPointerLeave: () => setHoveredId((h) => (h === a.id ? null : h)),
            onInput: () => restackRef.current()
          }}
        />
      ))}
    </div>
  )
}

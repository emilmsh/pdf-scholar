import { useRef } from 'react'
import { useEdgeFade } from '../edge-fade'

/** The card's width: ~50 characters of the reading face at 12 px, enough to
 *  read a paragraph without the lines breaking every few words */
const WIDTH = 300
/** The most of the window the card may take; more than that scrolls inside
 *  it, the edge fading where there is more (the link preview's rule — no
 *  scrollbar in a window this small) */
const MAX_SHARE = 0.4
/** Air between the mark and the card */
const GAP = 6
/** Keep the card this far inside the window's edges */
const EDGE = 8

interface Props {
  text: string
  /** The mark's box in viewport coordinates */
  anchor: { left: number; top: number; right: number; bottom: number }
  onPointerEnter(): void
  onPointerLeave(): void
}

/**
 * The comment behind a note or a markup, shown while the pointer rests on
 * the mark (PdfViewer's hover section). Hung off the mark's box — under it
 * when there is room, else over it — so it stands still while the pointer
 * crosses over to it; the viewer keeps it open while the pointer is on the
 * mark or the card. Pointer events are ON (the old tooltip's were off), which
 * is what lets the wheel scroll a long comment inside it.
 */
export default function AnnotHoverCard({ text, anchor, onPointerEnter, onPointerLeave }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEdgeFade(scrollRef, [text])

  const winW = window.innerWidth
  const winH = window.innerHeight
  const maxH = Math.max(80, Math.round(winH * MAX_SHARE))
  const left = Math.max(EDGE, Math.min(anchor.left, winW - WIDTH - EDGE))
  const roomBelow = winH - anchor.bottom - GAP - EDGE
  const roomAbove = anchor.top - GAP - EDGE
  // Below unless the room there is short AND there is more above: a mark at
  // the window's foot gets its card over it, every other one under it
  const below = roomBelow >= Math.min(maxH, 120) || roomBelow >= roomAbove
  const place: React.CSSProperties = below
    ? { left, top: anchor.bottom + GAP, maxHeight: Math.min(maxH, roomBelow) }
    : { left, bottom: winH - anchor.top + GAP, maxHeight: Math.min(maxH, roomAbove) }

  return (
    <div
      className="annot-hover-tip"
      style={place}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="annot-hover-text" ref={scrollRef}>
        {text}
      </div>
    </div>
  )
}

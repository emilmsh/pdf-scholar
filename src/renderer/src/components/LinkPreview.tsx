// Hover previews of in-document links (issue #31): rest the pointer on a
// citation, a «Figure 3» or an «(2.4)» and a window onto the destination opens
// beside it — the reference entry, the figure, the equation — without moving
// the page you are reading. Click inside it to go there (Ctrl/Cmd+click: the
// other column, exactly like the link itself). The wheel scrolls the window,
// not the page under it.
//
// The pointer choreography lives here; where the window looks and how large it
// is are the pure rules in ../link-preview.ts. The component never touches
// PdfPage's props: PdfPage records each internal anchor in LINK_RECORDS and
// this listens on the viewer root, so a split column showing another file
// previews against ITS document with no extra wiring.
//
// Touch has no hover, so a long-press on a link opens the same window (the
// tap still follows the link); a pen's hover works like the mouse's.
//
// A citation is not a window onto the page but a CARD, the way Zotero's reader
// shows one (issue #31, third round — Emil, 2026-10-16: Zotero's users are
// this app's readers): one row per reference, the entry's own text read off
// the reference list, selectable, with the links the PDF puts in it. A
// bracket is read whole from any of its numbers — «[3, 5–9]» is six rows,
// whether the PDF linked «3», «[5» or «9]». Each row has «Sammendrag»: the
// cited paper's abstract, fetched on that click and never before
// (src/shared/abstract.ts — the app is offline unless you ask), folding out
// under its row; and «Gå til» its place in the list. Once read in (a click,
// a selection, an abstract), the card stays put when the pointer leaves.
// An entry the page gives no text for falls back to the rendered window.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { OPS } from 'pdfjs-dist'
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist'
import { pageImageRects, pagePathRects } from '../image-regions'
import type { OpsTable } from '../image-regions'
import { useDismissable } from '../useDismissable'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { t } from '../i18n'
import { bridge } from '../bridge'
import type { CitationAbstract, FileError } from '../../../shared/types'
import { AbstractBody, AbstractSource } from './AbstractView'
import type { AbstractState } from './AbstractView'
import {
  belowFootnoteRule,
  cardEntries,
  citationGroup,
  clearOfNeighbours,
  citedRange,
  destFamily,
  destLabel,
  destOnFigureCaption,
  entryBox,
  entryLines,
  equationBox,
  familyDests,
  familySiblings,
  fitBox,
  floatBox,
  footnoteLines,
  groupDests,
  inFootnotes,
  LINK_RECORDS,
  linkKind,
  growInPlace,
  placePreview,
  previewScale,
  previewScroll,
  previewSize,
  rangeEnd,
  resolvePreviewTarget,
  textBounds,
  textExtent,
  textLines,
  scholarQuery,
  scholarUrl,
  uprightItems,
  viewFrame,
  withFloatNotes
} from '../link-preview'
import { findArxivId } from '../../../shared/abstract'
import type { CardEntry, FamilyDest, Graphic, LineLink, LinkKind, LinkRecord, PdfBox, PreviewTarget } from '../link-preview'

interface Props {
  /** The viewer's root: only links inside it are this component's */
  hostRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  delayMs: number
}

interface Open {
  anchor: HTMLElement
  rec: LinkRecord
  target: PreviewTarget
  pageIndex: number
  kind: LinkKind
  /** The rendered page — null for a citation card, which draws no page */
  canvas: HTMLCanvasElement | null
  /** A citation's references as text (Zotero's card), when the entries
   *  could be read off the reference list; null = the rendered window */
  card: Card | null
  /** Where the pointer was: a card is placed again once its height is known */
  pointerX: number
  /** CSS size of the page image */
  pageW: number
  pageH: number
  /** The destination in the image's CSS pixels (null = unnamed) */
  vx: number | null
  vy: number | null
  scroll: { left: number; top: number }
  box: { w: number; h: number }
  at: { left: number; top: number; below: boolean }
  /** The page image's scale — Ctrl+wheel over the window changes it */
  scale: number
  /** The works a cited range («5–9») names: the window holds them all, and
   *  the abstract button stands down (one abstract for five works would be
   *  a guess about which) */
  range: [number, number] | null
  /** Cut to the target itself — a citation's reference entry, a
   *  footnote, a figure or table, an equation's display — when the page
   *  says where it ends: no neighbours, no marker, and no scrolling unless
   *  it is bigger than the window may be */
  entry: boolean
  entryFits: boolean
  /** A cut-out's own box in the image's CSS pixels, its air included: the
   *  window's content IS this box, so a zoom or a resize scales the target
   *  and never opens onto the rest of the page (Emil, 2026-10-17: a resized
   *  footnote could suddenly be scrolled around its whole page). Null = a
   *  window onto the page. */
  clip: Clip | null
}

/** A cut-out: the window's content box (the target plus its air) and, inside
 *  it, the target itself — only that much of the page is painted; the air is
 *  blank paper, so it never shows the lines around the target */
interface Clip {
  l: number
  t: number
  w: number
  h: number
  inner: { l: number; t: number; r: number; b: number }
}

interface Card {
  entries: CardEntry[]
  /** «[3, 5–9]» for a group of more than one; null for one reference */
  label: string | null
}

/** The card's width: Zotero's 400 px, a little more for our larger type */
const CARD_W = 440

/** What «Sammendrag» found, per document and destination — a second hover on
 *  the same citation shows it again without asking anyone */
const abstractCache = new WeakMap<PDFDocumentProxy, Map<string, CitationAbstract>>()


/** How long the pointer may be between the link and the window (or off both)
 *  before the window goes: long enough to cross the gap, short enough that
 *  leaving reads as leaving. */
const CLOSE_GRACE_MS = 220
const LONG_PRESS_MS = 450
/** The footer line under the page window, borders included (app.css) */
const FOOT_PX = 27
/** Air around a target cut to its box, both sides together: a table's top
 *  rule or a plot's frame sits right on the box's edge, and 12 px a side read
 *  as crammed (Emil, 2026-10-17). Of the vertical air, TARGET_PAD_TOP goes
 *  above and the rest below — a caption's last line sat right on the
 *  window's foot. */
const TARGET_PAD = { x: 40, y: 40 }
const TARGET_PAD_TOP = 16
/** How small a cut-out may be read before its window scrolls instead. A
 *  figure or table is shown WHOLE (Emil, 2026-10-16: «du vil 100 % se hele
 *  figuren»), down to half the 100 % scale — a 10 pt label at 5 CSS px, the
 *  smallest at which a plot's shape and its axis labels still read; a
 *  footnote or a display is text to be read, and stops at 75 % (the
 *  sideways-page floor of v0.61.3). */
const FIGURE_FLOOR = 0.5
const TEXT_FLOOR = 0.75
/** Rendered pages kept per document. A paper's citations land on its one to
 *  three reference pages, so a handful makes every hover after the first one
 *  on a page instant. */
const CACHE_PAGES = 4
const MAX_CANVAS_PX = 1 << 24

const pageCache = new WeakMap<PDFDocumentProxy, Map<string, HTMLCanvasElement>>()

async function renderPage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  rotation: number
): Promise<{ canvas: HTMLCanvasElement; w: number; h: number; viewport: import('pdfjs-dist').PageViewport }> {
  const page = await pdf.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
  const key = `${pageIndex}@${scale.toFixed(3)}r${rotation}`
  let cache = pageCache.get(pdf)
  if (!cache) pageCache.set(pdf, (cache = new Map()))
  const hit = cache.get(key)
  if (hit) {
    // LRU: a hit moves to the back
    cache.delete(key)
    cache.set(key, hit)
    return { canvas: hit, w: viewport.width, h: viewport.height, viewport }
  }
  let dpr = window.devicePixelRatio || 1
  const px = viewport.width * viewport.height * dpr * dpr
  if (px > MAX_CANVAS_PX) dpr *= Math.sqrt(MAX_CANVAS_PX / px)
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.className = 'link-preview-canvas'
  await page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
  }).promise
  cache.set(key, canvas)
  while (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value!)
  return { canvas, w: viewport.width, h: viewport.height, viewport }
}

export default function LinkPreview({ hostRef, enabled, delayMs }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState<Open | null>(null)
  const openRef = useRef<Open | null>(null)
  openRef.current = open
  const boxRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const armTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  /** Bumps on every arm/close so a slow render for an old link never opens */
  const seq = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const delayRef = useRef(delayMs)
  delayRef.current = delayMs
  /** Each card row's abstract, by the entry's destination name */
  const [abs, setAbs] = useState<Record<string, AbstractState>>({})
  /** Read in (an abstract asked for, text selected, a zoom, a resize, a
   *  drag): the window no longer closes on pointer leave */
  const pinnedRef = useRef(false)
  /** Where the window stands once it has been placed for an abstract or
   *  dragged; null = the hover placement from `open.at` */
  const [placed, setPlaced] = useState<{ left: number; top: number; height: number | null } | null>(null)
  /** Dragged by the reader: their position wins from then on */
  const draggedRef = useRef(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  /** The corner grip (Emil, 2026-10-13: a figure can be bigger than the
   *  window): sizes the page part; null = the size the rules gave it. A
   *  resized window is being read, so it stays when the pointer leaves. */
  const [size, setSize] = useState<BoxSize | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  /** A cut-out being resized: the scale it is shown at (by CSS, over its
   *  last render) until the drag rests and it is rendered at that scale */
  const [liveScale, setLiveScale] = useState<number | null>(null)
  const liveScaleRef = useRef<number | null>(null)
  const setLive = (v: number | null): void => {
    liveScaleRef.current = v
    setLiveScale(v)
  }
  const resizeStart = useRef<{ w: number; h: number; scale: number } | null>(null)
  const resizeTimer = useRef<number | null>(null)
  /** The scale the rules gave the open target: a double-click on the grip
   *  goes back to it */
  const fitScaleRef = useRef(1)
  const { gripProps: baseGrip } = useResizable(
    scrollerRef,
    size,
    (s) => {
      pinnedRef.current = true
      clearClose()
      const o = openRef.current
      if (!o?.clip) {
        setSize(s)
        return
      }
      // A cut-out IS its window: the grip scales the target, both sides
      // together, by whichever side the drag moved more
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current)
      if (!s) {
        setSize(null)
        setLive(null)
        rescaleTo(o, fitScaleRef.current).catch(previewFailed)
        return
      }
      const start = resizeStart.current
      if (!start || s.w === null || s.h === null) return
      const dw = s.w / start.w
      const dh = s.h / start.h
      const want = Math.abs(dw - 1) >= Math.abs(dh - 1) ? dw : dh
      const scale = Math.round(Math.min(3, Math.max(0.5, start.scale * want)) * 1000) / 1000
      const k = scale / start.scale
      setSize({ w: Math.round(start.w * k), h: Math.round(start.h * k) })
      setLive(scale)
      resizeTimer.current = window.setTimeout(() => {
        resizeTimer.current = null
        const cur = openRef.current
        if (!cur) return
        rescaleTo(cur, scale)
          .then(() => setLive(null))
          .catch(previewFailed)
      }, 140)
    },
    { axis: 'both', minW: 160, minH: 60 }
  )
  const gripProps = {
    ...baseGrip,
    onPointerDown: (e: React.PointerEvent): void => {
      const r = scrollerRef.current?.getBoundingClientRect()
      const o = openRef.current
      resizeStart.current = r && o ? { w: r.width, h: r.height, scale: o.scale } : null
      baseGrip.onPointerDown(e)
    }
  }

  const clearArm = (): void => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    armTimer.current = null
  }
  const clearClose = (): void => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const close = useCallback((): void => {
    clearArm()
    clearClose()
    seq.current++
    pinnedRef.current = false
    setOpen(null)
  }, [])
  const scheduleClose = (): void => {
    if (pinnedRef.current) return
    clearClose()
    closeTimer.current = window.setTimeout(close, CLOSE_GRACE_MS)
  }

  /** Resolve, render and place the window for one anchor */
  const show = useCallback(async (anchor: HTMLElement, pointerX: number): Promise<void> => {
    const rec = LINK_RECORDS.get(anchor)
    if (!rec || !anchor.isConnected) return
    const mine = ++seq.current
    const target = await resolvePreviewTarget(rec.pdf, rec.dest)
    if (!target || mine !== seq.current) return
    if (target.kind === 'citation' && target.y !== null && target.name) {
      const card = await citationCard(anchor, rec, target).catch(() => null)
      if (mine !== seq.current || !anchor.isConnected) return
      if (card) {
        const w = Math.min(CARD_W, window.innerWidth - 24)
        // A first guess at the height; the layout effect below places the
        // card again by its real one before it is painted
        const h = Math.min(Math.round(window.innerHeight * 0.6), 24 + card.entries.length * 70)
        const box = { w, h }
        const r = anchor.getBoundingClientRect()
        const at = placePreview(r, pointerX, { w, h: h + FOOT_PX }, { w: window.innerWidth, h: window.innerHeight })
        const known = abstractCache.get(rec.pdf)
        const found: Record<string, AbstractState> = {}
        for (const e of card.entries) {
          const k = known?.get(e.dest)
          if (k) found[e.dest] = { state: 'done', result: k }
        }
        pinnedRef.current = false
        draggedRef.current = false
        setPlaced(null)
        setSize(null)
        setAbs(found)
        setOpen({
          anchor,
          rec,
          target,
          pageIndex: card.entries[0]!.pageIndex,
          kind: target.kind,
          canvas: null,
          card,
          pointerX,
          pageW: 0,
          pageH: 0,
          vx: null,
          vy: null,
          scroll: { left: 0, top: 0 },
          box,
          scale: 1,
          range: null,
          entry: false,
          entryFits: false,
          clip: null,
          at
        })
        return
      }
    }
    // The link's own words: a cited range («5–9») shows every entry it names
    const range = target.kind === 'citation' && target.y !== null ? citedRange(linkText(anchor)) : null
    const box = previewSize(target.kind, window.innerWidth, window.innerHeight)
    /** The default width, before anything grows it: what a target cut to
     *  its own box is read to fit */
    const prefW = box.w
    // Read at the scale that fits the page's column into the window —
    // independent of the document's zoom, which made a fit-width page's
    // window a keyhole onto one column and a fit-page window unreadably small
    // (issue #31, second round). The page's text is measured for it; the
    // same page gives the range its last entry.
    const dstPage = await rec.pdf.getPage(target.pageIndex + 1).catch(() => null)
    let scale = 1.25
    let rangeEndY: number | null = null
    /** The text block, in PDF space, so the window never starts so far right
     *  that it loses the end of the lines (the destination's x is the
     *  entry's indent, not the block's edge) */
    let block: PdfRect | null = null
    /** A citation's own entry (and a range's last one): the window is cut
     *  to exactly these lines */
    let entryRect: PdfRect | null = null
    /** The whole target — a footnote, a float, a display: the window is
     *  cut to it and sized to hold it (Emil, 2026-10-16) */
    let targetRect: PdfBox | null = null
    let fit: ReturnType<typeof fitBox> | null = null
    // Every measure goes through the page's own transform (viewportBox):
    // a landscape table in a portrait thesis is a /Rotate 90 page whose
    // text runs along PDF y, and reading its x as the width made the
    // window a keyhole with a sideways bar (Emil, 2026-10-13)
    const base = dstPage?.getViewport({ scale: 1, rotation: (dstPage.rotate + rec.rotation) % 360 })
    if (dstPage && base) {
      const content = await dstPage.getTextContent().catch(() => null)
      const pageWidth = (dstPage.view[2] ?? 612) - (dstPage.view[0] ?? 0)
      const pageHeight = (dstPage.view[3] ?? 792) - (dstPage.view[1] ?? 0)
      const lines = content ? textLines(content.items) : []
      if (content) {
        const extent = textExtent(lines, pageWidth, pageHeight)
        // A page shown sideways (/Rotate 90, or turned by the reader) has
        // its text drawn rotated more often than not, and textLines then
        // reads the glyph height as the line's length: measure every item's
        // own box instead, direction and all
        const sideways = base.rotation % 180 !== 0
        block = sideways
          ? (textBounds(content.items) ?? { x0: 0, x1: pageWidth, top: pageHeight, bottom: 0 })
          : { x0: extent.x0, x1: extent.x1, top: extent.y1, bottom: extent.y0 }
        const blockPx = viewportBox(base, block)
        const blockW = blockPx.r - blockPx.l
        // A column (or the block) wider than the window at 100 %: the window
        // grows first, up to most of the screen, and the text shrinks only
        // after that — and never below 75 %
        const twoColumn = extent.twoColumn && !sideways
        const columnPx = twoColumn ? (extent.columnW / (extent.x1 - extent.x0)) * blockW : blockW
        if (columnPx + 24 > box.w) box.w = Math.min(Math.round(window.innerWidth * 0.8), Math.ceil(columnPx) + 24)
        scale = previewScale(columnPx, box.w, columnPx + 24 > box.w ? 0.75 : 1)
        // A two-column page: the window is one column wide, not two
        if (twoColumn) box.w = Math.max(200, Math.min(box.w, Math.ceil(columnPx * scale) + 36))
      }
      if (target.kind === 'citation' && target.y !== null) {
        const siblings = await familySiblings(rec.pdf, target, dstPage)
        const label = destLabel(target.name)
        const count = range ? range[1] - range[0] + 1 : 1
        if (range) rangeEndY = rangeEnd({ x: target.x, y: target.y, n: label }, siblings, count)
        const first = entryLines(lines, { x: target.x, y: target.y }, siblings, label, pageWidth)
        const last =
          range && rangeEndY !== null
            ? entryLines(
                lines,
                { x: target.x, y: rangeEndY },
                siblings,
                label === null ? null : label + count - 1,
                pageWidth
              )
            : []
        entryRect = entryBox([...first, ...last])
        // The entry's own width is what has to fit — a reference list's
        // lines are often wider than the page's measured text block
        if (entryRect) {
          const e = viewportBox(base, entryRect)
          scale = previewScale(e.r - e.l, box.w, e.r - e.l + 24 > box.w ? 0.75 : 1)
        }
      } else if (content && target.y !== null) {
        targetRect = await targetBox(rec.pdf, target, dstPage, content.items, pageWidth, pageHeight, base)
        if (targetRect) {
          const e = viewportBox(base, targetRect)
          const floor = target.kind === 'figure' || target.kind === 'table' ? FIGURE_FLOOR : TEXT_FLOOR
          fit = fitBox(e.r - e.l, e.b - e.t, prefW, targetRoom(), floor, TARGET_PAD)
          scale = fit.scale
        }
      }
    }
    if (mine !== seq.current) return
    const [img, captionAbove] = await Promise.all([
      renderPage(rec.pdf, target.pageIndex, scale, rec.rotation),
      target.kind === 'figure' && target.y !== null
        ? destOnFigureCaption(rec.pdf, target.pageIndex, target.y)
        : Promise.resolve(false)
    ])
    if (mine !== seq.current || !anchor.isConnected) return
    let vx: number | null = null
    let vy: number | null = null
    if (target.x !== null || target.y !== null) {
      const [px, py] = img.viewport.convertToViewportPoint(target.x ?? 0, target.y ?? img.viewport.viewBox[3])
      vx = target.x === null ? null : px
      vy = target.y === null ? null : py
    }
    const maxH = Math.round(window.innerHeight * 0.6)
    let scroll: { left: number; top: number }
    let entry = false
    let entryFits = false
    let clip: Open['clip'] = null
    if (targetRect && fit) {
      // Cut to the target and sized to hold it: grown first, read smaller
      // only down to the floor, scrolled (inside the target) only past that
      clip = clipBox(viewportBox(img.viewport, targetRect), img.w, img.h)
      const room = targetRoom()
      box.w = Math.min(room.w, clip.w)
      box.h = Math.max(40, Math.min(room.h, clip.h))
      scroll = { left: 0, top: 0 }
      entry = true
      entryFits = fit.fits
    } else if (entryRect) {
      // Cut to the entry: its lines, the same air, nothing of the neighbours.
      // As wide as the entry needs, within the screen: the 600 px default is
      // a ceiling for page windows, not for a line that must come out whole
      clip = clipBox(viewportBox(img.viewport, entryRect), img.w, img.h)
      box.w = Math.min(window.innerWidth - 24, clip.w)
      box.h = Math.max(40, Math.min(clip.h, maxH))
      scroll = { left: 0, top: 0 }
      entry = true
      entryFits = clip.h <= maxH
    } else {
      if (range && target.y !== null && vy !== null) {
        // The entry could not be read off the page: a window tall enough for
        // the range, from the first entry to where the last one starts plus
        // a few lines of it; a range past the page shows to the page's foot
        const lastY = rangeEndY ?? (img.viewport.viewBox[1] ?? 0)
        const [, pyLast] = img.viewport.convertToViewportPoint(target.x ?? 0, lastY)
        box.h = Math.max(box.h, Math.min(maxH, Math.ceil(pyLast - vy) + Math.round(52 * scale)))
      }
      // A page narrower than the window: the window narrows to it
      box.w = Math.min(box.w, Math.ceil(img.w))
      scroll = previewScroll(target.kind, vx, vy, box, { w: img.w, h: img.h }, captionAbove)
      // …but never so far right that the lines' ends fall outside it
      if (block) {
        const edge = viewportBox(img.viewport, block).r
        scroll.left = Math.max(0, Math.min(scroll.left, Math.ceil(edge) + 12 - box.w))
      }
    }
    const r = anchor.getBoundingClientRect()
    // Placed by its whole height: the page window plus the footer line
    const at = placePreview(r, pointerX, { w: box.w, h: box.h + FOOT_PX }, { w: window.innerWidth, h: window.innerHeight })
    pinnedRef.current = false
    draggedRef.current = false
    fitScaleRef.current = scale
    setPlaced(null)
    setSize(null)
    setLive(null)
    setAbs({})
    setOpen({
      anchor,
      rec,
      target,
      pageIndex: target.pageIndex,
      kind: target.kind,
      canvas: img.canvas,
      card: null,
      pointerX,
      pageW: img.w,
      pageH: img.h,
      vx,
      vy,
      scroll,
      box,
      scale,
      range,
      entry,
      entryFits,
      clip,
      at
    })
  }, [])

  // The canvas is cached and shared, so it is mounted by hand, and the
  // window scrolled to the destination once it is in
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!open?.canvas || !scroller) return
    // A cut-out paints only the target; its air stays blank paper. On the
    // canvas itself, not its host: a clip-path makes a stacking context, and
    // one between the canvas and the sheet would kill the canvas's blend
    // into the paper tone (CLAUDE.md, mix-blend-mode). The canvas is cached
    // and shared, so a window onto the page clears it again.
    const c = open.clip
    open.canvas.style.clipPath = c
      ? `inset(${c.inner.t}px ${open.pageW - c.inner.r}px ${open.pageH - c.inner.b}px ${c.inner.l}px)`
      : ''
    scroller.querySelector('.link-preview-canvas-host')?.replaceChildren(open.canvas)
    scroller.scrollLeft = open.scroll.left
    scroller.scrollTop = open.scroll.top
  }, [open])

  /** A cut-out's window at a scale k over its last render: grown where it
   *  stands — rightward, and down from a window placed below its link or up
   *  from one held by its bottom above it — up to the room a target may take */
  const grownBox = (o: Open, clipW: number, clipH: number): { w: number; h: number } => {
    const room = targetRoom()
    const roomW = Math.min(room.w, window.innerWidth - o.at.left - 8)
    const roomH = Math.min(room.h, o.at.below ? window.innerHeight - o.at.top - FOOT_PX - 8 : o.at.top + o.box.h - 8)
    return { w: Math.min(roomW, clipW), h: Math.min(roomH, clipH) }
  }

  /** Ctrl+wheel (a pinch, too) over the window: the window's own scale, the
   *  point under its top-left corner kept. «Cropped and no way to zoom out»
   *  was the second-round report on issue #31. Each notch scales what is
   *  already drawn, by CSS, at once; the page is drawn again at the new scale
   *  only once the wheel rests — a render per notch made it choppy (Emil,
   *  2026-10-17). */
  const zoomTimer = useRef<number | null>(null)
  const zoomBy = (factor: number): void => {
    const o = openRef.current
    if (!o?.canvas) return
    const from = liveScaleRef.current ?? o.scale
    const scale = Math.round(Math.min(3, Math.max(0.5, from * factor)) * 1000) / 1000
    if (scale === from) return
    pinnedRef.current = true
    clearClose()
    setLive(scale)
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current)
    zoomTimer.current = window.setTimeout(() => {
      zoomTimer.current = null
      const cur = openRef.current
      if (!cur) return
      rescaleTo(cur, scale)
        .then(() => {
          if (liveScaleRef.current === scale) setLive(null)
        })
        .catch(previewFailed)
    }, 160)
  }
  const rescaleTo = async (o: Open, scale: number): Promise<void> => {
    if (!o.canvas || scale === o.scale) return
    const img = await renderPage(o.rec.pdf, o.pageIndex, scale, o.rec.rotation)
    if (openRef.current !== o) return
    const k = scale / o.scale
    const sc = scrollerRef.current
    // Zooming is reading: the window stays when the pointer leaves it
    pinnedRef.current = true
    // A cut-out scales with it, and its window follows — up to the room a
    // target may take, and scrolling inside the target past that — unless
    // the reader sized the window by hand (the grip sets it to match)
    const clip: Clip | null = o.clip && {
      l: Math.round(o.clip.l * k),
      t: Math.round(o.clip.t * k),
      w: Math.round(o.clip.w * k),
      h: Math.round(o.clip.h * k),
      inner: { l: o.clip.inner.l * k, t: o.clip.inner.t * k, r: o.clip.inner.r * k, b: o.clip.inner.b * k }
    }
    const box = clip && !sizeRef.current ? grownBox(o, clip.w, clip.h) : o.box
    setOpen({
      ...o,
      scale,
      canvas: img.canvas,
      pageW: img.w,
      pageH: img.h,
      vx: o.vx === null ? null : o.vx * k,
      vy: o.vy === null ? null : o.vy * k,
      // Shown at this scale already (by CSS zoom, mid-gesture): the scroll is
      // in the new layout's pixels and stays; otherwise it scales with it
      scroll:
        liveScaleRef.current !== null
          ? { left: sc?.scrollLeft ?? o.scroll.left, top: sc?.scrollTop ?? o.scroll.top }
          : { left: (sc?.scrollLeft ?? o.scroll.left) * k, top: (sc?.scrollTop ?? o.scroll.top) * k },
      box,
      clip,
      entryFits: clip ? clip.w <= box.w && clip.h <= box.h : false,
      // Held by its bottom: the bottom stays where it was
      at: o.at.below ? o.at : { ...o.at, top: o.at.top + o.box.h - box.h }
    })
  }
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !open) return
    // Native and non-passive: preventDefault keeps the page's own ctrl+wheel
    // zoom (and the browser's) out of it, stopPropagation keeps the viewer's
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      // A mouse notch is a fixed step; a trackpad pinch many small deltas,
      // scaled by their size so the zoom follows the fingers — the same
      // reading as the pages' own Ctrl+wheel (PdfViewer)
      zoomBy(Math.abs(e.deltaY) >= 90 ? (e.deltaY < 0 ? 1.15 : 1 / 1.15) : Math.exp(-e.deltaY * 0.006))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ---- Pointer choreography, delegated from the viewer root ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let press: { anchor: HTMLElement; x: number; y: number; timer: number } | null = null
    /** A long-press that opened the window must not ALSO follow the link */
    let swallowClickUntil = 0

    const anchorOf = (el: EventTarget | null): HTMLElement | null => {
      const a = (el as Element | null)?.closest?.('a.pdf-link.internal') as HTMLElement | null
      return a && LINK_RECORDS.has(a) ? a : null
    }
    const inBox = (el: EventTarget | null): boolean =>
      !!boxRef.current && el instanceof Node && boxRef.current.contains(el)

    const onOver = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (!a) return
      if (!enabledRef.current) {
        // Off: give the link its tooltip back if an earlier hover took it
        if (!a.title && a.dataset.tip) a.title = a.dataset.tip
        return
      }
      // The native tooltip would sit on top of the window
      if (a.title) {
        a.dataset.tip = a.title
        a.setAttribute('aria-label', a.title)
        a.removeAttribute('title')
      }
      if (e.pointerType === 'touch') return
      clearClose()
      if (openRef.current?.anchor === a) return
      clearArm()
      const x = e.clientX
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null
        show(a, x).catch(previewFailed)
      }, delayRef.current)
    }
    const onOut = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (!a || e.pointerType === 'touch') return
      if (anchorOf(e.relatedTarget) === a || inBox(e.relatedTarget)) return
      clearArm()
      if (openRef.current) scheduleClose()
      else seq.current++ // a render still in flight for this link
    }
    const onDown = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (e.pointerType === 'touch' && a && enabledRef.current) {
        const timer = window.setTimeout(() => {
          press = null
          swallowClickUntil = performance.now() + 900
          show(a, e.clientX).catch(previewFailed)
        }, LONG_PRESS_MS)
        press = { anchor: a, x: e.clientX, y: e.clientY, timer }
        return
      }
      // A click on a link follows it — the window has served its purpose
      if (a && !inBox(e.target)) close()
    }
    const endPress = (): void => {
      if (press) window.clearTimeout(press.timer)
      press = null
    }
    const onMove = (e: PointerEvent): void => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) endPress()
    }
    const onClickCapture = (e: MouseEvent): void => {
      // isTrusted: the window's own «go there» is a dispatched click
      if (e.isTrusted && performance.now() < swallowClickUntil && anchorOf(e.target)) {
        e.preventDefault()
        e.stopPropagation()
        swallowClickUntil = 0
      }
    }
    const onContextMenu = (e: MouseEvent): void => {
      // The long-press's own context menu, once it has opened the window
      if (performance.now() < swallowClickUntil && anchorOf(e.target)) e.preventDefault()
    }
    // The page moving under the window detaches it from its link
    const onScroll = (e: Event): void => {
      if (openRef.current && !inBox(e.target)) close()
    }
    host.addEventListener('pointerover', onOver)
    host.addEventListener('pointerout', onOut)
    host.addEventListener('pointerdown', onDown, true)
    host.addEventListener('pointermove', onMove, { passive: true })
    host.addEventListener('pointerup', endPress)
    host.addEventListener('pointercancel', endPress)
    host.addEventListener('click', onClickCapture, true)
    host.addEventListener('contextmenu', onContextMenu, true)
    host.addEventListener('scroll', onScroll, true)
    return () => {
      endPress()
      host.removeEventListener('pointerover', onOver)
      host.removeEventListener('pointerout', onOut)
      host.removeEventListener('pointerdown', onDown, true)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', endPress)
      host.removeEventListener('pointercancel', endPress)
      host.removeEventListener('click', onClickCapture, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      host.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef, show, close])

  useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])
  useEffect(() => () => {
    clearArm()
    clearClose()
  }, [])

  useDismissable(boxRef, !!open, close)

  // The point under the window's top-left corner stays put through a zoom:
  // the scroll follows the layout's scale. Measured on what is SHOWN (the
  // live scale mid-gesture, the rendered one after), so the hand-over from
  // CSS zoom to the new render moves nothing.
  const shownScale = liveScale ?? open?.scale ?? 1
  const prevShown = useRef(shownScale)
  useLayoutEffect(() => {
    const sc = scrollerRef.current
    const r = shownScale / prevShown.current
    prevShown.current = shownScale
    if (!sc || r === 1 || !Number.isFinite(r)) return
    sc.scrollLeft *= r
    sc.scrollTop *= r
  }, [shownScale])
  useEdgeFade(scrollerRef, [open, size, placed, liveScale])

  // A card is placed by its real height, known only once it is laid out:
  // before paint, so it never shows at the guessed one first
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!open?.card || placed || size || !box) return
    const h = box.offsetHeight
    if (Math.abs(h - (open.box.h + FOOT_PX)) < 1) return
    const at = placePreview(
      open.anchor.getBoundingClientRect(),
      open.pointerX,
      { w: open.box.w, h },
      { w: window.innerWidth, h: window.innerHeight }
    )
    setOpen({ ...open, at, box: { w: open.box.w, h: h - FOOT_PX } })
  }, [open, placed, size])

  // An abstract is in: the card stays put and grows downward, the abstract
  // falling out under the row it belongs to (growInPlace) — before paint, so
  // it never shows at the old size first. Loading changes nothing.
  const hasPanel = Object.values(abs).some((a) => a.state === 'done' || a.state === 'error')
  useLayoutEffect(() => {
    const list = scrollerRef.current
    const box = boxRef.current
    if (!open?.card || !hasPanel || !list || !box) return
    const need = list.scrollHeight + FOOT_PX
    const r = box.getBoundingClientRect()
    const at = growInPlace(r.top, need, { h: window.innerHeight })
    if (at.moved) {
      // The one slide, too little room under a card near the window's foot:
      // glided, not jumped (the transition is cleared before any drag)
      box.style.transition = 'top 180ms ease'
      window.setTimeout(() => {
        if (boxRef.current) boxRef.current.style.transition = ''
      }, 220)
    }
    setPlaced({ left: r.left, top: at.top, height: at.height })
  }, [open, abs, hasPanel])

  /** The footer is the handle: drag the window aside to read what is under
   *  it. A dragged window stays — leaving it no longer closes it. */
  const footHandle = {
    onPointerDown: (e: React.PointerEvent): void => {
      if ((e.target as Element).closest('button, a')) return
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* a synthetic event has no pointer to capture */
      }
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const d = dragRef.current
      const r = boxRef.current?.getBoundingClientRect()
      if (!d || !r) return
      draggedRef.current = true
      pinnedRef.current = true
      clearClose()
      const left = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - r.width - 8))
      const top = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - r.height - 8))
      setPlaced((p) => ({ left, top, height: p?.height ?? null }))
    },
    onPointerUp: (): void => {
      dragRef.current = null
    }
  }

  /** «Sammendrag» on one row: its entry's text, handed over */
  const askAbstract = async (o: Open, entry: CardEntry): Promise<void> => {
    pinnedRef.current = true
    clearClose()
    setAbs((m) => ({ ...m, [entry.dest]: { state: 'loading' } }))
    const result: CitationAbstract | FileError = await bridge.citationAbstract(entry.text)
    if (openRef.current?.card !== o.card) return // the window moved on meanwhile
    if ('error' in result) {
      setAbs((m) => ({ ...m, [entry.dest]: { state: 'error', error: result } }))
      return
    }
    let cache = abstractCache.get(o.rec.pdf)
    if (!cache) abstractCache.set(o.rec.pdf, (cache = new Map()))
    cache.set(entry.dest, result)
    setAbs((m) => ({ ...m, [entry.dest]: { state: 'done', result } }))
    // A row low in a long group: its abstract comes into view
    requestAnimationFrame(() => {
      boxRef.current
        ?.querySelector(`[data-dest="${CSS.escape(entry.dest)}"] .link-preview-abstract`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }

  if (!open) return null

  /** Go there: the anchor's own click, with the modifiers carried over, so
   *  every rule the link follows (back-stack, Ctrl → other column) holds */
  const follow = (e: React.MouseEvent): void => {
    const a = open.anchor
    close()
    if (!a.isConnected) return
    a.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
    )
  }
  /** «Gå til» on a card row: that entry's own destination, from the link's
   *  column (the link itself may point at another row's) */
  const goTo = (e: React.MouseEvent, dest: string): void => {
    const rec = open.rec
    if (dest === rec.dest || !rec.follow) {
      follow(e)
      return
    }
    close()
    rec.follow(dest, e.ctrlKey || e.metaKey)
  }

  // Before it is placed for an abstract (or dragged), the hover placement.
  // Opened above its link, the window is held by its BOTTOM, so a growing
  // footer never moves it toward the citation.
  const winH = window.innerHeight
  // Mid-zoom (or mid-resize), what is drawn is scaled by `live` until it is
  // drawn again; a cut-out's window follows it at once, as the render will
  const live = liveScale !== null && open.canvas ? liveScale / open.scale : 1
  const liveBox =
    open.clip && live !== 1 && !size ? grownBox(open, Math.round(open.clip.w * live), Math.round(open.clip.h * live)) : null
  // The box is the scroller's; the window's 1 px border goes around it, or a
  // cut-out exactly as wide as its window loses 2 px and fades at its edge
  const width = (size?.w ?? liveBox?.w ?? open.box.w) + 2
  const place: React.CSSProperties = placed
    ? { left: placed.left, top: placed.top, width }
    : open.at.below
      ? { left: open.at.left, top: open.at.top, width }
      : { left: open.at.left, bottom: winH - (open.at.top + open.box.h + FOOT_PX), width }
  const shell = (body: React.ReactNode, foot: React.ReactNode): React.JSX.Element => (
    <div
      ref={boxRef}
      className={`link-preview kind-${open.kind}${open.card ? ' is-card' : ''}${open.entry && open.entryFits && !size ? ' is-entry' : ''}`}
      style={place}
      onPointerEnter={clearClose}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch' && anchorOfTarget(e.relatedTarget) !== open.anchor) scheduleClose()
      }}
      role="dialog"
      aria-label={
        open.card
          ? t('linkPreview.cardLabel', { count: open.card.entries.length })
          : t('linkPreview.label', { page: open.pageIndex + 1 })
      }
    >
      <div className="link-preview-body">{body}</div>
      <div className="link-preview-foot" {...footHandle}>
        {foot}
      </div>
      <span className="box-grip link-preview-grip" title={t('bubble.resizeTip')} {...gripProps} />
    </div>
  )

  if (open.card) {
    const card = open.card
    const maxH = placed?.height != null ? placed.height - FOOT_PX : Math.round(winH * 0.6) - FOOT_PX
    return shell(
      <div
        ref={scrollerRef}
        className="lp-card"
        style={size?.h != null ? { height: size.h } : { maxHeight: Math.max(80, maxH) }}
        // Reading in — a press to select, a click on a row — keeps the card
        onPointerDown={() => {
          pinnedRef.current = true
          clearClose()
        }}
      >
        {card.entries.map((entry) => {
          const a = abs[entry.dest] ?? { state: 'idle' }
          return (
            <div key={entry.dest} className="lp-ref" data-dest={entry.dest}>
              <p className="lp-ref-text">
                {entry.segments.map((s, i) =>
                  s.url ? (
                    <a
                      key={i}
                      href={s.url}
                      title={s.url}
                      onClick={(e) => {
                        e.preventDefault()
                        bridge.openExternal(s.url!)
                      }}
                    >
                      {s.text}
                    </a>
                  ) : (
                    <span key={i}>{s.text}</span>
                  )
                )}
              </p>
              <div className="lp-ref-acts">
                {a.state === 'idle' && (
                  <button
                    type="button"
                    className="lp-ref-act"
                    title={t('linkPreview.abstractTip')}
                    onClick={() => void askAbstract(open, entry)}
                  >
                    {t('linkPreview.abstract')}
                  </button>
                )}
                {a.state === 'loading' && <span className="lpa-loading">{t('linkPreview.abstractLoading')}</span>}
                <AbstractSource abs={a} />
                {/* Away from the abstract, on the right: the work itself — a
                    free PDF when one is known for certain (an arXiv id, printed
                    or found by «Sammendrag»), a search for it, its place in the
                    list. Links that open the browser on a click, never before. */}
                <span className="lp-ref-end">
                  {(() => {
                    const arxiv = (a.state === 'done' && a.result.arxiv) || findArxivId(entry.text)
                    return arxiv ? (
                      <button
                        type="button"
                        className="lp-ref-act"
                        title={t('linkPreview.pdfTip')}
                        onClick={() => bridge.openExternal(`https://arxiv.org/pdf/${arxiv}`)}
                      >
                        {t('linkPreview.pdf')}
                      </button>
                    ) : null
                  })()}
                  <button
                    type="button"
                    className="lp-ref-act"
                    title={t('linkPreview.searchTip')}
                    onClick={() => bridge.openExternal(scholarUrl(scholarQuery(entry.text)))}
                  >
                    {t('linkPreview.search')}
                  </button>
                  <button
                    type="button"
                    className="lp-ref-act"
                    title={t('linkPreview.goToTip')}
                    onClick={(e) => goTo(e, entry.dest)}
                  >
                    {t('linkPreview.goTo', { page: entry.pageIndex + 1 })}
                  </button>
                </span>
              </div>
              <AbstractBody
                abs={a}
                className="lp-ref-abstract"
                onRetry={() => void askAbstract(open, entry)}
                // Its own cross: the abstract goes, the row and the card stay
                onClose={() => setAbs((m) => ({ ...m, [entry.dest]: { state: 'idle' } }))}
              />
            </div>
          )
        })}
      </div>,
      <span>{card.label ?? t('linkPreview.page', { page: open.pageIndex + 1 })}</span>
    )
  }

  const markTop =
    open.vy !== null && !open.entry && open.kind !== 'figure' && open.kind !== 'table' ? open.vy : null
  const pageH = size?.h ?? liveBox?.h ?? open.box.h
  const clip = open.clip
  // A cut-out: the content is the target's own box, the page slid under it —
  // there is no more of the page to scroll to. Mid-resize and mid-zoom it is
  // scaled by CSS `zoom` (which scales the layout too, so the window and the
  // scroll range follow at once) until it is drawn again at the new scale.
  const contentStyle: React.CSSProperties = {
    ...(clip ? { width: clip.w, height: clip.h, overflow: 'hidden' } : { width: open.pageW, height: open.pageH }),
    ...(live !== 1 ? { zoom: live } : {})
  }
  const sheetStyle: React.CSSProperties | undefined = clip
    ? { left: -clip.l, top: -clip.t, width: open.pageW, height: open.pageH, right: 'auto', bottom: 'auto' }
    : undefined
  return shell(
    <div
      ref={scrollerRef}
      className="link-preview-scroll"
      style={{ height: pageH }}
      onClick={follow}
      title={t('linkPreview.tip')}
    >
      <div className="link-preview-content" style={contentStyle}>
        <div className="link-preview-sheet" style={sheetStyle}>
          <div className="link-preview-canvas-host" />
        </div>
        {/* Outside the sheet: the theme filter would recolour the accent */}
        {markTop !== null && (
          <div className="link-preview-mark" style={{ top: markTop, left: Math.max(2, (open.vx ?? 0) - 10) }} />
        )}
      </div>
    </div>,
    <span>
      {t('linkPreview.page', { page: open.pageIndex + 1 })}
      {open.range && ` · ${open.range[0]}–${open.range[1]}`}
    </span>
  )
}

/** The citation card for a hovered citation link: the whole bracket its
 *  line holds around it (citationGroup), else the range its own characters
 *  name, else its one entry. Null when not one entry could be read off the
 *  reference list — the rendered window shows it then. */
async function citationCard(anchor: HTMLElement, rec: LinkRecord, target: PreviewTarget): Promise<Card | null> {
  const name = target.name!
  const family = await familyDests(rec.pdf, destFamily(name))
  const self: FamilyDest = family.find((d) => d.name === name) ?? {
    name,
    pageIndex: target.pageIndex,
    x: target.x,
    y: target.y!,
    n: destLabel(name)
  }
  let dests: FamilyDest[] | null = null
  let label: string | null = null
  const ctx = lineAround(anchor)
  if (ctx) {
    const others: LineLink<string | null>[] = ctx.others.map((o) => {
      const d = LINK_RECORDS.get(o.anchor)?.dest
      const n = typeof d === 'string' ? d : null
      return { start: o.start, end: o.end, kind: linkKind(n), label: destLabel(n), ref: n }
    })
    const group = citationGroup<string | null>(
      ctx.text,
      { start: ctx.start, end: ctx.end, kind: 'citation', label: destLabel(name), ref: name },
      others
    )
    if (group) {
      const per = group.parts.map((p) => groupDests(family, p, p.first, p.last))
      const whole = per.every((d) => d !== null)
      const parts = whole ? group.parts : [group.parts[group.hovered]!]
      const found = whole ? (per as FamilyDest[][]) : per[group.hovered] ? [per[group.hovered]!] : null
      if (found) {
        dests = found.flat()
        label = `[${parts.map((p) => (p.a === p.b ? `${p.a}` : `${p.a}–${p.b}`)).join(', ')}]`
      }
    }
  }
  if (!dests) {
    // The link's own characters: «5–9» linked whole, outside any bracket
    const range = citedRange(linkText(anchor))
    const inRange = range ? groupDests(family, { a: range[0], b: range[1] }, name, null) : null
    dests = inRange ?? [self]
    label = inRange && range ? `${range[0]}–${range[1]}` : null
  }
  // One work cited twice in a bracket is one row
  const seen = new Set<string>()
  dests = dests.filter((d) => !seen.has(d.name) && !!seen.add(d.name))
  const entries = await cardEntries(rec.pdf, dests, family.length ? family : [self])
  if (!entries.length) return null
  return { entries, label: entries.length > 1 ? label : null }
}

/** The line a link sits on, read off the page's text layer: its text, where
 *  the hovered link's characters are in it, and where every other in-document
 *  link on the line has its own. The line is the run of glyphs around the
 *  link with no column gap in it — a two-column page's other column is not
 *  part of it. Characters are placed by their own boxes, so a link that
 *  starts or ends mid-span («[8» of «[8–13]») is cut where it really is. */
function lineAround(
  anchor: HTMLElement
): { text: string; start: number; end: number; others: { anchor: HTMLElement; start: number; end: number }[] } | null {
  const page = anchor.closest('.pdf-page')
  if (!page) return null
  const box = anchor.getBoundingClientRect()
  if (box.width === 0) return null
  const midY = (box.top + box.bottom) / 2
  const range = document.createRange()
  const chars: { c: string; l: number; r: number; h: number }[] = []
  for (const span of page.querySelectorAll<HTMLElement>('.text-host .textLayer > span')) {
    const sr = span.getBoundingClientRect()
    if (midY < sr.top - 2 || midY > sr.bottom + 2) continue
    const node = span.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const text = node.textContent ?? ''
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const c = range.getBoundingClientRect()
      chars.push({ c: text[i]!, l: c.left, r: c.right, h: sr.height })
    }
  }
  if (!chars.length) return null
  chars.sort((p, q) => p.l - q.l)
  // The run around the link: cut at a gap wider than two line heights
  const at = chars.findIndex((c) => (c.l + c.r) / 2 >= box.left - 1)
  if (at < 0) return null
  let lo = at
  let hi = at
  const gap = (i: number): number => chars[i + 1]!.l - chars[i]!.r
  while (lo > 0 && gap(lo - 1) < chars[lo]!.h * 2) lo--
  while (hi < chars.length - 1 && gap(hi) < chars[hi]!.h * 2) hi++
  let text = ''
  const xs: number[] = []
  for (let i = lo; i <= hi; i++) {
    const ch = chars[i]!
    // Spans meet with no blank between them: a visible gap is one
    if (i > lo && gap(i - 1) > ch.h * 0.2 && !text.endsWith(' ') && ch.c !== ' ') {
      text += ' '
      xs.push(NaN)
    }
    text += ch.c
    xs.push((ch.l + ch.r) / 2)
  }
  const within = (r: DOMRect): { start: number; end: number } | null => {
    let s = -1
    let e = -1
    xs.forEach((x, i) => {
      if (x >= r.left - 1 && x <= r.right + 1) {
        if (s < 0) s = i
        e = i + 1
      }
    })
    return s < 0 ? null : { start: s, end: e }
  }
  const mine = within(box)
  if (!mine) return null
  const others: { anchor: HTMLElement; start: number; end: number }[] = []
  for (const a of page.querySelectorAll<HTMLElement>('a.pdf-link.internal')) {
    if (a === anchor || !LINK_RECORDS.has(a)) continue
    const r = a.getBoundingClientRect()
    if (midY < r.top - 2 || midY > r.bottom + 2) continue
    const w = within(r)
    if (w) others.push({ anchor: a, ...w })
  }
  return { text, ...mine, others }
}

/** The room a window cut to its target may take: most of the app window,
 *  the footer line aside */
/** How deep the fade at an edge with more beyond it runs */
const FADE_PX = 18

/** No scrollbar in the preview, not even the overlay pills — in a window
 *  this small they distract (Emil, 2026-10-17). What a bar said, that there
 *  is more, a soft fade at that edge says instead, and only while there is:
 *  the edges are CSS variables the stylesheet's mask reads. */
function useEdgeFade(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const f = (more: boolean): string => (more ? `${FADE_PX}px` : '0px')
      el.style.setProperty('--fade-t', f(el.scrollTop > 1))
      el.style.setProperty('--fade-b', f(el.scrollTop + el.clientHeight < el.scrollHeight - 1))
      el.style.setProperty('--fade-l', f(el.scrollLeft > 1))
      el.style.setProperty('--fade-r', f(el.scrollLeft + el.clientWidth < el.scrollWidth - 1))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // An abstract folding out, a resize, a render: the scroll range moves
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
}

/** A cut-out's box in the image's CSS pixels: the target plus TARGET_PAD,
 *  half on each side — the right edge rounded OUT like the left, so the
 *  rounding never takes its air from one side only — kept on the page,
 *  whose paper is the only background the air may show */
function clipBox(e: { l: number; t: number; r: number; b: number }, pageW: number, pageH: number): Clip {
  const l = Math.max(0, Math.floor(e.l - TARGET_PAD.x / 2))
  const t = Math.max(0, Math.floor(e.t - TARGET_PAD_TOP))
  const r = Math.min(Math.floor(pageW), Math.ceil(e.r + TARGET_PAD.x / 2))
  const b = Math.min(Math.floor(pageH), Math.ceil(e.b + TARGET_PAD.y - TARGET_PAD_TOP))
  return { l, t, w: Math.max(1, r - l), h: Math.max(1, b - t), inner: { ...e } }
}

function targetRoom(): { w: number; h: number } {
  return {
    w: Math.min(window.innerWidth - 24, Math.round(window.innerWidth * 0.9)),
    h: Math.round(window.innerHeight * 0.85) - FOOT_PX
  }
}

/** The box of the whole thing a destination points at — the footnote, the
 *  figure or table, the equation's display — read off its page (the rules
 *  in ../link-preview.ts). Null when the page does not say: the window then
 *  opens the way it always has. Text drawn rotated (arXiv's margin stamp)
 *  is left out of the reading. */
async function targetBox(
  pdf: PDFDocumentProxy,
  target: PreviewTarget,
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  items: readonly unknown[],
  pageWidth: number,
  pageHeight: number,
  vp: PageViewport
): Promise<PdfBox | null> {
  if (target.y === null) return null
  // The rules read a page the way it is SEEN. A landscape table in a portrait
  // thesis is a /Rotate 90 page whose text is drawn turned, so that it reads
  // upright once the page is shown turned — read in PDF space it is all
  // sideways and no box was ever found (64 of the 66 pages in Emil's thesis
  // where one was missing, 2026-10-17). So a turned page is read in the
  // frame it is shown in, and the box carried back to PDF space.
  const f = viewFrame(vp, pageWidth, pageHeight)
  const lines = textLines(uprightItems(f.items(items)))
  const dest = f.point({ x: target.x, y: target.y })
  const size = { w: f.w, h: f.h }
  // Every box is kept off the lines around it: its edges are where the
  // page's own content stops showing (the air outside is blank paper)
  const clear = (b: PdfBox | null): PdfBox | null => (b ? f.back(clearOfNeighbours(b, lines)) : null)
  const ops = OPS as unknown as OpsTable
  if (target.kind === 'footnote' || (target.kind === 'other' && inFootnotes(lines, dest, f.w))) {
    const [siblings, rules] = await Promise.all([
      target.name ? familySiblings(pdf, target, page) : Promise.resolve([]),
      pagePathRects(page, ops)
    ])
    const own = footnoteLines(lines, dest, siblings.map(f.point), f.w)
    const box = entryBox(own)
    return box && f.back(belowFootnoteRule(clearOfNeighbours(box, lines, own), rules.map(f.rect)))
  }
  if (target.kind !== 'figure' && target.kind !== 'table' && target.kind !== 'equation') return null
  const [images, paths] = await Promise.all([pageImageRects(page, ops), pagePathRects(page, ops)])
  const graphics: Graphic[] = [...images, ...paths].map(f.rect)
  const float = target.kind === 'equation' ? null : floatBox(target.kind, dest, lines, graphics, size)
  const box = target.kind === 'equation' ? equationBox(dest, lines, graphics, size) : float && withFloatNotes(float, lines)
  // A point past the box first: a plot's frame or a table's rule drawn ON its
  // edge keeps its whole stroke — unless a neighbour is that close
  return clear(box && { x0: box.x0 - 1, x1: box.x1 + 1, top: box.top + 1, bottom: box.bottom - 1 })
}

/** A preview that cannot be drawn simply does not open; the link still works */
function previewFailed(err: unknown): void {
  console.warn('pdfx: klarte ikke å forhåndsvise lenken', err)
}

/** A box in PDF user space (y up) */
interface PdfRect {
  x0: number
  x1: number
  top: number
  bottom: number
}

/** The box as the viewport shows it, in its CSS pixels — through the page's
 *  rotation, so a /Rotate 90 page's x-extent correctly comes out as height */
function viewportBox(
  vp: { convertToViewportPoint(x: number, y: number): number[] },
  r: PdfRect
): { l: number; t: number; r: number; b: number } {
  const pts = [
    vp.convertToViewportPoint(r.x0, r.top),
    vp.convertToViewportPoint(r.x1, r.top),
    vp.convertToViewportPoint(r.x0, r.bottom),
    vp.convertToViewportPoint(r.x1, r.bottom)
  ]
  const xs = pts.map((p) => p[0]!)
  const ys = pts.map((p) => p[1]!)
  return { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) }
}

function anchorOfTarget(el: EventTarget | null): Element | null {
  return ((el as Element | null)?.closest?.('a.pdf-link.internal') as Element | null) ?? null
}

/** The characters under the link's box, read off the page's text layer:
 *  what the citation itself says («5–9», «[12]»). A link's box often starts
 *  and ends mid-span, so the spans it touches are walked one character at a
 *  time and only the characters inside the box count. */
function linkText(anchor: HTMLElement): string {
  const page = anchor.closest('.pdf-page')
  if (!page) return ''
  const box = anchor.getBoundingClientRect()
  if (box.width === 0) return ''
  const midY = (box.top + box.bottom) / 2
  let out = ''
  const range = document.createRange()
  for (const span of page.querySelectorAll<HTMLElement>('.text-host .textLayer > span')) {
    const r = span.getBoundingClientRect()
    if (r.right < box.left || r.left > box.right || midY < r.top - 2 || midY > r.bottom + 2) continue
    const node = span.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const text = node.textContent ?? ''
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const c = range.getBoundingClientRect()
      const cx = (c.left + c.right) / 2
      if (cx >= box.left - 1 && cx <= box.right + 1) out += text[i]
    }
  }
  return out
}

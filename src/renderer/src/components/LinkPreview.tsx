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
// On a citation the footer offers «Sammendrag»: the cited paper's abstract,
// fetched on that click and never before (src/shared/abstract.ts — the app is
// offline unless you ask). The click is in the WINDOW, so the link itself
// still goes to the reference list. Once asked, the window stays put when the
// pointer leaves — it is being read — and grows away from the link.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useDismissable } from '../useDismissable'
import { t } from '../i18n'
import { bridge } from '../bridge'
import type { CitationAbstract, FileError } from '../../../shared/types'
import { AbstractBody, AbstractSource } from './AbstractView'
import type { AbstractState } from './AbstractView'
import {
  citationEntryText,
  destOnFigureCaption,
  LINK_RECORDS,
  placeExpanded,
  placePreview,
  previewScroll,
  previewSize,
  resolvePreviewTarget
} from '../link-preview'
import type { LinkKind, LinkRecord, PreviewTarget } from '../link-preview'

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
  canvas: HTMLCanvasElement
  /** CSS size of the page image */
  pageW: number
  pageH: number
  /** The destination in the image's CSS pixels (null = unnamed) */
  vx: number | null
  vy: number | null
  scroll: { left: number; top: number }
  box: { w: number; h: number }
  at: { left: number; top: number; below: boolean }
}

/** What «Sammendrag» found, per document and destination — a second hover on
 *  the same citation shows it again without asking anyone */
const abstractCache = new WeakMap<PDFDocumentProxy, Map<string, CitationAbstract>>()
const destKey = (dest: unknown): string => (typeof dest === 'string' ? dest : JSON.stringify(dest))


/** How long the pointer may be between the link and the window (or off both)
 *  before the window goes: long enough to cross the gap, short enough that
 *  leaving reads as leaving. */
const CLOSE_GRACE_MS = 220
const LONG_PRESS_MS = 450
/** The footer line under the page window, borders included (app.css) */
const FOOT_PX = 27
/** The page window's height once an abstract is in: the entry's first lines
 *  — enough to see what was matched — and the rest of the height goes to the
 *  abstract */
const COMPACT_PAGE_PX = 84
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
  const [abs, setAbs] = useState<AbstractState>({ state: 'idle' })
  /** Asked for the abstract: the window no longer closes on pointer leave */
  const pinnedRef = useRef(false)
  /** Where the window stands once it has been placed for an abstract or
   *  dragged; null = the hover placement from `open.at` */
  const [placed, setPlaced] = useState<{ left: number; top: number; height: number | null } | null>(null)
  /** Dragged by the reader: their position wins from then on */
  const draggedRef = useRef(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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
    // Read at the size the reader reads: the anchor's page tells the zoom.
    // Never below 100 % (a fitted page on a small window would make the
    // window's text unreadable) and never past 200 %.
    const pageEl = anchor.closest('.pdf-page') as HTMLElement | null
    const srcPage = await rec.pdf.getPage(Number(pageEl?.dataset.page) || 1).catch(() => null)
    let scale = 1.25
    if (pageEl && srcPage) {
      const base = srcPage.getViewport({ scale: 1, rotation: (srcPage.rotate + rec.rotation) % 360 })
      if (base.width > 0) scale = pageEl.getBoundingClientRect().width / base.width
    }
    scale = Math.min(2, Math.max(1, Math.round(scale * 20) / 20))
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
    const box = previewSize(target.kind, window.innerWidth, window.innerHeight)
    // A page narrower than the window: the window narrows to it
    box.w = Math.min(box.w, Math.ceil(img.w))
    const scroll = previewScroll(target.kind, vx, vy, box, { w: img.w, h: img.h }, captionAbove)
    const r = anchor.getBoundingClientRect()
    // Placed by its whole height: the page window plus the footer line
    const at = placePreview(r, pointerX, { w: box.w, h: box.h + FOOT_PX }, { w: window.innerWidth, h: window.innerHeight })
    const known = abstractCache.get(rec.pdf)?.get(destKey(rec.dest))
    pinnedRef.current = false
    draggedRef.current = false
    setPlaced(null)
    setAbs(known ? { state: 'done', result: known } : { state: 'idle' })
    setOpen({
      anchor,
      rec,
      target,
      pageIndex: target.pageIndex,
      kind: target.kind,
      canvas: img.canvas,
      pageW: img.w,
      pageH: img.h,
      vx,
      vy,
      scroll,
      box,
      at
    })
  }, [])

  // The canvas is cached and shared, so it is mounted by hand, and the
  // window scrolled to the destination once it is in
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!open || !scroller) return
    scroller.querySelector('.link-preview-canvas-host')?.replaceChildren(open.canvas)
    scroller.scrollLeft = open.scroll.left
    scroller.scrollTop = open.scroll.top
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

  // The abstract is in: place the whole window ONCE by what it now needs —
  // before paint, so it never shows at the old size first. Loading changes
  // nothing; this is the single move.
  const hasPanel = abs.state === 'done' || abs.state === 'error'
  useLayoutEffect(() => {
    const panel = panelRef.current
    const box = boxRef.current
    if (!open || !hasPanel || !panel || !box) return
    const need = COMPACT_PAGE_PX + panel.scrollHeight + FOOT_PX
    const winH = window.innerHeight
    const left = box.getBoundingClientRect().left
    if (draggedRef.current) {
      const top = box.getBoundingClientRect().top
      setPlaced({ left, top, height: Math.min(need, winH - top - 12) })
      return
    }
    const at = placeExpanded(open.anchor.getBoundingClientRect(), need, { h: winH })
    setPlaced({ left, top: at.top, height: at.height })
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

  /** «Sammendrag»: read the entry off the page, hand its text over */
  const askAbstract = async (o: Open): Promise<void> => {
    pinnedRef.current = true
    clearClose()
    setAbs({ state: 'loading' })
    const entry = await citationEntryText(o.rec.pdf, o.target)
    const result: CitationAbstract | FileError = entry
      ? await bridge.citationAbstract(entry)
      : { error: 'no entry text at the destination', code: 'abstract-unidentified' }
    if (openRef.current !== o) return // the window moved on meanwhile
    if ('error' in result) {
      setAbs({ state: 'error', error: result })
      return
    }
    let cache = abstractCache.get(o.rec.pdf)
    if (!cache) abstractCache.set(o.rec.pdf, (cache = new Map()))
    cache.set(destKey(o.rec.dest), result)
    setAbs({ state: 'done', result })
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

  const markTop = open.vy !== null && open.kind !== 'figure' && open.kind !== 'table' ? open.vy : null
  // Before it is placed for an abstract (or dragged), the hover placement.
  // Opened above its link, the window is held by its BOTTOM, so the footer's
  // «Henter …» never moves it toward the citation.
  const winH = window.innerHeight
  const place: React.CSSProperties = placed
    ? { left: placed.left, top: placed.top, width: open.box.w }
    : open.at.below
      ? { left: open.at.left, top: open.at.top, width: open.box.w }
      : { left: open.at.left, bottom: winH - (open.at.top + open.box.h + FOOT_PX), width: open.box.w }
  const pageH = hasPanel ? Math.min(COMPACT_PAGE_PX, open.box.h) : open.box.h
  const panelMax = placed?.height != null ? Math.max(80, placed.height - pageH - FOOT_PX) : undefined
  const canAsk = open.kind === 'citation' && open.target.y !== null
  return (
    <div
      ref={boxRef}
      className={`link-preview kind-${open.kind}`}
      style={place}
      onPointerEnter={clearClose}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch' && anchorOfTarget(e.relatedTarget) !== open.anchor) scheduleClose()
      }}
      role="dialog"
      aria-label={t('linkPreview.label', { page: open.pageIndex + 1 })}
    >
      <div
        ref={scrollerRef}
        className="link-preview-scroll"
        style={{ height: pageH }}
        onClick={follow}
        title={t('linkPreview.tip')}
      >
        <div className="link-preview-content" style={{ width: open.pageW, height: open.pageH }}>
          <div className="link-preview-sheet">
            <div className="link-preview-canvas-host" />
          </div>
          {/* Outside the sheet: the theme filter would recolour the accent */}
          {markTop !== null && (
            <div
              className="link-preview-mark"
              style={{ top: markTop, left: Math.max(2, (open.vx ?? 0) - 10) }}
            />
          )}
        </div>
      </div>
      <AbstractBody ref={panelRef} abs={abs} onRetry={() => void askAbstract(open)} maxHeight={panelMax} />
      <div className="link-preview-foot" {...footHandle}>
        <span>{t('linkPreview.page', { page: open.pageIndex + 1 })}</span>
        {canAsk && abs.state === 'idle' && (
          <button
            type="button"
            className="lpa-ask"
            title={t('linkPreview.abstractTip')}
            onClick={() => void askAbstract(open)}
          >
            {t('linkPreview.abstract')}
          </button>
        )}
        {abs.state === 'loading' && <span className="lpa-loading">{t('linkPreview.abstractLoading')}</span>}
        <AbstractSource abs={abs} />
      </div>
    </div>
  )
}

/** A preview that cannot be drawn simply does not open; the link still works */
function previewFailed(err: unknown): void {
  console.warn('pdfx: klarte ikke å forhåndsvise lenken', err)
}

function anchorOfTarget(el: EventTarget | null): Element | null {
  return ((el as Element | null)?.closest?.('a.pdf-link.internal') as Element | null) ?? null
}

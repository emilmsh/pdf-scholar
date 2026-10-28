// The tab strip's hover card (Edge's tab hover card, 2026-10-28): the whole
// file name, the folder it lives in, where the reader is and the library's
// picture of page 1 — what a tab squeezed to a few letters no longer says.
//
// Supplementary by design: «Alle åpne faner» lists the same, so a mouse alone
// raises it (no touch or pen equivalent — a long press there is the drag), and
// it never takes a pointer event, so the neighbouring tab is always clickable
// through it. Nothing is drawn for it: the picture is the one the library's
// grid already keeps (PdfxApi.getRecentThumbs), and a document without one —
// never pictured, or password-protected, which the store never pictures — gets
// the card without it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readingProgress } from '../../../shared/recent-thumbs'
import type { RecentThumbView } from '../../../shared/types'
import { bridge } from '../bridge'
import { t } from '../i18n'

/** Hover time before the first card, ms (Edge waits about this long) */
const SHOW_DELAY = 450
/** Leaving a tab hides its card only after this, so the pointer crossing the
 *  gap to the next tab moves the card instead of blinking it */
const HIDE_DELAY = 90
/** A card hidden this recently comes back without the delay — still sliding
 *  along the strip, not a fresh hover */
const WARM_FOR = 400
/** Card width, px — fixed, so it can be clamped to the window unmeasured */
const CARD_WIDTH = 288
/** The stored pictures are re-read at most this often while hovering */
const THUMBS_TTL = 15_000

interface Shown {
  path: string
  name: string
  left: number
  top: number
}

// ---------- The pictures, shared by every card this window shows ----------

let thumbsAt = 0
let thumbsLoad: Promise<Record<string, RecentThumbView>> | null = null
/** Object URLs by path, with the `taken` stamp each was made from */
const thumbUrls = new Map<string, { taken: number; url: string }>()

function loadThumbs(): Promise<Record<string, RecentThumbView>> {
  if (thumbsLoad && Date.now() - thumbsAt < THUMBS_TTL) return thumbsLoad
  thumbsAt = Date.now()
  thumbsLoad = bridge.getRecentThumbs().catch(() => ({}))
  return thumbsLoad
}

function thumbUrl(path: string, thumb: RecentThumbView | undefined): string | undefined {
  const cached = thumbUrls.get(path)
  if (!thumb?.image || thumb.locked) {
    if (cached) URL.revokeObjectURL(cached.url)
    thumbUrls.delete(path)
    return undefined
  }
  if (cached?.taken === thumb.taken) return cached.url
  if (cached) URL.revokeObjectURL(cached.url)
  const url = URL.createObjectURL(new Blob([thumb.image as BlobPart], { type: 'image/jpeg' }))
  thumbUrls.set(path, { taken: thumb.taken, url })
  return url
}

/** The line under the name: the folder for a file, the host for a web
 *  address, the picker's note for a file chosen without a path */
export function tabLocation(path: string): string | null {
  if (path.startsWith('fsa:')) return t('doc.pickedHint')
  if (/^file:/i.test(path)) {
    try {
      return tabLocation(decodeURIComponent(new URL(path).pathname).replace(/^\/([a-z]:)/i, '$1'))
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      return new URL(path).host || null
    } catch {
      return null
    }
  }
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return null
  // The root keeps its separator: «C:\», not «C:»
  return cut === 0 || /^[a-z]:$/i.test(path.slice(0, cut)) ? path.slice(0, cut + 1) : path.slice(0, cut)
}

/** A path with a line-break opportunity after every separator, so a deep
 *  folder wraps between folder names rather than inside one */
function breakAtSeparators(text: string): React.ReactNode[] {
  return text.split(/(?<=[\\/])/).flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]))
}

// ---------- The hook TabBar wires its tabs to ----------

export interface TabHoverCard {
  /** pointerenter on a tab element */
  enter(e: React.PointerEvent<HTMLElement>, tab: { path: string; name: string }): void
  /** pointerleave on a tab element */
  leave(): void
  /** The card itself, to render anywhere in the bar (it is position: fixed) */
  card: React.JSX.Element | null
}

/** `blocked`: something else owns the strip right now (the tab menu, the
 *  «Alle faner» list, a drag) — no card, and any card showing goes. */
export function useTabHoverCard(blocked: boolean): TabHoverCard {
  const [shown, setShown] = useState<Shown | null>(null)
  const [thumb, setThumb] = useState<{ path: string; url: string | undefined; pages: number | undefined }>()
  const [page, setPage] = useState<{ path: string; page: number | undefined }>()
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  /** Until when a new hover skips the delay (see WARM_FOR) */
  const warmUntil = useRef(0)
  const shownRef = useRef<Shown | null>(null)
  shownRef.current = shown

  const clearTimers = (): void => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
    showTimer.current = undefined
    hideTimer.current = undefined
  }

  /** Close now. `cold`: a deliberate act (a click, a drag, Esc) — the next
   *  hover waits its delay again instead of sliding in warm. */
  const close = useCallback((cold: boolean): void => {
    clearTimers()
    if (shownRef.current && !cold) warmUntil.current = Date.now() + WARM_FOR
    if (cold) warmUntil.current = 0
    setShown(null)
  }, [])

  // Everything that ends a hover, while a card shows or waits to: a press
  // anywhere (the tab's own click included — Edge drops it the same way), a
  // drag, the strip or anything else scrolling, Esc, the window losing focus.
  // Listening always, and returning at once when nothing is pending, is
  // cheaper than re-wiring seven listeners on every hover.
  useEffect(() => {
    const idle = (): boolean => !shownRef.current && showTimer.current === undefined
    const cold = (): void => {
      if (!idle()) close(true)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cold()
    }
    window.addEventListener('pointerdown', cold, true)
    window.addEventListener('dragstart', cold, true)
    window.addEventListener('scroll', cold, true)
    window.addEventListener('wheel', cold, { capture: true, passive: true })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cold)
    window.addEventListener('resize', cold)
    return () => {
      window.removeEventListener('pointerdown', cold, true)
      window.removeEventListener('dragstart', cold, true)
      window.removeEventListener('scroll', cold, true)
      window.removeEventListener('wheel', cold, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cold)
      window.removeEventListener('resize', cold)
    }
  }, [close])

  useEffect(() => {
    if (blocked) close(true)
  }, [blocked, close])

  useEffect(() => clearTimers, [])

  const enter = useCallback(
    (e: React.PointerEvent<HTMLElement>, tab: { path: string; name: string }): void => {
      // A mouse only: a pen's hover and a finger's press both report enter,
      // and a card under a finger hides what it is about to touch
      if (e.pointerType !== 'mouse' || blocked || e.buttons !== 0) return
      clearTimers()
      const el = e.currentTarget
      // Fetched now, so the delay covers the IPC and the card opens whole
      const path = tab.path
      void loadThumbs().then((all) => {
        const view = all[path]
        setThumb({ path, url: thumbUrl(path, view), pages: view?.pages || undefined })
      })
      void bridge
        .getPosition(path)
        .then((pos) => setPage({ path, page: pos?.page }))
        .catch(() => setPage({ path, page: undefined }))
      const show = (): void => {
        showTimer.current = undefined
        // Measured at show time: the strip scrolls, and the tab may have moved
        // since the pointer arrived
        const r = el.getBoundingClientRect()
        if (!el.isConnected || r.width === 0) return
        const left = Math.max(8, Math.min(r.left, window.innerWidth - CARD_WIDTH - 8))
        setShown({ path, name: tab.name, left, top: r.bottom + 6 })
      }
      if (shownRef.current || Date.now() < warmUntil.current) show()
      else showTimer.current = window.setTimeout(show, SHOW_DELAY)
    },
    [blocked]
  )

  const leave = useCallback((): void => {
    window.clearTimeout(showTimer.current)
    showTimer.current = undefined
    if (!shownRef.current) return
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined
      close(false)
    }, HIDE_DELAY)
  }, [close])

  let card: React.JSX.Element | null = null
  if (shown && !blocked) {
    const picture = thumb?.path === shown.path ? thumb : undefined
    const at = page?.path === shown.path ? page.page : undefined
    const progress = readingProgress(at, picture?.pages)
    const pageLine = progress
      ? t('welcome.recentsProgress', { page: String(progress.page), pages: String(progress.pages) })
      : at !== undefined && at >= 1
        ? t('tabs.cardPage', { page: String(Math.round(at)) })
        : null
    const location = tabLocation(shown.path)
    card = (
      <div
        className="tab-hover-card"
        role="tooltip"
        style={{ left: shown.left, top: shown.top, width: CARD_WIDTH }}
      >
        {picture?.url && (
          <span className="tab-hover-cover">
            <span className="tab-hover-sheet">
              <img src={picture.url} alt="" draggable={false} />
            </span>
          </span>
        )}
        <span className="tab-hover-text">
          <span className="tab-hover-name">{shown.name}</span>
          {location && <span className="tab-hover-where">{breakAtSeparators(location)}</span>}
          {pageLine && <span className="tab-hover-page">{pageLine}</span>}
        </span>
      </div>
    )
  }

  return { enter, leave, card }
}

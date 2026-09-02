// How wide the three dividers make things: the left sidebar, the right
// assistant panel, and the split view's own divider between the two pages
// columns.
//
// One hook for all three because they are the same interaction — grab, drag,
// release, persist — and because the owner requires the left and right sides to
// behave identically. Two independent implementations is exactly how that
// symmetry gets lost.
//
// The widths are persisted to localStorage rather than to the app's JSON state
// store: they are chrome the browser build has too, and `bridge` has no
// per-window width channel. Writes happen on pointer-up, never per move —
// a drag would otherwise write a few hundred times.
//
// PANEL_DEFAULTS and PANEL_LS_KEY are exported because "reset every preference"
// in the gear menu has to be able to clear this one from outside.
import { useCallback, useRef, useState } from 'react'
import { clamp } from '../clamp'

/** Drag-resizable panel widths: defaults, clamps and persistence. Left (TOC)
 *  and right (assistant/search) share identical defaults and clamps so the two
 *  sides look and behave the same — the owner wants them symmetric.
 *
 *  `pane` is the odd one out: it is the split view's divider, and it stores the
 *  second column's SHARE of the pages area (0–1), not a pixel width. A stored
 *  width can only ever be paid for by the first column — open a side panel and
 *  the left half shrinks alone — whereas a share makes both columns give up the
 *  same proportion. `PANEL_MIN.pane` stays a px floor per column, converted to a
 *  share against the live width whenever the divider is dragged; the ceiling
 *  falls out of it (one column's floor is the other's limit), so PANEL_MAX.pane
 *  is only there to keep the three records the same shape. */
export const PANEL_DEFAULTS = { sidebar: 340, ai: 340, web: 340, pane: 0.5 }
const PANEL_MIN = { sidebar: 264, ai: 264, web: 264, pane: 260 }
const PANEL_MAX = { sidebar: 600, ai: 600, web: 600, pane: 1 }
type PanelKey = keyof typeof PANEL_DEFAULTS
export const PANEL_LS_KEY = 'pdfx-panel-widths'

function loadPanelWidths(): Record<PanelKey, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_LS_KEY) ?? '{}')
    const paneShare = Number(parsed.pane)
    return {
      sidebar: clamp(Number(parsed.sidebar) || PANEL_DEFAULTS.sidebar, PANEL_MIN.sidebar, PANEL_MAX.sidebar),
      ai: clamp(Number(parsed.ai) || PANEL_DEFAULTS.ai, PANEL_MIN.ai, PANEL_MAX.ai),
      web: clamp(Number(parsed.web) || PANEL_DEFAULTS.web, PANEL_MIN.web, PANEL_MAX.web),
      // A share, so anything outside (0, 1) is a pixel width written by an older
      // build — fall back to an even split rather than clamping nonsense
      pane: paneShare > 0 && paneShare < 1 ? paneShare : PANEL_DEFAULTS.pane
    }
  } catch {
    return { ...PANEL_DEFAULTS }
  }
}

interface PanelWidths {
  panelW: Record<PanelKey, number>
  setPanelW: React.Dispatch<React.SetStateAction<Record<PanelKey, number>>>
  /** Read the live widths from a pointer handler without re-subscribing it */
  panelWRef: React.RefObject<Record<PanelKey, number>>
  /** The divider being dragged, if any — the body gets a class while it is */
  resizingPanel: PanelKey | null
  beginPanelResize: (panel: PanelKey, e: React.PointerEvent) => void
  resetPanelWidth: (panel: PanelKey) => void
  /** Write the current widths out. Exposed because opening the split view sets
   *  the divider's share from outside a drag, and that share must survive too. */
  persistPanelWidths: () => void
}

/**
 * @param pagesHostRef The first pages column's host element. The split divider
 *   works in shares, so it has to measure what it is dividing; that width lives
 *   in the DOM and nowhere else.
 */
export function usePanelWidths(
  pagesHostRef: React.RefObject<HTMLDivElement | null>
): PanelWidths {
  /** Drag-resizable panel widths (px), persisted per user */
  const [panelW, setPanelW] = useState(loadPanelWidths)
  const panelWRef = useRef(panelW)
  panelWRef.current = panelW
  const [resizingPanel, setResizingPanel] = useState<PanelKey | null>(null)

  /** pagesAreaWidth is declared further down (it needs the pages container) —
   *  reached through a ref so this callback's dependency array does not touch it
   *  during render, which would be a temporal-dead-zone reference. */
  const pagesAreaWidthRef = useRef<() => number>(() => 0)

  const persistPanelWidths = (): void => {
    try {
      localStorage.setItem(PANEL_LS_KEY, JSON.stringify(panelWRef.current))
    } catch {
      /* width preference is best-effort */
    }
  }

  const beginPanelResize = useCallback((panel: PanelKey, e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWRef.current[panel]
    // The split divider moves a share, so it needs the width it is dividing —
    // measured once at grab time, since nothing but the drag changes it.
    const total = panel === 'pane' ? pagesAreaWidthRef.current() : 0
    // Which side pane B sits on is read from the DOM at grab time («Bytt
    // plass» flips the columns with CSS order): dragging toward pane B always
    // shrinks it, whichever side it is on.
    const host = pagesHostRef.current
    const bEl = host?.parentElement?.querySelector<HTMLElement>('.pages-host.pane-b')
    const bOnLeft =
      !!host && !!bEl && bEl.getBoundingClientRect().left < host.getBoundingClientRect().left
    setResizingPanel(panel)
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      if (panel === 'pane') {
        if (total <= 0) return
        // Both columns keep the same px floor, expressed as a share of the area
        const floor = Math.min(PANEL_MIN.pane / total, 0.5)
        const share = clamp((startW * total + (bOnLeft ? dx : -dx)) / total, floor, 1 - floor)
        setPanelW((p) => (Math.abs(p.pane - share) < 0.0005 ? p : { ...p, pane: share }))
        return
      }
      // The sidebar grows rightwards; the AI panel sits to the right of what it
      // resizes, so it grows leftwards
      const w = clamp(Math.round(panel === 'sidebar' ? startW + dx : startW - dx), PANEL_MIN[panel], PANEL_MAX[panel])
      setPanelW((p) => (p[panel] === w ? p : { ...p, [panel]: w }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizingPanel(null)
      persistPanelWidths()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  /** The width the two pages columns share right now (both columns, no panels) —
   *  what the divider's share is a share OF. */
  const pagesAreaWidth = useCallback((): number => {
    const a = pagesHostRef.current
    if (!a) return 0
    const b = a.parentElement?.querySelector<HTMLElement>('.pages-host.pane-b')
    return a.clientWidth + (b?.clientWidth ?? 0)
  }, [])
  pagesAreaWidthRef.current = pagesAreaWidth

  const resetPanelWidth = useCallback((panel: PanelKey) => {
    setPanelW((p) => ({ ...p, [panel]: PANEL_DEFAULTS[panel] }))
    window.setTimeout(persistPanelWidths, 0)
  }, [])

  return {
    panelW,
    setPanelW,
    panelWRef,
    resizingPanel,
    beginPanelResize,
    resetPanelWidth,
    persistPanelWidths
  }
}

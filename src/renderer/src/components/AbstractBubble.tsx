// «Sammendrag» from the selection menu: the abstract of the paper a selected
// reference-list entry names (issue #31 follow-up — in the reference list
// itself there is no citation link to hover). The selection's text goes to
// the same lookup as the link preview's button (PdfxApi.citationAbstract);
// choosing the item IS the click that consents to the network call, so the
// bubble asks on mount. It opens clear of the selection, grows in place when
// the answer lands (one move, re-clamped to the window), drags by its grip
// like the other bubbles, and closes on Esc or a click outside.

import { useCallback, useEffect, useRef, useState } from 'react'
import { t, useLang } from '../i18n'
import { bridge } from '../bridge'
import { useDraggable } from '../useDraggable'
import { useDismissable } from '../useDismissable'
import { AbstractBody, AbstractSource } from './AbstractView'
import type { AbstractState } from './AbstractView'

interface Props {
  /** The selected text, lines kept (the lookup rejoins a DOI broken at a line end) */
  text: string
  /** The selection's box in viewport coords — the bubble opens clear of it */
  avoid: { top: number; bottom: number; left: number }
  onClose(): void
}

export default function AbstractBubble({ text, avoid, onClose }: Props): React.JSX.Element {
  useLang()
  const [abs, setAbs] = useState<AbstractState>({ state: 'loading' })
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )
  const ask = useCallback((): void => {
    setAbs({ state: 'loading' })
    void bridge.citationAbstract(text).then((result) => {
      if (!alive.current) return
      setAbs('error' in result ? { state: 'error', error: result } : { state: 'done', result })
    })
  }, [text])
  useEffect(ask, [ask])

  const { ref, style, handleProps } = useDraggable<HTMLDivElement>(avoid.left, avoid.bottom + 10, [abs.state], avoid)
  useDismissable(ref, true, onClose)
  // Never taller than the roomier side of the selection, so the selected
  // reference stays in view and the abstract scrolls the rest — unless
  // neither side has room worth reading in, when the abstract wins
  const winH = window.innerHeight
  // 18 = the 10 px gap and 8 px edge useDraggable keeps, 4 more for the border
  const side = Math.max(winH - avoid.bottom - 22, avoid.top - 22)
  const maxHeight = side >= 260 ? side : winH - 24

  return (
    <div
      className="abstract-bubble"
      ref={ref}
      style={{ ...style, maxHeight }}
      role="dialog"
      aria-label={t('linkPreview.abstract')}
    >
      <span className="menu-grip" title={t('menu.dragTip')} {...handleProps} />
      {abs.state === 'loading' && <p className="lpa-loading abstract-bubble-wait">{t('linkPreview.abstractLoading')}</p>}
      <AbstractBody abs={abs} onRetry={ask} className="abstract-bubble-body" />
      {abs.state === 'done' && abs.result.source && (
        <div className="abstract-bubble-foot">
          <AbstractSource abs={abs} />
        </div>
      )}
    </div>
  )
}

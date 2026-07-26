// The explain-selection popover: the floating bubble the context menu opens on
// a selection or a snipped figure. It fires ONE request, streams it, and offers
// to hand the finished exchange over to the chat panel.
//
// Its own file rather than part of AiPanel.tsx because it shares no state with
// the panel — different lifetime (mounted per invocation, thrown away on
// close), different transport (one request, no history), and its own
// positioning/drag/resize logic. The whole interface between the two is the
// AiSeed handover, declared here because this is the side that produces it.
//
// Two constraints that were learned the hard way and are easy to undo:
//   - Esc and outside clicks MUST dismiss it. The Lukk button once sat
//     offscreen and trapped the bubble open, hence useDismissable.
//   - Positioning is re-measured on every content change, not once. The bubble
//     grows while the answer streams and again when a figure decodes, so a
//     single height guess drifts offscreen. Once the user has dragged it, their
//     position wins and growth only re-clamps to the viewport edges.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AiCitation, AiContentPart, AiImage } from '../../../shared/types'
import { bridge } from '../bridge'
import {
  askSystem,
  askUserMessage,
  critiqueSystem,
  formatTokens,
  explainSystem,
  explainUserMessage,
  figureSystem,
  figureUserMessage,
  nextAiRequestId,
  referenceSystem,
  referenceUserMessage
} from '../ai'
import { t, useLang } from '../i18n'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { useDismissable } from '../useDismissable'
import { AssistantBody, renderMarkdown } from './ai-markdown'
import { IconSend, IconSparkle } from './icons'

const nextRequestId = nextAiRequestId

/** An exchange on its way from this popover into the chat panel */
export interface AiSeed {
  question: string
  answer: string
}

export interface AiQuickState {
  x: number
  y: number
  mode: 'explain' | 'simplify' | 'reference' | 'critique' | 'ask' | 'figure'
  selection: string
  pageNumber: number
  pageContext: string
  /** Reference lookup, critique and free-form questions need the whole
   *  document attached so the model can draw on the full paper;
   *  explain/simplify/figure stay page-local. pageStarts lets the citation
   *  chips resolve char offsets to page numbers. */
  document?: { title: string; text: string; pageStarts: number[] } | null
  /** Figure mode: the snipped page region, sent as an image */
  image?: AiImage
}

const quickTitle = (mode: AiQuickState['mode']): string =>
  mode === 'explain'
    ? t('ai.quickExplain')
    : mode === 'simplify'
      ? t('ai.quickSimplify')
      : mode === 'reference'
        ? t('ai.quickReference')
        : mode === 'critique'
          ? t('ai.quickCritique')
          : mode === 'figure'
            ? t('ai.quickFigure')
            : t('ai.quickAsk')

interface QuickProps {
  state: AiQuickState
  onSendToChat(seed: AiSeed): void
  onCitation?(citation: AiCitation): void
  onClose(): void
}

export function AiQuickPopover({ state, onSendToChat, onCitation, onClose }: QuickProps): React.JSX.Element {
  useLang()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [meta, setMeta] = useState<string | null>(null)
  const [parts, setParts] = useState<AiContentPart[] | null>(null)
  const requestIdRef = useRef<number | null>(null)
  const finalRef = useRef('')
  const isReference = state.mode === 'reference'
  const isCritique = state.mode === 'critique'
  const isAsk = state.mode === 'ask'
  const isFigure = state.mode === 'figure'
  /** Reference lookup, critique and ask attach the whole document */
  const usesDocument = isReference || isCritique || isAsk
  const [question, setQuestion] = useState('')
  /** Ask mode waits for the user's question before firing the request */
  const [asked, setAsked] = useState<string | null>(null)
  const active = !isAsk || asked !== null

  useEffect(() => {
    if (!active) return
    let stale = false
    const requestId = nextRequestId()
    requestIdRef.current = requestId
    const unsubscribe = bridge.onAiDelta((id, delta) => {
      if (id === requestId && !stale) setText((s) => s + delta)
    })
    void (async () => {
      const result = await bridge.aiChat({
        requestId,
        system: isReference
          ? referenceSystem()
          : isCritique
            ? critiqueSystem()
            : isAsk
              ? askSystem()
              : isFigure
                ? figureSystem()
                : explainSystem(state.mode as 'explain' | 'simplify'),
        messages: [
          {
            role: 'user',
            text: isReference
              ? referenceUserMessage(state.selection, state.pageNumber, state.pageContext)
              : isAsk
                ? askUserMessage(asked ?? '', state.selection, state.pageNumber, state.pageContext)
                : isFigure
                  ? figureUserMessage(state.pageNumber, state.pageContext)
                  : explainUserMessage(state.selection, state.pageNumber, state.pageContext),
            ...(isFigure && state.image ? { images: [state.image] } : {})
          }
        ],
        // Reference lookup, critique and free-form questions attach the whole
        // document so the model can draw on the full paper; the others stay
        // page-local (figure carries its snip as an image instead).
        document: usesDocument && state.document
          ? { title: state.document.title, text: state.document.text }
          : null,
        // Context-menu actions have no globe toggle — always instruction-gated:
        // «sjekk denne referansen på nettet» in a free-form question just works,
        // but nothing is searched unless the user asked for it.
        webSearch: 'ask'
      })
      if (stale) return
      setDone(true)
      if ('error' in result) {
        setError(result.error)
      } else {
        const full = result.parts.map((p) => p.text).join('')
        finalRef.current = full
        setText(full)
        setParts(result.parts)
        setMeta(formatTokens(result.usage))
      }
    })()
    return () => {
      stale = true
      unsubscribe()
      if (!finalRef.current && requestIdRef.current !== null) bridge.aiAbort(requestIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Measured positioning: the popover grows while the answer streams (and
  // when the figure image decodes), so a fixed height guess drifts offscreen.
  // Re-clamp on every content change (deltas, image decode via sizeBump) —
  // deliberately NOT ResizeObserver-only, whose callbacks ride the frame loop.
  // Once the user has dragged the popover, their position wins: growth only
  // re-clamps against the viewport edges, never back to the anchor.
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [sizeBump, setSizeBump] = useState(0)
  // Corner grip: a long answer about a figure is easier to read wide and tall.
  // Local state — a fresh popover always opens at the default shape; a
  // double-click on the grip goes back to it.
  const [quickSize, setQuickSize] = useState<BoxSize | null>(null)
  const { gripProps: quickGrip, style: quickSizeStyle } = useResizable(
    popRef,
    quickSize,
    setQuickSize,
    { axis: 'both', minW: 300, minH: 200 }
  )
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const draggedRef = useRef(false)
  useLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const clampTo = (left: number, top: number): { left: number; top: number } => ({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8))
    })
    setPos((p) => {
      const next = draggedRef.current && p ? clampTo(p.left, p.top) : clampTo(state.x, state.y + 10)
      return p && p.left === next.left && p.top === next.top ? p : next
    })
  }, [state.x, state.y, text, parts, asked, error, sizeBump])

  // Esc and clicks outside dismiss the popover — the Lukk button must never
  // be the only way out (it once sat offscreen and trapped the bubble open)
  useDismissable(popRef, true, onClose)

  return (
    <div
      className="ai-quick"
      ref={popRef}
      style={{ ...(pos ?? { left: state.x, top: state.y, visibility: 'hidden' }), ...quickSizeStyle }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="ai-quick-head"
        onPointerDown={(e) => {
          if (!pos) return
          dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
          try {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {
            /* synthetic events have no active pointer */
          }
          e.preventDefault()
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          draggedRef.current = true
          const el = popRef.current
          const w = el?.offsetWidth ?? 360
          const h = el?.offsetHeight ?? 200
          setPos({
            left: Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8)),
            top: Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - h - 8))
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
      >
        <IconSparkle size={14} />
        <span>
          {state.selection
            ? `${quickTitle(state.mode)}: «${state.selection.length > 42 ? `${state.selection.slice(0, 42)}…` : state.selection}»`
            : `${quickTitle(state.mode)} (${t('app.pageAbbrev')} ${state.pageNumber})`}
        </span>
      </div>
      {/* The snip stays visible outside the scrolling body, so the answer
          can be read against the figure it describes */}
      {isFigure && state.image && (
        <img
          className="ai-quick-figure"
          src={`data:${state.image.mediaType};base64,${state.image.dataBase64}`}
          alt={t('ai.imageAlt')}
          onLoad={() => setSizeBump((n) => n + 1)}
        />
      )}
      <div className="ai-quick-body">
        {!active ? (
          <div className="ai-quick-ask">
            <input
              type="text"
              autoFocus
              value={question}
              placeholder={t('ai.askPlaceholder')}
              spellCheck={false}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && question.trim()) setAsked(question.trim())
                if (e.key === 'Escape') onClose()
              }}
            />
            <button
              className="ai-send"
              title={t('ai.sendTip')}
              disabled={!question.trim()}
              onClick={() => question.trim() && setAsked(question.trim())}
            >
              <IconSend size={15} />
            </button>
          </div>
        ) : (
          <>
            {isAsk && <div className="ai-quick-question">{asked}</div>}
            {error ? (
              <div className="ai-error">{error}</div>
            ) : parts && usesDocument ? (
              <AssistantBody
                parts={parts}
                doc={state.document ? { text: state.document.text, pageStarts: state.document.pageStarts } : null}
                onCitation={(c) => onCitation?.(c)}
              />
            ) : text ? (
              renderMarkdown(text)
            ) : (
              <div className="ai-thinking">{t('ai.thinking')}</div>
            )}
          </>
        )}
      </div>
      <div className="ai-quick-actions">
        {meta && <span className="ai-meta">{meta}</span>}
        <button
          className="btn-secondary"
          disabled={!done || !!error}
          onClick={() =>
            onSendToChat({
              question: t('ai.quickQuestion', {
                title: isAsk && asked ? asked : quickTitle(state.mode),
                selection: state.selection,
                page: state.pageNumber
              }),
              answer: finalRef.current
            })
          }
        >
          {t('ai.sendToChat')}
        </button>
        <button className="btn-primary" onClick={onClose}>
          {t('app.close')}
        </button>
      </div>

      <span className="box-grip" title={t('bubble.resizeTip')} {...quickGrip} />
    </div>
  )
}

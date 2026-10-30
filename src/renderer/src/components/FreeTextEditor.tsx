// The text box being written on the page (issue #66, Edge's text box as the
// reporter's reference). Three things the plain textarea it replaced could not
// do:
//
//   - GROW AS IT IS TYPED INTO. A new box starts as wide as its placeholder,
//     widens with the longest line, and wraps once it nears the page's right
//     edge (freetextAutoSize). The moment the corner handle is dragged, the
//     width is the reader's and stays put; the height still grows with the
//     lines. A re-opened box is sized already, so it starts that way. Nothing
//     about this is stored: a PDF has no autosize flag, and the box that
//     commits is just a rect.
//   - MOVE BEFORE IT IS WRITTEN. A grip beside the first line drags the box —
//     empty or not — for the misplaced click the reporter described. It keeps
//     the textarea focused, so the draft is neither committed nor discarded
//     by the drag.
//   - SHOW ITS WORDS WHERE THE FILE WILL. No inset, the saved appearance's
//     own line box (freetextLineCss), no kerning: the first line sits where it
//     will sit in the file, so nothing moves when the box commits.
//
// The size lives in this component's own state rather than the viewer's, so a
// keystroke re-renders this box and nothing else.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PageRect } from '../../../shared/types'
import type { PdfStandardFont } from '@embedpdf/models'
import { freetextAutoSize, freetextLineCss, freetextMinSize, rgbCss, textFontCss } from '../annotations'
import { bubblesWhileTyping } from '../keymap'
import { t } from '../i18n'

export interface FreeTextEditorProps {
  /** The page's top-left corner in the pane's layout, px */
  pageLeft: number
  pageTop: number
  /** px per page point */
  scale: number
  /** The page's size in points */
  pageW: number
  pageH: number
  /** Where the box starts, page points. With `w`/`h` the box is sized
   *  already (a re-opened one) and keeps its width. */
  x: number
  y: number
  w?: number | undefined
  h?: number | undefined
  text: string
  fontSize: number
  font: PdfStandardFont | undefined
  color: [number, number, number]
  /** A re-opened box is backed, so its old letters do not show through */
  opaque: boolean
  onCommit(text: string, rect: PageRect): void
  onCancel(): void
}

/** The box as the reader is shaping it, in page points */
interface Box {
  x: number
  y: number
  /** Set once the width is the reader's (dragged, or a re-opened box) */
  pinnedW: number | null
  /** The height the reader dragged to: the box never shrinks below it */
  floorH: number
}

export default function FreeTextEditor(p: FreeTextEditorProps): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(p.text)
  const [box, setBox] = useState<Box>(() => ({
    x: p.x,
    y: p.y,
    pinnedW: p.w ?? null,
    floorH: p.h ?? 0
  }))
  /** Lines the browser wrapped beyond the measurement, px, for the text and
   *  width it was found at — see the layout effect below */
  const [overflow, setOverflow] = useState({ key: '', px: 0 })
  const placeholder = t('text.placeholder')

  const size = useMemo(() => {
    if (box.pinnedW === null) {
      return freetextAutoSize(text, placeholder, p.fontSize, p.font, box.x, p.pageW)
    }
    const min = freetextMinSize(text.length > 0 ? text : placeholder, p.fontSize, box.pinnedW, p.font)
    return { w: Math.max(box.pinnedW, min.w), h: Math.max(box.floorH, min.h) }
  }, [text, placeholder, p.fontSize, p.font, p.pageW, box])

  const w = size.w
  const overflowKey = `${w}\n${p.scale}\n${text}`
  const h = size.h + (overflow.key === overflowKey ? overflow.px / p.scale : 0)
  const sizePx = p.fontSize * p.scale
  const lines = freetextLineCss(p.font, sizePx)
  /** The move grip: as tall as a line, within reason */
  const gripH = Math.max(14, Math.min(lines.lineHeight, 24))

  // The measurement and the textarea's own wrapping agree (same face, same
  // width, no kerning), but should the textarea ever need one more line than
  // was measured, the first line would scroll out of the top of the box —
  // the box grows instead, and the commit takes the grown height along.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = 0
    el.scrollLeft = 0
    const extra = el.scrollHeight - el.clientHeight
    if (extra > 1) {
      setOverflow((o) => ({ key: overflowKey, px: (o.key === overflowKey ? o.px : 0) + extra }))
    }
  })

  const committed = useRef(false)
  const commit = useCallback(() => {
    if (committed.current) return
    committed.current = true
    const value = (ref.current?.value ?? text).trim()
    // An untouched box — placeholder only — is never saved
    if (value) p.onCommit(value, { x: box.x, y: box.y, w, h })
    else p.onCancel()
  }, [p, text, box, w, h])

  /** Drag the box (grip) or its corner (handle). The textarea keeps focus:
   *  preventDefault on the press stops the browser moving focus to the grip,
   *  which would blur — and so commit, or discard — the draft. Listeners on
   *  window, so a fast drag that leaves the grip still lands. */
  const drag = (kind: 'move' | 'size', e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const start = { cx: e.clientX, cy: e.clientY, box, w, h }
    const id = e.pointerId
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      const dx = (ev.clientX - start.cx) / p.scale
      const dy = (ev.clientY - start.cy) / p.scale
      if (kind === 'move') {
        setBox({
          ...start.box,
          x: Math.min(Math.max(0, start.box.x + dx), Math.max(0, p.pageW - start.w)),
          y: Math.min(Math.max(0, start.box.y + dy), Math.max(0, p.pageH - start.h))
        })
      } else {
        // The width is the reader's from here on; never past the page edge
        const nw = Math.min(Math.max(p.fontSize, start.w + dx), Math.max(p.fontSize, p.pageW - start.box.x))
        setBox({ ...start.box, pinnedW: nw, floorH: Math.max(0, start.h + dy) })
      }
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      ref.current?.focus()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // A placed box takes the keyboard at once (autoFocus does not survive the
  // pointerdown that placed it on every platform)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div
      className="freetext-draft"
      style={{
        left: p.pageLeft + box.x * p.scale,
        top: p.pageTop + box.y * p.scale + lines.shift,
        width: w * p.scale,
        height: h * p.scale
      }}
      // The viewer's own press handling (deselect, drag a mark, pan) must not
      // see a press inside the box
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        className="freetext-editor"
        autoFocus
        spellCheck={false}
        defaultValue={p.text}
        placeholder={placeholder}
        style={{
          // An edited box previews in ITS stored look; a new draft follows
          // the tool preference live, so what you type is what commits —
          // the TYPEFACE included. Typing in one face and committing in
          // another is not a preview, and it is not only cosmetic: the
          // commit's box is measured in the committed face, so an editor set
          // in another one wraps somewhere else (Emil, 2026-08-08).
          color: rgbCss(p.color, 1),
          fontSize: sizePx,
          lineHeight: `${lines.lineHeight}px`,
          ...textFontCss(p.font),
          ...(p.opaque ? { background: 'rgba(255, 255, 255, 0.96)' } : {})
        }}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          // App shortcuts bubble to the window handler (find steals focus and
          // the onBlur below commits, or discards, an empty draft)
          if (bubblesWhileTyping(e)) return
          e.stopPropagation()
          if (e.key === 'Escape') {
            committed.current = true
            p.onCancel()
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={commit}
      />
      <div
        className="freetext-grip freetext-move"
        title={t('text.moveGrip')}
        // Beside the FIRST line, where the eye is — not above the box, where
        // it would cover the printed line the box is written under
        style={{ height: gripH, top: (lines.lineHeight - gripH) / 2 }}
        onPointerDown={(e) => drag('move', e)}
        onMouseDown={(e) => e.preventDefault()}
      />
      <div
        className="freetext-grip freetext-resize"
        title={t('text.resizeGrip')}
        onPointerDown={(e) => drag('size', e)}
        onMouseDown={(e) => e.preventDefault()}
      />
    </div>
  )
}

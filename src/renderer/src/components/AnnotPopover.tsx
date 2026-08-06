import { useEffect, useRef, useState } from 'react'
import { annotTypeLabel, FREETEXT_COLORS, HIGHLIGHT_COLORS, UNDERLINE_COLORS } from '../annotations'
import type { PageAnnotation } from '../annotations'
import { t, useLang } from '../i18n'
import { bubblesWhileTyping } from '../keymap'
import { useDraggable } from '../useDraggable'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { MarkupColorRow } from './SelectionMenu'

interface Props {
  x: number
  y: number
  /** Markup rect (viewport coords) to open clear of, so it stays readable.
   *  `| undefined` because the viewer forwards it straight off a draft object
   *  where it is optional — a JSX attribute is always present, so an optional
   *  prop that is forwarded rather than conditionally spread has to accept it. */
  avoid?: { top: number; bottom: number; left: number } | null | undefined
  annotation: PageAnnotation
  /** Focus the comment field on open (immediate-comment flow) */
  focusText?: boolean | undefined
  onColor(color: [number, number, number]): void
  onContents(text: string): void
  onDelete(): void
  onClose(): void
  /** Drag-resized size for THIS annotation (the viewer remembers it per
   *  annotation, so re-opening a long comment comes back roomy); null = the
   *  default shape from the stylesheet */
  size: BoxSize | null
  onResize(size: BoxSize | null): void
}

export default function AnnotPopover({
  x,
  y,
  avoid,
  annotation,
  focusText,
  onColor,
  onContents,
  onDelete,
  onClose,
  size,
  onResize
}: Props): React.JSX.Element {
  useLang()
  const [text, setText] = useState(annotation.contents ?? '')
  const textRef = useRef<HTMLTextAreaElement>(null)

  // Opens clear of the markup (below/above it) so the marked text stays
  // readable, and is draggable by its header for further nudging.
  const { ref, style, positioned, handleProps } = useDraggable(x, y + 10, [], avoid)
  // Corner grip resizes the whole bubble (the comment field takes the slack);
  // double-clicking the grip restores the default shape.
  const { gripProps, style: sizeStyle } = useResizable(ref, size, onResize, {
    axis: 'both',
    minW: 224,
    // Floor = the bubble's natural height (header + swatches + a usable comment
    // field + the delete row); below that the fixed rows would have to squeeze.
    minH: 178
  })

  // Focus the comment field once the bubble is measured and visible. Focusing
  // it while still `visibility: hidden` (pre-measure) is a no-op — that left the
  // caret out until you clicked in. Guard so it only lands once.
  const focusedRef = useRef(false)
  useEffect(() => {
    if (focusText && positioned && !focusedRef.current) {
      focusedRef.current = true
      textRef.current?.focus()
    }
  }, [focusText, positioned])

  // Closing the popover must never lose a typed comment: click-outside
  // unmounts before the textarea's blur fires, and Esc bypasses it entirely —
  // so flush any pending edit on unmount.
  const pendingRef = useRef({ text, saved: annotation.contents ?? '', onContents })
  pendingRef.current = { text, saved: annotation.contents ?? '', onContents }
  useEffect(
    () => () => {
      const { text: latest, saved, onContents: save } = pendingRef.current
      if (latest.trim() !== saved) save(latest.trim())
    },
    []
  )

  return (
    <div
      className="annot-popover"
      ref={ref}
      style={{ ...style, ...sizeStyle }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="annot-popover-head" {...handleProps}>
        <span>{annotTypeLabel(annotation.type)}</span>
        {annotation.author && <span className="annot-popover-author">{annotation.author}</span>}
      </div>

      <MarkupColorRow
        palette={
          annotation.type === 'freetext'
            ? FREETEXT_COLORS
            : annotation.type === 'highlight' || annotation.type === 'note'
              ? HIGHLIGHT_COLORS
              : UNDERLINE_COLORS
        }
        swatch={annotation.type === 'highlight' || annotation.type === 'note' || annotation.type === 'freetext' ? 'dot' : 'bar'}
        tipKey="popover.colorTip"
        onPick={(c) => onColor(c.rgb)}
      />

      {/* Text boxes edit their text inline (click the box) — a comment field
          here would just duplicate the box contents */}
      {annotation.type !== 'freetext' && (
        <textarea
          ref={textRef}
          className="annot-popover-text"
          value={text}
          placeholder={annotation.type === 'note' ? t('popover.notePlaceholder') : t('popover.commentPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter and Esc both commit: closing unmounts the
            // popover, and the unmount flush above saves the pending text
            // exactly once. (The global Esc handler never sees keys from
            // here — propagation stops below.)
            if (bubblesWhileTyping(e)) return // an app shortcut (find, save, zoom …)
            if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
            e.stopPropagation()
          }}
        />
      )}

      <div className="annot-popover-actions">
        <button className="annot-delete" onClick={onDelete}>
          {t('app.delete')}
        </button>
      </div>

      <span className="box-grip" title={t('bubble.resizeTip')} {...gripProps} />
    </div>
  )
}

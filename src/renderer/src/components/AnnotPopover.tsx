import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  annotTypeLabel,
  FREETEXT_COLORS,
  FREETEXT_SIZE,
  HIGHLIGHT_COLORS,
  PEN_COLORS,
  TEXT_FONT_DEFAULT,
  TEXT_FONT_FAMILIES,
  textFontCss,
  textFontOf,
  textFontParts,
  UNDERLINE_COLORS
} from '../annotations'
import type { PageAnnotation } from '../annotations'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP } from '../tool-prefs'
import type { PdfStandardFont } from '@embedpdf/models'
import { t, useLang } from '../i18n'
import { bubblesWhileTyping } from '../keymap'
import { useDraggable } from '../useDraggable'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { MarkupColorRow } from './SelectionMenu'
import { inTextField } from './TextContextMenu'

/** Marks made by a DRAWING tool (the pen and the shapes), as opposed to marks
 *  anchored to text. They share the pen case; text markup keeps its own
 *  saturated palette, where a colour has to read as a thin line under words. */
const DRAWN_TYPES: ReadonlySet<PageAnnotation['type']> = new Set([
  'ink',
  'square',
  'circle',
  'line',
  'arrow'
])

/** The bubble's default shape follows the comment (Emil, 2026-10-27: it
 *  showed a few lines at a time, and an average paragraph should be readable
 *  without scrolling). The field opens at the text's own height up to
 *  FIT_SHARE of the window; a double-click on the grip, from the default,
 *  grows it to show the whole text up to ALL_SHARE, and a second one puts
 *  the default back. A comment past LONG_CHARS also takes the wider step
 *  (.annot-popover.is-wide). A size the reader DRAGGED wins over all of it. */
const FIT_SHARE = 0.5
const ALL_SHARE = 0.8
const LONG_CHARS = 320
/** The stylesheet's field height — the floor the fit never goes under */
const FIELD_MIN_PX = 72
/** The field's two borders, outside its scrollHeight */
const FIELD_BORDER_PX = 2

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
  /** freetext only: re-set the box in another Standard-14 face. The viewer
   *  re-measures the box in the new face before sending it on — a box typed in
   *  Helvetica and switched to Courier needs more width for the same words. */
  onFont(font: PdfStandardFont): void
  /** freetext only: re-set the box at another size in points (issue #53 —
   *  before, the size could be chosen for the NEXT box only). Re-measured by
   *  the viewer like a face change. */
  onFontSize(size: number): void
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
  onFont,
  onFontSize,
  onContents,
  onDelete,
  onClose,
  size,
  onResize
}: Props): React.JSX.Element {
  useLang()
  const [text, setText] = useState(annotation.contents ?? '')
  const textRef = useRef<HTMLTextAreaElement>(null)

  // The default shape, when no dragged size overrides it: the field at the
  // text's height (fitH), the whole text after a double-click (showAll), the
  // wider step for a long comment. needsRoomRef says whether the text has
  // more than the fit shows — the toggle has nothing to show otherwise.
  const [showAll, setShowAll] = useState(false)
  const [fitH, setFitH] = useState<number | null>(null)
  const needsRoomRef = useRef(false)
  const hasField = annotation.type !== 'freetext'
  const wide = !size && hasField && (showAll || text.length > LONG_CHARS)

  // Opens clear of the markup (below/above it) so the marked text stays
  // readable, and is draggable by its header for further nudging. Re-clamped
  // when the fit changes the bubble's height, so a tall one stays on screen.
  const { ref, style, positioned, handleProps } = useDraggable(x, y + 10, [fitH, wide], avoid)
  // Corner grip resizes the whole bubble (the comment field takes the slack);
  // double-clicking the grip toggles whole-text ⇄ default, or restores the
  // default from a dragged size.
  const { gripProps, style: sizeStyle } = useResizable(ref, size, onResize, {
    axis: 'both',
    // The stylesheet's width: the longest colour row on one line (app.css)
    minW: 320,
    // Floor = the bubble's natural height (header + swatches + a usable comment
    // field + the delete row); below that the fixed rows would have to squeeze.
    minH: 178,
    onReset: () => {
      if (size) {
        onResize(null)
        setShowAll(false)
      } else if (showAll || needsRoomRef.current) {
        setShowAll((v) => !v)
      }
    }
  })

  // Measure the comment's own height and fit the field to it: the field is
  // collapsed for a moment so scrollHeight reports the CONTENT (a field taller
  // than its text reports its own box), the chrome around it is what the
  // bubble measures beyond the field, and the cap leaves the bubble within
  // its share of the window. Runs again as the text is typed, so the field
  // grows with it up to the cap.
  useLayoutEffect(() => {
    const field = textRef.current
    const box = ref.current
    if (size || !field || !box) {
      setFitH(null)
      return
    }
    const before = field.style.height
    field.style.height = '0px'
    const content = field.scrollHeight + FIELD_BORDER_PX
    field.style.height = before
    const chrome = box.offsetHeight - field.offsetHeight
    const share = showAll ? ALL_SHARE : FIT_SHARE
    const cap = Math.max(FIELD_MIN_PX, Math.round(window.innerHeight * share) - chrome)
    const fitCap = Math.max(FIELD_MIN_PX, Math.round(window.innerHeight * FIT_SHARE) - chrome)
    needsRoomRef.current = content > fitCap
    setFitH(Math.max(FIELD_MIN_PX, Math.min(content, cap)))
  }, [text, size, showAll, wide, ref])

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
      className={`annot-popover${wide ? ' is-wide' : ''}`}
      ref={ref}
      style={{ ...style, ...sizeStyle }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        if (!inTextField(e.target)) e.preventDefault()
      }}
    >
      <div className="annot-popover-head" {...handleProps}>
        <span>{annotTypeLabel(annotation.type)}</span>
        {annotation.author && <span className="annot-popover-author">{annotation.author}</span>}
      </div>

      {/* Recolouring a mark offers the palette the tool that MADE it offers,
          so the swatch that is ringed here is the swatch you picked there. */}
      <MarkupColorRow
        palette={
          annotation.type === 'freetext'
            ? FREETEXT_COLORS
            : annotation.type === 'highlight' || annotation.type === 'note'
              ? HIGHLIGHT_COLORS
              : DRAWN_TYPES.has(annotation.type)
                ? PEN_COLORS
                : UNDERLINE_COLORS
        }
        swatch={
          annotation.type === 'highlight' ||
          annotation.type === 'note' ||
          annotation.type === 'freetext'
            ? 'dot'
            : 'bar'
        }
        tipKey="popover.colorTip"
        onPick={(c) => onColor(c.rgb)}
      />

      {/* A text box can be RE-SET, not only recoloured (Emil, 2026-08-09): the
          toolbar's font choice only ever reached boxes that did not exist yet,
          so a paragraph typed in the wrong face had to be deleted and retyped.
          Deliberately the same three chips and the same two A's as the text
          tool's own menu — one control, in two places, so neither has to be
          learned twice. A box read back from a FILE has no font of its own
          (pdf.js paints those from the appearance stream); it reads as
          Helvetica here, which is what the engine will write if it is changed. */}
      {annotation.type === 'freetext' &&
        (() => {
          const parts = textFontParts(annotation.font ?? TEXT_FONT_DEFAULT)
          const fontSize = annotation.fontSize ?? FREETEXT_SIZE
          return (
            <>
              {/* The size too (issue #53): the same slider as the text tool's
                  menu, over the same range, applied to THIS box. The commit
                  happens on release (change), not on every tick of the drag —
                  each one is an engine write and an undo step. */}
              <div className="theme-menu-label slider-label">
                {t('tb.fontSize')}
                <output>{fontSize} pt</output>
              </div>
              <input
                type="range"
                className="font-size-range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                defaultValue={fontSize}
                onChange={(e) => onFontSize(Number(e.target.value))}
                aria-label={t('tb.fontSize')}
              />
              <div className="font-row">
                {TEXT_FONT_FAMILIES.map((family) => {
                  const face = textFontOf(family, parts.bold, parts.italic)
                  return (
                    <button
                      key={family}
                      className={`font-chip${parts.family === family ? ' selected' : ''}`}
                      style={textFontCss(face)}
                      onClick={() => onFont(face)}
                    >
                      {family}
                    </button>
                  )
                })}
              </div>
              <div className="font-style-row">
                {([
                  ['bold', 'tb.textBold'],
                  ['italic', 'tb.textItalic']
                ] as const).map(([which, tip]) => {
                  const on = which === 'bold' ? parts.bold : parts.italic
                  return (
                    <button
                      key={which}
                      className={`font-style font-style-${which}${on ? ' selected' : ''}`}
                      title={t(tip)}
                      aria-pressed={on}
                      onClick={() =>
                        onFont(
                          textFontOf(
                            parts.family,
                            which === 'bold' ? !parts.bold : parts.bold,
                            which === 'italic' ? !parts.italic : parts.italic
                          )
                        )
                      }
                    >
                      A
                    </button>
                  )
                })}
              </div>
            </>
          )
        })()}

      {/* Text boxes edit their text inline (click the box) — a comment field
          here would just duplicate the box contents */}
      {annotation.type !== 'freetext' && (
        <textarea
          ref={textRef}
          className="annot-popover-text"
          // The fit applies only while no dragged size holds the bubble —
          // then the field takes the slack of the dragged box instead
          style={!size && fitH != null ? { height: fitH } : undefined}
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

      <span
        className="box-grip"
        title={t(hasField ? 'bubble.resizeFitTip' : 'bubble.resizeTip')}
        {...gripProps}
      />
    </div>
  )
}

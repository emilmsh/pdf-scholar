import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addCustomColor,
  colorLabel,
  hexToRgb,
  HIGHLIGHT_COLORS,
  loadCustomColors,
  UNDERLINE_COLORS
} from '../annotations'
import type { HighlightColor } from '../annotations'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import { useDraggable } from '../useDraggable'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { useDismissable } from '../useDismissable'
import {
  IconBook,
  IconComment,
  IconCopy,
  IconGlobe,
  IconMarkupHighlight,
  IconMarkupSquiggly,
  IconMarkupStrikeout,
  IconMarkupUnderline,
  IconNote,
  IconSparkle,
  IconTally,
  IconTranslate
} from './icons'

const HEX_RE = /^#?[0-9a-fA-F]{6}$/

/** Small popover behind the "+" swatch: a colour wheel and a hex field so
 *  users can pick visually or paste an exact #rrggbb. */
function CustomColorPicker({ onPick }: { onPick(hex: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState('#')
  const ref = useRef<HTMLDivElement>(null)

  const closePicker = useCallback(() => setOpen(false), [])
  useDismissable(ref, open, closePicker)

  const commit = (value: string): void => {
    if (!HEX_RE.test(value)) return
    onPick(value.startsWith('#') ? value.toLowerCase() : `#${value.toLowerCase()}`)
    setOpen(false)
  }

  return (
    <div className="color-plus-wrap" ref={ref}>
      <button className="color-plus" title={t('menu.customColor')} onClick={() => setOpen((o) => !o)}>
        +
      </button>
      {open && (
        <div className="color-picker-pop" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="color"
            className="color-picker-wheel"
            value={HEX_RE.test(hex) ? hex : '#ffd54a'}
            onChange={(e) => {
              setHex(e.target.value)
              onPick(e.target.value.toLowerCase())
            }}
          />
          <input
            type="text"
            className="color-picker-hex"
            value={hex}
            placeholder="#rrggbb"
            spellCheck={false}
            autoFocus
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit(hex)
              if (e.key === 'Escape') setOpen(false)
            }}
          />
          <button
            className="color-picker-apply"
            disabled={!HEX_RE.test(hex)}
            onClick={() => commit(hex)}
          >
            ✓
          </button>
        </div>
      )}
    </div>
  )
}

/** Palette dots/bars + last-used custom colors + a custom hex/wheel picker */
export function MarkupColorRow({
  palette,
  swatch,
  tipKey,
  onPick
}: {
  palette: HighlightColor[]
  swatch: 'dot' | 'bar'
  tipKey: MsgKey
  onPick(color: HighlightColor): void
}): React.JSX.Element {
  const [customs, setCustoms] = useState<HighlightColor[]>(loadCustomColors)
  const colors = [...palette, ...customs.filter((c) => !palette.some((p) => p.hex === c.hex))]
  const pickCustom = (hex: string): void => {
    addCustomColor(hex)
    setCustoms(loadCustomColors())
    onPick({ key: 'custom', hex, rgb: hexToRgb(hex) })
  }
  return (
    <div className="color-row">
      {colors.map((c) =>
        swatch === 'dot' ? (
          <button
            key={c.hex}
            className="color-dot"
            style={{ background: c.hex }}
            title={t(tipKey, { color: colorLabel(c).toLowerCase() })}
            onClick={() => onPick(c)}
          />
        ) : (
          <button
            key={c.hex}
            className="color-bar"
            title={t(tipKey, { color: colorLabel(c).toLowerCase() })}
            onClick={() => onPick(c)}
          >
            <span style={{ background: c.hex }} />
          </button>
        )
      )}
      <CustomColorPicker onPick={pickCustom} />
    </div>
  )
}

export interface MenuState {
  /** viewport (client) coordinates */
  x: number
  y: number
  pageNumber: number
  mode: 'selection' | 'point'
  /** click point in page space (point mode) */
  pagePoint?: { x: number; y: number }
}

/** Word Counter Plus-style stats for the current selection. Words split on
 *  any Unicode whitespace; sentences on terminal punctuation (a non-empty
 *  selection without punctuation still counts as one). Reading time at a
 *  calm 200 wpm — the figure people quote for prose. */
interface SelectionStats {
  words: number
  characters: number
  charactersNoSpaces: number
  sentences: number
  /** whole minutes at 200 wpm; 0 means "under a minute" (with words > 0) */
  minutes: number
}

function countSelection(text: string): SelectionStats {
  const trimmed = text.trim()
  // A "word" must carry a letter or number — a lone dash or bullet doesn't
  // count (matches how Word Counter Plus tallies).
  const words = trimmed ? trimmed.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0
  const characters = text.length
  const charactersNoSpaces = text.replace(/\s/g, '').length
  const sentenceMarks = (trimmed.match(/[.!?…]+(?=\s|$)/g) ?? []).length
  const sentences = trimmed ? Math.max(1, sentenceMarks) : 0
  return { words, characters, charactersNoSpaces, sentences, minutes: Math.floor(words / 200) }
}

/** Count block expanded on demand from the «Ordtelling» menu item. */
function SelectionCount({ text }: { text: string }): React.JSX.Element | null {
  useLang()
  if (!text.trim()) return null
  const s = countSelection(text)
  const readingTime = s.words === 0 || s.minutes < 1 ? t('menu.readingUnderMin') : `${s.minutes} min`
  const rows: [MsgKey, string][] = [
    ['menu.words', String(s.words)],
    ['menu.characters', String(s.characters)],
    ['menu.charactersNoSpaces', String(s.charactersNoSpaces)],
    ['menu.sentences', String(s.sentences)],
    ['menu.readingTime', readingTime]
  ]
  return (
    <dl className="selection-stats">
      {rows.map(([key, value]) => (
        <div className="selection-stat" key={key}>
          <dt>{t(key)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export type MenuAction =
  | { kind: 'highlight'; color: HighlightColor }
  | { kind: 'underline'; color: HighlightColor }
  | { kind: 'strikeout'; color: HighlightColor }
  | { kind: 'squiggly'; color: HighlightColor }
  | { kind: 'note' }
  | { kind: 'comment' }
  | { kind: 'copy' }
  | { kind: 'search' }
  | { kind: 'dictionary' }
  | { kind: 'translate' }
  | { kind: 'ai'; mode: 'explain' | 'simplify' }
  | { kind: 'reference' }
  | { kind: 'critique' }
  | { kind: 'ask' }
  | { kind: 'snip' }

interface MenuProps {
  menu: MenuState
  onAction(action: MenuAction): void
}

export function SelectionMenu({ menu, onAction }: MenuProps): React.JSX.Element {
  useLang()
  const isSelection = menu.mode === 'selection'
  // Draggable, like the note and comment bubbles: this menu is the tallest
  // popup in the app, and a reader who wants to see what is under it should be
  // able to pull it aside rather than close it and lose the selection.
  //
  // The anchor is passed as a ZERO-HEIGHT avoid rect, which reproduces exactly
  // the placement this menu has always had — 10px below the pointer, flipped
  // above it when that would overflow the bottom, then edge-clamped — so
  // nothing about how it opens changes; only the drag is new.
  const { ref, style, handleProps } = useDraggable<HTMLDivElement>(menu.x, menu.y, [], {
    top: menu.y,
    bottom: menu.y,
    left: menu.x
  })
  // Snapshot the selected text at mount — the menu preserves the live
  // selection (mousedown is prevented), so this is stable while it's open.
  const [selText] = useState(() => window.getSelection()?.toString() ?? '')
  /** Word count expands on demand instead of tailing every menu */
  const [showCount, setShowCount] = useState(false)

  return (
    <div
      className="selection-menu"
      ref={ref}
      style={style}
      onMouseDown={(e) => {
        // Keep the text selection alive while interacting with the menu
        e.preventDefault()
        e.stopPropagation()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Every other row of this menu is a target, so the drag needs its own
          strip rather than "anywhere on the chrome" — grabbing a colour dot to
          move the menu would mark the text instead. */}
      <span className="menu-grip" title={t('menu.dragTip')} {...handleProps} />
      {isSelection && (
        <>
          <div className="menu-color-group">
            <span className="menu-row-label" title={t('menu.marker')}>
              <IconMarkupHighlight size={19} />
            </span>
            <MarkupColorRow
              palette={HIGHLIGHT_COLORS}
              swatch="dot"
              tipKey="menu.markerTip"
              onPick={(color) => onAction({ kind: 'highlight', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label" title={t('menu.underline')}>
              <IconMarkupUnderline size={19} />
            </span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.underlineTip"
              onPick={(color) => onAction({ kind: 'underline', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label" title={t('menu.strikeout')}>
              <IconMarkupStrikeout size={19} />
            </span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.strikeoutTip"
              onPick={(color) => onAction({ kind: 'strikeout', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label" title={t('menu.squiggly')}>
              <IconMarkupSquiggly size={19} />
            </span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.squigglyTip"
              onPick={(color) => onAction({ kind: 'squiggly', color })}
            />
          </div>
          <div className="menu-sep" />
          {/* Comment = highlight bound to the text with the note prompt up
              front; Notat stays the free-floating sticky */}
          <button className="menu-item" onClick={() => onAction({ kind: 'comment' })}>
            <span className="menu-icon"><IconComment size={15} /></span> {t('menu.comment')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'note' })}>
            <span className="menu-icon"><IconNote size={15} /></span> {t('menu.note')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'copy' })}>
            <span className="menu-icon"><IconCopy size={15} /></span> {t('menu.copy')}
          </button>
          <div className="menu-sep" />
          <div className="menu-section-label">
            <IconSparkle size={11} />
            {t('menu.aiSection')}
          </div>
          {/* All assistant actions are siblings of one gesture ("ask the
              assistant about this selection") — one uniform chip grid, where
              «Spør …» opens the popover with a free-form question box */}
          <div className="menu-ai-grid">
            <button
              className="menu-ai-chip"
              title={t('menu.aiExplainTip')}
              onClick={() => onAction({ kind: 'ai', mode: 'explain' })}
            >
              {t('menu.aiExplain')}
            </button>
            <button
              className="menu-ai-chip"
              title={t('menu.aiSimplifyTip')}
              onClick={() => onAction({ kind: 'ai', mode: 'simplify' })}
            >
              {t('menu.aiSimplify')}
            </button>
            <button
              className="menu-ai-chip"
              title={t('menu.aiCritiqueTip')}
              onClick={() => onAction({ kind: 'critique' })}
            >
              {t('menu.aiCritique')}
            </button>
            <button
              className="menu-ai-chip"
              title={t('menu.aiReferenceTip')}
              onClick={() => onAction({ kind: 'reference' })}
            >
              {t('menu.aiReference')}
            </button>
            <button
              className="menu-ai-chip menu-ai-chip-wide"
              title={t('menu.aiAskTip')}
              onClick={() => onAction({ kind: 'ask' })}
            >
              {t('menu.aiAsk')}
            </button>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => onAction({ kind: 'search' })}>
            <span className="menu-icon"><IconGlobe size={15} /></span> {t('menu.webSearch')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'dictionary' })}>
            <span className="menu-icon"><IconBook size={15} /></span> {t('menu.dictionary')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'translate' })}>
            <span className="menu-icon"><IconTranslate size={15} /></span> {t('menu.translate')}
          </button>
          <button className="menu-item" onClick={() => setShowCount((v) => !v)}>
            <span className="menu-icon"><IconTally size={15} /></span> {t('menu.count')}
          </button>
          {showCount && <SelectionCount text={selText} />}
        </>
      )}
      {!isSelection && (
        <>
          <button className="menu-item" onClick={() => onAction({ kind: 'note' })}>
            <span className="menu-icon"><IconNote size={15} /></span> {t('menu.newNoteHere')}
          </button>
          <button className="menu-item" title={t('menu.snipTip')} onClick={() => onAction({ kind: 'snip' })}>
            <span className="menu-icon"><IconSparkle size={15} /></span> {t('menu.snip')}
          </button>
        </>
      )}
    </div>
  )
}

interface NoteProps {
  x: number
  y: number
  /** Markup rect (viewport coords) to open clear of, so it stays readable.
   *  Forwarded from an optional field on the note draft — see AnnotPopover. */
  avoid?: { top: number; bottom: number; left: number } | null | undefined
  onSave(text: string): void
  onCancel(): void
}

export function NotePopover({ x, y, avoid, onSave, onCancel }: NoteProps): React.JSX.Element {
  useLang()
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Opens clear of the markup (below/above it) so the marked text stays
  // readable; draggable from its chrome (the textarea keeps its own pointer).
  const { ref, style, positioned, handleProps } = useDraggable(x, y + 10, [], avoid)
  // A NEW note always opens at the default shape, so the default never gets
  // lost behind a drag — hence local state, which dies with the draft. (The
  // comment popover on an EXISTING annotation remembers its size; see
  // AnnotPopover + bubbleSizes in PdfViewer.)
  const [size, setSize] = useState<BoxSize | null>(null)
  const { gripProps, style: sizeStyle } = useResizable(ref, size, setSize, {
    axis: 'both',
    minW: 224,
    // Floor = a usable text field plus the Avbryt/Lagre row
    minH: 152
  })

  // Focus once the box is measured and visible — focusing while still
  // `visibility: hidden` (pre-measure) is a no-op.
  const focusedRef = useRef(false)
  useEffect(() => {
    if (positioned && !focusedRef.current) {
      focusedRef.current = true
      taRef.current?.focus()
    }
  }, [positioned])

  return (
    <div
      className="note-popover"
      ref={ref}
      style={{ ...style, ...sizeStyle }}
      onMouseDown={(e) => e.stopPropagation()}
      {...handleProps}
    >
      <textarea
        ref={taRef}
        value={text}
        placeholder={t('menu.notePlaceholder')}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text.trim())
          if (e.key === 'Escape') onCancel()
          e.stopPropagation()
        }}
      />
      <div className="note-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn-secondary" onClick={onCancel}>
          {t('app.cancel')}
        </button>
        <button className="btn-primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          {t('app.save')}
        </button>
      </div>

      <span className="box-grip" title={t('bubble.resizeTip')} {...gripProps} />
    </div>
  )
}

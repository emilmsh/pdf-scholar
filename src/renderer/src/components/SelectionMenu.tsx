import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

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
  | { kind: 'similar' }
  | { kind: 'snip' }

interface MenuProps {
  menu: MenuState
  onAction(action: MenuAction): void
}

function clampToViewport(x: number, y: number, w: number, h: number): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y + 10, window.innerHeight - h - 8))
  }
}

/** Position a fixed popup at its anchor, measured after render: clamp
 *  horizontally, flip above the anchor when it would overflow the bottom. */
function useMeasuredPosition(
  x: number,
  y: number
): { ref: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
    let top = y + 10
    if (top + height > window.innerHeight - 8) top = y - height - 10
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
    setPos({ left, top })
  }, [x, y])
  return {
    ref,
    // Render invisibly at the anchor until measured — prevents a flicker jump
    style: pos ?? { left: x, top: y, visibility: 'hidden' }
  }
}

export function SelectionMenu({ menu, onAction }: MenuProps): React.JSX.Element {
  useLang()
  const isSelection = menu.mode === 'selection'
  const { ref, style } = useMeasuredPosition(menu.x, menu.y)
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
              className="menu-ai-chip"
              title={t('menu.aiSimilarTip')}
              onClick={() => onAction({ kind: 'similar' })}
            >
              {t('menu.aiSimilar')}
            </button>
            <button
              className="menu-ai-chip"
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
  onSave(text: string): void
  onCancel(): void
}

export function NotePopover({ x, y, onSave, onCancel }: NoteProps): React.JSX.Element {
  useLang()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { left, top } = clampToViewport(x, y, 280, 160)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div className="note-popover" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        placeholder={t('menu.notePlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text.trim())
          if (e.key === 'Escape') onCancel()
          e.stopPropagation()
        }}
      />
      <div className="note-actions">
        <button className="btn-secondary" onClick={onCancel}>
          {t('app.cancel')}
        </button>
        <button className="btn-primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          {t('app.save')}
        </button>
      </div>
    </div>
  )
}

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
import { IconBook, IconCopy, IconGlobe, IconNote, IconSparkle, IconTranslate } from './icons'

/** Palette dots/bars + last-used custom colors + a native color-wheel pick */
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
      <label className="color-plus" title={t('menu.customColor')}>
        +
        <input
          type="color"
          onChange={(e) => {
            const hex = e.target.value
            addCustomColor(hex)
            setCustoms(loadCustomColors())
            onPick({ key: 'custom', hex, rgb: hexToRgb(hex) })
          }}
        />
      </label>
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

export type MenuAction =
  | { kind: 'highlight'; color: HighlightColor }
  | { kind: 'underline'; color: HighlightColor }
  | { kind: 'strikeout'; color: HighlightColor }
  | { kind: 'squiggly'; color: HighlightColor }
  | { kind: 'note' }
  | { kind: 'copy' }
  | { kind: 'search' }
  | { kind: 'dictionary' }
  | { kind: 'translate' }
  | { kind: 'ai'; mode: 'explain' | 'simplify' | 'define' }

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
            <span className="menu-row-label">{t('menu.marker')}</span>
            <MarkupColorRow
              palette={HIGHLIGHT_COLORS}
              swatch="dot"
              tipKey="menu.markerTip"
              onPick={(color) => onAction({ kind: 'highlight', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label">{t('menu.underline')}</span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.underlineTip"
              onPick={(color) => onAction({ kind: 'underline', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label">{t('menu.strikeout')}</span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.strikeoutTip"
              onPick={(color) => onAction({ kind: 'strikeout', color })}
            />
          </div>
          <div className="menu-color-group">
            <span className="menu-row-label">{t('menu.squiggly')}</span>
            <MarkupColorRow
              palette={UNDERLINE_COLORS}
              swatch="bar"
              tipKey="menu.squigglyTip"
              onPick={(color) => onAction({ kind: 'squiggly', color })}
            />
          </div>
          <div className="menu-sep" />
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
          <button className="menu-item" onClick={() => onAction({ kind: 'ai', mode: 'explain' })}>
            {t('menu.aiExplain')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'ai', mode: 'simplify' })}>
            {t('menu.aiSimplify')}
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'ai', mode: 'define' })}>
            {t('menu.aiDefine')}
          </button>
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
        </>
      )}
      {!isSelection && (
        <button className="menu-item" onClick={() => onAction({ kind: 'note' })}>
          <span className="menu-icon"><IconNote size={15} /></span> {t('menu.newNoteHere')}
        </button>
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

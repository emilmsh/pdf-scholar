import { useEffect, useRef, useState } from 'react'
import { HIGHLIGHT_COLORS } from '../annotations'
import type { HighlightColor } from '../annotations'

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
  | { kind: 'underline' }
  | { kind: 'strikeout' }
  | { kind: 'note' }
  | { kind: 'copy' }
  | { kind: 'search' }
  | { kind: 'dictionary' }
  | { kind: 'translate' }

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

export function SelectionMenu({ menu, onAction }: MenuProps): React.JSX.Element {
  const isSelection = menu.mode === 'selection'
  const { left, top } = clampToViewport(menu.x, menu.y, 240, isSelection ? 260 : 60)

  return (
    <div
      className="selection-menu"
      style={{ left, top }}
      onMouseDown={(e) => {
        // Keep the text selection alive while interacting with the menu
        e.preventDefault()
        e.stopPropagation()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isSelection && (
        <>
          <div className="color-row">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.hex}
                className="color-dot"
                style={{ background: c.hex }}
                title={`Marker (${c.name.toLowerCase()})`}
                onClick={() => onAction({ kind: 'highlight', color: c })}
              />
            ))}
          </div>
          <button className="menu-item" onClick={() => onAction({ kind: 'underline' })}>
            <span className="menu-glyph menu-glyph-underline">U</span> Understrek
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'strikeout' })}>
            <span className="menu-glyph menu-glyph-strikeout">S</span> Gjennomstrek
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'note' })}>
            <span className="menu-glyph">✎</span> Notat
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => onAction({ kind: 'copy' })}>
            Kopier
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => onAction({ kind: 'search' })}>
            Søk på nettet
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'dictionary' })}>
            Slå opp i ordbok
          </button>
          <button className="menu-item" onClick={() => onAction({ kind: 'translate' })}>
            Oversett
          </button>
        </>
      )}
      {!isSelection && (
        <button className="menu-item" onClick={() => onAction({ kind: 'note' })}>
          <span className="menu-glyph">✎</span> Nytt notat her
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
        placeholder="Skriv et notat …"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text.trim())
          if (e.key === 'Escape') onCancel()
          e.stopPropagation()
        }}
      />
      <div className="note-actions">
        <button className="btn-secondary" onClick={onCancel}>
          Avbryt
        </button>
        <button className="btn-primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          Lagre
        </button>
      </div>
    </div>
  )
}

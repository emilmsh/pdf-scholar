import { useState } from 'react'
import { ANNOT_TYPE_LABELS, HIGHLIGHT_COLORS } from '../annotations'
import type { PageAnnotation } from '../annotations'

interface Props {
  x: number
  y: number
  annotation: PageAnnotation
  onColor(color: [number, number, number]): void
  onContents(text: string): void
  onDelete(): void
}

export default function AnnotPopover({
  x,
  y,
  annotation,
  onColor,
  onContents,
  onDelete
}: Props): React.JSX.Element {
  const [text, setText] = useState(annotation.contents ?? '')
  const left = Math.max(8, Math.min(x, window.innerWidth - 264))
  const top = Math.max(8, Math.min(y + 10, window.innerHeight - 240))

  return (
    <div
      className="annot-popover"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="annot-popover-head">
        <span>{ANNOT_TYPE_LABELS[annotation.type]}</span>
        {annotation.author && <span className="annot-popover-author">{annotation.author}</span>}
      </div>

      <div className="color-row">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.hex}
            className="color-dot"
            style={{ background: c.hex }}
            title={c.name}
            onClick={() => onColor(c.rgb)}
          />
        ))}
      </div>

      <textarea
        className="annot-popover-text"
        value={text}
        placeholder={annotation.type === 'note' ? 'Notattekst …' : 'Legg til kommentar …'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== (annotation.contents ?? '')) onContents(text.trim())
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />

      <div className="annot-popover-actions">
        <button className="annot-delete" onClick={onDelete}>
          Slett
        </button>
      </div>
    </div>
  )
}

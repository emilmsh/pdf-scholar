// The remembered colour-wheel picks as swatches — shared by every palette that
// shows them: the selection menu's markup rows, the recolour popover and the
// toolbar's marker and markup menus (issue #50: a colour picked in the menu
// used to be usable from the menu alone, never with the marker tool).
import { useEffect, useState } from 'react'
import { CUSTOM_COLORS_EVENT, loadCustomColors, removeCustomColor } from '../annotations'
import type { HighlightColor } from '../annotations'
import { t } from '../i18n'

/** The remembered picks, following every change made anywhere in the window
 *  (the four rows of one menu, the toolbar behind it — each has its own copy,
 *  so a colour forgotten in one place must go from all of them) */
export function useCustomColors(): HighlightColor[] {
  const [customs, setCustoms] = useState<HighlightColor[]>(loadCustomColors)
  useEffect(() => {
    const refresh = (): void => setCustoms(loadCustomColors())
    window.addEventListener(CUSTOM_COLORS_EVENT, refresh)
    return () => window.removeEventListener(CUSTOM_COLORS_EVENT, refresh)
  }, [])
  return customs
}

/** The palette, then the remembered picks that are not already in it */
export function withCustomColors(palette: HighlightColor[], customs: HighlightColor[]): HighlightColor[] {
  return [...palette, ...customs.filter((c) => !palette.some((p) => p.hex === c.hex))]
}

/** A remembered swatch can be forgotten: a × at its shoulder, shown on hover
 *  — and, since a finger has no hover, armed by a long-press, which Chromium
 *  reports as contextmenu (the right-click the issue asked for). The three
 *  slots were a one-way queue before; the only way out of a wrong pick was
 *  «Tilbakestill innstillinger». */
export function CustomSwatch({ hex, children }: { hex: string; children: React.ReactNode }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  return (
    <span
      className={`color-custom${armed ? ' armed' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setArmed(true)
      }}
    >
      {children}
      <button
        className="color-forget"
        title={t('menu.forgetColor')}
        aria-label={t('menu.forgetColor')}
        onClick={(e) => {
          e.stopPropagation()
          removeCustomColor(hex)
        }}
      >
        ×
      </button>
    </span>
  )
}

/** Each colour as `render` draws it (the swatch must carry `key={c.hex}`),
 *  a remembered one wrapped so it can be forgotten */
export function renderSwatches(
  colors: HighlightColor[],
  render: (c: HighlightColor) => React.JSX.Element
): React.JSX.Element[] {
  return colors.map((c) =>
    c.key === 'custom' ? (
      <CustomSwatch key={c.hex} hex={c.hex}>
        {render(c)}
      </CustomSwatch>
    ) : (
      render(c)
    )
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { isElectron } from '../bridge'
import { useDismissable } from '../useDismissable'

/**
 * The right-click menu for TEXT everywhere the app has no menu of its own.
 *
 * Electron ships no context menu at all: a right-click that nobody handles does
 * nothing. The pages, the tab strip and the sidebar document header build their
 * own menus, and every other surface — the assistant's answers, the settings,
 * the library, a comment's textarea — was dead on right-click, so the text
 * there could be selected but never copied the way a Windows user copies
 * anything (Emil, 2026-09-08). This is the fallback for all of it.
 *
 * Electron only: in a plain browser and in the extension the browser's own menu
 * is already there, knows more (search, inspect, spell-check) and is what the
 * reader expects — and this menu also does not appear inside the surfaces that
 * preventDefault their own contextmenu, which is how those keep their menus.
 *
 * The clipboard is driven through execCommand on the LIVE selection where it
 * can be: the menu prevents mousedown so the selection (or the caret in a text
 * field) survives the click, exactly as the selection menu on the pages does.
 */

type Field = HTMLInputElement | HTMLTextAreaElement

interface MenuState {
  x: number
  y: number
  /** The text field under the pointer, when the click landed in one */
  field: Field | null
  /** The editable host (field or contenteditable) — cut/paste are offered here */
  editable: HTMLElement | null
  /** Whether anything is selected right now */
  hasSelection: boolean
  /** Where «Marker alt» selects: the field, or the text block under the pointer */
  scope: HTMLElement
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

/** The text block «Marker alt» should take — the whole assistant answer when the
 *  click is inside one, otherwise the nearest paragraph-sized ancestor. */
const BLOCK_SELECTOR =
  '.ai-msg, p, li, td, th, dd, dt, pre, blockquote, h1, h2, h3, h4, [role="listitem"], [role="dialog"], section, article'

/** Is this event target a place where text is TYPED? The surfaces that own
 *  their right-click (the pages, the note popover, the selection menu) ask this
 *  before claiming the event, so a comment's textarea gets THIS menu — paste
 *  included — and not a page menu with nothing to paste into. */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return fieldOf(target) !== null || target.closest('[contenteditable=""], [contenteditable="true"]') !== null
}

function fieldOf(el: Element | null): Field | null {
  if (!el) return null
  const host = el.closest('input, textarea')
  if (host instanceof HTMLTextAreaElement) return host
  if (host instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(host.type || 'text')) return host
  return null
}

function selectedText(field: Field | null): string {
  if (field) {
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? 0
    return field.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ''
}

/** Is there any text at all where the click landed? A right-click on an icon
 *  button or an empty stretch of chrome gets no menu — there is nothing to copy
 *  and «Marker alt» would select the toolbar. */
function hasTextAround(target: Element, scope: HTMLElement): boolean {
  if (target.closest('button, [role="button"], a, svg, canvas, input[type="range"], input[type="checkbox"]')) {
    return false
  }
  return (scope.textContent ?? '').trim().length > 0
}

export function TextContextMenu(): React.JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setMenu(null), [])
  useDismissable(ref, menu !== null, close)

  useEffect(() => {
    if (!isElectron) return
    const onContextMenu = (e: MouseEvent): void => {
      // A surface with a menu of its own has already said so
      if (e.defaultPrevented) return
      const target = e.target instanceof Element ? e.target : null
      if (!target) return
      const field = fieldOf(target)
      const editable = field ?? (target.closest('[contenteditable=""], [contenteditable="true"]') as HTMLElement | null)
      const scope = editable ?? (target.closest(BLOCK_SELECTOR) as HTMLElement | null) ?? (target as HTMLElement)
      const hasSelection = selectedText(field).length > 0
      if (!editable && !hasSelection && !hasTextAround(target, scope)) return
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, field, editable, hasSelection, scope })
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // Keep the menu on screen; it is measured after the first paint
  useEffect(() => {
    const el = ref.current
    if (!el || !menu) return
    const r = el.getBoundingClientRect()
    const dx = Math.max(0, r.right - window.innerWidth + 8)
    const dy = Math.max(0, r.bottom - window.innerHeight + 8)
    if (dx || dy) el.style.transform = `translate(${-dx}px, ${-dy}px)`
  }, [menu])

  if (!menu) return null

  const copy = (): void => {
    const text = selectedText(menu.field)
    // execCommand copies the live selection (rich text included); the snapshot
    // is the net for the rare case the selection collapsed under the click.
    if (!document.execCommand('copy') && text) void navigator.clipboard?.writeText(text).catch(() => {})
    close()
  }
  const cut = (): void => {
    document.execCommand('cut')
    close()
  }
  const paste = async (): Promise<void> => {
    close()
    const host = menu.editable
    if (!host) return
    host.focus()
    try {
      const text = await navigator.clipboard.readText()
      if (text) document.execCommand('insertText', false, text)
    } catch {
      /* clipboard denied or empty — nothing to insert */
    }
  }
  const selectAll = (): void => {
    if (menu.field) {
      menu.field.focus()
      menu.field.select()
    } else {
      const range = document.createRange()
      range.selectNodeContents(menu.scope)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    close()
  }

  return (
    <div
      className="text-menu"
      role="menu"
      ref={ref}
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => {
        // Keep the selection (and the field's caret) alive under the click
        e.preventDefault()
        e.stopPropagation()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.editable && (
        <button className="menu-item" role="menuitem" disabled={!menu.hasSelection} onClick={cut}>
          {t('menu.cut')}
        </button>
      )}
      <button className="menu-item" role="menuitem" disabled={!menu.hasSelection} onClick={copy}>
        {t('menu.copy')}
      </button>
      {menu.editable && (
        <button className="menu-item" role="menuitem" onClick={() => void paste()}>
          {t('menu.paste')}
        </button>
      )}
      <div className="menu-sep" />
      <button className="menu-item" role="menuitem" onClick={selectAll}>
        {t('menu.selectAll')}
      </button>
    </div>
  )
}

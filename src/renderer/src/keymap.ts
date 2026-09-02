// The keyboard map: every command the keyboard can reach, what it is bound to,
// and the machinery to rebind it.
//
// Before this file the shortcuts were a chain of `e.key === 'x'` branches in
// App.tsx and PdfViewer.tsx. That works right up until you want to SHOW the
// user what the keyboard does — the list existed only as control flow, three
// tooltips repeated parts of it by hand, and nothing could be rebound. The
// registry below is now the single source of truth: the handlers resolve an
// event to a command id through it, the shortcuts dialog renders it, and the
// tooltips read their key names out of it.
//
// A command may hold SEVERAL chords (redo is Ctrl+Shift+Z and Ctrl+Y; rotate
// right is Shift+R and ]), so a binding is an ordered list, not one string.
//
// Chord syntax: modifiers then key, lowercase, joined by '+'.
//   'mod+s'         Ctrl+S on Windows/Linux, Cmd+S on macOS
//   'ctrl+tab'      literal Ctrl on every platform (Cmd+Tab is the OS switcher)
//   'alt+arrowleft' 'shift+f3'  'f11'  ']'  'p'
// 'mod' is stored rather than resolved so a keymap means the same thing on
// either platform — the same reason platform.ts exists.
import { isMac } from './platform'
import { READ_ALOUD } from './flags'
import type { MsgKey } from './i18n'

/** Command ids are the stable keys a stored keymap is written against — they
 *  outlive labels and defaults, so renaming one silently drops the user's
 *  binding. Treat them as a persisted format. */
export type CommandId =
  // File
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.print'
  | 'window.new'
  // Tabs
  | 'tab.next'
  | 'tab.prev'
  | 'tab.close'
  | 'tab.moveLeft'
  | 'tab.moveRight'
  // Navigation
  | 'nav.back'
  | 'nav.forward'
  | 'nav.prevPage'
  | 'nav.nextPage'
  | 'nav.gotoPage'
  | 'doc.bookmark'
  // View
  | 'view.fullscreen'
  | 'view.present'
  | 'view.rotateRight'
  | 'view.rotateLeft'
  | 'view.spread'
  | 'view.coverPage'
  | 'view.split'
  | 'view.marginNotes'
  | 'view.togglePin'
  | 'view.cycleTheme'
  | 'view.readAloud'
  // Zoom
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.actual'
  | 'zoom.fitToggle'
  | 'zoom.fitWidth'
  | 'zoom.fitPage'
  // Panels
  | 'panel.toc'
  | 'panel.ai'
  // Search
  | 'search.open'
  | 'search.next'
  | 'search.prev'
  // Editing
  | 'edit.undo'
  | 'edit.redo'
  | 'annot.delete'
  | 'annot.toggleHidden'
  // Tools
  | 'tool.highlight'
  | 'tool.underline'
  | 'tool.strikeout'
  | 'tool.squiggly'
  | 'tool.pen'
  | 'tool.marker'
  | 'tool.eraser'
  | 'tool.text'
  | 'tool.note'
  | 'tool.square'
  | 'tool.circle'
  | 'tool.line'
  | 'tool.arrow'
  | 'tool.signature'
  | 'tool.snip'

export type CategoryId =
  | 'file'
  | 'tabs'
  | 'nav'
  | 'view'
  | 'zoom'
  | 'panels'
  | 'search'
  | 'edit'
  | 'tools'

export interface Command {
  id: CommandId
  category: CategoryId
  labelKey: MsgKey
  /** Shipped bindings. Empty = the command is reachable by mouse only until the
   *  user gives it a key, which is the other half of what the map is for. */
  defaults: readonly string[]
  /** May fire while the caret is in a text field — for commands that mean the
   *  same thing mid-typing (save, find, zoom, full screen). Even then a chord
   *  that would otherwise TYPE a character is still swallowed, so a rebind can
   *  never turn a letter into an action while the reader is writing a note.
   *  Undo is deliberately false: a textarea owns its own Ctrl+Z. */
  whileTyping?: boolean
  /** Hidden unless the feature flag is on (read-aloud, see flags.ts) */
  flagged?: boolean
}

export const CATEGORY_LABELS: Record<CategoryId, MsgKey> = {
  file: 'keys.catFile',
  tabs: 'keys.catTabs',
  nav: 'keys.catNav',
  view: 'keys.catView',
  zoom: 'keys.catZoom',
  panels: 'keys.catPanels',
  search: 'keys.catSearch',
  edit: 'keys.catEdit',
  tools: 'keys.catTools'
}

export const CATEGORY_ORDER: readonly CategoryId[] = [
  'file',
  'tabs',
  'nav',
  'view',
  'zoom',
  'panels',
  'search',
  'edit',
  'tools'
]

/** The registry. Defaults reproduce exactly what the app shipped with — every
 *  one of them was a hardcoded branch before, and a reader who learned it must
 *  not have to relearn it because the list moved house. */
const REGISTRY: readonly Command[] = [
  // ---------- File ----------
  { id: 'file.open', category: 'file', labelKey: 'keys.fileOpen', defaults: ['mod+o'], whileTyping: true },
  { id: 'file.save', category: 'file', labelKey: 'keys.fileSave', defaults: ['mod+s'], whileTyping: true },
  // Both were shipped unbound, which the keyboard map made visible the moment
  // it was photographed (Emil, 2026-08-09). The fourteen TOOL commands below
  // are unbound on purpose — which letter a tool deserves is the reader's call
  // — but these two are file commands with a convention every app on the
  // platform already follows, and print had just lost its toolbar icon to the
  // Save menu. Leaving it reachable only by two clicks was not the trade the
  // move was meant to make.
  { id: 'file.saveAs', category: 'file', labelKey: 'keys.fileSaveAs', defaults: ['mod+shift+s'] },
  { id: 'file.print', category: 'file', labelKey: 'keys.filePrint', defaults: ['mod+p'] },
  { id: 'window.new', category: 'file', labelKey: 'keys.windowNew', defaults: ['mod+shift+n'], whileTyping: true },

  // ---------- Tabs ----------
  // Ctrl (not mod) on purpose: Cmd+Tab is the macOS app switcher, so tab
  // cycling is Ctrl+Tab on every platform.
  { id: 'tab.next', category: 'tabs', labelKey: 'keys.tabNext', defaults: ['ctrl+tab'], whileTyping: true },
  { id: 'tab.prev', category: 'tabs', labelKey: 'keys.tabPrev', defaults: ['ctrl+shift+tab'], whileTyping: true },
  { id: 'tab.close', category: 'tabs', labelKey: 'keys.tabClose', defaults: ['mod+w'], whileTyping: true },
  { id: 'tab.moveLeft', category: 'tabs', labelKey: 'keys.tabMoveLeft', defaults: ['mod+shift+pageup'], whileTyping: true },
  { id: 'tab.moveRight', category: 'tabs', labelKey: 'keys.tabMoveRight', defaults: ['mod+shift+pagedown'], whileTyping: true },

  // ---------- Navigation ----------
  { id: 'nav.back', category: 'nav', labelKey: 'keys.navBack', defaults: ['alt+arrowleft'] },
  { id: 'nav.forward', category: 'nav', labelKey: 'keys.navForward', defaults: ['alt+arrowright'] },
  // Book-style page turns (Karl Whelan's ask, 2026-09-02): with a fit zoom this
  // reads as a full-page view without ever leaving continuous scroll. Bare ←/→
  // was doing nothing vertically, so the keys were free — and unbinding the
  // pair hands them back to the browser's native horizontal panning.
  { id: 'nav.prevPage', category: 'nav', labelKey: 'keys.navPrevPage', defaults: ['arrowleft'] },
  { id: 'nav.nextPage', category: 'nav', labelKey: 'keys.navNextPage', defaults: ['arrowright'] },
  // Owned by the toolbar, not the viewer: the command focuses the page field, so
  // it lives where that field lives. whileTyping, because a caret already parked
  // in some other field is exactly when you want to jump to the page box.
  { id: 'nav.gotoPage', category: 'nav', labelKey: 'keys.navGotoPage', defaults: ['mod+g'], whileTyping: true },
  { id: 'doc.bookmark', category: 'nav', labelKey: 'keys.docBookmark', defaults: ['b'] },

  // ---------- View ----------
  { id: 'view.fullscreen', category: 'view', labelKey: 'keys.viewFullscreen', defaults: ['f11', 'f'], whileTyping: true },
  { id: 'view.present', category: 'view', labelKey: 'keys.viewPresent', defaults: ['p'] },
  { id: 'view.rotateRight', category: 'view', labelKey: 'keys.viewRotateRight', defaults: ['shift+r', ']'] },
  { id: 'view.rotateLeft', category: 'view', labelKey: 'keys.viewRotateLeft', defaults: ['['] },
  { id: 'view.spread', category: 'view', labelKey: 'keys.viewSpread', defaults: [] },
  { id: 'view.coverPage', category: 'view', labelKey: 'keys.viewCoverPage', defaults: [] },
  { id: 'view.split', category: 'view', labelKey: 'keys.viewSplit', defaults: ['s'] },
  // Unbound as shipped, like the tools: the margin view arrived after the
  // reading letters were spoken for, and 'm' is the kind of key a reader should
  // get to spend themselves.
  { id: 'view.marginNotes', category: 'view', labelKey: 'keys.viewMarginNotes', defaults: [] },
  { id: 'view.togglePin', category: 'view', labelKey: 'keys.viewTogglePin', defaults: ['v'] },
  // Cycles day→sepia→night→night+ (a reader-feature ask, 2026-09-02). 'd' was
  // free and reads as dag/dark in both languages; handled in App.tsx's shell
  // switch because the theme must flip with no document open too.
  { id: 'view.cycleTheme', category: 'view', labelKey: 'keys.viewCycleTheme', defaults: ['d'] },
  { id: 'view.readAloud', category: 'view', labelKey: 'keys.viewReadAloud', defaults: ['r'], flagged: true },

  // ---------- Zoom ----------
  // Two chords for zoom in because '+' is unshifted on a Norwegian layout and
  // Shift+= on a US one — both reach the same key cap.
  { id: 'zoom.in', category: 'zoom', labelKey: 'keys.zoomIn', defaults: ['mod++', 'mod+='], whileTyping: true },
  { id: 'zoom.out', category: 'zoom', labelKey: 'keys.zoomOut', defaults: ['mod+-'], whileTyping: true },
  { id: 'zoom.actual', category: 'zoom', labelKey: 'keys.zoomActual', defaults: ['mod+0'], whileTyping: true },
  { id: 'zoom.fitToggle', category: 'zoom', labelKey: 'keys.zoomFitToggle', defaults: ['w'] },
  { id: 'zoom.fitWidth', category: 'zoom', labelKey: 'keys.zoomFitWidth', defaults: [] },
  { id: 'zoom.fitPage', category: 'zoom', labelKey: 'keys.zoomFitPage', defaults: [] },

  // ---------- Panels ----------
  { id: 'panel.toc', category: 'panels', labelKey: 'keys.panelToc', defaults: ['t'] },
  { id: 'panel.ai', category: 'panels', labelKey: 'keys.panelAi', defaults: ['a'] },

  // ---------- Search ----------
  { id: 'search.open', category: 'search', labelKey: 'keys.searchOpen', defaults: ['mod+f'], whileTyping: true },
  { id: 'search.next', category: 'search', labelKey: 'keys.searchNext', defaults: ['f3'], whileTyping: true },
  { id: 'search.prev', category: 'search', labelKey: 'keys.searchPrev', defaults: ['shift+f3'], whileTyping: true },

  // ---------- Editing ----------
  { id: 'edit.undo', category: 'edit', labelKey: 'keys.editUndo', defaults: ['mod+z'] },
  // Ctrl+Y first because that is the one the toolbar tooltip advertises (and
  // shortcutLabel takes the first) — Ctrl+Shift+Z is the alternative spelling.
  { id: 'edit.redo', category: 'edit', labelKey: 'keys.editRedo', defaults: ['mod+y', 'mod+shift+z'] },
  { id: 'annot.delete', category: 'edit', labelKey: 'keys.annotDelete', defaults: ['delete', 'backspace'] },
  { id: 'annot.toggleHidden', category: 'edit', labelKey: 'keys.annotToggleHidden', defaults: ['h'] },

  // ---------- Tools ----------
  // All unbound as shipped: thirteen letters spent on tools would collide with
  // the reading keys, and which tool deserves a key is exactly the choice this
  // map hands to the reader.
  { id: 'tool.highlight', category: 'tools', labelKey: 'keys.toolHighlight', defaults: [] },
  { id: 'tool.underline', category: 'tools', labelKey: 'keys.toolUnderline', defaults: [] },
  { id: 'tool.strikeout', category: 'tools', labelKey: 'keys.toolStrikeout', defaults: [] },
  { id: 'tool.squiggly', category: 'tools', labelKey: 'keys.toolSquiggly', defaults: [] },
  { id: 'tool.pen', category: 'tools', labelKey: 'keys.toolPen', defaults: [] },
  { id: 'tool.marker', category: 'tools', labelKey: 'keys.toolMarker', defaults: [] },
  { id: 'tool.eraser', category: 'tools', labelKey: 'keys.toolEraser', defaults: [] },
  { id: 'tool.text', category: 'tools', labelKey: 'keys.toolText', defaults: [] },
  { id: 'tool.note', category: 'tools', labelKey: 'keys.toolNote', defaults: [] },
  { id: 'tool.square', category: 'tools', labelKey: 'keys.toolSquare', defaults: [] },
  { id: 'tool.circle', category: 'tools', labelKey: 'keys.toolCircle', defaults: [] },
  { id: 'tool.line', category: 'tools', labelKey: 'keys.toolLine', defaults: [] },
  { id: 'tool.arrow', category: 'tools', labelKey: 'keys.toolArrow', defaults: [] },
  // Shipped in v0.35.0, after this registry was written — and a map that calls
  // itself "every command the keyboard can reach" cannot be one tool short.
  { id: 'tool.signature', category: 'tools', labelKey: 'keys.toolSignature', defaults: [] },
  { id: 'tool.snip', category: 'tools', labelKey: 'keys.toolSnip', defaults: [] }
]

/** The commands the map shows and the handlers honour. A flagged command that
 *  is switched off is dropped entirely rather than greyed out — leaving it in
 *  would also reserve its chord ('r') against a feature nobody can reach. */
export const COMMANDS: readonly Command[] = REGISTRY.filter((c) => !c.flagged || READ_ALOUD)

const BY_ID = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]))

export function commandById(id: CommandId): Command | undefined {
  return BY_ID.get(id)
}

/** Keys that a chord may not use on their own. Bare, each one already has a job
 *  the app cannot take away — Escape backs out of everything, Tab moves focus,
 *  Enter presses the focused button, and ↑/↓, Space, Home/End scroll the
 *  document. With a modifier they are all fair game. ←/→ and PageUp/Down are
 *  deliberately NOT here: the page-turn commands ship on bare ←/→, and a
 *  reader who would rather turn pages with PageUp/Down (or reclaim ←/→ for
 *  native horizontal panning) must be able to say so. */
const RESERVED_BARE = new Set([
  'escape',
  'tab',
  'enter',
  'space',
  'arrowup',
  'arrowdown',
  'home',
  'end'
])

/** Keydowns that are only a modifier or a lock being held, plus the dead key a
 *  compose sequence starts with — never a chord on their own. ('os' is the
 *  legacy name some layouts still report for Meta.) */
const MODIFIER_KEYS = new Set([
  'shift',
  'control',
  'alt',
  'meta',
  'altgraph',
  'capslock',
  'numlock',
  'scrolllock',
  'dead',
  'unidentified',
  'os'
])

/** The part of a keydown a chord is made of. Structural rather than
 *  `KeyboardEvent` so React's synthetic event fits too — the text fields that
 *  stop propagation ask this module which keys to let through. */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface Chord {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** Normalised key name: a single lowercase character, or a lowercased named
   *  key ('f11', 'arrowleft', 'pagedown'). */
  key: string
}

function normalizeKey(raw: string): string {
  return raw === ' ' ? 'space' : raw.toLowerCase()
}

/** Parse a stored chord. 'mod' resolves to the platform's primary modifier here,
 *  at the boundary, so everything downstream compares raw modifier flags. */
export function parseChord(chord: string): Chord | null {
  // Split on '+' but keep a literal '+' key: 'mod++' → ['mod', '+']
  const parts: string[] = []
  let buffer = ''
  for (const ch of chord) {
    if (ch === '+' && buffer !== '') {
      parts.push(buffer)
      buffer = ''
    } else if (ch === '+') {
      // '+' where a token was expected is the key itself
      buffer = '+'
    } else {
      buffer += ch
    }
  }
  if (buffer !== '') parts.push(buffer)
  if (parts.length === 0) return null
  const key = normalizeKey(parts[parts.length - 1])
  if (key === '') return null
  const out: Chord = { ctrl: false, meta: false, alt: false, shift: false, key }
  for (const mod of parts.slice(0, -1)) {
    switch (mod.toLowerCase()) {
      case 'mod':
        if (isMac) out.meta = true
        else out.ctrl = true
        break
      case 'ctrl':
        out.ctrl = true
        break
      case 'meta':
      case 'cmd':
        out.meta = true
        break
      case 'alt':
        out.alt = true
        break
      case 'shift':
        out.shift = true
        break
      default:
        return null // an unknown modifier makes the whole chord meaningless
    }
  }
  return out
}

/** Canonical string for a chord, with the platform's primary modifier written
 *  back as 'mod' so a recorded binding stays portable. */
export function serializeChord(c: Chord): string {
  const parts: string[] = []
  // The primary modifier is written as 'mod'; the other one keeps its own name
  // (Ctrl on macOS is a modifier in its own right, and the Windows key exists).
  if (isMac) {
    if (c.meta) parts.push('mod')
    if (c.ctrl) parts.push('ctrl')
  } else {
    if (c.ctrl) parts.push('mod')
    if (c.meta) parts.push('meta')
  }
  if (c.alt) parts.push('alt')
  if (c.shift) parts.push('shift')
  parts.push(c.key)
  return parts.join('+')
}

/** Why a keypress cannot become a binding. null = it can. */
export type RecordRejection = 'modifier-only' | 'reserved'

export interface RecordResult {
  chord: string | null
  rejected: RecordRejection | null
}

/** Turn a keypress into a storable chord, or say why it can't be one. */
export function recordChord(e: KeyboardEvent): RecordResult {
  const key = normalizeKey(e.key)
  if (MODIFIER_KEYS.has(key)) return { chord: null, rejected: 'modifier-only' }
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey
  // Shift alone does not lift a reserved key: Shift+Enter is still Enter's job.
  if (bare && RESERVED_BARE.has(key)) return { chord: null, rejected: 'reserved' }
  return {
    chord: serializeChord({
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      key
    }),
    rejected: null
  }
}

/** Lookup key for the reverse index: raw modifier flags + key, so a stored
 *  'mod+s' and a literal 'ctrl+s' land on the same entry where they mean the
 *  same keypress (Windows/Linux) and different ones where they don't (macOS). */
function indexKey(c: Chord): string {
  return `${c.ctrl ? 'c' : ''}${c.meta ? 'm' : ''}${c.alt ? 'a' : ''}${c.shift ? 's' : ''}|${c.key}`
}

const isLetter = (key: string): boolean => key.length === 1 && key >= 'a' && key <= 'z'

/** Would this key put a character in the field it is pressed in? Function keys,
 *  Escape and the navigation keys would not — which is why F11 can toggle full
 *  screen mid-sentence but a bare 'f' must not. */
const producesText = (key: string): boolean => key.length === 1 || key === 'space'

// ---------------------------------------------------------------------------
// The store. Overrides live in Settings (so they follow the user across the
// three platforms and the gear menu's reset clears them by construction), and
// are mirrored here because the key handlers are not React components and must
// see the current map synchronously.
// ---------------------------------------------------------------------------

/** command id → its chords. An entry REPLACES that command's defaults; an empty
 *  array means the user unbound it. Absent = shipped defaults. */
export type KeymapOverrides = Record<string, string[]>

let overrides: KeymapOverrides = {}
let index = new Map<string, CommandId>()
const listeners = new Set<() => void>()
/** Bumped on every change — the snapshot useSyncExternalStore compares */
let revision = 0

function rebuild(): void {
  index = new Map()
  for (const cmd of COMMANDS) {
    for (const chord of bindingsFor(cmd.id)) {
      const parsed = parseChord(chord)
      if (!parsed) continue
      // First writer wins, so a malformed override cannot shadow a working
      // binding on another command.
      const k = indexKey(parsed)
      if (!index.has(k)) index.set(k, cmd.id)
    }
  }
  revision++
  for (const cb of listeners) cb()
}

/** Replace the whole override set (App pushes Settings.keymap in here). */
export function setKeymapOverrides(next: KeymapOverrides | undefined): void {
  overrides = sanitize(next)
  rebuild()
}

export function getKeymapOverrides(): KeymapOverrides {
  return overrides
}

/** Drop anything a hand-edited or version-skewed state file could contain:
 *  unknown command ids, non-arrays, non-strings, unparseable chords and
 *  duplicates. A broken keymap must degrade to defaults, never to a dead
 *  keyboard. */
function sanitize(raw: KeymapOverrides | undefined): KeymapOverrides {
  if (!raw || typeof raw !== 'object') return {}
  const out: KeymapOverrides = {}
  for (const [id, chords] of Object.entries(raw)) {
    if (!BY_ID.has(id as CommandId) || !Array.isArray(chords)) continue
    const clean: string[] = []
    for (const chord of chords) {
      if (typeof chord !== 'string') continue
      const parsed = parseChord(chord)
      if (!parsed) continue
      const canonical = serializeChord(parsed)
      if (!clean.includes(canonical)) clean.push(canonical)
    }
    out[id] = clean
  }
  return out
}

/** The chords a command actually answers to right now. */
export function bindingsFor(id: CommandId): readonly string[] {
  return overrides[id] ?? BY_ID.get(id)?.defaults ?? []
}

/** True when a command sits exactly on its shipped bindings — drives whether a
 *  per-row reset is offered at all (hidden when there is nothing to undo, the
 *  same rule the tool popovers use). */
export function isDefaultBinding(id: CommandId): boolean {
  const stored = overrides[id]
  if (!stored) return true
  const defaults = BY_ID.get(id)?.defaults ?? []
  return stored.length === defaults.length && stored.every((c, i) => c === defaults[i])
}

/** Any command off its defaults? Drives the dialog's global reset button. */
export function hasCustomBindings(): boolean {
  return COMMANDS.some((c) => !isDefaultBinding(c.id))
}

/** Which command owns a chord, if any. */
export function commandForChord(chord: string): CommandId | null {
  const parsed = parseChord(chord)
  return parsed ? (index.get(indexKey(parsed)) ?? null) : null
}

/** Resolve a keypress to the command it should run.
 *
 *  `typing` (caret in an input/textarea) drops everything except the commands
 *  that opted in with a chord that would not type a character anyway — a bare
 *  letter must never fire while the reader is writing a note, whatever it is
 *  bound to.
 */
export function commandForEvent(e: KeyLike, typing: boolean): CommandId | null {
  const key = normalizeKey(e.key)
  if (MODIFIER_KEYS.has(key)) return null
  const chord: Chord = {
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key
  }
  let id = index.get(indexKey(chord))
  // Shift is what PRODUCED a punctuation character on most layouts (US '+' is
  // Shift+=, '?' is Shift+/), so for non-letter keys the flag is already baked
  // into e.key and must not have to match again — otherwise Ctrl+'+' would miss
  // 'mod++' for every reader whose plus sign is shifted.
  if (id === undefined && chord.shift && !isLetter(key) && key.length === 1) {
    id = index.get(indexKey({ ...chord, shift: false }))
  }
  if (id === undefined) return null
  if (typing) {
    const cmd = BY_ID.get(id)
    if (!cmd?.whileTyping) return null
    const modified = e.ctrlKey || e.metaKey || e.altKey
    if (!modified && producesText(key)) return null
  }
  return id
}

/** True when a keypress must reach the window handler even though the caret is
 *  in a text field that otherwise stops propagation (the composer, the note
 *  popovers, the search field). That is exactly the set of commands marked
 *  `whileTyping`, so asking here rather than testing for Ctrl+F by hand means a
 *  REBOUND find — or save, or zoom — gets through as well. */
export function bubblesWhileTyping(e: KeyLike): boolean {
  return commandForEvent(e, true) !== null
}

// ---------- Mutations (pure: they return the next override set) ----------

export interface AssignOutcome {
  next: KeymapOverrides
  /** The command the chord was taken from, when it had an owner */
  displaced: CommandId | null
}

/** Give `id` another chord. A chord belongs to one command at a time, so it is
 *  removed from its previous owner and the caller is told which — silently
 *  stealing a key is how a keymap editor loses the user's trust. */
export function assignBinding(id: CommandId, chord: string): AssignOutcome {
  const parsed = parseChord(chord)
  if (!parsed) return { next: overrides, displaced: null }
  const canonical = serializeChord(parsed)
  const owner = commandForChord(canonical)
  const next: KeymapOverrides = { ...overrides }
  if (owner && owner !== id) {
    next[owner] = bindingsFor(owner).filter((c) => c !== canonical)
  }
  const mine = bindingsFor(id)
  next[id] = mine.includes(canonical) ? [...mine] : [...mine, canonical]
  return { next, displaced: owner && owner !== id ? owner : null }
}

/** Take one chord away from a command (its other chords stay). */
export function removeBinding(id: CommandId, chord: string): KeymapOverrides {
  return { ...overrides, [id]: bindingsFor(id).filter((c) => c !== chord) }
}

/** Back to shipped defaults for one command. */
export function resetCommand(id: CommandId): KeymapOverrides {
  const next = { ...overrides }
  delete next[id]
  return next
}

/** Back to shipped defaults for everything. */
export function resetAllCommands(): KeymapOverrides {
  return {}
}

/** Subscribe to keymap changes (the dialog and the tooltips re-render on them). */
export function subscribeKeymap(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function keymapRevision(): number {
  return revision
}

// ---------------------------------------------------------------------------
// Keyboard capture. While the map is recording a chord, the app's own handlers
// must stand down — otherwise pressing 't' to bind it would also toggle the
// sidebar behind the dialog. A module-level flag rather than a prop because the
// handlers that need it (App, PdfViewer) are nowhere near the dialog in the
// tree, and this is the same file they already ask about bindings.
// ---------------------------------------------------------------------------

let captured = false

export function setKeyboardCaptured(on: boolean): void {
  captured = on
}

export function isKeyboardCaptured(): boolean {
  return captured
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Printable name per named key. Everything not listed falls back to the key
 *  itself, uppercased (letters, digits, brackets). */
const KEY_LABELS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  space: 'Space',
  enter: '↵',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  insert: 'Ins'
}

function keyLabel(key: string): string {
  const named = KEY_LABELS[key]
  if (named) return named
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase()
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
}

/** A chord as the user should read it: 'Ctrl + Shift + Z', or macOS's glyph
 *  run '⌘⇧Z' (the platform convention — a mac user reads spelled-out modifier
 *  names as a foreign app). */
export function formatChord(chord: string): string {
  const c = parseChord(chord)
  if (!c) return chord
  if (isMac) {
    let out = ''
    if (c.ctrl) out += '⌃'
    if (c.alt) out += '⌥'
    if (c.shift) out += '⇧'
    if (c.meta) out += '⌘'
    return out + keyLabel(c.key)
  }
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.meta) parts.push('Win')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  parts.push(keyLabel(c.key))
  return parts.join('+')
}

/** A command's first binding, formatted, or null when it has none — what the
 *  tooltips splice in so they can never advertise a key the user rebound. */
export function shortcutLabel(id: CommandId): string | null {
  const first = bindingsFor(id)[0]
  return first ? formatChord(first) : null
}

/** Every binding a command has, formatted and joined — for the handful of
 *  tooltips that have always named both ways in (fullskjerm «F / F11», rotate
 *  «Shift+R / ]»). */
export function shortcutLabels(id: CommandId): string | null {
  const all = bindingsFor(id).map(formatChord)
  return all.length > 0 ? all.join(' / ') : null
}

/** `text` with the command's shortcut appended in parentheses, or plain `text`
 *  when it is unbound. Every tooltip that used to hardcode "(Ctrl+S)" goes
 *  through this, so none of them can advertise a key the user rebound. */
export function withShortcut(text: string, id: CommandId): string {
  const label = shortcutLabel(id)
  return label ? `${text} (${label})` : text
}

/** withShortcut, naming every binding rather than just the first. */
export function withShortcuts(text: string, id: CommandId): string {
  const label = shortcutLabels(id)
  return label ? `${text} (${label})` : text
}

// Build the initial index from the shipped defaults so the very first keypress
// (before Settings have loaded) already works.
rebuild()

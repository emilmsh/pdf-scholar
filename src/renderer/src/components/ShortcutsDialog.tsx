// The keyboard map: every command, what it is bound to, and how to change it.
//
// Two jobs, and the first one matters most — a reader who never rebinds anything
// still gets a complete picture of what the keyboard does, which until now
// existed only as branches in two keydown handlers. Rebinding is the second.
//
// Recording is the whole trick: while this dialog listens for a chord it takes
// the keyboard away from the app (keymap.ts's capture flag), because otherwise
// binding 'T' would also toggle the panel behind the dialog.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  assignBinding,
  bindingsFor,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  COMMANDS,
  commandById,
  commandForChord,
  formatChord,
  hasCustomBindings,
  isDefaultBinding,
  keymapRevision,
  recordChord,
  removeBinding,
  resetAllCommands,
  resetCommand,
  setKeyboardCaptured,
  subscribeKeymap
} from '../keymap'
import type { CommandId, KeymapOverrides } from '../keymap'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import { IconPlus, IconReset } from './icons'

interface Props {
  onChange(next: KeymapOverrides): void
  onClose(): void
}

/** What the dialog is waiting for. `replacing` is set when the user clicked an
 *  existing key rather than «+» — that key steps aside for whatever comes next. */
interface Recording {
  id: CommandId
  replacing: string | null
}

/** A recorded chord that is already spoken for, held back until the reader says
 *  what to do with it. Nothing is written while this is pending: a key changing
 *  owner behind your back is the one thing a keymap editor must not do. */
interface Conflict {
  id: CommandId
  chord: string
  replacing: string | null
  /** The command that holds the chord today and would lose it */
  owner: CommandId
}

/** The takeover that just happened, so the row can say so and offer the way
 *  back. The displaced command is left with no key on purpose — it now shows
 *  «Ingen tast» in the map and can be given another one. */
interface Takeover {
  id: CommandId
  chord: string
  from: CommandId
  /** The whole override set as it was before — one click puts it all back */
  before: KeymapOverrides
}

/** Keys the app cannot hand over, listed so the map is complete rather than
 *  merely editable. Chip text is literal on purpose: these are not bindings, so
 *  they never go through the chord grammar. */
const FIXED_KEYS: readonly { labelKey: MsgKey; keys: readonly string[] }[] = [
  { labelKey: 'keys.fixedEscape', keys: ['Esc'] },
  { labelKey: 'keys.fixedScroll', keys: ['↑', '↓', 'PgUp', 'PgDn', 'Space'] },
  { labelKey: 'keys.fixedPresentNav', keys: ['←', '→', 'Space'] },
  { labelKey: 'keys.fixedPresentEnds', keys: ['Home', 'End'] }
]

export default function ShortcutsDialog({ onChange, onClose }: Props): React.JSX.Element {
  useLang()
  // The bindings live in keymap.ts's store (the key handlers read them
  // synchronously), so subscribe rather than take them as a prop.
  useSyncExternalStore(subscribeKeymap, keymapRevision)
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  /** A keypress that cannot become a binding, kept so the row can say why */
  const [rejected, setRejected] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [takeover, setTakeover] = useState<Takeover | null>(null)

  // The app's shortcut handlers stand down for as long as the map is open —
  // not just while recording. Otherwise a keypress that lands on a chip button
  // rather than the filter field ('T', 'S') would work the panels behind the
  // modal. This does not block typing: it only silences the window handlers.
  useEffect(() => {
    setKeyboardCaptured(true)
    return () => setKeyboardCaptured(false)
  }, [])

  /** Write a chord onto a command. The one place a binding changes, so both the
   *  uncontested case and the confirmed overwrite go through it. `replacing` is
   *  the chord this one was clicked to stand in for; assignBinding has already
   *  taken the chord off any previous owner. */
  const apply = useCallback(
    (id: CommandId, chord: string, replacing: string | null): void => {
      const before = bindingsSnapshot()
      const { next, displaced } = assignBinding(id, chord)
      if (replacing && replacing !== chord) {
        next[id] = (next[id] ?? []).filter((c) => c !== replacing)
      }
      onChange(next)
      setTakeover(displaced ? { id, chord, from: displaced, before } : null)
    },
    [onChange]
  )

  // Recording: listen for the chord until one arrives or Esc cancels.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // Nothing gets through — not the app's shortcuts, not the browser's
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setRecording(null)
        setRejected(null)
        return
      }
      const { chord, rejected: why } = recordChord(e)
      if (why === 'modifier-only') return // still reaching for the key itself
      if (why === 'reserved' || !chord) {
        // Stay in recording mode: the reader gets to try another key without
        // clicking again, which is what "that one is taken" should feel like.
        setRejected(e.key === ' ' ? 'Space' : e.key)
        return
      }
      // Taken by something else? Stop here and ask. A chord can only ever
      // belong to one command, so accepting it MEANS taking it away from the
      // other one — that is a decision, not a detail.
      const owner = commandForChord(chord)
      if (owner && owner !== recording.id) {
        setConflict({ id: recording.id, chord, replacing: recording.replacing, owner })
        setRecording(null)
        setRejected(null)
        return
      }
      apply(recording.id, chord, recording.replacing)
      setRecording(null)
      setRejected(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, apply])

  // Esc, when nothing is being recorded (the handler above owns it then): it
  // backs out of a pending overwrite question first, and only closes the map
  // once there is nothing smaller to cancel.
  useEffect(() => {
    if (recording) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (conflict) setConflict(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, conflict, onClose])

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COMMANDS
    return COMMANDS.filter((c) => {
      if (t(c.labelKey).toLowerCase().includes(q)) return true
      if (t(CATEGORY_LABELS[c.category]).toLowerCase().includes(q)) return true
      // Searching for the KEY is the other way in: "what does F11 do?"
      return bindingsFor(c.id).some((chord) => formatChord(chord).toLowerCase().includes(q))
    })
  }, [query])

  const startRecording = (id: CommandId, replacing: string | null): void => {
    setTakeover(null)
    setRejected(null)
    setConflict(null)
    setRecording({ id, replacing })
  }

  const row = (id: CommandId): React.JSX.Element => {
    const command = commandById(id)!
    const chords = bindingsFor(id)
    const isRecording = recording?.id === id
    const atDefault = isDefaultBinding(id)
    const defaultLabel = command.defaults.map(formatChord).join(' / ')
    return (
      <div className="keys-row" key={id}>
        <span className="keys-label">{t(command.labelKey)}</span>
        <span className="keys-binding">
          {chords.map((chord) => (
            <span className="keys-chip-wrap" key={chord}>
              <button
                className="keys-chip"
                title={t('keys.changeTip')}
                onClick={() => startRecording(id, chord)}
              >
                {formatChord(chord)}
              </button>
              <button
                className="keys-chip-remove"
                title={t('keys.removeTip')}
                aria-label={t('keys.removeTip')}
                onClick={() => onChange(removeBinding(id, chord))}
              >
                ✕
              </button>
            </span>
          ))}
          {isRecording ? (
            <span className="keys-recording">
              <span className="keys-recording-dot" />
              {t('keys.recording')}
              <span className="keys-recording-hint">{t('keys.recordingHint')}</span>
            </span>
          ) : (
            <>
              {chords.length === 0 && <span className="keys-unbound">{t('keys.unbound')}</span>}
              <button
                className="keys-add"
                title={t('keys.addTip')}
                aria-label={t('keys.addTip')}
                onClick={() => startRecording(id, null)}
              >
                <IconPlus size={13} />
              </button>
            </>
          )}
          {/* Hidden while on defaults: an always-visible reset is noise on the
              forty rows nobody touched. */}
          {!atDefault && (
            <button
              className="keys-reset-one"
              title={
                defaultLabel
                  ? t('keys.resetOneTip', { keys: defaultLabel })
                  : t('keys.resetOneEmptyTip')
              }
              aria-label={
                defaultLabel
                  ? t('keys.resetOneTip', { keys: defaultLabel })
                  : t('keys.resetOneEmptyTip')
              }
              onClick={() => {
                setTakeover(null)
                setConflict(null)
                onChange(resetCommand(id))
              }}
            >
              <IconReset size={13} />
            </button>
          )}
        </span>
        {/* The chord is taken. Nothing has been written yet — this asks first,
            and «Overskriv» is what makes the other command lose the key. */}
        {conflict?.id === id && (
          <span className="keys-note keys-note-ask">
            {t('keys.conflict', {
              keys: formatChord(conflict.chord),
              from: t(commandById(conflict.owner)!.labelKey)
            })}
            <button
              className="keys-note-action"
              onClick={() => {
                apply(conflict.id, conflict.chord, conflict.replacing)
                setConflict(null)
              }}
            >
              {t('keys.overwrite')}
            </button>
            <button className="keys-note-undo" onClick={() => setConflict(null)}>
              {t('app.cancel')}
            </button>
          </span>
        )}
        {isRecording && rejected && (
          <span className="keys-note keys-note-warn">
            {t('keys.reserved', { key: rejected })}
          </span>
        )}
        {takeover?.id === id && (
          <span className="keys-note">
            {t('keys.tookOver', {
              keys: formatChord(takeover.chord),
              from: t(commandById(takeover.from)!.labelKey)
            })}
            <button
              className="keys-note-undo"
              onClick={() => {
                onChange(takeover.before)
                setTakeover(null)
              }}
            >
              {t('keys.undoTakeover')}
            </button>
          </span>
        )}
      </div>
    )
  }

  const changed = COMMANDS.filter((c) => !isDefaultBinding(c.id)).length

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        // Clicking the backdrop closes; clicking inside must not
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="shortcuts-dialog" role="dialog" aria-modal="true" aria-label={t('keys.title')}>
        <div className="shortcuts-head">
          {/* How the map works rides on the TITLE's tooltip rather than a
              permanent paragraph: it is read once and then costs two lines of a
              dialog that already scrolls. Every control says its own job on
              hover anyway. */}
          <div className="shortcuts-title-row">
            <h2 className="shortcuts-title" title={t('keys.intro')}>
              {t('keys.title')}
            </h2>
            {changed > 0 && (
              <span className="shortcuts-changed">{t('keys.customCount', { count: changed })}</span>
            )}
            <button className="shortcuts-close" onClick={onClose} aria-label={t('app.close')}>
              ✕
            </button>
          </div>
          <div className="shortcuts-tools">
            <input
              className="shortcuts-filter"
              type="search"
              value={query}
              autoFocus
              placeholder={t('keys.filter')}
              onChange={(e) => setQuery(e.target.value)}
              // The filter field is a text field inside a keyboard editor: its
              // own typing must never reach the app's shortcut handlers.
              onKeyDown={(e) => e.stopPropagation()}
            />
            {hasCustomBindings() && (
              <button
                className="btn-secondary shortcuts-reset-all"
                title={t('keys.resetAllTip')}
                onClick={() => {
                  setTakeover(null)
                  setConflict(null)
                  setRecording(null)
                  onChange(resetAllCommands())
                }}
              >
                <IconReset size={14} />
                {t('keys.resetAll')}
              </button>
            )}
          </div>
        </div>

        <div className="shortcuts-body">
          {CATEGORY_ORDER.map((category) => {
            const inCategory = commands.filter((c) => c.category === category)
            if (inCategory.length === 0) return null
            return (
              <section className="keys-group" key={category}>
                <h3 className="keys-group-title">{t(CATEGORY_LABELS[category])}</h3>
                {inCategory.map((c) => row(c.id))}
              </section>
            )
          })}

          {commands.length === 0 && (
            <p className="shortcuts-empty">{t('keys.noMatches', { query: query.trim() })}</p>
          )}

          {/* The fixed keys close the map: without them a reader would conclude
              Esc simply is not in it. */}
          {!query.trim() && (
            <section className="keys-group keys-group-fixed">
              {/* Same rule as the dialog's own intro: the explanation is on
                  hover, because these rows already look inert. */}
              <h3 className="keys-group-title" title={t('keys.fixedIntro')}>
                {t('keys.fixedTitle')}
              </h3>
              {FIXED_KEYS.map((fixed) => (
                <div className="keys-row" key={fixed.labelKey}>
                  <span className="keys-label">{t(fixed.labelKey)}</span>
                  <span className="keys-binding">
                    {fixed.keys.map((key) => (
                      <span className="keys-chip is-fixed" key={key}>
                        {key}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** The current override set, as a plain object to hand back on «Angre». Read
 *  through the same accessor the handlers use so it can never drift from what
 *  is actually in force. */
function bindingsSnapshot(): KeymapOverrides {
  const out: KeymapOverrides = {}
  for (const c of COMMANDS) {
    if (!isDefaultBinding(c.id)) out[c.id] = [...bindingsFor(c.id)]
  }
  return out
}

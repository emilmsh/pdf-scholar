import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AiConfigView,
  RecentFile,
  RecentsGridSize,
  Settings,
  UpdateCheckOutcome,
  UpdateUnsupportedReason
} from '../../../shared/types'
import { BREW_UPGRADE_COMMAND } from '../../../shared/update-channel'
import { readingProgress } from '../../../shared/recent-thumbs'
import { recentsGridSizeOrDefault, splitRecents, stepRecentsGridSize } from '../../../shared/recents'
import { bridge, isElectron } from '../bridge'
import { locale, t, useLang } from '../i18n'
import {
  AppMark,
  IconArrowLeft,
  IconDocument,
  IconFolderOpen,
  IconGrid,
  IconHeart,
  IconList,
  IconLock,
  IconMinus,
  IconPin,
  IconPinOff,
  IconPlus,
  IconSparkle
} from './icons'
import { AiSettings } from './AiPanel'
import FileAccessNotice from './FileAccessNotice'
import { dismissFileAccessNotice, fileAccessGranted, fileAccessNoticeDismissed } from '../extension-file-access'
import { useRecentThumbs } from '../hooks/useRecentThumbs'

type RecentsView = Settings['recentsView']

interface Props {
  recents: RecentFile[]
  onOpenDialog(): void
  onOpenRecent(path: string): void
  /** «Nylig lest» as the compact list or as a grid of first pages (issue #28) */
  recentsView: RecentsView
  onRecentsViewChange(view: RecentsView): void
  /** How large the grid's first pages are drawn (issue #29) */
  recentsGridSize: RecentsGridSize
  onRecentsGridSizeChange(size: RecentsGridSize): void
  /** The list as the store now holds it, after a pin, a removal or its undo
   *  here — the library calls the bridge itself and hands the answer up */
  onRecentsChange(recents: RecentFile[]): void
  /** A document still open behind this screen, and the way back to it.
   *
   *  The extension only. There, this screen IS the library and there is no tab
   *  strip to return through — so without this the back arrow was a one-way
   *  door with an unsaved document stranded behind it (Emil, 2026-08-09). The
   *  desktop leaves it undefined: its tab strip is the way back, and a second
   *  control saying the same thing would be clutter. */
  resume?: { name: string; onResume(): void } | undefined
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
}

export function updateOutcomeText(outcome: UpdateCheckOutcome): string {
  switch (outcome.status) {
    case 'none':
      return t('update.upToDate', { current: outcome.current })
    case 'available':
      return t('update.checkAvailable', { version: outcome.version ?? '' })
    case 'ready':
      return t('update.checkReady', { version: outcome.version ?? '' })
    case 'manual':
      // The notice raised alongside this carries the copyable command; this
      // line is the one-liner for the toolbar menu and the welcome screen.
      return outcome.channel === 'brew'
        ? t('update.checkManualBrew', {
            version: outcome.version ?? '',
            command: BREW_UPGRADE_COMMAND
          })
        : t('update.checkManualDownload', { version: outcome.version ?? '' })
    case 'unsupported':
      if (outcome.reason === 'store') return t('update.unsupportedStore')
      return t('update.unsupportedDev')
    case 'error':
      return t('update.checkError')
  }
}

/** A picked file has no folder path — the `fsa:` pseudo-path is an internal
 *  key, so show the same hint the sidebar uses. */
function recentLocation(path: string): string {
  return path.startsWith('fsa:') ? t('doc.pickedHint') : path
}

export default function Welcome({
  recents,
  onOpenDialog,
  onOpenRecent,
  recentsView,
  onRecentsViewChange,
  recentsGridSize,
  onRecentsGridSizeChange,
  onRecentsChange,
  resume
}: Props): React.JSX.Element {
  useLang()
  const thumbs = useRecentThumbs(recents, recentsView === 'grid')
  const gridSize = recentsGridSizeOrDefault(recentsGridSize)
  const { pinned, recent } = splitRecents(recents)

  // ---------- Keeping the list tidy (issue #29) ----------
  /** The last entry taken out, while its «Angre» is still on offer. Only the
   *  last: a second removal replaces the offer rather than stacking them. */
  const [removed, setRemoved] = useState<{ entry: RecentFile; index: number } | null>(null)
  const removedTimerRef = useRef<number | null>(null)
  const clearRemovedTimer = (): void => {
    if (removedTimerRef.current !== null) window.clearTimeout(removedTimerRef.current)
    removedTimerRef.current = null
  }
  useEffect(() => clearRemovedTimer, [])

  const removeEntry = useCallback(
    (entry: RecentFile) => {
      const index = recents.findIndex((r) => r.path === entry.path)
      void bridge.removeRecent(entry.path).then(onRecentsChange)
      clearRemovedTimer()
      setRemoved({ entry, index: Math.max(0, index) })
      removedTimerRef.current = window.setTimeout(() => setRemoved(null), 6000)
    },
    [recents, onRecentsChange]
  )
  const undoRemove = (): void => {
    if (!removed) return
    clearRemovedTimer()
    void bridge.restoreRecent(removed.entry, removed.index).then(onRecentsChange)
    setRemoved(null)
  }
  const togglePin = (entry: RecentFile): void => {
    void bridge.pinRecent(entry.path, entry.pinnedAt === undefined).then(onRecentsChange)
  }

  /** The entry's own two actions, beside — never inside — its button (a
   *  button cannot hold buttons). Revealed on hover and focus, always shown
   *  on touch; Delete on the focused entry does what the cross does. */
  const entryActions = (r: RecentFile): React.JSX.Element => {
    const isPinned = r.pinnedAt !== undefined
    const pinLabel = t(isPinned ? 'welcome.recentsUnpin' : 'welcome.recentsPin')
    return (
      <span className="recent-actions">
        <button
          className={`recent-action${isPinned ? ' is-on' : ''}`}
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={isPinned}
          onClick={() => togglePin(r)}
        >
          {isPinned ? <IconPinOff size={14} /> : <IconPin size={14} />}
        </button>
        <button
          className="recent-action"
          title={t('welcome.recentsRemove')}
          aria-label={t('welcome.recentsRemove')}
          onClick={() => removeEntry(r)}
        >
          ✕
        </button>
      </span>
    )
  }
  const onEntryKey = (e: React.KeyboardEvent, r: RecentFile): void => {
    if (e.key !== 'Delete') return
    e.preventDefault()
    removeEntry(r)
  }

  const gridItem = (r: RecentFile): React.JSX.Element => {
    const thumb = thumbs[r.path]
    const progress = readingProgress(thumb?.page, thumb?.pages)
    const at = progress
      ? t('welcome.recentsProgress', {
          page: String(progress.page),
          pages: String(progress.pages)
        })
      : null
    return (
      <li key={r.path} className="recent-item">
        <button
          className="recent-card"
          onClick={() => onOpenRecent(r.path)}
          onKeyDown={(e) => onEntryKey(e, r)}
          title={[recentLocation(r.path), formatDate(r.lastOpened)].join('\n')}
        >
          {/* A fixed frame whatever arrives in it, so a picture drawn late
              never moves the grid. The sheet is white paper recoloured as a
              whole, picture and margin alike, so a letterboxed page has no
              visible seam. */}
          <span className="recent-cover">
            <span className="recent-sheet">
              {thumb?.url && <img src={thumb.url} alt="" draggable={false} />}
            </span>
            {!thumb?.url && (thumb?.locked ? <IconLock size={22} /> : <IconDocument size={22} />)}
            {progress && (
              <span className="recent-progress" style={{ width: `${progress.fraction * 100}%` }} />
            )}
          </span>
          <span className="recent-card-name">{r.name}</span>
          {at && <span className="recent-card-meta">{at}</span>}
        </button>
        {entryActions(r)}
      </li>
    )
  }

  const listItem = (r: RecentFile): React.JSX.Element => (
    <li key={r.path} className="recent-item">
      <button
        className="recent-row"
        onClick={() => onOpenRecent(r.path)}
        onKeyDown={(e) => onEntryKey(e, r)}
        title={r.path.startsWith('fsa:') ? undefined : r.path}
      >
        <IconDocument />
        <span className="recent-name">{r.name}</span>
        <span className="recent-path">{recentLocation(r.path)}</span>
        <span className="recent-date">{formatDate(r.lastOpened)}</span>
      </button>
      {entryActions(r)}
    </li>
  )

  const group = (items: RecentFile[]): React.JSX.Element =>
    recentsView === 'grid' ? (
      <ul className={`recents-grid size-${gridSize}`}>{items.map(gridItem)}</ul>
    ) : (
      <ul className="recents-list">{items.map(listItem)}</ul>
    )
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [showAiSetup, setShowAiSetup] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateOutcome, setUpdateOutcome] = useState<UpdateCheckOutcome | null>(null)
  const [version, setVersion] = useState('')
  // undefined while probing; 'store' hides the manual check (the Store owns
  // updates there, so the control would only ever say "nothing to do").
  const [updSupport, setUpdSupport] = useState<UpdateUnsupportedReason | null | undefined>(undefined)

  // The browser-extension target only: ask for «Gi tilgang til URL-adresser for
  // fil» when the browser says we do not have it. A store install never does,
  // and nothing in the install flow can say so — this card is the whole ask
  // (see extension-file-access.ts). Dismissible, because until the user opens a
  // local PDF nothing is actually broken.
  const [needsFileAccess, setNeedsFileAccess] = useState(false)

  useEffect(() => {
    void bridge.getVersion().then(setVersion)
    void bridge.updateSupport().then(setUpdSupport)
  }, [])

  useEffect(() => {
    let stale = false
    void (async () => {
      if ((await fileAccessGranted()) !== false) return
      if (await fileAccessNoticeDismissed()) return
      if (!stale) setNeedsFileAccess(true)
    })()
    return () => {
      stale = true
    }
  }, [])

  const showUpdateCheck = isElectron && updSupport !== undefined && updSupport !== 'store'

  const checkForUpdates = (): void => {
    if (updateChecking) return
    setUpdateChecking(true)
    setUpdateOutcome(null)
    void bridge
      .updateCheck()
      .then(setUpdateOutcome)
      .catch(() => setUpdateOutcome({ status: 'error', current: '' }))
      .finally(() => setUpdateChecking(false))
  }

  // Load the AI config so we can invite first-time users to add a key. Gate the
  // invitation on "no key for the active provider" so it disappears once set up.
  useEffect(() => {
    let stale = false
    void bridge.aiGetConfig().then((view) => {
      if (!stale) setConfig(view)
    })
    return () => {
      stale = true
    }
  }, [])

  const hasKey = config ? config.hasKey[config.provider] : true

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-lockup">
          <AppMark className="welcome-mark" />
          <div className="welcome-logo">PDF Scholar</div>
        </div>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>

        <div className="welcome-actions">
          {/* The document you came from leads, because you are one click from
              having meant to go back to it. Opening another is the secondary
              act while one is already open. */}
          {resume && (
            <button className="btn-primary" onClick={resume.onResume}>
              <IconArrowLeft />
              {t('welcome.resume', { name: resume.name })}
            </button>
          )}
          <button className={resume ? 'btn-secondary' : 'btn-primary'} onClick={onOpenDialog}>
            <IconFolderOpen />
            {t('welcome.openPdf')}
          </button>
        </div>
        <p className="welcome-hint">{t('welcome.dragHint')}</p>

        {needsFileAccess && (
          <FileAccessNotice
            variant="welcome"
            onDismiss={() => {
              dismissFileAccessNotice()
              setNeedsFileAccess(false)
            }}
          />
        )}

        {config && !hasKey && (
          <div className="welcome-ai-card">
            <div className="welcome-ai-icon">
              <IconSparkle size={18} />
            </div>
            <div className="welcome-ai-text">
              <div className="welcome-ai-title">{t('welcome.aiTitle')}</div>
              <p className="welcome-ai-body">{t('welcome.aiBody')}</p>
            </div>
            <button className="btn-secondary welcome-ai-btn" onClick={() => setShowAiSetup(true)}>
              {t('welcome.aiSetup')}
            </button>
          </div>
        )}

        {recents.length > 0 && (
          <div className={`recents${recentsView === 'grid' ? ' is-grid' : ''}`}>
            <div className="recents-head">
              <h2>{t('welcome.recents')}</h2>
              <div className="recents-tools">
                {/* Three fixed sizes — presets, not a slider — and only while
                    there are first pages to size */}
                {recentsView === 'grid' && (
                  <div className="recents-view recents-size" role="group" aria-label={t('welcome.recentsSize')}>
                    <button
                      title={t('welcome.recentsSmaller')}
                      aria-label={t('welcome.recentsSmaller')}
                      disabled={gridSize === 'small'}
                      onClick={() => onRecentsGridSizeChange(stepRecentsGridSize(gridSize, -1))}
                    >
                      <IconMinus size={15} />
                    </button>
                    <button
                      title={t('welcome.recentsLarger')}
                      aria-label={t('welcome.recentsLarger')}
                      disabled={gridSize === 'large'}
                      onClick={() => onRecentsGridSizeChange(stepRecentsGridSize(gridSize, 1))}
                    >
                      <IconPlus size={15} />
                    </button>
                  </div>
                )}
                <div className="recents-view" role="group" aria-label={t('welcome.recentsView')}>
                  <button
                    className={recentsView === 'list' ? 'is-active' : ''}
                    aria-pressed={recentsView === 'list'}
                    title={t('welcome.recentsList')}
                    aria-label={t('welcome.recentsList')}
                    onClick={() => onRecentsViewChange('list')}
                  >
                    <IconList size={16} />
                  </button>
                  <button
                    className={recentsView === 'grid' ? 'is-active' : ''}
                    aria-pressed={recentsView === 'grid'}
                    title={t('welcome.recentsGrid')}
                    aria-label={t('welcome.recentsGrid')}
                    onClick={() => onRecentsViewChange('grid')}
                  >
                    <IconGrid size={16} />
                  </button>
                </div>
              </div>
            </div>
            {/* One box, one scroll: «Festet» on top under its own label,
                then the rest below a hairline. With nothing pinned there is
                no label, and the box is the list it always was. */}
            <div className="recents-box">
              {pinned.length > 0 && (
                <section className="recents-group">
                  <h3>{t('welcome.recentsPinned')}</h3>
                  {group(pinned)}
                </section>
              )}
              {recent.length > 0 && (
                <section className={`recents-group${pinned.length > 0 ? ' after-pinned' : ''}`}>
                  {group(recent)}
                </section>
              )}
            </div>
          </div>
        )}

        {/* Quiet footer: version + manual update check (the toolbar's gear
            menu offers the same — this is the copy you see before any
            document is open). If a newer version is found, the regular
            update toast (with its download button) appears alongside. */}
        <div className="welcome-updates">
          {version && <span className="welcome-version">PDF Scholar {version}</span>}
          {showUpdateCheck && (
            <button className="welcome-updates-btn" onClick={checkForUpdates} disabled={updateChecking}>
              {updateChecking ? t('update.checking') : t('update.check')}
            </button>
          )}
          {updateOutcome && <span className="welcome-updates-result">{updateOutcomeText(updateOutcome)}</span>}
        </div>

        <p className="welcome-credit">
          <button
            className="welcome-credit-link"
            onClick={() => bridge.openExternal('https://www.linkedin.com/in/elisabeth-walle-239028140/')}
          >
            {t('welcome.logoCredit')}
          </button>
          <span className="welcome-credit-sep">·</span>
          <button
            className="welcome-sponsor"
            onClick={() => bridge.openExternal('https://github.com/sponsors/emilmsh')}
            title={t('app.sponsorTip')}
          >
            <IconHeart size={12} />
            {t('app.sponsor')}
          </button>
        </p>
      </div>

      {removed && (
        <div className="toast app-toast recents-undo" role="status">
          <span>{t('welcome.recentsRemoved', { name: removed.entry.name })}</span>
          <button className="toast-action" onClick={undoRemove}>
            {t('welcome.recentsUndo')}
          </button>
        </div>
      )}

      {showAiSetup && config && (
        <div className="welcome-ai-backdrop" onMouseDown={() => setShowAiSetup(false)}>
          <div className="welcome-ai-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="welcome-ai-modal-head">
              <IconSparkle size={16} />
              <span>{t('welcome.aiTitle')}</span>
            </header>
            <p className="welcome-ai-guide">{t('welcome.aiGuide')}</p>
            <AiSettings
              config={config}
              onSaved={(next) => {
                setConfig(next)
                setShowAiSetup(false)
              }}
              onClose={() => setShowAiSetup(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CloseOutcome,
  FilePayload,
  ManualUpdateChannel,
  ReadingPosition,
  RecentFile,
  Settings,
  ThemeName
} from '../../shared/types'
import { BREW_UPGRADE_COMMAND, RELEASES_PAGE_URL } from '../../shared/update-channel'
import { bridge, isElectron } from './bridge'
import { errorText, setLanguage, t, useLang } from './i18n'
import { primaryMod } from './platform'
import { browserCurrentBytes } from './annotation-engine-browser'
import PdfViewer from './components/PdfViewer'
import TabBar from './components/TabBar'
import Welcome from './components/Welcome'
import { DEFAULT_SETTINGS as FALLBACK_SETTINGS } from '../../shared/defaults'

interface OpenTab {
  id: string
  payload: FilePayload
  initialPosition: ReadingPosition | null
  /** Bumped when the file is re-opened with fresh bytes (e.g. from Explorer
   *  after an external update) — keys the viewer so it remounts and reloads */
  epoch: number
}


let tabCounter = 0

/** A copyable shell command inside the update notice. macOS only in practice:
 *  that build detects updates but can't install them (docs/PLATFORMS.md §1), so
 *  the command IS the action — it stays selectable as well as one-click copyable. */
function UpdateCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(id)
  }, [copied])
  return (
    <div className="update-toast-cmd">
      <code>{command}</code>
      <button
        className="update-toast-copy"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => {} // clipboard denied — the text is still there to select
          )
        }}
      >
        {copied ? t('update.copied') : t('update.copy')}
      </button>
    </div>
  )
}

export default function App(): React.JSX.Element {
  useLang()
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)
  /** Active tab is in presentation mode → tuck the tab bar too */
  const [presenting, setPresenting] = useState(false)
  /** Tab ids with unsaved annotation changes (save model) */
  const [dirtyTabs, setDirtyTabs] = useState<ReadonlySet<string>>(new Set())
  const dirtyTabsRef = useRef(dirtyTabs)
  dirtyTabsRef.current = dirtyTabs

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (prev.has(id) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const resolvedTheme: ThemeName =
    settings.theme === 'auto'
      ? systemDark
        ? settings.autoDark
        : settings.autoLight
      : settings.theme

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Apply the resolved theme (all page recoloring lives in the theme's CSS)
  // and recolor the native window-controls overlay to match. The colors
  // MUST mirror --bg-titlebar / --text in app.css.
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    const overlay: Record<ThemeName, [string, string]> = {
      day: ['#ededf0', '#1d1d1f'],
      sepia: ['#e9e6db', '#3d3929'],
      night: ['#21211f', '#eeece2'],
      nightHc: ['#111113', '#f5f5f7']
    }
    bridge.setTitleBarColors(...overlay[resolvedTheme])
  }, [resolvedTheme])

  // OS fullscreen hides the titlebar strip (the native controls hide too)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => bridge.onFullScreen(setFullscreen), [])

  // Auto-update (Electron only). Checks run quietly in main, but downloading
  // is the user's decision: available → "Last ned" button → downloading (with
  // progress) → ready → "Start på nytt nå" (or it installs on quit).
  // Dismissing the toast changes nothing about that flow — a completed
  // download still announces itself, and install-on-quit still happens.
  // 'manual' is the macOS terminus: detected, but we can't install it, so the
  // notice hands over the command instead of a button that would do nothing.
  const [update, setUpdate] = useState<
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string; percent: number }
    | { phase: 'ready'; version: string }
    | { phase: 'manual'; version: string; channel: ManualUpdateChannel }
    | null
  >(null)
  useEffect(() => bridge.onUpdateAvailable((version) => {
    setUpdate((prev) => (prev && prev.phase !== 'available' ? prev : { phase: 'available', version }))
  }), [])
  useEffect(() => bridge.onUpdateProgress((percent) => {
    setUpdate((prev) =>
      prev && prev.phase !== 'ready' ? { phase: 'downloading', version: prev.version, percent } : prev
    )
  }), [])
  useEffect(() => bridge.onUpdateReady((version) => setUpdate({ phase: 'ready', version })), [])
  useEffect(() => bridge.onUpdateManual((version, channel) =>
    setUpdate({ phase: 'manual', version, channel })
  ), [])

  // Keep the i18n store in sync with the language setting
  useEffect(() => {
    setLanguage(settings.language)
  }, [settings.language])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }))
    bridge.setSettings(patch)
  }, [])

  const refreshRecents = useCallback(() => {
    bridge.getRecents().then(setRecents)
  }, [])

  // ---------- Tabs ----------

  const reallyCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id)
      const closing = prev[index]
      if (closing) bridge.docClosed(closing.payload.path)
      const next = prev.filter((t) => t.id !== id)
      setActiveId((current) => {
        if (current !== id) return current
        return next[Math.min(index, next.length - 1)]?.id ?? null
      })
      return next
    })
    setDirtyTabs((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  /** Browser stand-in for the desktop's native save/discard/cancel prompt:
   *  an in-app dialog with the same three verdicts and the same wording. */
  const [confirmState, setConfirmState] = useState<{
    name: string
    resolve(verdict: 'save' | 'discard' | 'cancel'): void
  } | null>(null)

  /** Platform-neutral unsaved-changes prompt. Electron shows the native dialog
   *  (main performs the save itself); the browser shows the in-app dialog and
   *  performs the save here — serialize the live document, then overwrite the
   *  local file or open the save picker. A cancelled picker cancels the close
   *  (the browser CAN still cancel at that stage; losing the marks would be
   *  worse than desktop, which has no picker step). */
  const confirmCloseVerdict = useCallback(
    async (path: string, name: string): Promise<CloseOutcome> => {
      if (isElectron) return bridge.docConfirmClose(path)
      const verdict = await new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
        setConfirmState({ name, resolve })
      )
      setConfirmState(null)
      if (verdict !== 'save') return { verdict }
      const bytes = await browserCurrentBytes(path)
      if (!bytes) return { verdict: 'cancel' }
      const result = await bridge.saveDocumentBytes(path, name, bytes)
      // A cancelled picker (null) is the user's own choice and needs no
      // message; a real write failure must not pass for a cancel in silence.
      if (!result) return { verdict: 'cancel' }
      if ('error' in result) return { verdict: 'cancel', error: result.error }
      return { verdict: 'save' }
    },
    []
  )

  /** A save the user asked for that did not happen. Keeping the document open
   *  is the right recovery, but only once they know why it stayed open. */
  const reportCloseFailure = useCallback((outcome: CloseOutcome): void => {
    if (outcome.error) setError(t('app.saveFailed', { error: outcome.error }))
  }, [])

  /** Browser stand-in for the external-update prompt below — same three
   *  verdicts, wording tailored to "the file changed under your feet". */
  const [externalUpdateState, setExternalUpdateState] = useState<{
    name: string
    resolve(verdict: 'save' | 'discard' | 'cancel'): void
  } | null>(null)

  /** Asks what to do when re-opening a path whose tab has unsaved marks AND
   *  the file on disk has changed since — a plain reload would silently drop
   *  the annotated draft. Unlike confirmCloseVerdict, 'save' here always
   *  means "save a copy" (a destination picker, never overwrite `path` in
   *  place — it now holds someone else's content). A cancelled/failed copy
   *  save downgrades to 'cancel' so the caller keeps the old tab untouched. */
  const confirmExternalUpdateVerdict = useCallback(
    async (path: string, name: string): Promise<'save' | 'discard' | 'cancel'> => {
      let verdict: 'save' | 'discard' | 'cancel'
      if (isElectron) {
        verdict = await bridge.docConfirmExternalUpdate(path)
      } else {
        verdict = await new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
          setExternalUpdateState({ name, resolve })
        )
        setExternalUpdateState(null)
      }
      if (verdict !== 'save') return verdict
      const bytes = isElectron ? new Uint8Array() : await browserCurrentBytes(path)
      if (!bytes) return 'cancel'
      const result = await bridge.saveFileAs(name, bytes, path)
      if (!result || 'error' in result) return 'cancel'
      return 'save'
    },
    []
  )

  const openPayload = useCallback(
    async (payload: FilePayload) => {
      const existing = tabsRef.current.find((t) => t.payload.path === payload.path)
      if (existing) {
        setError(null)
        // The file may have changed on disk since the tab loaded (opening an
        // updated PDF from Explorer, or dropping a same-named file, must never
        // show stale bytes). Reload with the fresh payload — unless the tab
        // has unsaved annotations, which must not be lost to an external
        // update without the user getting a chance to keep them as a copy.
        if (dirtyTabsRef.current.has(existing.id)) {
          const verdict = await confirmExternalUpdateVerdict(
            existing.payload.path,
            existing.payload.name
          )
          if (verdict === 'cancel') {
            setActiveId(existing.id)
            return
          }
          await bridge.docDiscard(existing.payload.path)
          setTabDirty(existing.id, false)
        }
        setActiveId(existing.id)
        const initialPosition = await bridge.getPosition(payload.path)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existing.id ? { ...t, payload, initialPosition, epoch: t.epoch + 1 } : t
          )
        )
        return
      }
      const initialPosition = await bridge.getPosition(payload.path)
      const tab: OpenTab = { id: `tab-${++tabCounter}`, payload, initialPosition, epoch: 0 }
      bridge.docOpened(payload.path)
      setTabs((prev) => [...prev, tab])
      setActiveId(tab.id)
      setError(null)
    },
    [confirmExternalUpdateVerdict, setTabDirty]
  )

  /** Called by the viewer when Save/Ctrl+S finds the file changed outside the
   *  app since editing began — the same menu as re-opening a stale path, just
   *  reached from the other direction. 'save' has already flushed the old
   *  draft into a copy by the time this resolves; 'save' and 'discard' both
   *  retire the draft and reload the tab with the fresh external bytes so
   *  there is nothing stale left to (over)write. */
  const handleSaveExternalConflict = useCallback(
    async (path: string, name: string): Promise<'save' | 'discard' | 'cancel'> => {
      const verdict = await confirmExternalUpdateVerdict(path, name)
      if (verdict === 'cancel') return verdict
      const existing = tabsRef.current.find((t) => t.payload.path === path)
      await bridge.docDiscard(path)
      if (existing) setTabDirty(existing.id, false)
      const result = await bridge.readFile(path)
      if (existing && !('error' in result)) {
        const initialPosition = await bridge.getPosition(path)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existing.id ? { ...t, payload: result, initialPosition, epoch: t.epoch + 1 } : t
          )
        )
      }
      return verdict
    },
    [confirmExternalUpdateVerdict, setTabDirty]
  )

  /** Close with the unsaved-changes prompt when the tab is dirty. Resolves to
   *  whether the tab actually went away, so a bulk close can ask about one tab at
   *  a time instead of stacking a dialog per dirty document. */
  const closeTabAwait = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return false
      if (!dirtyTabsRef.current.has(id)) {
        reallyCloseTab(id)
        return true
      }
      const outcome = await confirmCloseVerdict(tab.payload.path, tab.payload.name)
      if (outcome.verdict === 'cancel') {
        reportCloseFailure(outcome)
        return false
      }
      reallyCloseTab(id)
      return true
    },
    [reallyCloseTab, confirmCloseVerdict, reportCloseFailure]
  )

  const closeTab = useCallback(
    (id: string) => {
      void closeTabAwait(id)
    },
    [closeTabAwait]
  )

  /** "Close other tabs" / "Close tabs to the right". Sequential on purpose: with
   *  two unsaved documents, firing both closes at once would stack two save
   *  dialogs on top of each other. Cancelling one keeps that tab and moves on to
   *  the next — the ask was to close the others, not to give up on all of them. */
  const closeTabs = useCallback(
    async (ids: string[]) => {
      for (const id of ids) await closeTabAwait(id)
    },
    [closeTabAwait]
  )

  /** Drag a tab to a new position (also Ctrl+Shift+PageUp/PageDown) */
  const moveTab = useCallback((id: string, toIndex: number) => {
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id)
      const to = Math.max(0, Math.min(prev.length - 1, toIndex))
      if (from === -1 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  // Move a tab to another window (drag) or tear it off into a new one. The
  // source tab closes WITHOUT the discard prompt so its unsaved draft (kept on
  // disk, keyed by path in main) travels with the document — the target window
  // opens the same path and picks the draft back up.
  const moveTabOut = useCallback(
    async (id: string, path: string) => {
      const verdict = await bridge.tabDropAtCursor(path)
      if (verdict === 'window' || verdict === 'new') reallyCloseTab(id)
    },
    [reallyCloseTab]
  )

  const moveToNewWindow = useCallback(
    (id: string, path: string) => {
      bridge.newWindow(path)
      reallyCloseTab(id)
    },
    [reallyCloseTab]
  )

  /** Explicit reload from the tab context menu: re-read the file from disk and
   *  remount the viewer. Unsaved annotations go through the same save/discard/
   *  cancel dialog as closing — an explicit reload may drop them, silence not. */
  const reloadTab = useCallback(
    async (id: string, path: string) => {
      if (dirtyTabsRef.current.has(id)) {
        const tab = tabsRef.current.find((t) => t.id === id)
        const outcome = await confirmCloseVerdict(path, tab?.payload.name ?? path)
        if (outcome.verdict === 'cancel') {
          reportCloseFailure(outcome)
          return
        }
        setTabDirty(id, false) // saved or discarded — the remounted viewer starts clean
      }
      const result = await bridge.readFile(path)
      if ('error' in result) {
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      const initialPosition = await bridge.getPosition(path)
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, payload: result, initialPosition, epoch: t.epoch + 1 } : t))
      )
      setActiveId(id)
    },
    [setTabDirty, confirmCloseVerdict, reportCloseFailure]
  )

  /** «Save a copy» semantics: continue working in the copy. The edits were
   *  just flushed INTO the new file, so swap this tab over to it (the viewer
   *  remounts on the fresh bytes) and silently drop the original's draft —
   *  the whole point of saving a copy is that the original stays untouched,
   *  and a surviving draft would resurrect the edits on its next open. */
  const adoptSavedCopy = useCallback(
    async (id: string, newPath: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      const oldPath = tab.payload.path
      // The save dialog may have overwritten a file that is open in another
      // tab: that document was just replaced wholesale, so retire its tab
      // (and any draft of its previous content) before this tab takes over
      // the path — tabs must stay unique per path.
      const other = tabsRef.current.find((t) => t.id !== id && t.payload.path === newPath)
      if (other) {
        await bridge.docDiscard(newPath)
        reallyCloseTab(other.id)
      }
      const result = await bridge.readFile(newPath)
      if ('error' in result) return // the copy is safely on disk; stay on the original
      await bridge.docDiscard(oldPath)
      if (oldPath !== newPath) {
        bridge.docClosed(oldPath)
        bridge.docOpened(newPath)
      }
      const initialPosition = await bridge.getPosition(newPath)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, payload: result, initialPosition, epoch: t.epoch + 1 } : t
        )
      )
      setTabDirty(id, false)
    },
    [reallyCloseTab, setTabDirty]
  )

  const cycleTab = useCallback((delta: number) => {
    setActiveId((current) => {
      const list = tabsRef.current
      if (list.length < 2) return current
      const index = list.findIndex((t) => t.id === current)
      return list[(index + delta + list.length) % list.length].id
    })
  }, [])

  const openPath = useCallback(
    async (path: string) => {
      const existing = tabsRef.current.find((t) => t.payload.path === path)
      if (existing && dirtyTabsRef.current.has(existing.id)) {
        const verdict = await confirmExternalUpdateVerdict(path, existing.payload.name)
        if (verdict === 'cancel') {
          // Unsaved annotations trump the external update — just focus the tab
          setActiveId(existing.id)
          return
        }
        // 'save' (copy flushed elsewhere) or 'discard': the old draft is no
        // longer needed — drop it and fall through to load the fresh bytes.
        await bridge.docDiscard(path)
        setTabDirty(existing.id, false)
      }
      // Existing-but-clean tabs fall through: re-read so an externally updated
      // file shows its latest bytes (openPayload swaps them into the tab).
      const result = await bridge.readFile(path)
      if ('error' in result) {
        if (existing) {
          setActiveId(existing.id) // file gone/busy — keep showing what we have
          return
        }
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      await openPayload(result)
    },
    [openPayload, confirmExternalUpdateVerdict, setTabDirty]
  )

  const openDialog = useCallback(async () => {
    const result = await bridge.openFileDialog()
    if (!result) return
    if ('error' in result) {
      setError(t('app.openFailed', { error: errorText(result) }))
      return
    }
    await openPayload(result)
  }, [openPayload])

  useEffect(() => {
    bridge.getSettings().then(setSettingsState)
    refreshRecents()
    bridge.getPendingPath().then((path) => {
      if (path) openPath(path)
    })
    return bridge.onOpenPath((path) => openPath(path))
  }, [refreshRecents, openPath])

  // Refresh recents whenever the last tab closes (back at the welcome screen)
  useEffect(() => {
    if (tabs.length === 0) refreshRecents()
  }, [tabs.length, refreshRecents])

  // Tab shortcuts: Ctrl+Tab / Ctrl+Shift+Tab cycle (Ctrl also on mac — Cmd+Tab
  // is the OS app switcher), Cmd/Ctrl+W close, Cmd/Ctrl+O open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      } else if (primaryMod(e) && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        // Read the active id from a ref, not a setActiveId updater: closing runs
        // its own setActiveId to pick the neighbour, and returning `current` from
        // an outer updater would clobber that and leave no active tab.
        if (activeIdRef.current) closeTab(activeIdRef.current)
      } else if (primaryMod(e) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        bridge.newWindow()
      } else if (primaryMod(e) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        void openDialog()
      } else if (
        primaryMod(e) &&
        e.shiftKey &&
        (e.key === 'PageUp' || e.key === 'PageDown')
      ) {
        // Move the active tab, the browser shortcut for the same thing
        const id = activeIdRef.current
        if (!id) return
        const at = tabsRef.current.findIndex((t) => t.id === id)
        if (at === -1) return
        e.preventDefault()
        moveTab(id, at + (e.key === 'PageUp' ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cycleTab, closeTab, openDialog, moveTab])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
      const realPath = bridge.getPathForFile(file)
      if (realPath) {
        await openPath(realPath)
      } else {
        await openPayload({
          path: file.name,
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer())
        })
      }
    },
    [openPath, openPayload]
  )

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Lukk">
            ✕
          </button>
        </div>
      )}

      <TabBar
        tabs={tabs.map((t) => ({
          id: t.id,
          name: t.payload.name,
          path: t.payload.path,
          dirty: dirtyTabs.has(t.id)
        }))}
        activeId={activeId}
        hidden={presenting || fullscreen}
        onSelect={setActiveId}
        onClose={closeTab}
        onNewTab={() => void openDialog()}
        onNewWindow={() => bridge.newWindow()}
        onOpenInNewWindow={(path) => bridge.newWindow(path)}
        onShowInFolder={(path) => bridge.showInFolder(path)}
        onTabDragOut={(id, path) => void moveTabOut(id, path)}
        onReorder={moveTab}
        onCloseMany={(ids) => void closeTabs(ids)}
        onMoveToNewWindow={moveToNewWindow}
        onReload={(id, path) => void reloadTab(id, path)}
        onLibrary={() => activeId && closeTab(activeId)}
      />

      {tabs.length > 0 ? (
        <div className="tab-views">
          {tabs.map((tab) => (
            <div key={`${tab.id}:${tab.epoch}`} className={`tab-view${tab.id === activeId ? ' active' : ''}`}>
              <PdfViewer
                payload={tab.payload}
                initialPosition={tab.initialPosition}
                active={tab.id === activeId}
                settings={settings}
                resolvedTheme={resolvedTheme}
                onSettingsChange={updateSettings}
                onPresentationChange={setPresenting}
                onDirtyChange={(dirty) => setTabDirty(tab.id, dirty)}
                onSavedAs={(path) => void adoptSavedCopy(tab.id, path)}
                onExternalSaveConflict={handleSaveExternalConflict}
                onClose={() => closeTab(tab.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />
      )}
      {isElectron && update && (
        <div className="update-toast" role="status">
          <div className="update-toast-text">
            {update.phase === 'available' && (
              <>
                <strong>{t('update.available')}</strong>
                <span>{t('update.availableBody', { version: update.version })}</span>
              </>
            )}
            {update.phase === 'downloading' && (
              <>
                <strong>{t('update.downloading')}</strong>
                <span>{t('update.downloadingBody', { version: update.version, percent: String(update.percent) })}</span>
              </>
            )}
            {update.phase === 'ready' && (
              <>
                <strong>{t('update.ready')}</strong>
                <span>{t('update.body', { version: update.version })}</span>
              </>
            )}
            {update.phase === 'manual' && (
              <>
                <strong>{t('update.available')}</strong>
                <span>
                  {update.channel === 'brew'
                    ? t('update.manualBrewBody', { version: update.version })
                    : t('update.manualDownloadBody', { version: update.version })}
                </span>
                {update.channel === 'brew' && <UpdateCommand command={BREW_UPGRADE_COMMAND} />}
              </>
            )}
          </div>
          {update.phase === 'manual' && update.channel === 'download' && (
            <button
              className="btn-primary"
              onClick={() => bridge.openExternal(RELEASES_PAGE_URL)}
            >
              {t('update.manualOpen')}
            </button>
          )}
          {update.phase === 'available' && (
            <button
              className="btn-primary"
              onClick={() => {
                bridge.updateDownload()
                setUpdate({ phase: 'downloading', version: update.version, percent: 0 })
              }}
            >
              {t('update.download')}
            </button>
          )}
          {update.phase === 'ready' && (
            <button className="btn-primary" onClick={() => bridge.updateRestart()}>
              {t('update.restartNow')}
            </button>
          )}
          <button
            className="update-toast-close"
            aria-label={t('update.dismissTip')}
            title={t('update.dismissTip')}
            onClick={() => setUpdate(null)}
          >
            ✕
          </button>
        </div>
      )}
      {confirmState && (
        <div className="confirm-overlay" onMouseDown={(e) => e.stopPropagation()}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true">
            <p className="confirm-message">
              {t('app.confirmCloseMessage', { name: confirmState.name })}
            </p>
            <p className="confirm-detail">{t('app.confirmCloseDetail')}</p>
            <div className="confirm-actions">
              <button className="btn-secondary" onClick={() => confirmState.resolve('cancel')}>
                {t('app.cancel')}
              </button>
              <button className="btn-secondary" onClick={() => confirmState.resolve('discard')}>
                {t('app.dontSave')}
              </button>
              <button className="btn-primary" autoFocus onClick={() => confirmState.resolve('save')}>
                {t('app.save')}
              </button>
            </div>
          </div>
        </div>
      )}
      {externalUpdateState && (
        <div className="confirm-overlay" onMouseDown={(e) => e.stopPropagation()}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true">
            <p className="confirm-message">
              {t('app.confirmExternalUpdateMessage', { name: externalUpdateState.name })}
            </p>
            <p className="confirm-detail">{t('app.confirmExternalUpdateDetail')}</p>
            <div className="confirm-actions">
              <button
                className="btn-secondary"
                onClick={() => externalUpdateState.resolve('cancel')}
              >
                {t('app.cancel')}
              </button>
              <button
                className="btn-secondary"
                onClick={() => externalUpdateState.resolve('discard')}
              >
                {t('app.dontSave')}
              </button>
              <button
                className="btn-primary"
                autoFocus
                onClick={() => externalUpdateState.resolve('save')}
              >
                {t('app.saveCopy')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

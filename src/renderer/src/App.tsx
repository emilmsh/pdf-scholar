import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FilePayload,
  ReadingPosition,
  RecentFile,
  Settings,
  ThemeName
} from '../../shared/types'
import { bridge, isElectron } from './bridge'
import { setLanguage, t, useLang } from './i18n'
import { primaryMod } from './platform'
import { browserCurrentBytes } from './annotation-engine-browser'
import PdfViewer from './components/PdfViewer'
import TabBar from './components/TabBar'
import Welcome from './components/Welcome'

interface OpenTab {
  id: string
  payload: FilePayload
  initialPosition: ReadingPosition | null
  /** Bumped when the file is re-opened with fresh bytes (e.g. from Explorer
   *  after an external update) — keys the viewer so it remounts and reloads */
  epoch: number
}

const FALLBACK_SETTINGS: Settings = {
  theme: 'day',
  autoLight: 'day',
  autoDark: 'night',
  keepAwake: false,
  language: 'auto'
}

let tabCounter = 0

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
  const [update, setUpdate] = useState<
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string; percent: number }
    | { phase: 'ready'; version: string }
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
    async (path: string, name: string): Promise<'save' | 'discard' | 'cancel'> => {
      if (isElectron) return bridge.docConfirmClose(path)
      const verdict = await new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
        setConfirmState({ name, resolve })
      )
      setConfirmState(null)
      if (verdict !== 'save') return verdict
      const bytes = await browserCurrentBytes(path)
      if (!bytes) return 'cancel'
      const result = await bridge.saveDocumentBytes(path, name, bytes)
      if (!result || 'error' in result) return 'cancel'
      return 'save'
    },
    []
  )

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

  /** Close with the unsaved-changes prompt when the tab is dirty */
  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (!dirtyTabsRef.current.has(id)) {
        reallyCloseTab(id)
        return
      }
      void confirmCloseVerdict(tab.payload.path, tab.payload.name).then((verdict) => {
        if (verdict === 'cancel') return
        reallyCloseTab(id)
      })
    },
    [reallyCloseTab, confirmCloseVerdict]
  )

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
        const verdict = await confirmCloseVerdict(path, tab?.payload.name ?? path)
        if (verdict === 'cancel') return
        setTabDirty(id, false) // saved or discarded — the remounted viewer starts clean
      }
      const result = await bridge.readFile(path)
      if ('error' in result) {
        setError(`Kunne ikke åpne filen: ${result.error}`)
        return
      }
      const initialPosition = await bridge.getPosition(path)
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, payload: result, initialPosition, epoch: t.epoch + 1 } : t))
      )
      setActiveId(id)
    },
    [setTabDirty, confirmCloseVerdict]
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
        setError(`Kunne ikke åpne filen: ${result.error}`)
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
      setError(`Kunne ikke åpne filen: ${result.error}`)
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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cycleTab, closeTab, openDialog])

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
          </div>
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

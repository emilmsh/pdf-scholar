import { useCallback, useEffect, useState } from 'react'
import type { FilePayload, ReadingPosition, RecentFile, Settings, ThemeName } from '../../shared/types'
import { bridge } from './bridge'
import { setLanguage, t } from './i18n'
import { browserCurrentBytes } from './annotation-engine-browser'
import {
  checkForExtensionUpdate,
  skipExtensionUpdate,
  EXTENSION_DOWNLOAD_URL
} from './extension-update'
import PdfViewer from './components/PdfViewer'
import Welcome from './components/Welcome'

// Single-document shell for the browser-extension target. Each PDF lives in its
// own browser tab, so there is no in-app TabBar — this renders exactly one
// PdfViewer for the document handed to the page via the ?file= param.
//
// The chrome around the viewer (theme resolution, settings, fullscreen,
// language) mirrors App.tsx deliberately: the two shells should stay in
// functional parity. Once the tab-mode work lands in App.tsx, the shared parts
// are the natural thing to extract into a common <AppShell>.

const FALLBACK_SETTINGS: Settings = {
  theme: 'day',
  autoLight: 'day',
  autoDark: 'night',
  keepAwake: false,
  language: 'auto'
}

export default function ExtensionApp(): React.JSX.Element {
  const [payload, setPayload] = useState<FilePayload | null>(null)
  const [initialPosition, setInitialPosition] = useState<ReadingPosition | null>(null)
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Bumped when the open document is replaced with fresh bytes in place
   *  (external-update conflict) — forces PdfViewer to remount, matching
   *  App.tsx's per-tab epoch (there's only ever one "tab" here). */
  const [epoch, setEpoch] = useState(0)

  const resolvedTheme: ThemeName =
    settings.theme === 'auto'
      ? systemDark
        ? settings.autoDark
        : settings.autoLight
      : settings.theme

  // ---------- Theme + settings (mirrors App.tsx) ----------

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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

  useEffect(() => {
    setLanguage(settings.language)
  }, [settings.language])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }))
    bridge.setSettings(patch)
  }, [])

  // ---------- Document loading ----------

  const openPayload = useCallback(async (p: FilePayload) => {
    const pos = await bridge.getPosition(p.path)
    setInitialPosition(pos)
    bridge.docOpened(p.path)
    setPayload(p)
    setError(null)
    document.title = `${p.name} — PDF Scholar`
    // Reflect the document in the address bar: a reopenable URL goes into
    // ?file= (so a reload restores the document); a picker-opened file has no
    // path the browser itself can reopen, so its name rides in the hash purely
    // for display.
    history.replaceState(
      null,
      '',
      p.path.startsWith('fsa:')
        ? `${location.pathname}#${encodeURIComponent(p.name)}`
        : `${location.pathname}?file=${encodeURIComponent(p.path)}`
    )
  }, [])

  const openPath = useCallback(
    async (path: string) => {
      const result = await bridge.readFile(path)
      if ('error' in result) {
        setError(`Kunne ikke åpne filen: ${result.error}`)
        return
      }
      await openPayload(result)
    },
    [openPayload]
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

  // On mount: load settings/recents, then the document handed to this tab.
  useEffect(() => {
    bridge.getSettings().then(setSettingsState)
    bridge.getRecents().then(setRecents)
    bridge
      .getPendingPath()
      .then(async (path) => {
        if (path) await openPath(path)
      })
      .finally(() => setLoading(false))
  }, [openPath])

  // A dropped PDF opens in a NEW browser tab (this tab keeps its document),
  // matching the "each PDF is a tab" model. With no document yet, open in place.
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
      const p: FilePayload = {
        path: file.name,
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer())
      }
      if (payload) bridge.newWindow(p.path)
      else await openPayload(p)
    },
    [payload, openPayload]
  )

  const closeDocument = useCallback(() => {
    // Closing the last document = closing this browser tab.
    window.close()
  }, [])

  // ---------- External-update conflict (Save finds the file changed) ----------
  // No native dialog here (not Electron) — same in-app modal + verdicts as
  // App.tsx's browser-fallback flow, adapted to this shell's single document
  // (no tab list, no separate draft file — a "discard" is just re-reading).
  const [externalUpdateState, setExternalUpdateState] = useState<{
    name: string
    resolve(verdict: 'save' | 'discard' | 'cancel'): void
  } | null>(null)

  const handleSaveExternalConflict = useCallback(
    async (path: string, name: string): Promise<'save' | 'discard' | 'cancel'> => {
      const verdict = await new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
        setExternalUpdateState({ name, resolve })
      )
      setExternalUpdateState(null)
      if (verdict === 'save') {
        const bytes = await browserCurrentBytes(path)
        if (!bytes) return 'cancel'
        const result = await bridge.saveFileAs(name, bytes, path)
        if (!result || 'error' in result) return 'cancel'
      }
      if (verdict !== 'cancel') {
        const fresh = await bridge.readFile(path)
        if ('error' in fresh) return verdict
        setInitialPosition(await bridge.getPosition(path))
        setPayload(fresh)
        setEpoch((e) => e + 1)
      }
      return verdict
    },
    []
  )

  // Sideloaded installs have no update channel (only store installs
  // auto-update) — surface new releases with a dismissible toast instead.
  // Store installs never see this (see extension-update.ts).
  const [extUpdate, setExtUpdate] = useState<string | null>(null)
  useEffect(() => {
    void checkForExtensionUpdate().then(setExtUpdate)
  }, [])

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

      {payload ? (
        <div className="tab-views">
          <div className="tab-view active">
            <PdfViewer
              key={`${payload.path}:${epoch}`}
              payload={payload}
              initialPosition={initialPosition}
              active
              settings={settings}
              resolvedTheme={resolvedTheme}
              onSettingsChange={updateSettings}
              onPresentationChange={() => {}}
              onDirtyChange={() => {}}
              onSavedAs={() => {}} // extension: «save a copy» is a plain export (PLATFORMS.md §9)
              onExternalSaveConflict={handleSaveExternalConflict}
              onClose={closeDocument}
              onOpenFile={openDialog}
            />
          </div>
        </div>
      ) : loading ? (
        <div className="ext-loading" />
      ) : (
        <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />
      )}
      {extUpdate && (
        <div className="update-toast" role="status">
          <div className="update-toast-text">
            <strong>{t('update.extAvailable')}</strong>
            <span>{t('update.extBody', { version: extUpdate })}</span>
          </div>
          <button className="btn-primary" onClick={() => bridge.openExternal(EXTENSION_DOWNLOAD_URL)}>
            {t('update.extDownload')}
          </button>
          <button
            className="update-toast-close"
            aria-label={t('update.dismissTip')}
            title={t('update.dismissTip')}
            onClick={() => {
              void skipExtensionUpdate(extUpdate)
              setExtUpdate(null)
            }}
          >
            ✕
          </button>
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

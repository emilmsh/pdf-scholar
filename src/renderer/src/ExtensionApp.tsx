import { useCallback, useEffect, useState } from 'react'
import type { FilePayload, ReadingPosition, RecentFile, Settings, ThemeName } from '../../shared/types'
import { bridge } from './bridge'
import { buildViewerUrl } from '../../shared/viewer-url'
import { openInBrowserViewer } from './extension-api'
import { insecureRetryUrl } from '../../shared/insecure-retry'
import { errorText, setLanguage, t } from './i18n'
import { browserCurrentBytes } from './annotation-engine-browser'
import {
  checkForExtensionUpdate,
  skipExtensionUpdate,
  EXTENSION_DOWNLOAD_URL
} from './extension-update'
import { extensionContextLost, fileAccessGranted } from './extension-file-access'
import PdfViewer from './components/PdfViewer'
import Welcome from './components/Welcome'
import FileAccessNotice from './components/FileAccessNotice'
import { DEFAULT_SETTINGS as FALLBACK_SETTINGS } from '../../shared/defaults'

// Single-document shell for the browser-extension target. Each PDF lives in its
// own browser tab, so there is no in-app TabBar — this renders exactly one
// PdfViewer for the document handed to the page via the ?file= param.
//
// The chrome around the viewer (theme resolution, settings, fullscreen,
// language) mirrors App.tsx deliberately: the two shells should stay in
// functional parity. Once the tab-mode work lands in App.tsx, the shared parts
// are the natural thing to extract into a common <AppShell>.


export default function ExtensionApp(): React.JSX.Element {
  const [payload, setPayload] = useState<FilePayload | null>(null)
  const [initialPosition, setInitialPosition] = useState<ReadingPosition | null>(null)
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)
  /** The URL an open failed on, when the browser's own reader can still take it
   *  (see openPath) — drives the escape-hatch button in the error banner. */
  const [errorFallback, setErrorFallback] = useState<string | null>(null)
  /** The plaintext twin of a URL whose https side never answered — the second,
   *  deliberately manual escape hatch (see shared/insecure-retry.ts). */
  const [insecureRetry, setInsecureRetry] = useState<string | null>(null)
  /** The local PDF we were asked for while the browser withholds file:// access
   *  — a named failure with a fix, so it gets the fix (FileAccessNotice) rather
   *  than a line of red text. */
  const [fileAccessPath, setFileAccessPath] = useState<string | null>(null)
  /** The library is a place here too (Emil, 2026-08-09). It was wired to
   *  window.close(), so a button labelled «Back to the library» shut the
   *  browser tab and dropped you wherever it had been opened from — the
   *  extensions page, in the report that found this. The shell already HAS a
   *  library screen (Welcome, below); it simply was not reachable. Same shape
   *  as App.tsx, deliberately: the two shells are meant to stay in functional
   *  parity, and «each PDF is a browser tab» never required the tab to die. */
  const [atLibrary, setAtLibrary] = useState(false)
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
    setAtLibrary(false)
    setError(null)
    setErrorFallback(null)
    setInsecureRetry(null)
    setFileAccessPath(null)
    document.title = `${p.name} — PDF Scholar`
    // Reflect the document in the address bar: a reopenable URL goes into the
    // encoded ?file= param (so a reload restores the document, and the raw param
    // the redirect rule wrote is replaced by one that round-trips); a
    // picker-opened file has no path the browser itself can reopen, so its name
    // rides in the hash purely for display.
    history.replaceState(
      null,
      '',
      p.path.startsWith('fsa:')
        ? `${location.pathname}#${encodeURIComponent(p.name)}`
        : buildViewerUrl(location.pathname, p.path)
    )
  }, [])

  const openPath = useCallback(
    async (path: string, opts?: { handOffOnFailure?: boolean }) => {
      const result = await bridge.readFile(path)
      if ('error' in result) {
        // The one failure that is a missing permission rather than a missing
        // file: show what to switch on, not what went wrong (the notice keeps
        // the hand-off to the browser's reader as its escape hatch).
        if (result.code === 'ext-file-access') {
          setError(null)
          setErrorFallback(null)
          setFileAccessPath(path)
          return
        }
        // `doc-unreachable` means the site never answered and it is an https URL,
        // so the hand-off is a dead end BY CONSTRUCTION: the browser's own
        // https→http fallback only fires for an upgrade the browser itself made,
        // and our hand-off navigates to an explicit https URL. Handing over would
        // trade our banner for the browser's error page and lose the one thing
        // that still works — the plaintext retry we can offer below.
        const insecure = result.code === 'doc-unreachable' ? insecureRetryUrl(path) : null
        // The parity bar is the browser's own reader: if it would have rendered
        // the navigation we intercepted, an error banner from us IS the
        // regression, so hand the tab back and let the user read the document.
        // Only for the navigation that opened this tab (handOffOnFailure) —
        // navigating away with a document open would take its unsaved
        // annotations along. And only for http(s): a file:// failure is a
        // one-time toggle the user can fix ("Allow access to file URLs"), and
        // silently routing around it would hide the fix forever.
        if (
          !insecure &&
          opts?.handOffOnFailure &&
          /^https?:/i.test(path) &&
          (await openInBrowserViewer(path, result.error))
        ) {
          return
        }
        setError(t('app.openFailed', { error: errorText(result) }))
        // Still offer the hand-off by hand for the cases above.
        if (/^(https?|file):/i.test(path)) setErrorFallback(path)
        setInsecureRetry(insecure)
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
      setError(t('app.openFailed', { error: errorText(result) }))
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
        if (path) await openPath(path, { handOffOnFailure: true })
      })
      .finally(() => setLoading(false))
  }, [openPath])

  // The switch is flipped on a page we cannot see, so this tab has to notice by
  // itself: re-probe whenever it is looked at again, and open the document the
  // user originally asked for the moment the browser says yes. (Chromium may
  // also restart the extension on the flip; the page then comes back with the
  // same ?rawfile= and opens it anyway — this is the belt to those braces, and
  // it costs one probe.)
  useEffect(() => {
    if (!fileAccessPath) return
    const recheck = (): void => {
      if (document.hidden) return
      // Chromium RELOADS the extension when the switch is flipped, which leaves
      // this page orphaned: every chrome.* call from here on throws, so it can
      // never notice the very thing it is waiting for. Reload — the URL still
      // carries the document, so the PDF comes straight back.
      if (extensionContextLost()) {
        location.reload()
        return
      }
      void fileAccessGranted().then((granted) => {
        if (granted !== true) return
        setFileAccessPath(null)
        void openPath(fileAccessPath)
      })
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('focus', recheck)
    }
  }, [fileAccessPath, openPath])

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

  /** Leave the document for the library. Not window.close(): the tab belongs
   *  to the reader, and a document that would not open is a reason to show
   *  them the library, not to take the tab away. */
  const goToLibrary = useCallback(() => setAtLibrary(true), [])

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

  // The missing-permission screen. With no document it takes the welcome
  // screen's place (there is nothing else to look at); with one open — a failed
  // click in the recents list — it floats over it, because the document already
  // on screen must not disappear behind an error.
  const accessNotice = fileAccessPath && (
    <FileAccessNotice
      variant="blocked"
      onRetry={() => void openPath(fileAccessPath)}
      onOpenInBrowser={() => void openInBrowserViewer(fileAccessPath)}
      onDismiss={() => setFileAccessPath(null)}
    />
  )

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          {errorFallback && (
            <button className="btn-secondary" onClick={() => void openInBrowserViewer(errorFallback)}>
              {t('app.openInBrowser')}
            </button>
          )}
          {/* Dropping the encryption is the reader's call, never ours — so it is
              a button, and what it costs is on the button rather than in prose
              nobody reads. */}
          {insecureRetry && (
            <button
              className="btn-secondary"
              title={t('app.retryInsecureHint')}
              onClick={() => void openPath(insecureRetry)}
            >
              {t('app.retryInsecure')}
            </button>
          )}
          <button
            onClick={() => {
              setError(null)
              setErrorFallback(null)
              setInsecureRetry(null)
            }}
            aria-label="Lukk"
          >
            ✕
          </button>
        </div>
      )}

      {/* One stack, as in App.tsx: the viewer is never unmounted to show the
          library, it is a layer underneath (.tab-view is absolute + visibility).
          That is what lets you walk to the library and back without losing the
          page you were on — or, here, an unsaved annotation, since this shell
          has no draft file to fall back on. */}
      {payload ? (
        <div className="tab-views">
          <div className={`tab-view${atLibrary ? '' : ' active'}`}>
            <PdfViewer
              key={`${payload.path}:${epoch}`}
              payload={payload}
              initialPosition={initialPosition}
              active={!atLibrary}
              settings={settings}
              resolvedTheme={resolvedTheme}
              onSettingsChange={updateSettings}
              onPresentationChange={() => {}}
              // The extension has no tab strip of its own to reveal — the
              // browser's is right there above it.
              onChromeVisible={() => {}}
              onLeaveDocument={goToLibrary}
              onDirtyChange={() => {}}
              onSavedAs={() => {}} // extension: «save a copy» is a plain export (PLATFORMS.md §9)
              onExternalSaveConflict={handleSaveExternalConflict}
              onClose={goToLibrary}
              onOpenFile={openDialog}
            />
          </div>
          {atLibrary && (
            <div className="tab-view active">
              {/* The document is still mounted behind this — and with no tab
                  strip here, this button is the ONLY way back to it. Without
                  it the back arrow was a one-way door: unsaved marks stranded
                  behind a screen that offered nothing but "open another". */}
              <Welcome
                recents={recents}
                onOpenDialog={openDialog}
                onOpenRecent={openPath}
                resume={{ name: payload.name, onResume: () => setAtLibrary(false) }}
              />
            </div>
          )}
          {accessNotice && (
            <div className="fileaccess-backdrop" onMouseDown={() => setFileAccessPath(null)}>
              <div onMouseDown={(e) => e.stopPropagation()}>{accessNotice}</div>
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="ext-loading" />
      ) : accessNotice ? (
        <div className="fileaccess-screen">{accessNotice}</div>
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

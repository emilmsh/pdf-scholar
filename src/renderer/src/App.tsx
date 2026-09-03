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
import { commandForEvent, isKeyboardCaptured, setKeymapOverrides } from './keymap'
import { applyPageTune, tuneTitleBar } from './theme-tune'
import { createDocRegistry } from './doc-registry'
import { emitLocalDocEvent } from './local-doc-events'
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
  /** A DIFFERENT file shown in this tab's second split column («Åpne i delt
   *  visning»). null = the split, if open, shows `payload` — exactly the
   *  behaviour the split always had. The same path may simultaneously be open
   *  as its own tab: main keeps one draft per path, the local doc bus keeps
   *  the two views converged, and docRegistry keeps the bookkeeping honest. */
  splitDoc: { payload: FilePayload; initialPosition: ReadingPosition | null } | null
}


let tabCounter = 0

/** Refcounted wrapper around main's per-window open-document Set — a path can
 *  be on screen twice in one window (its own tab + another tab's split pane),
 *  and main must hear docClosed only when the LAST viewer goes away. One per
 *  window: each window is its own renderer process, so module scope is right. */
const docRegistry = createDocRegistry(
  (path) => bridge.docOpened(path),
  (path) => bridge.docClosed(path)
)

/** App-level draft retirements (discard flows) travel the local bus too, so a
 *  split pane showing the same path re-reads instead of showing dead marks. */
const discardDraft = async (path: string): Promise<void> => {
  await bridge.docDiscard(path)
  emitLocalDocEvent(path, 'draft-ended', null)
}

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
  /** The library is a PLACE, not the absence of documents (Emil, 2026-08-09).
   *
   *  It used to be neither: the button called «back to the library» was wired
   *  to closeTab, so with several documents open it closed one and landed you
   *  in the next, and with one open it closed that and the library appeared
   *  only because nothing was left. Going home cost you a document every time,
   *  and the open ones were invisible from there.
   *
   *  So this is a view flag, and NOT `activeId = null`: the active tab has to
   *  be remembered while you are away, or coming back would have to guess
   *  which document you meant. Every PdfViewer stays MOUNTED behind the library
   *  — `.tab-view` is absolute + visibility, never unmounted — so scroll
   *  position, zoom, split, panels and unsaved drafts are all still there when
   *  you return. Nothing is restored because nothing was torn down. */
  const [atLibrary, setAtLibrary] = useState(false)
  /** Same reason activeIdRef exists: the window-level key handler is bound once
   *  and would otherwise close over the flag's first value forever. */
  const atLibraryRef = useRef(atLibrary)
  atLibraryRef.current = atLibrary
  /** Go to a document. The ONE way a tab becomes active, so no caller can
   *  activate one while the library is still covering it. */
  const goToTab = useCallback((id: string) => {
    setActiveId(id)
    setAtLibrary(false)
  }, [])
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)
  /** «Dag» / «Sepia» / … flashed briefly when 'd' cycles the reading mode.
   *  The keyboard path needs it: the menu shows its own selection state, but a
   *  keypress recolours the page with nothing saying which mode you landed in
   *  (Emil, 2026-09-02). App-level like the shortcut itself, so it also works
   *  from the library. */
  const [themeToast, setThemeToast] = useState<string | null>(null)
  const themeToastTimerRef = useRef<number | null>(null)
  const flashThemeName = useCallback((name: string) => {
    setThemeToast(name)
    if (themeToastTimerRef.current) window.clearTimeout(themeToastTimerRef.current)
    themeToastTimerRef.current = window.setTimeout(() => setThemeToast(null), 1400)
  }, [])
  useEffect(
    () => () => {
      if (themeToastTimerRef.current) window.clearTimeout(themeToastTimerRef.current)
    },
    []
  )
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

  /** Tab ids whose SPLIT document (a different file in the second column) has
   *  unsaved changes — tracked apart from dirtyTabs because closing must be
   *  able to prompt for each document by name. */
  const [splitDirtyTabs, setSplitDirtyTabs] = useState<ReadonlySet<string>>(new Set())
  const splitDirtyTabsRef = useRef(splitDirtyTabs)
  splitDirtyTabsRef.current = splitDirtyTabs

  const setSplitTabDirty = useCallback((id: string, dirty: boolean) => {
    setSplitDirtyTabs((prev) => {
      if (prev.has(id) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  /** Same pattern: the shell key handler is bound once per dep change and
   *  must read the CURRENT theme when cycling, not the one at bind time. */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
  // plus the tone/strength override: inline --page-filter/--page-bg (and, for
  // a tinted tone, the chrome variables) on <html> beat the theme block by
  // cascade, and every consumer reads the variables — one write retunes them
  // all. Untuned = the properties are REMOVED, so an untouched theme stays
  // exactly the shipped CSS. The native window-controls overlay follows: the
  // static map (MUST mirror --bg-titlebar / --text in app.css) unless the
  // active tone derives its own pair.
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    applyPageTune(resolvedTheme, settings.themeTune, settings.customTone, settings.nightTone)
    const overlay: Record<ThemeName, [string, string]> = {
      day: ['#ededf0', '#1d1d1f'],
      sepia: ['#e9e6db', '#3d3929'],
      night: ['#21211f', '#eeece2'],
      nightHc: ['#111113', '#f5f5f7'],
      custom: ['#ededf0', '#1d1d1f']
    }
    const toned = tuneTitleBar(resolvedTheme, settings.customTone, settings.nightTone)
    bridge.setTitleBarColors(...(toned ?? overlay[resolvedTheme]))
  }, [resolvedTheme, settings.themeTune, settings.customTone, settings.nightTone])

  // OS fullscreen hides the titlebar strip (the native controls hide too)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => bridge.onFullScreen(setFullscreen), [])
  /** Is the active viewer showing its toolbar? In fullscreen the tab strip
   *  rides along with it, so reaching for the top brings the whole of the
   *  chrome back at once instead of half of it. */
  const [chromeVisible, setChromeVisible] = useState(true)

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

  // Same for the keyboard map: the key handlers are not components, so the
  // rebound shortcuts are mirrored into keymap.ts's own store where they can be
  // read synchronously from a keydown listener.
  useEffect(() => {
    setKeymapOverrides(settings.keymap)
  }, [settings.keymap])

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
      if (closing) {
        docRegistry.release(closing.payload.path)
        // The split column's document is a viewer of its own path too
        if (closing.splitDoc) docRegistry.release(closing.splitDoc.payload.path)
      }
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
    setSplitDirtyTabs((prev) => {
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
            goToTab(existing.id)
            return
          }
          await discardDraft(existing.payload.path)
          setTabDirty(existing.id, false)
        }
        goToTab(existing.id)
        const initialPosition = await bridge.getPosition(payload.path)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existing.id ? { ...t, payload, initialPosition, epoch: t.epoch + 1 } : t
          )
        )
        return
      }
      const initialPosition = await bridge.getPosition(payload.path)
      const tab: OpenTab = {
        id: `tab-${++tabCounter}`,
        payload,
        initialPosition,
        epoch: 0,
        splitDoc: null
      }
      docRegistry.acquire(payload.path)
      setTabs((prev) => [...prev, tab])
      goToTab(tab.id)
      setError(null)
    },
    [confirmExternalUpdateVerdict, setTabDirty, goToTab]
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
      await discardDraft(path)
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
    [confirmExternalUpdateVerdict, setTabDirty, goToTab]
  )

  /** Close the split column's document (a different file in pane B): the same
   *  unsaved-changes guard a tab close runs, but only when this pane is the
   *  LAST viewer of the path in this window — a tab still showing the same
   *  file keeps the draft alive, so there is nothing to ask about yet.
   *  Resolves to whether the pane actually closed. */
  const closeSplitDoc = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      const split = tab?.splitDoc
      if (!tab || !split) return true
      const path = split.payload.path
      if (docRegistry.count(path) <= 1 && splitDirtyTabsRef.current.has(tabId)) {
        const outcome = await confirmCloseVerdict(path, split.payload.name)
        if (outcome.verdict === 'cancel') {
          reportCloseFailure(outcome)
          return false
        }
      }
      docRegistry.release(path)
      setSplitTabDirty(tabId, false)
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, splitDoc: null } : t)))
      return true
    },
    [confirmCloseVerdict, reportCloseFailure, setSplitTabDirty]
  )

  /** «Åpne i delt visning»: show `path` in the second column of `hostTabId`.
   *  Fresh readFile — main resolves any existing draft behind it, so the pane
   *  shows the file's live edited state. The source tab (if any) stays open:
   *  same model as two windows on one file, one draft in main, views converge
   *  over the doc buses. */
  const openInSplit = useCallback(
    async (hostTabId: string, path: string, picked?: FilePayload) => {
      const host = tabsRef.current.find((t) => t.id === hostTabId)
      if (!host) return
      // Same file as the host document: that is the plain same-file split —
      // the viewer opens it itself (the entry points already route there)
      if (host.payload.path === path) return
      if (host.splitDoc) {
        if (host.splitDoc.payload.path === path) {
          goToTab(hostTabId)
          return
        }
        // Replacing a foreign split runs its close guard first
        if (!(await closeSplitDoc(hostTabId))) return
      }
      const result = picked ?? (await bridge.readFile(path))
      if ('error' in result) {
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      const initialPosition = await bridge.getPosition(path)
      docRegistry.acquire(path)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === hostTabId ? { ...t, splitDoc: { payload: result, initialPosition } } : t
        )
      )
      goToTab(hostTabId)
    },
    [closeSplitDoc, goToTab]
  )

  /** «Annen fil …» under «Åpne i delt visning» in the view menu: pick a PDF and
   *  show it in the host tab's split column */
  const openOtherInSplit = useCallback(
    async (hostTabId: string) => {
      const result = await bridge.openFileDialog()
      if (!result) return
      if ('error' in result) {
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      await openInSplit(hostTabId, result.path, result)
    },
    [openInSplit]
  )

  /** Closing pane A while pane B shows a different file: the reader is keeping
   *  the OTHER document, so it takes over the tab. If it already has a tab of
   *  its own, the host tab simply closes and that tab comes forward. */
  const promoteSplitDoc = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      const split = tab?.splitDoc
      if (!tab || !split) return
      const yTab = tabsRef.current.find(
        (t) => t.id !== tabId && t.payload.path === split.payload.path
      )
      if (yTab) {
        // closeTabAwait handles both documents' guards (split prompt is
        // skipped — Y's own tab keeps its draft alive)
        const closed = await closeTabAwaitRef.current(tabId)
        if (closed) goToTab(yTab.id)
        return
      }
      // The host document leaves this window — guard its draft if this viewer
      // is the last one showing it
      if (dirtyTabsRef.current.has(tabId) && docRegistry.count(tab.payload.path) <= 1) {
        const outcome = await confirmCloseVerdict(tab.payload.path, tab.payload.name)
        if (outcome.verdict === 'cancel') {
          reportCloseFailure(outcome)
          return
        }
      }
      const result = await bridge.readFile(split.payload.path)
      if ('error' in result) return
      const initialPosition = await bridge.getPosition(split.payload.path)
      docRegistry.release(tab.payload.path)
      // The pane's acquire on Y carries over to the tab — no registry change
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, payload: result, initialPosition, epoch: t.epoch + 1, splitDoc: null }
            : t
        )
      )
      setTabDirty(tabId, false)
      setSplitTabDirty(tabId, false)
    },
    [confirmCloseVerdict, reportCloseFailure, setTabDirty, setSplitTabDirty, goToTab]
  )

  /** Close with the unsaved-changes prompt when the tab is dirty. Resolves to
   *  whether the tab actually went away, so a bulk close can ask about one tab at
   *  a time instead of stacking a dialog per dirty document. */
  const closeTabAwait = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return false
      // The split column's document first, sequentially — two unsaved
      // documents must not stack two dialogs (same rule closeTabs follows)
      if (tab.splitDoc && !(await closeSplitDoc(id))) return false
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
    [reallyCloseTab, confirmCloseVerdict, reportCloseFailure, closeSplitDoc]
  )
  /** promoteSplitDoc needs closeTabAwait, which is declared after it — the ref
   *  breaks the cycle the same way the viewer's late-bound refs do. */
  const closeTabAwaitRef = useRef<(id: string) => Promise<boolean>>(() => Promise.resolve(false))
  closeTabAwaitRef.current = closeTabAwait

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
      goToTab(id)
    },
    [setTabDirty, confirmCloseVerdict, reportCloseFailure, goToTab]
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
        await discardDraft(newPath)
        reallyCloseTab(other.id)
      }
      const result = await bridge.readFile(newPath)
      if ('error' in result) return // the copy is safely on disk; stay on the original
      await discardDraft(oldPath)
      if (oldPath !== newPath) {
        docRegistry.release(oldPath)
        docRegistry.acquire(newPath)
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
    // Ctrl+Tab from the library goes BACK INTO the documents rather than
    // cycling invisibly behind it — with one open it is the only one, so the
    // early return below would otherwise make the key do nothing at all.
    if (tabsRef.current.length > 0) setAtLibrary(false)
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
          goToTab(existing.id)
          return
        }
        // 'save' (copy flushed elsewhere) or 'discard': the old draft is no
        // longer needed — drop it and fall through to load the fresh bytes.
        await discardDraft(path)
        setTabDirty(existing.id, false)
      }
      // Existing-but-clean tabs fall through: re-read so an externally updated
      // file shows its latest bytes (openPayload swaps them into the tab).
      const result = await bridge.readFile(path)
      if ('error' in result) {
        if (existing) {
          goToTab(existing.id) // file gone/busy — keep showing what we have
          return
        }
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      await openPayload(result)
    },
    [openPayload, confirmExternalUpdateVerdict, setTabDirty, goToTab]
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

  // A detached assistant asked for a citation in one of our documents: bring
  // that document's tab forward (and leave the library). The mounted viewer's
  // own subscription performs the jump and answers for it — this one always
  // returns false so it can never ack a jump nobody displayed.
  useEffect(
    () =>
      bridge.onAssistantJumpRequest((path) => {
        const tab = tabsRef.current.find((t) => t.payload.path === path)
        if (tab) goToTab(tab.id)
        return false
      }),
    [goToTab]
  )

  // Refresh recents whenever the library comes into view — the last tab
  // closing, or simply walking back to it. Reading a document is exactly what
  // changes this list, so arriving with the version from an hour ago would
  // show a stale «recent» every time.
  useEffect(() => {
    if (atLibrary || tabs.length === 0) refreshRecents()
  }, [atLibrary, tabs.length, refreshRecents])

  // Shell-level shortcuts (tabs, windows, opening a file). Which keys reach
  // them is keymap.ts's business — this only says what each command does. The
  // shipped bindings are the ones they always had: Ctrl+Tab cycles (Ctrl on mac
  // too, Cmd+Tab being the OS app switcher), Cmd/Ctrl+W closes, Cmd/Ctrl+O opens.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // The shortcuts dialog is recording a chord — every key belongs to it
      if (isKeyboardCaptured()) return
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      const command = commandForEvent(e, typing)
      if (!command) return
      const moveActiveTab = (delta: number): void => {
        const id = activeIdRef.current
        if (!id) return
        const at = tabsRef.current.findIndex((t) => t.id === id)
        if (at === -1) return
        e.preventDefault()
        moveTab(id, at + delta)
      }
      switch (command) {
        case 'tab.next':
          e.preventDefault()
          cycleTab(1)
          break
        case 'tab.prev':
          e.preventDefault()
          cycleTab(-1)
          break
        case 'tab.close':
          e.preventDefault()
          // Read the active id from a ref, not a setActiveId updater: closing runs
          // its own setActiveId to pick the neighbour, and returning `current` from
          // an outer updater would clobber that and leave no active tab.
          // Nothing to close from the library: activeId still names the document
          // you will return to, and closing it from there would shut a document
          // you are not even looking at.
          if (activeIdRef.current && !atLibraryRef.current) closeTab(activeIdRef.current)
          break
        case 'window.new':
          e.preventDefault()
          bridge.newWindow()
          break
        case 'file.open':
          e.preventDefault()
          void openDialog()
          break
        // Cycle the reading mode through the four core themes. App-level, not
        // the viewer's switch: the theme is an app setting and the key must
        // work with no document open. 'auto' and 'custom' are not IN the cycle
        // (auto is a policy, custom is a menu choice) — from either, the first
        // press lands on day, which indexOf's −1 gives for free.
        case 'view.cycleTheme': {
          e.preventDefault()
          const order = ['day', 'sepia', 'night', 'nightHc'] as const
          const labels = {
            day: 'tb.themeDay',
            sepia: 'tb.themeSepia',
            night: 'tb.themeNight',
            nightHc: 'tb.themeNightHc'
          } as const
          const at = (order as readonly string[]).indexOf(settingsRef.current.theme)
          const next = order[(at + 1) % order.length]
          updateSettings({ theme: next })
          flashThemeName(t(labels[next]))
          break
        }
        // Moving the active tab — the browser shortcut for the same thing
        case 'tab.moveLeft':
          moveActiveTab(-1)
          break
        case 'tab.moveRight':
          moveActiveTab(1)
          break
        default:
          // Every other command belongs to the viewer, which has its own listener
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cycleTab, closeTab, openDialog, moveTab, updateSettings, flashThemeName])

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
      {/* The reading mode 'd' just landed in — keyed so a rapid cycle replays
          the pop-in per step instead of one long static pill */}
      {themeToast && (
        <div key={themeToast} className="toast app-toast" role="status">
          {themeToast}
        </div>
      )}

      <TabBar
        tabs={tabs.map((t) => ({
          id: t.id,
          name: t.payload.name,
          path: t.payload.path,
          // Either document in the tab (its own, or the split column's other
          // file) having unsaved changes lights the dot
          dirty: dirtyTabs.has(t.id) || splitDirtyTabs.has(t.id)
        }))}
        // No tab is the current one while the library is showing — the strip
        // stays, so the open documents are visible and one click away from
        // there, but none of them is what you are looking at.
        activeId={atLibrary ? null : activeId}
        // Fullscreen tucks the strip — but reaching for the top brings it
        // back with the toolbar. Only worth it with MORE THAN ONE tab: with a
        // single document open the strip is a title bar, and revealing it adds
        // nothing to a reader who went fullscreen to be rid of exactly that.
        // At the library the strip is the only way back to a document, so it
        // is never tucked there.
        hidden={
          !atLibrary && (presenting || (fullscreen && (tabs.length < 2 || !chromeVisible)))
        }
        onSelect={goToTab}
        onClose={closeTab}
        onNewTab={() => void openDialog()}
        onNewWindow={() => bridge.newWindow()}
        onOpenInNewWindow={(path) => bridge.newWindow(path)}
        onShowInFolder={(path) => bridge.showInFolder(path)}
        // Fire-and-forget: zotero:// works without the local API, and the tab
        // menu has no hint surface — the save menu's Zotero section is where
        // failures get named.
        onShowInZotero={(path) => void bridge.zoteroSelect(path)}
        onTabDragOut={(id, path) => void moveTabOut(id, path)}
        onReorder={moveTab}
        onCloseMany={(ids) => void closeTabs(ids)}
        onMoveToNewWindow={moveToNewWindow}
        onReload={(id, path) => void reloadTab(id, path)}
        onOpenInSplit={(path) => {
          const host = activeIdRef.current
          if (host && !atLibraryRef.current) void openInSplit(host, path)
        }}
      />

      {/* One stack, always. The documents are NEVER unmounted to show the
          library — they are layers under it, hidden the same way an inactive
          tab is (`.tab-view` = absolute + visibility). That is the whole
          mechanism behind "go home and come back without losing your place":
          there is no place to restore, because the viewer never stopped
          existing. Unmounting here instead would throw away scroll position,
          zoom, the split, open panels and any unsaved draft. */}
      <div className="tab-views">
        {tabs.map((tab) => {
          const showing = tab.id === activeId && !atLibrary
          return (
            <div key={`${tab.id}:${tab.epoch}`} className={`tab-view${showing ? ' active' : ''}`}>
              <PdfViewer
                payload={tab.payload}
                initialPosition={tab.initialPosition}
                active={showing}
                settings={settings}
                resolvedTheme={resolvedTheme}
                onSettingsChange={updateSettings}
                onPresentationChange={setPresenting}
                onChromeVisible={setChromeVisible}
                onDirtyChange={(dirty) => setTabDirty(tab.id, dirty)}
                onSavedAs={(path) => void adoptSavedCopy(tab.id, path)}
                onExternalSaveConflict={handleSaveExternalConflict}
                onClose={() => closeTab(tab.id)}
                onLeaveDocument={() => setAtLibrary(true)}
                splitDoc={tab.splitDoc}
                onSplitDirtyChange={(dirty) => setSplitTabDirty(tab.id, dirty)}
                onRequestCloseSplitDoc={() => void closeSplitDoc(tab.id)}
                onRequestPromoteSplitDoc={() => void promoteSplitDoc(tab.id)}
                onRequestOpenInSplit={(path) => void openInSplit(tab.id, path)}
                splitCandidates={
                  isElectron
                    ? tabs
                        .filter((o) => o.id !== tab.id)
                        .map((o) => ({ name: o.payload.name, path: o.payload.path }))
                    : undefined
                }
                onRequestOpenOtherInSplit={isElectron ? () => void openOtherInSplit(tab.id) : undefined}
              />
            </div>
          )
        })}
        {/* With nothing open the library is not a choice, it is all there is */}
        {(atLibrary || tabs.length === 0) && (
          <div className="tab-view active">
            <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />
          </div>
        )}
      </div>
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

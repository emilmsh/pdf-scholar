import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FilePayload,
  ReadingPosition,
  RecentFile,
  Settings,
  ThemeName
} from '../../shared/types'
import { bridge } from './bridge'
import { setLanguage } from './i18n'
import PdfViewer from './components/PdfViewer'
import TabBar from './components/TabBar'
import Welcome from './components/Welcome'

interface OpenTab {
  id: string
  payload: FilePayload
  initialPosition: ReadingPosition | null
}

const FALLBACK_SETTINGS: Settings = {
  theme: 'day',
  keepAwake: false,
  language: 'auto',
  showTabBar: false
}

let tabCounter = 0

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)
  /** Active tab is in distraction-free mode → tuck the tab bar too */
  const [immersive, setImmersive] = useState(false)
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
    settings.theme === 'auto' ? (systemDark ? 'night' : 'day') : settings.theme

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Apply the resolved theme (all page recoloring lives in the theme's CSS)
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
  }, [resolvedTheme])

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

  const openPayload = useCallback(async (payload: FilePayload) => {
    const existing = tabsRef.current.find((t) => t.payload.path === payload.path)
    if (existing) {
      setActiveId(existing.id)
      setError(null)
      return
    }
    const initialPosition = await bridge.getPosition(payload.path)
    const tab: OpenTab = { id: `tab-${++tabCounter}`, payload, initialPosition }
    bridge.docOpened(payload.path)
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
    setError(null)
  }, [])

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

  /** Close with the unsaved-changes prompt when the tab is dirty */
  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (!dirtyTabsRef.current.has(id)) {
        reallyCloseTab(id)
        return
      }
      void bridge.docConfirmClose(tab.payload.path).then((verdict) => {
        if (verdict === 'cancel') return
        reallyCloseTab(id)
      })
    },
    [reallyCloseTab]
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
      if (existing) {
        setActiveId(existing.id)
        return
      }
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

  // Tab shortcuts: Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+W close, Ctrl+O open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      } else if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        setActiveId((current) => {
          if (current) closeTab(current)
          return current
        })
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        bridge.newWindow()
      } else if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
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

      {tabs.length > 0 && settings.showTabBar && (
        <TabBar
          tabs={tabs.map((t) => ({
            id: t.id,
            name: t.payload.name,
            path: t.payload.path,
            dirty: dirtyTabs.has(t.id)
          }))}
          activeId={activeId}
          hidden={immersive}
          onSelect={setActiveId}
          onClose={closeTab}
          onNewTab={() => void openDialog()}
          onNewWindow={() => bridge.newWindow()}
          onOpenInNewWindow={(path) => bridge.newWindow(path)}
        />
      )}

      {tabs.length > 0 ? (
        <div className="tab-views">
          {tabs.map((tab) => (
            <div key={tab.id} className={`tab-view${tab.id === activeId ? ' active' : ''}`}>
              <PdfViewer
                payload={tab.payload}
                initialPosition={tab.initialPosition}
                active={tab.id === activeId}
                settings={settings}
                resolvedTheme={resolvedTheme}
                onSettingsChange={updateSettings}
                onImmersiveChange={setImmersive}
                onDirtyChange={(dirty) => setTabDirty(tab.id, dirty)}
                docs={tabs.map((d) => ({
                  id: d.id,
                  name: d.payload.name,
                  path: d.payload.path,
                  dirty: dirtyTabs.has(d.id),
                  active: d.id === activeId
                }))}
                onSelectDoc={setActiveId}
                onCloseDoc={closeTab}
                onOpenDialog={() => void openDialog()}
                onNewWindow={(path) => bridge.newWindow(path)}
                onClose={() => closeTab(tab.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />
      )}
    </div>
  )
}

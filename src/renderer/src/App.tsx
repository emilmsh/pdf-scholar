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
  themeAdjust: {
    day: { contrast: 1, brightness: 1 },
    sepia: { contrast: 1, brightness: 1 },
    night: { contrast: 1, brightness: 1 }
  },
  keepAwake: false,
  language: 'auto'
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

  // Apply resolved theme + per-theme page adjustments as CSS variables
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    const adjust = settings.themeAdjust[resolvedTheme]
    root.style.setProperty('--page-contrast', String(adjust.contrast))
    root.style.setProperty('--page-brightness', String(adjust.brightness))
  }, [resolvedTheme, settings.themeAdjust])

  // Keep the i18n store in sync with the language setting
  useEffect(() => {
    setLanguage(settings.language)
  }, [settings.language])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => ({
      ...prev,
      ...patch,
      themeAdjust: { ...prev.themeAdjust, ...patch.themeAdjust }
    }))
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
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
    setError(null)
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      setActiveId((current) => {
        if (current !== id) return current
        return next[Math.min(index, next.length - 1)]?.id ?? null
      })
      return next
    })
  }, [])

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

      {tabs.length > 0 && (
        <TabBar
          tabs={tabs.map((t) => ({ id: t.id, name: t.payload.name, path: t.payload.path }))}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeTab}
          onNewTab={() => void openDialog()}
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

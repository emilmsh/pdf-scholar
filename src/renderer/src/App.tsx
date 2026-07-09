import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  FilePayload,
  ReadingPosition,
  RecentFile,
  Settings,
  ThemeName
} from '../../shared/types'
import { bridge } from './bridge'
import PdfViewer from './components/PdfViewer'
import Welcome from './components/Welcome'

interface OpenDocument {
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
  keepAwake: false
}

export default function App(): React.JSX.Element {
  const [doc, setDoc] = useState<OpenDocument | null>(null)
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [error, setError] = useState<string | null>(null)

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

  const openPayload = useCallback(async (payload: FilePayload) => {
    const initialPosition = await bridge.getPosition(payload.path)
    setDoc({ payload, initialPosition })
    setError(null)
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

  useEffect(() => {
    bridge.getSettings().then(setSettingsState)
    refreshRecents()
    bridge.getPendingPath().then((path) => {
      if (path) openPath(path)
    })
    return bridge.onOpenPath((path) => openPath(path))
  }, [refreshRecents, openPath])

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

  const closeDocument = useCallback(() => {
    setDoc(null)
    refreshRecents()
  }, [refreshRecents])

  const viewer = useMemo(() => {
    if (!doc) return null
    return (
      <PdfViewer
        key={doc.payload.path}
        payload={doc.payload}
        initialPosition={doc.initialPosition}
        settings={settings}
        resolvedTheme={resolvedTheme}
        onSettingsChange={updateSettings}
        onClose={closeDocument}
      />
    )
  }, [doc, settings, resolvedTheme, updateSettings, closeDocument])

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
      {viewer ?? <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { FilePayload, ReadingPosition, RecentFile, ThemeName } from '../../shared/types'
import { bridge } from './bridge'
import PdfViewer from './components/PdfViewer'
import Welcome from './components/Welcome'

interface OpenDocument {
  payload: FilePayload
  initialPosition: ReadingPosition | null
}

export default function App(): React.JSX.Element {
  const [doc, setDoc] = useState<OpenDocument | null>(null)
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [theme, setThemeState] = useState<ThemeName>('day')
  const [error, setError] = useState<string | null>(null)

  const applyTheme = useCallback((t: ThemeName, persist = true) => {
    setThemeState(t)
    document.documentElement.dataset.theme = t
    if (persist) bridge.setTheme(t)
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
    bridge.getSettings().then((s) => applyTheme(s.theme, false))
    refreshRecents()
    bridge.getPendingPath().then((path) => {
      if (path) openPath(path)
    })
    return bridge.onOpenPath((path) => openPath(path))
  }, [applyTheme, refreshRecents, openPath])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
      const realPath = bridge.getPathForFile(file)
      if (realPath) {
        await openPath(realPath)
      } else {
        await openPayload({ path: file.name, name: file.name, data: new Uint8Array(await file.arrayBuffer()) })
      }
    },
    [openPath, openPayload]
  )

  const closeDocument = useCallback(() => {
    setDoc(null)
    refreshRecents()
  }, [refreshRecents])

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
      {doc ? (
        <PdfViewer
          key={doc.payload.path}
          payload={doc.payload}
          initialPosition={doc.initialPosition}
          theme={theme}
          onThemeChange={applyTheme}
          onClose={closeDocument}
        />
      ) : (
        <Welcome recents={recents} onOpenDialog={openDialog} onOpenRecent={openPath} />
      )}
    </div>
  )
}

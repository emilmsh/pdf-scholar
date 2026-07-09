// Types shared between the Electron main process, preload bridge and renderer.

export type ThemeName = 'day' | 'sepia' | 'night'

export interface Settings {
  theme: ThemeName
}

export interface RecentFile {
  path: string
  name: string
  lastOpened: number
}

export interface ReadingPosition {
  /** 1-based page number of the topmost visible page */
  page: number
  /** Scroll offset within that page as a fraction of page height (0–1) */
  offset: number
  zoom: number
}

export interface FilePayload {
  path: string
  name: string
  data: Uint8Array
}

export interface FileError {
  error: string
}

export interface PdfxApi {
  openFileDialog(): Promise<FilePayload | FileError | null>
  readFile(path: string): Promise<FilePayload | FileError>
  getRecents(): Promise<RecentFile[]>
  getSettings(): Promise<Settings>
  getPosition(path: string): Promise<ReadingPosition | null>
  getPendingPath(): Promise<string | null>
  setPosition(path: string, pos: ReadingPosition): void
  setTheme(theme: ThemeName): void
  /** Resolve the real filesystem path of a File dropped onto the window (Electron only) */
  getPathForFile(file: File): string | null
  onOpenPath(cb: (path: string) => void): () => void
}

declare global {
  interface Window {
    api?: PdfxApi
  }
}

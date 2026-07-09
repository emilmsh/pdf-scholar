// Types shared between the Electron main process, preload bridge and renderer.

export type ThemeName = 'day' | 'sepia' | 'night'
/** User's theme choice — 'auto' follows the OS light/dark setting */
export type ThemePreference = ThemeName | 'auto'

/** Per-theme page adjustments; 1 = neutral, sensible range 0.6–1.4 */
export interface ThemeAdjust {
  contrast: number
  brightness: number
}

export interface Settings {
  theme: ThemePreference
  themeAdjust: Record<ThemeName, ThemeAdjust>
  keepAwake: boolean
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

export type AnnotationType = 'highlight' | 'underline' | 'strikeout' | 'note'

/** Rect in PDF points, origin at the page's top-left, y growing downward
 *  (MuPDF page space — same direction as pdf.js viewport space). */
export interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

export interface AnnotateRequest {
  path: string
  /** 0-based page index */
  pageIndex: number
  type: AnnotationType
  quads: PageRect[]
  /** rgb 0–1 */
  color: [number, number, number]
  opacity: number
  contents?: string
  author?: string
}

export type AnnotateResult = { ok: true } | FileError

export interface PdfxApi {
  openFileDialog(): Promise<FilePayload | FileError | null>
  readFile(path: string): Promise<FilePayload | FileError>
  getRecents(): Promise<RecentFile[]>
  getSettings(): Promise<Settings>
  getPosition(path: string): Promise<ReadingPosition | null>
  getPendingPath(): Promise<string | null>
  setPosition(path: string, pos: ReadingPosition): void
  setSettings(patch: Partial<Settings>): void
  /** Write an annotation into the PDF file (mupdf, incremental save) */
  annotate(req: AnnotateRequest): Promise<AnnotateResult>
  /** Open an http(s) URL in the system browser */
  openExternal(url: string): void
  setFullscreen(on: boolean): void
  /** Resolve the real filesystem path of a File dropped onto the window (Electron only) */
  getPathForFile(file: File): string | null
  onOpenPath(cb: (path: string) => void): () => void
}

declare global {
  interface Window {
    api?: PdfxApi
  }
}

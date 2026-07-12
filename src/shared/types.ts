// Types shared between the Electron main process, preload bridge and renderer.

export type ThemeName = 'day' | 'sepia' | 'night'
/** User's theme choice — 'auto' follows the OS light/dark setting */
export type ThemePreference = ThemeName | 'auto'

/** Per-theme page adjustments; 1 = neutral, sensible range 0.6–1.4 */
export interface ThemeAdjust {
  contrast: number
  brightness: number
}

/** UI language — 'auto' follows the OS/browser language */
export type LanguagePreference = 'nb' | 'en' | 'auto'

export interface Settings {
  theme: ThemePreference
  themeAdjust: Record<ThemeName, ThemeAdjust>
  keepAwake: boolean
  language: LanguagePreference
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

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'freetext'

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
  /** ink: freehand strokes; line/arrow: [[start, end]] — in page space */
  strokes?: [number, number][][]
  /** ink/shapes: stroke width in PDF points */
  width?: number
  /** freetext only */
  fontSize?: number
}

/** On success carries the PDF object number of the (new) annotation */
export type AnnotateResult = { ok: true; id: number } | FileError

export interface ModifyAnnotationRequest {
  path: string
  /** 0-based page index */
  pageIndex: number
  /** PDF object number identifying the annotation */
  id: number
  color?: [number, number, number]
  opacity?: number
  contents?: string
  /** Move/resize (note drag) — page space, top-left origin */
  rect?: PageRect
}

export interface DeleteAnnotationRequest {
  path: string
  pageIndex: number
  id: number
}

// ---------- AI (BYO API key, multi-provider) ----------

export type AiProviderId = 'anthropic' | 'openai' | 'azure' | 'mock'

/** How hard the model should reason; mapped per provider/model in main */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export interface AiConfig {
  provider: AiProviderId
  /** Model id/deployment per provider */
  models: Record<AiProviderId, string>
  azure: { endpoint: string; deployment: string }
  /** Reasoning effort (default 'medium') */
  thinking: ThinkingLevel
}

/** Config as exposed to the renderer — keys never leave the main process */
export interface AiConfigView extends AiConfig {
  hasKey: Record<AiProviderId, boolean>
  encryptionAvailable: boolean
}

export interface AiMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AiChatRequest {
  requestId: number
  system: string
  messages: AiMessage[]
  /** Page-joined document text; sent with citations enabled where supported */
  document: { title: string; text: string } | null
}

/** Normalized citation. 'char' = offsets into the document text we sent
 *  (Anthropic char_location); 'quote' = verbatim quote + page, resolved by
 *  the renderer via text search (prompt-contract providers). */
export type AiCitation =
  | { kind: 'char'; start: number; end: number; citedText: string }
  | { kind: 'quote'; pageNumber: number; quote: string }

export interface AiContentPart {
  text: string
  citations: AiCitation[]
}

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type AiChatResult =
  | { ok: true; parts: AiContentPart[]; usage: AiUsage; model: string }
  | FileError

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
  /** Change color/opacity/contents of an existing annotation */
  updateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult>
  deleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult>
  /** Open an http(s) URL in the system browser */
  openExternal(url: string): void
  /** Open the system print dialog for the PDF file */
  printFile(path: string): Promise<{ ok: true } | FileError>
  /** Save text content via a save dialog; null = user cancelled */
  saveTextFile(defaultName: string, content: string): Promise<{ path: string } | FileError | null>
  setFullscreen(on: boolean): void
  /** Resolve the real filesystem path of a File dropped onto the window (Electron only) */
  getPathForFile(file: File): string | null
  onOpenPath(cb: (path: string) => void): () => void
  // ---------- AI ----------
  aiGetConfig(): Promise<AiConfigView>
  /** Patch config; `keys` entries are plaintext and encrypted at rest in main */
  aiSetConfig(patch: Partial<AiConfig> & { keys?: Partial<Record<AiProviderId, string>> }): Promise<AiConfigView>
  /** Streams deltas via onAiDelta; resolves with the final result */
  aiChat(request: AiChatRequest): Promise<AiChatResult>
  aiAbort(requestId: number): void
  onAiDelta(cb: (requestId: number, text: string) => void): () => void
}

declare global {
  interface Window {
    api?: PdfxApi
  }
}

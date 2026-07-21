// Types shared between the Electron main process, preload bridge and renderer.

/** 'night' is the softer dark mode; 'nightHc' is the high-contrast one */
export type ThemeName = 'day' | 'sepia' | 'night' | 'nightHc'
/** User's theme choice — 'auto' follows the OS light/dark setting */
export type ThemePreference = ThemeName | 'auto'

/** UI language — 'auto' follows the OS/browser language */
export type LanguagePreference = 'nb' | 'en' | 'auto'

export interface Settings {
  theme: ThemePreference
  /** Which light theme 'auto' resolves to when the OS is in light mode */
  autoLight: 'day' | 'sepia'
  /** Which dark theme 'auto' resolves to when the OS is in dark mode */
  autoDark: 'night' | 'nightHc'
  keepAwake: boolean
  language: LanguagePreference
}

export interface RecentFile {
  path: string
  name: string
  lastOpened: number
}

/** User-applied view rotation in clockwise degrees (added on top of the
 *  page's intrinsic /Rotate). Not baked into the file — a display setting. */
export type ViewRotation = 0 | 90 | 180 | 270

export interface ReadingPosition {
  /** 1-based page number of the topmost visible page */
  page: number
  /** Scroll offset within that page as a fraction of page height (0–1) */
  offset: number
  zoom: number
  /** View rotation (clockwise degrees); absent = 0 */
  rotation?: ViewRotation
  /** Two-page spread on? absent = false */
  spread?: boolean
}

export interface FilePayload {
  path: string
  name: string
  data: Uint8Array
}

export interface FileError {
  error: string
}

/** Outcome of dropping a dragged tab (see PdfxApi.tabDropAtCursor) */
export type TabDropResult = 'window' | 'new' | 'same'

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
  /** ink (marker): bake the appearance with /BM Multiply so text under the
   *  stroke stays legible — the freehand twin of a text highlight */
  blend?: 'multiply'
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
  /** Move: translate all geometry by (dx, dy) in page space (top-left origin,
   *  y down). The engine reads the annotation's own geometry and writes it
   *  back shifted — Line via setLine (getRect/setRect throw on Line in mupdf
   *  1.28), Ink via setInkList, everything else via setRect. */
  translate?: { dx: number; dy: number }
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
  /** Whether this platform can store provider API keys at all (desktop and
   *  extension can; the plain-web preview is mock-only). Drives the
   *  "add your API key" callout in the assistant. */
  keysSupported: boolean
}

/** An image attached to a user message (figure snip, pasted screenshot).
 *  Raw base64 without the data: prefix; mediaType e.g. 'image/png'. */
export interface AiImage {
  mediaType: string
  dataBase64: string
}

export interface AiMessage {
  role: 'user' | 'assistant'
  text: string
  /** Only meaningful on user messages */
  images?: AiImage[]
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

/** Result of a manual "check for updates".
 *  - available: newer version detected, not downloaded (offer a download)
 *  - ready: an update is already downloaded and installs on quit/restart
 *  - none: this is the latest version
 *  - unsupported: this build doesn't self-update (dev run, unsigned macOS,
 *    or Microsoft Store — the Store owns the update cycle there)
 *  - error: the check itself failed (offline, rate-limited, …) */
export interface UpdateCheckOutcome {
  status: 'available' | 'ready' | 'none' | 'unsupported' | 'error'
  /** Version on offer (available/ready) */
  version?: string
  /** Currently running app version */
  current: string
  /** Why self-update is unsupported, when status = 'unsupported' */
  reason?: 'dev' | 'mac' | 'store'
}

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
  /** Open a new app window, optionally loading a document (side-by-side use) */
  newWindow(path?: string): void
  /** A tab was dragged out and released. Main hit-tests the cursor against
   *  every window: 'window' = handed to another window (merge), 'new' = torn
   *  off into a fresh window, 'same' = dropped back on the source (no-op).
   *  The source closes its tab for 'window'/'new'. */
  tabDropAtCursor(path: string): Promise<TabDropResult>
  // ---------- Save model (annotation edits go to a draft, not the file) ----------
  /** Tell main a document is open in this window (unsaved-changes guard) */
  docOpened(path: string): void
  docClosed(path: string): void
  /** True when the document has unsaved annotation changes (a draft exists) */
  docIsDirty(path: string): Promise<boolean>
  /** Write the draft back over the original file */
  docSave(path: string): Promise<{ ok: true } | FileError>
  /** Native save/discard/cancel prompt; performs the chosen action */
  docConfirmClose(path: string): Promise<'save' | 'discard' | 'cancel'>
  /** Open the system print dialog for the PDF file */
  printFile(path: string): Promise<{ ok: true } | FileError>
  /** Save text content via a save dialog; null = user cancelled */
  saveTextFile(defaultName: string, content: string): Promise<{ path: string } | FileError | null>
  /** Save a copy of the current PDF to a user-chosen location. `data` is the
   *  renderer's bytes (used by the web/extension download path); Electron
   *  prefers `path` so unsaved annotation edits (the draft) are included.
   *  null = user cancelled. */
  saveFileAs(
    defaultName: string,
    data: Uint8Array,
    path?: string
  ): Promise<{ path: string } | FileError | null>
  /** Persist final PDF bytes for the browser save flow: overwrites the original
   *  local file when it was opened via a file handle, otherwise prompts for a
   *  location. `name` is the suggested filename. null = user cancelled. */
  saveDocumentBytes(
    path: string,
    name: string,
    data: Uint8Array
  ): Promise<{ path: string } | FileError | null>
  /** Reveal the file in Windows File Explorer */
  showInFolder(path: string): void
  setFullscreen(on: boolean): void
  /** Notifies when the window enters/leaves OS fullscreen */
  onFullScreen(cb: (fullscreen: boolean) => void): () => void
  /** Sync the native window-controls overlay with the current theme */
  setTitleBarColors(color: string, symbolColor: string): void
  /** Resolve the real filesystem path of a File dropped onto the window (Electron only) */
  getPathForFile(file: File): string | null
  onOpenPath(cb: (path: string) => void): () => void
  /** App version for the About/settings surface (package.json / manifest) */
  getVersion(): Promise<string>
  // ---------- Auto-update (Electron only; no-ops elsewhere) ----------
  // Policy: checks are quiet and automatic, but DOWNLOADING an update is
  // always the user's decision — nothing is fetched or installed silently.
  /** Fires when a newer version has been detected (nothing downloaded yet) */
  onUpdateAvailable(cb: (version: string) => void): () => void
  /** Download progress for a user-initiated update download (0–100) */
  onUpdateProgress(cb: (percent: number) => void): () => void
  /** Fires when an update has been downloaded and will install on quit */
  onUpdateReady(cb: (version: string) => void): () => void
  /** Manual "check for updates"; resolves with the outcome */
  updateCheck(): Promise<UpdateCheckOutcome>
  /** Start downloading the detected update (user consent) */
  updateDownload(): void
  /** Quit and install the downloaded update now (no-op when none is ready) */
  updateRestart(): void
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

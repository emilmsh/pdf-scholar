// Types shared between the Electron main process, preload bridge and renderer.
import type { PdfStandardFont } from '@embedpdf/models'

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
  /** Name written into new annotations' author field (/T) — the standard PDF
   *  metadata other readers show as the commenter. Empty (the default, since
   *  the app has no accounts) writes no author at all. */
  annotAuthor: string
  /** Rebound keyboard shortcuts: command id → its chords, where an entry
   *  REPLACES that command's shipped bindings (an empty array means the user
   *  unbound it) and an absent one means defaults. Only commands the user
   *  actually changed are stored, so the shipped map stays free to evolve.
   *
   *  Deliberately typed loosely here: the command ids and the chord grammar are
   *  the renderer's business (`src/renderer/src/keymap.ts`), main only persists
   *  the object, and a stored id that no longer exists is dropped on load
   *  rather than failing a build in main. */
  keymap: Record<string, string[]>
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

/** A page the reader marked to come back to. Stored per file next to the
 *  reading position, so it is a view-layer bookmark and NOT written into the
 *  PDF — a /Dest in the file would need the same write path annotations use, and
 *  no other reader would show it the way we do anyway. */
export interface DocBookmark {
  /** 1-based page number */
  page: number
  /** What the reader called it; empty means "just this page" and the UI shows
   *  the page number instead. */
  label: string
  createdAt: number
}

export interface FilePayload {
  path: string
  name: string
  data: Uint8Array
}

/** A failure the engine can name, as opposed to one it can only quote.
 *
 *  main and shared cannot reach the renderer's i18n, so they used to send
 *  Norwegian prose across IPC and an English user read a Norwegian sentence
 *  inside a translated shell. A code lets the renderer translate instead. Only
 *  failures we RECOGNISE get one: an fs or provider error still travels as its
 *  own message, because inventing a code for "whatever the OS said" would lose
 *  the only detail that helps. */
export type EngineErrorCode =
  | 'annot-not-found'
  | 'annot-no-position'
  | 'annot-no-object-number'
  | 'annot-update-rejected'
  | 'annot-list-asymmetric'
  | 'annot-empty-stroke'
  | 'annot-pressure-bake'
  | 'annot-line-endpoints'
  | 'annot-unknown-type'
  | 'annot-stamp-no-image'
  | 'form-field-not-found'
  | 'form-field-read-only'
  | 'form-field-not-written'
  | 'pdf-password-protected'
  | 'pdf-password-wrong'
  | 'pdf-print-encrypted'
  | 'doc-too-large'
  | 'doc-too-large-browser'
  | 'doc-not-open'
  | 'append-unsupported'
  | 'append-objstm-edit'
  | 'append-encrypted'
  | 'append-no-image'
  | 'append-no-form-fill'

/** The same idea for the AI request path, which fails for its own set of named
 *  reasons. Kept a separate union because these are whole sentences shown in a
 *  chat bubble, not fragments spliced into a toast — they live under the
 *  `aierr.*` i18n prefix, and `errorText` routes on the `ai-` stem. */
export type AiErrorCode =
  | 'ai-key-missing'
  | 'ai-key-undecryptable'
  | 'ai-key-session-only'
  | 'ai-azure-unconfigured'
  | 'ai-compat-unconfigured'
  | 'ai-model-unchosen'
  | 'ai-endpoint-unreachable'
  | 'ai-endpoint-incompatible'
  | 'ai-context-overflow'
  | 'ai-refusal'
  | 'ai-stream-aborted'
  | 'ai-provider-unknown'
  | 'ai-aborted'

export interface FileError {
  /** Always set: the fallback text, and what goes in the log */
  error: string
  /** Set when the failure is one of the recognised kinds above, so the renderer
   *  can show its own translation rather than this string. */
  code?: EngineErrorCode | AiErrorCode | undefined
}

/** A partial update where "not changing this field" may be written as an explicit
 *  `undefined` rather than by omitting the key.
 *
 *  `Partial<T>` is not enough under exactOptionalPropertyTypes: it permits the key
 *  to be absent but rejects `{ provider: undefined }`, which is exactly what a
 *  caller produces when it forwards optional values out of another object. Every
 *  consumer of a patch in this codebase merges with `??` or a spread, so the two
 *  forms mean the same thing — this type says so instead of each call site
 *  working around it. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined }

/** Outcome of dropping a dragged tab (see PdfxApi.tabDropAtCursor) */
export type TabDropResult = 'window' | 'new' | 'same'

/** What the unsaved-changes prompt settled on. `error` only ever accompanies
 *  'cancel': the user chose Save, the write failed, and the document must stay
 *  open with its draft intact — the caller keeps the tab AND says why. Without
 *  this channel a failed save is indistinguishable from a successful one, and
 *  the tab closes over annotations that never reached disk. */
export interface CloseOutcome {
  verdict: 'save' | 'discard' | 'cancel'
  error?: string
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
  /** An image placed on the page — the signature the user drew once and stamps
   *  wherever it is needed. A standard /Stamp annotation with the image in its
   *  appearance stream, so every other reader shows it. */
  | 'stamp'
  // HISTORY: v0.35–v0.36 had a 'handnote' here too — a text box drawn in an
  // embedded handwriting font, also a /Stamp. It was removed in v0.37: its
  // whole purpose was to SIMULATE pen writing for the screenshots, and a typed
  // note wearing handwriting is a costume, not a feature (Emil, 2026-08-09).
  // Anyone who wants handwriting has a pen and uses the pen tool. A file that
  // still contains one opens fine — it is a /Stamp with an appearance stream,
  // and reads back as an (uneditable) stamp.

/** Rect in PDF points, origin at the page's top-left, y growing downward —
 *  the same direction as pdf.js viewport space and as what the write engine
 *  expects, so no flip happens anywhere. */
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
  // `| undefined` alongside `?`: the renderer builds these requests as plain
  // object literals, so an unused field is PRESENT and undefined rather than
  // absent, which exactOptionalPropertyTypes treats as distinct. Both are
  // accepted because both are what the engine already handles — it checks
  // `!== undefined` on every one of them.
  contents?: string | undefined
  author?: string | undefined
  /** ink: freehand strokes; line/arrow: [[start, end]] — in page space */
  strokes?: [number, number][][] | undefined
  /** ink (pen): per-point pen pressure (0–1), parallel to `strokes`. Presence
   *  makes the engine bake a variable-width appearance stream (the stroke's
   *  calligraphy) instead of PDFium's uniform one; the InkList keeps the
   *  centerline so other editors still see a standard Ink. */
  pressures?: number[][] | undefined
  /** ink/shapes: stroke width in PDF points */
  width?: number | undefined
  /** freetext only */
  fontSize?: number | undefined
  /** freetext only: which of the 14 standard PDF fonts the box is set in.
   *  Standard-14 ONLY, deliberately: PDFium builds the appearance stream for
   *  those itself, nothing is embedded, the words stay searchable, and every
   *  reader in the world already has them. Omitted means Helvetica. Any other
   *  typeface would have to be embedded, and FPDFAnnot_AppendObject refuses
   *  every subtype but STAMP and INK — which is the trap the handwriting note
   *  fell into. */
  font?: PdfStandardFont | undefined
  /** freetext only: opaque fill behind the text (rgb 0–1). Used by the
   *  margin export's numbered anchor chips, which sit over page content and
   *  must stay readable there. */
  background?: [number, number, number] | undefined
  /** freetext only: box border (the chips carry the anchor's colour here) */
  border?: { color: [number, number, number]; width: number } | undefined
  /** ink (marker): bake the appearance with /BM Multiply so text under the
   *  stroke stays legible — the freehand twin of a text highlight */
  blend?: 'multiply' | undefined
  /** stamp only: the PNG bytes to embed. PDFium decodes these itself and stores
   *  the image in the appearance stream, so nothing here re-encodes pixels.
   *  Travels over IPC as a Uint8Array (structured clone handles it). */
  image?: Uint8Array | undefined
}

/** A digital signature found in the document.
 *
 *  Deliberately says nothing about VALIDITY. Verifying a signature means
 *  parsing the PKCS#7 blob and walking a certificate chain to a trust store —
 *  a crypto dependency this app does not carry, and the kind of claim that is
 *  worse than useless if it is wrong. What we can honestly report is that the
 *  document carries signatures, when they were made and why; the UI says the
 *  rest in words. */
export interface DocSignature {
  /** /M — when it was signed, as the PDF recorded it. May be empty. */
  time: string
  /** /Reason — free text the signer typed, when they typed one */
  reason: string
  /** The signature handler, e.g. `adbe.pkcs7.detached` or `ETSI.CAdES.detached`
   *  (the latter is what makes a signature PAdES). Empty when unreadable. */
  subFilter: string
  /** True when the signature declares a DocMDP transform — "no changes allowed
   *  after this point", the certification signature rather than an approval. */
  certifying: boolean
}

/** On success carries the PDF object number of the (new) annotation */
export type AnnotateResult = { ok: true; id: number } | FileError

export interface ModifyAnnotationRequest {
  path: string
  /** 0-based page index */
  pageIndex: number
  /** PDF object number identifying the annotation */
  id: number
  // Present-and-undefined is fine here for the same reason as AnnotateRequest:
  // updateOn guards each field with `!== undefined` before touching the model,
  // so an undefined field is a no-op rather than a write of nothing.
  color?: [number, number, number] | undefined
  opacity?: number | undefined
  contents?: string | undefined
  /** freetext only: re-set the box in another of the Standard 14. The engine
   *  writes it to the model's fontFamily and lets PDFium rebuild the appearance
   *  stream, exactly as at create time — so a box re-set in Courier is
   *  indistinguishable from one typed in Courier, and the words stay real text.
   *
   *  The RECT is not derived from this. A wider face needs a wider box, and the
   *  measurement lives in the renderer (freetextMinSize, which is a canvas), not
   *  here — so the caller sends the re-measured `quads` in the SAME patch. A
   *  font sent alone is honoured and may leave the text wrapping differently. */
  font?: PdfStandardFont | undefined
  /** Move/resize (note drag) — page space, top-left origin */
  rect?: PageRect | undefined
  /** Move: translate all geometry by (dx, dy) in page space (top-left origin,
   *  y down). The engine reads the annotation's own geometry and writes it back
   *  shifted — per-subtype, because a Line's endpoints and an Ink's stroke list
   *  do not follow a plain rect move. */
  translate?: { dx: number; dy: number } | undefined
  // ---- resize / re-shape: the caller sends the NEW geometry outright ----
  // `translate` can only shift what is already there, which is why a mark used
  // to be un-editable: getting one line more of a highlight, or a square 20 pt
  // wider, meant deleting it and drawing again. These two carry the replacement
  // geometry in the same page space as AnnotateRequest, so the engines reuse the
  // create-time builders for the appearance and nothing about the shape is
  // computed twice.
  /** Text markup (highlight/underline/strikeout/squiggly): the whole new quad
   *  list, one quad per line of text. */
  quads?: PageRect[] | undefined
  /** line/arrow: one pair of endpoints. ink: the whole new stroke list. */
  strokes?: [number, number][][] | undefined
  /** ink (pen): pressures parallel to `strokes`, when the caller holds them.
   *  The engines re-bake a moved/re-shaped pressure stroke's appearance either
   *  way (stored pressures are read back from the annotation itself); sending
   *  them here just skips that read. */
  pressures?: number[][] | undefined
}

export interface DeleteAnnotationRequest {
  path: string
  pageIndex: number
  id: number
}

/** What to put in one AcroForm field.
 *
 *  Three kinds because PDFium's form-fill environment has three doors and no
 *  fourth: text goes in through the edit control (select-all + replace),
 *  check boxes and radio buttons are TOGGLED (there is no "set to true"), and
 *  a combo/list box picks by OPTION INDEX rather than by label — the label is
 *  display text and two options may share one. A signature field is not here
 *  at all: signing needs cryptography we deliberately do not carry (see
 *  DocSignature). */
export type FormFieldValue =
  | { kind: 'text'; text: string }
  | { kind: 'checked'; checked: boolean }
  | {
      kind: 'choice-index'
      /** 0-based index into the field's /Opt array */
      index: number
      // `| undefined` alongside `?` for the same reason as AnnotateRequest: the
      // renderer builds these as plain object literals, so an unused field is
      // present-and-undefined rather than absent.
      /** Omitted means "select it" — the only thing a combo box can do, and
       *  what a click on a list box option means. `false` deselects, which
       *  only a multi-select list box can honour. */
      selected?: boolean | undefined
    }

export interface SetFormFieldRequest {
  path: string
  /** 0-based page index */
  pageIndex: number
  /** PDF object number of the WIDGET annotation — the same identity every
   *  annotation write uses. Deliberately not the field's /T name (two widgets
   *  of one radio group share it) and not EmbedPDF's /NM uuid (reading that
   *  MINTS one into annotations that lack it, dirtying the document). */
  id: number
  value: FormFieldValue
}

// ---------- AI (BYO API key, multi-provider) ----------

export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'azure'
  // First-class hosted OpenAI-compatible services (one key each; base URLs in
  // shared/ai-provider-profile.ts COMPAT_SERVICES)
  | 'openrouter'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'groq'
  // Custom OpenAI-compatible endpoint / local servers (Ollama, LM Studio)
  | 'compat'
  | 'mock'

/** How hard the model should reason; mapped per provider/model in main */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export interface AiConfig {
  provider: AiProviderId
  /** Model id/deployment per provider */
  models: Record<AiProviderId, string>
  /** apiVersion '' means "use the app's built-in default" — stored empty so the
   *  default can move with app updates without touching saved config */
  azure: { endpoint: string; deployment: string; apiVersion: string }
  /** The OpenAI-compatible provider: any server speaking /chat/completions —
   *  OpenRouter, Mistral, Groq, or a local Ollama/LM Studio. baseUrl is the
   *  API root (usually ending in /v1); the model id lives in models.compat
   *  and the (optional) key in the ordinary key store. */
  compat: { baseUrl: string }
  /** Reasoning effort (default 'medium') */
  thinking: ThinkingLevel
}

/** Capability summary for an Anthropic model, normalized from the Models API's
 *  `capabilities` tree. This is what lets request shaping stop guessing from
 *  model-name regexes: the API says outright whether adaptive thinking and
 *  which effort levels are accepted. Absent for providers whose models
 *  endpoint returns no capability data (OpenAI). */
export interface AiModelCaps {
  /** capabilities.thinking.types.adaptive.supported */
  adaptiveThinking: boolean
  /** capabilities.thinking.types.enabled.supported (budget_tokens style) */
  budgetThinking: boolean
  /** Effort levels with supported:true, in ladder order ([] = no effort param) */
  effort: string[]
}

/** One model as reported live by a provider's models endpoint */
export interface AiRemoteModel {
  id: string
  displayName?: string
  caps?: AiModelCaps
  /** The context the server will actually serve for this model (tokens),
   *  when the endpoint can tell us — today only Ollama via /api/show
   *  (num_ctx if configured, else the server default, capped by the
   *  architecture's maximum). Absent = unknown, use the provider floor. */
  contextTokens?: number
  /** Whether the model accepts images, when the endpoint reports it (Ollama's
   *  capabilities array). Absent = unknown — treated as "allow and let the
   *  degrade nets handle it". */
  vision?: boolean
}

/** Cached snapshot of the providers' live model lists, fetched with the user's
 *  own API key (see src/shared/ai-model-catalog.ts). Per-provider timestamps so
 *  one provider failing to refresh never blocks the other. Missing entry =
 *  never fetched (no key yet, or fetch always failed) — callers fall back to
 *  the curated list / regex heuristics. */
export interface AiModelCatalog {
  anthropic?: { fetchedAt: number; models: AiRemoteModel[] }
  openai?: { fetchedAt: number; models: AiRemoteModel[] }
  openrouter?: { fetchedAt: number; models: AiRemoteModel[] }
  gemini?: { fetchedAt: number; models: AiRemoteModel[] }
  xai?: { fetchedAt: number; models: AiRemoteModel[] }
  mistral?: { fetchedAt: number; models: AiRemoteModel[] }
  groq?: { fetchedAt: number; models: AiRemoteModel[] }
  /** Also remembers WHICH endpoint the list came from, so a changed base URL
   *  never shows another server's models */
  compat?: { fetchedAt: number; models: AiRemoteModel[]; baseUrl: string }
}

/** What is actually protecting a stored API key right now.
 *
 *  This is deliberately NOT a boolean. "Encrypted or not" cannot describe the
 *  three real situations, and a UI that promises encryption generically is
 *  lying on at least one platform. Each variant below states what it protects
 *  against AND what it does not, because that is what the user needs to decide
 *  whether to paste a key with billing attached to it. */
export type KeyStorageMode =
  /** Encrypted at rest by the operating system's own key store — Windows DPAPI,
   *  macOS Keychain, or Linux Secret Service (gnome-keyring/kwallet). The blob
   *  is decryptable only by this OS user on this machine, so copying the file
   *  elsewhere yields nothing. Does not protect against code already running as
   *  this user, which can ask the OS to decrypt just as the app does. */
  | 'os-keystore'
  /** Encrypted with AES-GCM under a key that no script can read: a
   *  non-extractable WebCrypto key kept in IndexedDB, where `exportKey` throws.
   *  Protects the stored bytes against anything that merely READS the browser
   *  profile (a backup, a sync copy, another program on disk). It does NOT
   *  protect against code running inside this browser profile, which can use
   *  the key without ever seeing it — and Chrome makes no promise that the key
   *  material itself is encrypted at rest, so a determined attacker with raw
   *  file access could still reassemble it. Defence in depth, not a keychain. */
  | 'browser-nonextractable'
  /** Held in memory for this session only, never written to disk. Chosen when
   *  no key store is available at all: forgetting the key on quit is strictly
   *  better than leaving it in a file in the clear. */
  | 'session-only'
  /** On disk with nothing protecting it. Only reachable via a legacy stored
   *  value; the app does not write this any more. */
  | 'plaintext'

/** Config as exposed to the renderer — keys never leave the main process */
export interface AiConfigView extends AiConfig {
  hasKey: Record<AiProviderId, boolean>
  /** How keys are held on this platform, so the settings UI can say so exactly */
  keyStorage: KeyStorageMode
  /** Whether this platform can store provider API keys at all (desktop and
   *  extension can; the plain-web preview is mock-only). Drives the
   *  "add your API key" callout in the assistant. */
  keysSupported: boolean
  /** Live model lists as last fetched from the providers ({} until a key
   *  exists and a refresh has succeeded) */
  catalog: AiModelCatalog
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
  /** Only meaningful on user messages, and built present-and-undefined when the
   *  turn has no attachments — the provider adapters all check for a non-empty
   *  array, so absent and undefined are the same request on the wire. */
  images?: AiImage[] | undefined
}

/** Web-search availability for a chat request. 'off' = tool not attached;
 *  'ask' = tool attached but the model may only use it when the user's
 *  message explicitly asks for a web lookup; 'on' = the model searches
 *  whenever it judges the answer needs external information. */
export type AiWebSearchMode = 'off' | 'ask' | 'on'

export interface AiChatRequest {
  requestId: number
  system: string
  messages: AiMessage[]
  /** Page-joined document text; sent with citations enabled where supported */
  document: { title: string; text: string } | null
  /** Web-search mode (server-side provider tool). Only honored by providers
   *  that support it (Anthropic, OpenAI); others ignore it. Absent = 'off'. */
  webSearch?: AiWebSearchMode
}

/** Normalized citation. 'char' = offsets into the document text we sent
 *  (Anthropic char_location); 'quote' = verbatim quote + page, resolved by
 *  the renderer via text search (prompt-contract providers); 'web' = an
 *  external source from the web-search tool, opened in the browser. */
export type AiCitation =
  | { kind: 'char'; start: number; end: number; citedText: string }
  | { kind: 'quote'; pageNumber: number; quote: string }
  | { kind: 'web'; url: string; title: string }

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

/** Why a build can't self-update: developer run, unsigned macOS, or a
 *  Microsoft Store/MSIX package (the Store owns the update cycle). `null`
 *  means self-update is supported. Note that 'mac' bars INSTALLING an update,
 *  not detecting one — that build still checks and reports 'manual'. */
export type UpdateUnsupportedReason = 'dev' | 'mac' | 'store'

/** How a build that can't self-update gets the new version: `brew` when it was
 *  installed from the Homebrew cask, `download` for a hand-installed dmg. */
export type ManualUpdateChannel = 'brew' | 'download'

/** Result of a manual "check for updates".
 *  - available: newer version detected, not downloaded (offer a download)
 *  - ready: an update is already downloaded and installs on quit/restart
 *  - manual: newer version detected, but this build can't install it itself
 *    (macOS) — `channel` says how the user does it
 *  - none: this is the latest version
 *  - unsupported: no check was even attempted (dev run, or Microsoft Store —
 *    the Store owns the update cycle there)
 *  - error: the check itself failed (offline, rate-limited, …) */
export interface UpdateCheckOutcome {
  status: 'available' | 'ready' | 'manual' | 'none' | 'unsupported' | 'error'
  /** Version on offer (available/ready/manual) */
  version?: string
  /** Currently running app version */
  current: string
  /** Why self-update is unsupported, when status = 'unsupported' */
  reason?: UpdateUnsupportedReason
  /** How to install it by hand, when status = 'manual' */
  channel?: ManualUpdateChannel
}

export interface PdfxApi {
  openFileDialog(): Promise<FilePayload | FileError | null>
  /** `awaitSettled` waits for the file to stop changing before reading it, for
   *  the retry after a parse failure — the likeliest cause of one is that the
   *  program which asked us to open the file was still writing it. Platforms
   *  that serve URLs rather than files ignore the flag and simply read again. */
  readFile(path: string, opts?: { awaitSettled?: boolean }): Promise<FilePayload | FileError>
  getRecents(): Promise<RecentFile[]>
  getSettings(): Promise<Settings>
  getPosition(path: string): Promise<ReadingPosition | null>
  getPendingPath(): Promise<string | null>
  setPosition(path: string, pos: ReadingPosition): void
  /** Bookmarks for one file, page order. Same fire-and-forget shape as
   *  setPosition: the list is small, the write is not worth awaiting, and losing
   *  the last one to a crash costs a click. */
  getBookmarks(path: string): Promise<DocBookmark[]>
  setBookmarks(path: string, bookmarks: DocBookmark[]): void
  setSettings(patch: Partial<Settings>): void
  /** Write an annotation into the PDF file (EmbedPDF/PDFium; the >150 MB path
   *  goes through src/main/incremental-appender.ts instead) */
  annotate(req: AnnotateRequest): Promise<AnnotateResult>
  /** Change color/opacity/contents of an existing annotation */
  updateAnnotation(req: ModifyAnnotationRequest): Promise<AnnotateResult>
  deleteAnnotation(req: DeleteAnnotationRequest): Promise<AnnotateResult>
  /** Fill one AcroForm field, addressed by its widget's PDF object number.
   *  Returns that same id on success — the value is READ BACK out of the field
   *  before we report ok, because PDFium returns success for writes it did not
   *  perform (unchecking a radio button being the measured case). */
  setFormField(req: SetFormFieldRequest): Promise<AnnotateResult>
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
  /** Hand over the password an encrypted document was just unlocked with, so the
   *  write engine can open it too. The renderer is where the unlock happens —
   *  pdf.js refuses the bytes and the user types the password — but on desktop
   *  the annotation engine lives in main and opens the draft itself, which is
   *  encrypted the same way. Held in memory for the session only, never written
   *  to disk. A no-op on the platforms whose write engine is already in the
   *  renderer (browser, extension). */
  docUnlock(path: string, password: string): Promise<void>
  /** The digital signatures the document carries, if any. Read once per open —
   *  a signature cannot appear while the file sits there. Never reports whether
   *  a signature is VALID; see DocSignature. */
  docSignatures(path: string): Promise<DocSignature[] | FileError>
  /** True when the document has unsaved annotation changes (a draft exists) */
  docIsDirty(path: string): Promise<boolean>
  /** True when the original file changed outside the app since this session
   *  started annotating it — checked before Save so an in-place write never
   *  silently clobbers a newer external version. Always false when there is
   *  no real overwrite-in-place target for `path` (e.g. a URL-opened PDF in
   *  the browser/extension) — nothing to conflict with. */
  docWasModifiedExternally(path: string): Promise<boolean>
  /** Write the draft back over the original file */
  docSave(path: string): Promise<{ ok: true } | FileError>
  /** Native save/discard/cancel prompt; performs the chosen action */
  docConfirmClose(path: string): Promise<CloseOutcome>
  /** Native prompt shown when re-opening a path whose tab has unsaved
   *  annotations AND the on-disk file has changed underneath it — a plain
   *  reload would silently drop the annotated draft. Question only, no
   *  action performed: 'save' means the caller should still run the
   *  save-a-copy flow (saveFileAs) before discarding/reloading. */
  docConfirmExternalUpdate(path: string): Promise<'save' | 'discard' | 'cancel'>
  /** Silently drop the document's draft. Only safe when the edits are known
   *  to live elsewhere — «save a copy» flushes them into the copy the app is
   *  about to switch to, and the original must not resurrect them. */
  docDiscard(path: string): Promise<void>
  /** Fires in every OTHER window that has `path` open when this window's
   *  annotation write lands. There is exactly one draft per path (main owns it),
   *  so the receiver re-reads that draft rather than replaying a patch: the file
   *  is the single source of truth, which is the only way two windows editing
   *  the same document cannot drift apart. Never fires in the window that made
   *  the change. */
  onAnnotationsChangedElsewhere(cb: (path: string) => void): () => void
  /** Fires in every OTHER window that has `path` open when this window ends the
   *  shared draft — a Save (the work is now on disk) or a discard (it is gone).
   *  Without it those windows would keep offering to save nothing, and after a
   *  discard would keep showing marks the document no longer has. */
  onDraftEndedElsewhere(cb: (path: string) => void): () => void
  /** Open the system print dialog for the PDF file */
  printFile(path: string): Promise<{ ok: true } | FileError>
  /** Save exported content (text, or bytes for binary formats like .docx) via
   *  a save dialog; null = user cancelled */
  saveTextFile(
    defaultName: string,
    content: string | Uint8Array
  ): Promise<{ path: string } | FileError | null>
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
  /** Fires when a newer version exists that this build can't install itself
   *  (macOS) — the UI shows how to update by hand instead of a download button */
  onUpdateManual(cb: (version: string, channel: ManualUpdateChannel) => void): () => void
  /** Whether this build can self-update, resolved locally (no network). Lets
   *  the UI hide the "check for updates" control on builds where it's moot —
   *  notably Store/MSIX. `null` = self-update supported. */
  updateSupport(): Promise<UpdateUnsupportedReason | null>
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
  /** Refresh the live model catalog from every provider with a usable key.
   *  TTL-gated (a fresh cache returns immediately) unless force; resolves with
   *  the updated view either way, so callers can just re-render from it.
   *  Fetch failures keep the previous snapshot — this never makes things worse. */
  aiRefreshModels(force?: boolean): Promise<AiConfigView>
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

import { app } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AiConfig,
  AiModelCatalog,
  AiProviderId,
  DocBookmark,
  Patch,
  ReadingPosition,
  RecentFile,
  Settings
} from '../shared/types'
import { DEFAULT_AI_MODELS, DEFAULT_SETTINGS } from '../shared/defaults'
export type { Settings }

export interface StoredAiConfig extends AiConfig {
  /** API keys, encrypted with safeStorage, base64-encoded ('' = not set) */
  keys: Record<AiProviderId, string>
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface AppState {
  recents: RecentFile[]
  positions: Record<string, ReadingPosition>
  /** Per-file page bookmarks, keyed by the same path as `positions` */
  bookmarks: Record<string, DocBookmark[]>
  settings: Settings
  ai: StoredAiConfig
  /** Live model lists cached from the providers (see shared/ai-model-catalog.ts) */
  modelCatalog: AiModelCatalog
  window?: WindowState
}

const DEFAULT_AI: StoredAiConfig = {
  provider: 'anthropic',
  models: { ...DEFAULT_AI_MODELS },
  azure: { endpoint: '', deployment: '', apiVersion: '' },
  compat: { baseUrl: '' },
  thinking: 'medium',
  keys: {
    anthropic: '',
    openai: '',
    azure: '',
    openrouter: '',
    gemini: '',
    xai: '',
    mistral: '',
    groq: '',
    compat: '',
    mock: ''
  }
}

const DEFAULTS: AppState = {
  recents: [],
  positions: {},
  bookmarks: {},
  settings: { ...DEFAULT_SETTINGS },
  ai: DEFAULT_AI,
  modelCatalog: {}
}

export function mergeAiConfig(
  base: StoredAiConfig,
  patch: Patch<AiConfig> & { keys?: Partial<Record<AiProviderId, string>> | undefined }
): StoredAiConfig {
  return {
    ...base,
    provider: patch.provider ?? base.provider,
    models: { ...base.models, ...patch.models },
    azure: { ...base.azure, ...patch.azure },
    compat: { ...base.compat, ...patch.compat },
    thinking: patch.thinking ?? base.thinking,
    keys: { ...base.keys, ...patch.keys }
  }
}

let cached: AppState | null = null

const stateFile = (): string => join(app.getPath('userData'), 'pdfx-state.json')

export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return { ...base, ...patch }
}

export function getState(): AppState {
  if (cached) return cached
  let loaded: AppState
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8'))
    loaded = {
      ...DEFAULTS,
      ...parsed,
      settings: mergeSettings(DEFAULTS.settings, parsed.settings ?? {}),
      ai: mergeAiConfig(DEFAULT_AI, parsed.ai ?? {})
    }
  } catch (err) {
    // A file that exists but won't parse holds data (encrypted API keys!)
    // that the next saveState would otherwise overwrite with defaults —
    // keep a copy so nothing is lost permanently.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('pdfx: state file unreadable, backing it up', err)
      try {
        copyFileSync(stateFile(), stateFile() + '.corrupt')
      } catch {
        /* backup is best-effort */
      }
    }
    loaded = structuredClone(DEFAULTS)
  }
  cached = loaded
  return loaded
}

export function saveState(): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    // Atomic write: a crash mid-write must never truncate the state file —
    // it holds the encrypted API keys, and a half-written JSON would be
    // replaced by defaults on the next launch.
    const tmp = stateFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(getState(), null, 2))
    renameSync(tmp, stateFile())
  } catch (err) {
    console.error('pdfx: failed to save state', err)
  }
}

export function addRecent(path: string, name: string): void {
  const state = getState()
  state.recents = [
    { path, name, lastOpened: Date.now() },
    ...state.recents.filter((r) => r.path !== path)
  ].slice(0, 20)
  saveState()
}

export function setPosition(path: string, pos: ReadingPosition): void {
  getState().positions[path] = pos
  saveState()
}

export function getBookmarks(path: string): DocBookmark[] {
  return getState().bookmarks[path] ?? []
}

/** Replace one file's bookmarks. An empty list drops the key rather than storing
 *  `[]`, so unbookmarking the last page leaves no trace in the state file. */
export function setBookmarks(path: string, bookmarks: DocBookmark[]): void {
  const state = getState()
  if (bookmarks.length === 0) delete state.bookmarks[path]
  else state.bookmarks[path] = bookmarks
  saveState()
}

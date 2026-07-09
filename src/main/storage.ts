import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ReadingPosition, RecentFile, Settings } from '../shared/types'
export type { Settings }

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
  settings: Settings
  window?: WindowState
}

const DEFAULTS: AppState = {
  recents: [],
  positions: {},
  settings: {
    theme: 'day',
    themeAdjust: {
      day: { contrast: 1, brightness: 1 },
      sepia: { contrast: 1, brightness: 1 },
      night: { contrast: 1, brightness: 1 }
    },
    keepAwake: false
  }
}

let cached: AppState | null = null

const stateFile = (): string => join(app.getPath('userData'), 'pdfx-state.json')

export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    themeAdjust: { ...base.themeAdjust, ...patch.themeAdjust }
  }
}

export function getState(): AppState {
  if (cached) return cached
  let loaded: AppState
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8'))
    loaded = {
      ...DEFAULTS,
      ...parsed,
      settings: mergeSettings(DEFAULTS.settings, parsed.settings ?? {})
    }
  } catch {
    loaded = structuredClone(DEFAULTS)
  }
  cached = loaded
  return loaded
}

export function saveState(): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(getState(), null, 2))
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

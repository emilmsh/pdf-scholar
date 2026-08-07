// Shipped defaults, in one place because all three targets need the same ones.
//
// These were written out six times (main's store, the web fallback, the
// extension's api, both app shells, and the gear menu's reset) with nothing
// tying the copies together. Five were annotated `Settings`, so a new required
// preference would at least fail typecheck there — but the sixth is an argument
// to `onSettingsChange(patch: Partial<Settings>)`, where a missing field compiles
// clean. That is the failure worth preventing: add a preference, and the reset
// button quietly stops resetting it, with nothing to notice.
//
// `resetPreferences` therefore spreads DEFAULT_SETTINGS rather than restating it,
// so it is exhaustive by construction instead of by memory.
import type { AiProviderId, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'day',
  autoLight: 'day',
  autoDark: 'night',
  keepAwake: false,
  language: 'auto',
  annotAuthor: ''
}

/** Model per provider when nothing is stored yet. Azure has no default — its
 *  deployment name is per-account — and mock is a fixed stand-in.
 *
 *  CHANGING THESE CHANGES WHICH MODEL USERS GET. That is a product decision, not
 *  a refactor: do not touch them without asking. */
export const DEFAULT_AI_MODELS: Record<AiProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra',
  azure: '',
  // The compat-family providers have no defaults: their model lists are
  // live-fetched, and picking one is a product decision the USER makes from
  // the model menu (an empty model gives the named ai-model-unchosen error)
  openrouter: '',
  gemini: '',
  xai: '',
  mistral: '',
  groq: '',
  // Same for the local servers: what is installed differs per machine, so the
  // list is fetched from the server and the user picks
  ollama: '',
  lmstudio: '',
  compat: '',
  mock: 'mock-1'
}

/** Azure OpenAI data-plane api-version used when the user has not overridden it
 *  in the settings (config stores '' for "use the default"). Bump this when
 *  Azure requires a newer version for current models — see docs/MODEL-UPDATE.md. */
export const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview'

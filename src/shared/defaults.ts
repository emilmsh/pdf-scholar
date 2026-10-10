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
  // 1 = exactly the shipped look. Anything else is applied as an inline
  // --page-filter/--page-bg override (renderer's theme-tune.ts), so the
  // untouched default costs nothing and renders bit-identically to before.
  themeTune: { sepia: 1, night: 1, custom: 1 },
  customTone: 'sepia',
  nightTone: 'warm',
  nightKeepImages: false,
  selectionMenuTrigger: 'auto',
  selectionMenuCompact: false,
  fileIcon: 'document',
  fileIconPath: '',
  tabIcon: 'app',
  tabIconImage: '',
  keepAwake: false,
  language: 'auto',
  annotAuthor: '',
  citationStyle: 'apa',
  // Empty = every command sits on the bindings keymap.ts ships. The defaults
  // themselves live there, next to the commands they belong to, so this stays
  // "nothing rebound" rather than a second copy of the map.
  keymap: {},
  recentsView: 'list',
  recentsGridSize: 'medium',
  // On: a restored tab reads nothing until it is shown, so the cost of
  // remembering a long session is a row of names in the tab strip.
  restoreSession: true,
  pagedView: false,
  linkPreview: true,
  linkPreviewDelay: 'medium'
}

/** How many files «Nylig lest» remembers, on every platform (docs/SPEC.md §8).
 *  The extension kept 30 against the desktop's 20 until 2026-10-06 — a
 *  divergence nothing called for — and the library's grid stores one picture
 *  per entry, so the number is also what bounds that store. */
export const RECENTS_MAX = 20

/** Model per provider when nothing is stored yet. Azure has no default — its
 *  deployment name is per-account — and mock is a fixed stand-in.
 *
 *  CHANGING THESE CHANGES WHICH MODEL USERS GET. That is a product decision, not
 *  a refactor: do not touch them without asking. */
export const DEFAULT_AI_MODELS: Record<AiProviderId, string> = {
  // Emil, 2026-09-27: Opus 5.5 and GPT-6 Sol (were Sonnet 5 and GPT-5.6 Terra)
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-sol',
  // Emil's call 2026-09-27, verified live on a Pro plan that day
  chatgpt: 'gpt-6-sol',
  azure: '',
  // The compat-family providers have no defaults: their model lists are
  // live-fetched, and picking one is a product decision the USER makes from
  // the model menu (an empty model gives the named ai-model-unchosen error)
  openrouter: '',
  gemini: '',
  xai: '',
  mistral: '',
  groq: '',
  compat: '',
  mock: 'mock-1'
}

/** Azure OpenAI data-plane api-version used when the user has not overridden it
 *  in the settings (config stores '' for "use the default"). Bump this when
 *  Azure requires a newer version for current models — see docs/MODEL-UPDATE.md. */
export const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview'

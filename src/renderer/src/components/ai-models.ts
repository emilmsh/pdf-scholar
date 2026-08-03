// The provider/model catalogue: which providers exist, which models each one
// offers, what a model is called in the UI, and where its spending cap lives.
// Pure data plus formatting/merge helpers — no JSX, no state.
//
// Its own file because three separate surfaces read it (the key manager, the
// header chip's quick menu, and the panel header's model name) and because it
// is the part of the AI code with an external maintenance cadence: model ids
// churn with the providers. The curated list below is the shipped baseline;
// at runtime it is merged with the live catalog fetched from the providers
// (modelOptions below), so new models appear without an app update and retired
// ones get flagged. Refresh workflow for the curated data: docs/MODEL-UPDATE.md
// (`npm run check:models` reports the drift).
import type { AiModelCatalog, AiProviderId, ThinkingLevel } from '../../../shared/types'
import { isLocalEndpoint, remoteModel } from '../../../shared/ai-model-catalog'
import type { CatalogProviderId } from '../../../shared/ai-model-catalog'
import { isCompatService } from '../../../shared/ai-provider-profile'
import { t } from '../i18n'
import type { MsgKey } from '../i18n'

/** The catalog id for a provider, or null for the two that have no live list
 *  (Azure is per-account, mock is fake). Everything else live-fetches. */
const catalogId = (p: AiProviderId): CatalogProviderId | null =>
  p === 'azure' || p === 'mock' ? null : p

// Display order is RANKED by likelihood of preferred use (general global
// usage patterns — Emil's call 2026-08-03), NOT alphabetical and NOT the
// order the providers were added. The app's default provider is a separate
// product decision and does not move with this list.
export const providerLabels = (): { id: AiProviderId; label: string }[] => [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'xai', label: 'xAI (Grok)' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'groq', label: 'Groq' },
  { id: 'compat', label: t('ai.providerCompat') },
  { id: 'mock', label: t('ai.providerMock') }
]

/** Base-URL presets for the compat provider — since the hosted services
 *  became first-class key slots (fase 10.3) only the LOCAL servers live
 *  here, plus whatever URL the user types. `modelHint` is only a placeholder
 *  example for the model-id field, never sent anywhere. Verified monthly
 *  (docs/MAINTENANCE.md row 4). */
export const compatPresets = (): { label: string; url: string; modelHint: string }[] => [
  { label: `Ollama (${t('ai.localTag')})`, url: 'http://localhost:11434/v1', modelHint: 'llama3.1' },
  { label: `LM Studio (${t('ai.localTag')})`, url: 'http://localhost:1234/v1', modelHint: 'qwen2.5-7b-instruct' }
]

// Curated, verified model lists (see docs/agent-notes/modeller-api.md),
// ordered by capability (heaviest first) with clean names only — the
// descriptor lives in `hint`, shown as the option's hover tooltip so the
// list stays clean without leaving new users guessing. `label` is the
// dropdown text; `short` is for the compact header chip (never the raw
// hyphenated id).
export const MODELS: Record<
  AiProviderId,
  { id: string; label: string; short: string; hint?: MsgKey }[]
> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5', short: 'Fable 5', hint: 'ai.modelHintHeaviest' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', short: 'Opus 4.8', hint: 'ai.modelHintCapable' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', short: 'Sonnet 5', hint: 'ai.modelHintRecommended' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', short: 'Haiku 4.5', hint: 'ai.modelHintFast' }
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', short: 'GPT-5.6 Sol', hint: 'ai.modelHintCapable' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', short: 'GPT-5.6 Terra', hint: 'ai.modelHintRecommended' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', short: 'GPT-5.6 Luna', hint: 'ai.modelHintFast' }
  ],
  azure: [],
  // The compat family (hosted services + custom/local) has no curated lists:
  // the endpoint decides what exists, and the live /models fetch fills the menu
  openrouter: [],
  gemini: [],
  xai: [],
  mistral: [],
  groq: [],
  compat: [],
  mock: [{ id: 'mock-1', label: 'Testmodell (mock)', short: 'Testmodell' }]
}

/** Fallback default per provider when no model is stored yet. Mirrors main's
 *  storage defaults — MODELS is display-ordered by capability, so [0] is the
 *  heaviest model, NOT the default. */
export const DEFAULT_MODELS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra'
}

/** One entry in a model dropdown: the curated list merged with the live
 *  catalog. `missing` = curated/selected id no longer listed by the provider
 *  (probably retired — the UI marks it); `curated` = shipped entry with a
 *  hand-written label and hint, as opposed to a live-discovered id. */
export interface ModelOption {
  id: string
  label: string
  short: string
  hint?: MsgKey
  curated: boolean
  missing: boolean
}

/** The dropdown list for a provider: curated entries first (flagged when the
 *  live catalog no longer lists them), then live-discovered models the curated
 *  list does not know yet, in the provider's own (newest-first) order. With no
 *  fetched catalog this degrades to exactly the curated list.
 *
 *  For compat, pass the configured base URL: the snapshot remembers which
 *  endpoint it came from, and a list fetched from another server must not
 *  show against this one. */
export function modelOptions(
  provider: AiProviderId,
  catalog?: AiModelCatalog,
  compatBaseUrl?: string
): ModelOption[] {
  const curated = MODELS[provider] ?? []
  const remote =
    provider === 'compat'
      ? catalog?.compat &&
        catalog.compat.baseUrl === (compatBaseUrl ?? '').trim().replace(/\/+$/, '')
        ? catalog.compat
        : undefined
      : provider === 'anthropic' || provider === 'openai' || isCompatService(provider)
        ? catalog?.[provider]
        : undefined
  if (!remote) return curated.map((m) => ({ ...m, curated: true, missing: false }))
  const remoteIds = new Set(remote.models.map((m) => m.id))
  const options: ModelOption[] = curated.map((m) => ({
    ...m,
    curated: true,
    missing: !remoteIds.has(m.id)
  }))
  // «lokal»-merke: models served from a loopback endpoint say so in the list
  // (the short chip name stays clean)
  const localSuffix =
    provider === 'compat' && catalog?.compat && isLocalEndpoint(catalog.compat.baseUrl)
      ? ` · ${t('ai.localTag')}`
      : ''
  for (const m of remote.models) {
    if (curated.some((c) => c.id === m.id)) continue
    const label = (m.displayName ?? prettyModelName(provider, m.id)) + localSuffix
    options.push({ id: m.id, label, short: prettyModelName(provider, m.id), curated: false, missing: false })
  }
  return options
}

/** Clean display name for the header chip. Uses the curated `short` name when the
 *  model is one we know; for custom ids the user typed themselves we title-case
 *  the segments so the chip never shows a raw lowercase-with-hyphens id. */
export function prettyModelName(provider: AiProviderId, id: string): string {
  const found = MODELS[provider]?.find((m) => m.id === id)
  if (found) return found.short
  if (!id) return ''
  // Aggregator ids carry a vendor prefix (anthropic/claude-sonnet-5) — the
  // vendor belongs in the menu's group label, never in the header chip
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1)
  return id
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .trim()
}

// Context-window floors (tokens): what decides when a document is too large
// to attach whole and must be excerpted instead (ai-retrieval.ts). Floors, not
// specs — deliberately conservative, because the two failure modes are not
// symmetric: a low guess costs an unnecessary excerpt, a high guess costs a
// hard provider error in the middle of a question. Live-discovered and custom
// ids get the provider floor (Azure lowest: deployments routinely cap below
// the base model). Maintained with the curated MODELS list (docs/MODEL-UPDATE.md).
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-fable-5': 200_000,
  'claude-opus-4-8': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.6-sol': 250_000,
  'gpt-5.6-terra': 250_000,
  'gpt-5.6-luna': 250_000
}

const PROVIDER_CONTEXT_FLOOR: Record<AiProviderId, number> = {
  anthropic: 200_000,
  openai: 200_000,
  azure: 120_000,
  // Conservative floors for the hosted services — the live catalog's
  // per-model context_length (OpenRouter reports it) overrides these, so the
  // floor only decides for models the listing did not describe.
  openrouter: 32_000,
  gemini: 200_000,
  xai: 128_000,
  mistral: 32_000,
  groq: 32_000,
  // Deliberately the lowest floor: an unknown compat endpoint may be a hosted
  // frontier model (≥128k) or a local model configured with a few thousand
  // tokens of context. 32k excerpts early rather than erroring mid-question;
  // the Ollama enrichment (/api/show) replaces the guess with the real number.
  compat: 32_000,
  mock: 200_000
}

/** Context-window floor for a model (tokens). For compat models the live
 *  catalog may know the REAL served context (Ollama /api/show) — that number
 *  replaces the provider floor in both directions: an 8k local model stops
 *  being silently truncated at 32k, and an explicitly configured 128k one
 *  stops being excerpted early. */
export function contextTokensFor(
  provider: AiProviderId,
  modelId: string,
  catalog?: AiModelCatalog
): number {
  const cat = catalogId(provider)
  if (cat) {
    const live = remoteModel(catalog, cat, modelId)?.contextTokens
    if (live) return live
  }
  return MODEL_CONTEXT_TOKENS[modelId] ?? PROVIDER_CONTEXT_FLOOR[provider] ?? 120_000
}

/** Whether the selected model can read images, as far as we know. Per-model
 *  answers exist only where a listing reports them (Ollama capabilities);
 *  unknown stays permissive — the degrade nets own the rest. */
export function modelSupportsImages(
  provider: AiProviderId,
  modelId: string,
  catalog?: AiModelCatalog
): boolean {
  const cat = catalogId(provider)
  if (!cat) return true
  return remoteModel(catalog, cat, modelId)?.vision !== false
}

// Where each provider lets you set a spending cap — linked from the key field
// so the reminder to cap a key is one click from acting on it.
export const SPEND_CAP_URLS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'https://console.anthropic.com/settings/limits',
  openai: 'https://platform.openai.com/settings/organization/limits',
  azure: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview',
  openrouter: 'https://openrouter.ai/settings/credits',
  gemini: 'https://aistudio.google.com/usage',
  xai: 'https://console.x.ai/',
  mistral: 'https://console.mistral.ai/billing/',
  groq: 'https://console.groq.com/settings/billing'
}

/** Short names for the spend-cap link row (the full keyProviders names are
 *  too long to sit inline in one sentence) */
export const SPEND_CAP_LABELS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  azure: 'Azure',
  openrouter: 'OpenRouter',
  gemini: 'Google',
  xai: 'xAI',
  mistral: 'Mistral',
  groq: 'Groq'
}

export const THINKING_LEVELS: { id: ThinkingLevel; key: MsgKey }[] = [
  { id: 'off', key: 'ai.thinkOff' },
  { id: 'low', key: 'ai.thinkLow' },
  { id: 'medium', key: 'ai.thinkMedium' },
  { id: 'high', key: 'ai.thinkHigh' }
]

/** Configurable providers for the key manager and the model menu (mock is
 *  not listed — it needs no setup). Same RANKED order as providerLabels; a
 *  function, not a constant, because the compat label is translated. */
export const keyProviders = (): { id: AiProviderId; name: string }[] => [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Claude (Anthropic)' },
  { id: 'gemini', name: 'Google Gemini' },
  { id: 'azure', name: 'Azure OpenAI' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'xai', name: 'xAI (Grok)' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'groq', name: 'Groq' },
  { id: 'compat', name: t('ai.providerCompat') }
]

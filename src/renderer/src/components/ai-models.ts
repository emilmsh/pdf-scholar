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
import { curateRemoteModels, isLocalEndpoint, remoteModel } from '../../../shared/ai-model-catalog'
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
//
// These lists are the WHOLE menu for their provider (modelOptions below):
// a model is offered because we verified it against our request parameters,
// never because the provider happens to list it — offering fewer models that
// work beats offering everything (Emil, 2026-08-12). Kept current by the
// scheduled review in docs/MODEL-UPDATE.md; deliberately short — current
// generation only, no retired or dated-snapshot ids.
//
// Before adding an entry, read "Curation rules" at the top of
// docs/MODEL-UPDATE.md: ~7 models per provider, image-in/text-out models only,
// and a `short` that fits ~85px of header chip.
export const MODELS: Record<
  AiProviderId,
  { id: string; label: string; short: string; hint?: MsgKey }[]
> = {
  anthropic: [
    // Fable 5.1 replaced Fable 5 in the same slot 2026-09-05 (launched
    // 2026-09-01; Fable 5 moved to Anthropic's "Legacy models" list, still
    // served — a stored Fable 5 selection stays pickable)
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', short: 'Fable 5.1', hint: 'ai.modelHintHeaviest' },
    { id: 'claude-opus-5', label: 'Claude Opus 5', short: 'Opus 5', hint: 'ai.modelHintCapable' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', short: 'Sonnet 5', hint: 'ai.modelHintRecommended' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', short: 'Haiku 4.5', hint: 'ai.modelHintFast' }
  ],
  openai: [
    // GPT-6 Astra (launched 2026-09-03) sits above the 5.6 trio, which stays
    // current — Astra is a new top tier, not a replacement
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', short: 'GPT-6 Astra', hint: 'ai.modelHintHeaviest' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', short: 'GPT-5.6 Sol', hint: 'ai.modelHintCapable' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', short: 'GPT-5.6 Terra', hint: 'ai.modelHintRecommended' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', short: 'GPT-5.6 Luna', hint: 'ai.modelHintFast' }
  ],
  azure: [],
  // Hosted-service lineups verified against provider docs 2026-08-12/13
  // (docs/agent-notes/modeller-api.md has the sources and open questions)
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', short: 'Gemini 3.1 Pro', hint: 'ai.modelHintCapable' },
    // Replaced gemini-3.6-flash this round (superseded 2026-08-13, same slot)
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', short: 'Gemini 3.7 Flash', hint: 'ai.modelHintRecommended' },
    // `short` drops "Flash-" — the full name is the widest label in the whole
    // catalogue and the only one the header chip still cannot fit at the
    // default panel width. The menu keeps the provider's own name.
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', short: 'Gemini 3.5 Lite', hint: 'ai.modelHintFast' }
  ],
  xai: [
    { id: 'grok-4.6', label: 'Grok 4.6', short: 'Grok 4.6', hint: 'ai.modelHintCapable' },
    { id: 'grok-4.3', label: 'Grok 4.3', short: 'Grok 4.3', hint: 'ai.modelHintRecommended' }
  ],
  // Mistral publishes dated ids only — Medium outranks Large in their current
  // lineup (Medium 3.5 is the frontier model, Large 3 the value workhorse)
  mistral: [
    { id: 'mistral-medium-3-5-26-04', label: 'Mistral Medium 3.5', short: 'Mistral Medium', hint: 'ai.modelHintCapable' },
    { id: 'mistral-large-3-25-12', label: 'Mistral Large 3', short: 'Mistral Large', hint: 'ai.modelHintRecommended' },
    { id: 'mistral-small-4-0-26-03', label: 'Mistral Small 4', short: 'Mistral Small', hint: 'ai.modelHintFast' }
  ],
  // Groq's PRODUCTION tier only (their own designation) — the Llama pair was
  // deprecated 2026-06-17 with gpt-oss as the named replacement
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', short: 'GPT-OSS 120B', hint: 'ai.modelHintRecommended' },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', short: 'GPT-OSS 20B', hint: 'ai.modelHintFast' }
  ],
  // No curated list where the endpoint IS the catalogue: OpenRouter is an
  // aggregator (hundreds of models is the product) and compat is whatever
  // server the user pointed us at — the live /models fetch fills those menus
  openrouter: [],
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

/** The dropdown list for a provider. A provider with a curated list shows
 *  EXACTLY that list — live-discovered models are not appended, because a new
 *  id is a model whose parameters nobody has verified yet (the scheduled
 *  review in docs/MODEL-UPDATE.md adds it once someone has). The live catalog
 *  still speaks here in one way: a curated id the provider no longer lists is
 *  flagged (probably retired — the UI marks it ⚠).
 *
 *  Providers with no curated list (OpenRouter, compat) are the opposite by
 *  design: the endpoint IS the catalogue, so the live fetch fills the menu —
 *  but a catalogue of 409 is not a menu, so a long self-describing list is put
 *  through `curateRemoteModels` first (docs/MODEL-UPDATE.md § Curation rules).
 *  `all` skips that selection: the menu passes it while the user is typing in
 *  the filter field, which is what keeps every model REACHABLE by name even
 *  though only the selection is offered.
 *  For compat, pass the configured base URL: the snapshot remembers which
 *  endpoint it came from, and a list fetched from another server must not
 *  show against this one. */
export function modelOptions(
  provider: AiProviderId,
  catalog?: AiModelCatalog,
  compatBaseUrl?: string,
  opts?: { all?: boolean }
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
  if (curated.length > 0) {
    if (!remote) return curated.map((m) => ({ ...m, curated: true, missing: false }))
    // Gemini's compat listing prefixes ids with "models/" while chat accepts
    // the bare id — normalize so the retirement flag never fires on a prefix
    const remoteIds = new Set(remote.models.map((m) => m.id.replace(/^models\//, '')))
    return curated.map((m) => ({ ...m, curated: true, missing: !remoteIds.has(m.id) }))
  }
  if (!remote) return []
  const local = Boolean(
    provider === 'compat' && catalog?.compat && isLocalEndpoint(catalog.compat.baseUrl)
  )
  // «lokal»-merke: models served from a loopback endpoint say so in the list
  // (the short chip name stays clean)
  const localSuffix = local ? ` · ${t('ai.localTag')}` : ''
  // A local server is the one endpoint that really does get to decide: the
  // models on it are there because the user pulled them, one at a time. The
  // selection rule is for a hosted catalogue nobody curated.
  const listed = opts?.all || local ? remote.models : curateRemoteModels(remote.models)
  return listed.map((m) => ({
    id: m.id,
    label: (m.displayName ?? prettyModelName(provider, m.id)) + localSuffix,
    short: prettyModelName(provider, m.id),
    curated: false,
    missing: false
  }))
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
  // Anthropic's own model table (platform.claude.com, verified 2026-08-13,
  // Fable 5.1 added 2026-09-05) states 1M tokens for Fable 5.1, Opus 5 and
  // Sonnet 5 — matches docs/agent-notes/modeller-api.md, which had recorded
  // the same number since July; the two were out of sync here until this pass.
  'claude-fable-5-1': 1_000_000,
  // claude-fable-5 kept here though no longer curated (see MODELS.anthropic) —
  // a stored selection from before 5.1 must not regress to the 200k floor
  'claude-fable-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  // 922K is the documented INPUT capacity (1.05M total minus the 128K output
  // ceiling); 900K keeps the floor conservative without throwing the window
  // away, as the old 250_000 did. Verified 2026-08-13 (Astra 2026-09-05, same
  // numbers on its model page), see modeller-api.md.
  'gpt-6-astra': 900_000,
  'gpt-5.6-sol': 900_000,
  'gpt-5.6-terra': 900_000,
  'gpt-5.6-luna': 900_000,
  // Verified against provider docs 2026-08-12/13; entries missing here on
  // purpose (Gemini Flash-Lite) fall back to the provider floor because no
  // context number was documented — excerpting early is the cheap failure,
  // erroring mid-question is not
  'gemini-3.1-pro-preview': 1_000_000,
  'gemini-3.7-flash': 1_000_000,
  // gemini-3.6-flash kept here though no longer curated (see MODELS.gemini) —
  // a stored selection from before this review must not regress to the 200k
  // provider floor
  'gemini-3.6-flash': 1_000_000,
  'grok-4.6': 500_000,
  // grok-4.5 kept here though no longer curated (see MODELS.xai) — a stored
  // selection from before this review must not regress to the 128k floor
  'grok-4.5': 500_000,
  'grok-4.3': 1_000_000,
  'openai/gpt-oss-120b': 131_072,
  'openai/gpt-oss-20b': 131_072,
  // Mistral model cards (docs.mistral.ai, verified 2026-08-13): all three of
  // the "26" generation share a 256k window
  'mistral-medium-3-5-26-04': 256_000,
  'mistral-large-3-25-12': 256_000,
  'mistral-small-4-0-26-03': 256_000
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

// Where each provider lets you create an API key — linked from the key field
// so "get a key" is one click, not a search. Azure is deliberately absent: it
// has no single create page (keys live on the resource's Keys-and-Endpoint
// blade), so its field gets an explanatory hint instead. 'compat' is absent
// for the same kind of reason — a local Ollama or LM Studio needs no key at
// all, and a custom endpoint's key comes from whoever runs it.
export const KEY_CREATE_URLS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  gemini: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  mistral: 'https://console.mistral.ai/api-keys/',
  groq: 'https://console.groq.com/keys'
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

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
import { t } from '../i18n'
import type { MsgKey } from '../i18n'

export const providerLabels = (): { id: AiProviderId; label: string }[] => [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'mock', label: t('ai.providerMock') }
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
 *  fetched catalog this degrades to exactly the curated list. */
export function modelOptions(provider: AiProviderId, catalog?: AiModelCatalog): ModelOption[] {
  const curated = MODELS[provider] ?? []
  const remote =
    provider === 'anthropic' || provider === 'openai' ? catalog?.[provider] : undefined
  if (!remote) return curated.map((m) => ({ ...m, curated: true, missing: false }))
  const remoteIds = new Set(remote.models.map((m) => m.id))
  const options: ModelOption[] = curated.map((m) => ({
    ...m,
    curated: true,
    missing: !remoteIds.has(m.id)
  }))
  for (const m of remote.models) {
    if (curated.some((c) => c.id === m.id)) continue
    const label = m.displayName ?? prettyModelName(provider, m.id)
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
  return id
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .trim()
}

// Where each provider lets you set a spending cap — linked from the key field
// so the reminder to cap a key is one click from acting on it.
export const SPEND_CAP_URLS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'https://console.anthropic.com/settings/limits',
  openai: 'https://platform.openai.com/settings/organization/limits',
  azure: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview'
}

export const THINKING_LEVELS: { id: ThinkingLevel; key: MsgKey }[] = [
  { id: 'off', key: 'ai.thinkOff' },
  { id: 'low', key: 'ai.thinkLow' },
  { id: 'medium', key: 'ai.thinkMedium' },
  { id: 'high', key: 'ai.thinkHigh' }
]

/** Key-holding providers, in display order (mock is not key-based) */
export const KEY_PROVIDERS: { id: AiProviderId; name: string }[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'azure', name: 'Azure OpenAI' }
]

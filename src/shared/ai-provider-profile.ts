// What each AI provider supports, as ONE explicit declaration — the contract
// that keeps a wider provider set from breaking the UI (docs/ROADMAP.md fase 10).
//
// The rule the profile enforces: a capability a provider lacks must not exist
// as a choice. The composer's web-search toggle, the reasoning selector and the
// key requirements all read this table instead of switching on provider ids,
// so adding a provider means declaring what it can do here — every affordance
// then shows or hides itself, and a forgotten surface fails visibly in review
// rather than silently at send time.
//
// The profile is deliberately about the PROVIDER, not the model: model-level
// variation (which effort levels, context size) stays in the live catalog
// (ai-model-catalog.ts) and per-family rules (ai-chat.ts). Two safety nets sit
// under this table for whatever it cannot know: the degrade-on-400 retry in
// ai-chat.ts, and the named AI_ERRORS codes.
//
// `npm run test:ai-chat` holds each provider's request path to its row here —
// a profile that disagrees with what the path actually sends is a test failure,
// not a latent UI lie.
import {
  STANDARD_THINKING_LEVELS,
  THINKING_LEVELS,
  type AiModelCaps,
  type AiProviderId,
  type ThinkingLevel
} from './types'

/** Anthropic models whose thinking cannot be configured at all: the Fable
 *  family and Opus from 5.5 on. Shared with request shaping (anthropicTraits
 *  in ai-chat.ts), where the sources are. */
export const ANTHROPIC_ALWAYS_THINKS_RE = /fable|mythos|opus-5-5/i

/** Haiku 4.5 and older: no effort parameter and no adaptive thinking, so the
 *  request carries no reasoning control at all (Haiku 5.5 has both). */
export function isLegacyHaiku(model: string): boolean {
  return /haiku/i.test(model) && !/haiku-[5-9]/i.test(model)
}

/** OpenAI's own models that take `xhigh` and `max`, by exact id, on the
 *  OpenAI API and the ChatGPT plan: the model overview's «Reasoning» row
 *  reads low to max for GPT-6.2 Astra and Sol, none to max for GPT-6.1 Terra
 *  and GPT-6 Luna, and GPT-6.1 Sol's own page says «`reasoning.effort`
 *  supports `low`, `medium` (default), `high`, `xhigh`, and `max`»
 *  (developers.openai.com/api/docs/models, read 2026-11-27). Exact ids and
 *  the two first-party providers only: the same id behind a custom endpoint,
 *  OpenRouter or an Azure deployment is somebody else's server. */
const OPENAI_XHIGH_MAX_RE = /^gpt-6\.2-(astra|sol)$|^gpt-6\.1-(sol|terra)$|^gpt-6-luna$/i

/** `xhigh` with no `max` above it, at the provider that documents it: xAI for
 *  grok-4.3 and 4.5 to 4.7, Google for gemini-4-hydrogen and gemini-4-neon
 *  (the sources are at OPENAI_REASONING_RE below). */
const XHIGH_AT: Partial<Record<AiProviderId, RegExp>> = {
  xai: /grok-4\.[3567]/i,
  gemini: /gemini-4-(hydrogen|neon)/i
}

/** The reasoning efforts THIS model takes, lowest first: what the menu offers
 *  and what a request may carry. Empty = the request carries no reasoning
 *  control for this model, and the menu shows none.
 *
 *  «Off» is listed only where the model can stop reasoning; a model that
 *  cannot (Fable, GPT-6.2 Astra, Grok 4.7 ...) starts at Low. The levels
 *  above High are listed only where the provider documents them for the
 *  model by name. Mistral's reasoning models know two values, off and on.
 *  An Azure deployment's name says nothing about its model, so it gets the
 *  four everybody has and the degrade-on-400 net.
 *
 *  `caps` is the live capability data for an Anthropic model, when a
 *  snapshot exists: the API's own list of efforts wins over the family rule. */
export function thinkingLevels(provider: AiProviderId, model: string, caps?: AiModelCaps): readonly ThinkingLevel[] {
  const profile = PROVIDER_PROFILES[provider].thinking

  if (profile === 'none') return []
  if (profile === 'per-model') {
    const efforts = caps ? caps.effort : isLegacyHaiku(model) ? [] : ['low', 'medium', 'high']
    const on = THINKING_LEVELS.filter((level) => level !== 'off' && efforts.includes(level))

    if (on.length === 0) return []
    return ANTHROPIC_ALWAYS_THINKS_RE.test(model) ? on : ['off', ...on]
  }
  if (provider === 'azure') return STANDARD_THINKING_LEVELS
  if (MISTRAL_REASONING_RE.test(model)) return ['off', 'high']
  if (!OPENAI_REASONING_RE.test(model)) return []

  const firstParty = provider === 'openai' || provider === 'chatgpt'
  const above: ThinkingLevel[] =
    firstParty && OPENAI_XHIGH_MAX_RE.test(model) ? ['xhigh', 'max'] : XHIGH_AT[provider]?.test(model) ? ['xhigh'] : []
  const off: ThinkingLevel[] = OPENAI_ALWAYS_REASONS_RE.test(model) ? [] : ['off']

  return [...off, 'low', 'medium', 'high', ...above]
}

/** The level a saved preference comes to on this model: itself when the model
 *  takes it, else the nearest level above it that the model does take, else
 *  the model's highest. So «Maximum» chosen on one model is «High» on a model
 *  that stops there and Maximum again on going back, and «Off» on a model
 *  that cannot stop reasoning is its lowest effort. The preference itself is
 *  never rewritten. The menu shows this level and the request sends it. */
export function effectiveThinking(
  provider: AiProviderId,
  model: string,
  level: ThinkingLevel,
  caps?: AiModelCaps
): ThinkingLevel {
  const levels = thinkingLevels(provider, model, caps)

  if (levels.length === 0 || levels.includes(level)) return level

  const rank = THINKING_LEVELS.indexOf(level)

  return levels.find((one) => THINKING_LEVELS.indexOf(one) > rank) ?? levels[levels.length - 1]
}

export interface AiProviderProfile {
  /** How grounded citations travel: 'native' = the provider emits citation
   *  blocks itself (char offsets into the document we sent); 'contract' = the
   *  [KILDE s.N: "…"] prompt contract, parsed out of the answer text. */
  citations: 'native' | 'contract'
  /** A server-side web-search tool exists — the composer shows the globe toggle */
  webSearch: boolean
  /** Reasoning control: 'per-model' = capability-dependent (Anthropic — the
   *  catalog/family rules decide per model), 'effort' = OpenAI-style
   *  reasoning_effort, 'none' = no control (the selector is hidden) */
  thinking: 'per-model' | 'effort' | 'none'
  /** Accepts image parts in user turns */
  vision: boolean
  /** A request cannot run without an API key (false = keyless, e.g. mock now,
   *  local servers later) */
  keyRequired: boolean
}

/** Model ids that accept OpenAI-style reasoning_effort. One definition shared
 *  by request shaping (ai-chat.ts) and the reasoning selector's visibility
 *  (AiModelMenu), so what the UI offers and what the request sends can never
 *  drift apart. Providers whose profile says thinking:'per-model' (Anthropic)
 *  have their own capability logic and never consult this.
 *
 *  grok-4.5, grok-4.6 and grok-4.7 are included because xAI documents
 *  reasoning_effort low/medium/high/xhigh for all three (docs/agent-notes/
 *  modeller-api.md, verified 2026-08-12, 2026-08-13 and 2026-09-26); 4.5 and
 *  4.6 stay in the regex even though the curated menu now offers 4.7, so a
 *  stored selection from before either switch keeps working.
 *
 *  grok-4.3 is included because its own model page (docs.x.ai/developers/
 *  models/grok-4.3, verified 2026-11-09) documents "Reasoning efforts
 *  (supported): none, low, medium, high, xhigh" — the generic xAI reasoning
 *  capabilities page still doesn't name 4.3 at all (only 4.5/4.6/4.7 and the
 *  multi-agent variant), which is why this stayed an open question for three
 *  months; the model's own page settles it. Unlike 4.5–4.7, 4.3 documents
 *  `none`, so it does NOT go in `OPENAI_ALWAYS_REASONS_RE` below.
 *
 *  gpt-oss (Groq's openai/gpt-oss-120b and openai/gpt-oss-20b) is included
 *  because Groq documents reasoning_effort low/medium/high for both
 *  (console.groq.com/docs/reasoning, verified 2026-08-17).
 *
 *  gemini-4-argon is included because Google's OpenAI-compat guide
 *  (aistudio.google.com/docs/openai, verified 2026-11-16, formerly
 *  ai.google.dev/gemini-api/docs/openai — redirects there since 2026-11-09)
 *  maps reasoning_effort minimal/low/medium/high to a `thinking_level` of
 *  low/low/medium/high for this model BY NAME. gemini-4-hydrogen is included
 *  for the same reason: the mapping table's former Argon-only column was
 *  renamed to a generic "Gemini 4" column on 2026-11-16 and now covers both
 *  ids, with `xhigh` documented for Hydrogen specifically. gemini-4-neon
 *  (added 2026-11-23, same table re-checked that day) is included the same
 *  way: the `xhigh` cell now names BOTH `gemini-4-neon` and `gemini-4-hydrogen`
 *  — so Neon is treated as covered by the rest of that column too. All three
 *  are literal ids, not a `gemini-4` family pattern — gemini-4-carbon, added
 *  2026-11-16, still has NO column in that table and so stays unverified
 *  (open question in docs/agent-notes/modeller-api.md), and the table's other
 *  columns (3.1 Flash-Lite, 3 Flash, 2.5) still don't correspond to any of our
 *  curated Gemini ids either. */
export const OPENAI_REASONING_RE = /gpt-[5-9]|o[0-9]|grok-4\.[3567]|gpt-oss|gemini-4-(argon|hydrogen|neon)/i

/** Models whose reasoning cannot be switched off, so «Av» maps to the lowest
 *  effort instead of `none` — the same honest mapping the Anthropic path uses
 *  for its always-thinking models. Each one documents the refusal:
 *  - GPT-6 Astra and GPT-6.1 Sol 400 on `reasoning.effort: "none"` (and on
 *    `"minimal"` for 6.1 Sol) — developers.openai.com/api/docs/models/
 *    gpt-6-astra (verified 2026-09-05) and /gpt-6.1-sol (verified 2026-10-05).
 *    NOT GPT-6 Sol or Luna: both document `none` (their model pages, verified
 *    2026-09-26).
 *  - GPT-6.2 Astra and GPT-6.2 Sol 400 on `none` too: «GPT-6.2 Astra and
 *    GPT-6.2 Sol reject requests that set `reasoning.effort` … to `none`»
 *    (developers.openai.com/api/docs/guides/reasoning, verified 2026-11-19).
 *  - grok-4.5/4.6/4.7: «Reasoning cannot be disabled» (docs.x.ai/developers/
 *    model-capabilities/text/reasoning, verified 2026-09-26).
 *  - gpt-oss on Groq takes low/medium/high only; `none` is reserved for the
 *    Qwen models Groq also hosts (console.groq.com/docs/reasoning, verified
 *    2026-08-31).
 *  - gemini-4-argon, gemini-4-hydrogen and gemini-4-neon: the reasoning_effort
 *    mapping table (aistudio.google.com/docs/openai, verified 2026-11-16,
 *    re-checked 2026-11-23 for Neon) has no `none`/off row for any of the
 *    three models' shared column, and the page states reasoning "cannot be
 *    turned off for Gemini 2.5 Pro, Gemini 3, or Gemini 4 models" — all three
 *    are newer reasoning models in the same mandatory-thinking family, with no
 *    documented off switch. Treated like Fable/Astra: «Av» sends the lowest
 *    effort instead of guessing at an undocumented `none`. gemini-4-carbon is
 *    deliberately NOT here: it has no column in that table at all, so no
 *    reasoning parameter is sent for it in the first place (see
 *    OPENAI_REASONING_RE).
 *  Until 2026-09-26 «Av» sent `none` to the last two — a value neither
 *  documents — and leaned on the degrade-on-400 net when it was refused. */
export const OPENAI_ALWAYS_REASONS_RE =
  /gpt-6-astra|gpt-6\.1-sol|gpt-6\.2-(astra|sol)|grok-4\.[5-7]|gpt-oss|gemini-4-(argon|hydrogen|neon)/i

/** Mistral's reasoning switch is `reasoning_effort` too, but with a two-value
 *  domain: `"high"` (thinking on) or `"none"` (off — «the model thinks
 *  minimally and the thinking chunk is omitted»), documented for Mistral
 *  Medium 3.5 (`mistral-medium-2604`) and Mistral Small 4 (`mistral-small-2603`,
 *  which the docs name through its alias `mistral-small-latest`) at
 *  docs.mistral.ai/capabilities/reasoning, verified 2026-10-05 against the
 *  docs — the live run that day was 429'd by the owner's account quota, so
 *  the first real question is still owed (docs/agent-notes/modeller-api.md).
 *  Low/Medium/High in the UI therefore all send `high` — there is no smaller
 *  step to send — and Off sends `none`. Reasoning is off by default at
 *  Mistral, so a model outside this match is simply asked without the
 *  parameter, as before; the match is narrow on purpose (Mistral Large 3 and
 *  Ministral 3 document no reasoning_effort at all). Small 4 left the curated
 *  menu the same day (see MODELS.mistral), but a stored or typed id still
 *  gets the documented mapping. */
export const MISTRAL_REASONING_RE = /^mistral-(medium-(2604|3[-.]5|latest)|small-(2603|latest))$/i

/** Mistral Small 4 answers BLIND when reasoning is on: the same red square it
 *  names «Rød.» under `reasoning_effort: "none"` becomes «Jeg kan ikke se
 *  bildet» under `"high"` (two direct requests, 2026-10-05; the live suite
 *  saw the same). Medium 3.5 reads the image under `high`. So a request that
 *  carries an image is sent to Small 4 with `none` whatever the UI level —
 *  a sighted answer without reasoning beats a reasoned answer about a picture
 *  the model never saw. Undocumented on Mistral's side; re-probe each review. */
export const MISTRAL_BLIND_WHEN_REASONING_RE = /^mistral-small-(2603|latest)$/i

/** The first-class hosted OpenAI-compatible services (fase 10.3): a FINITE,
 *  curated set — one key field each, entered once, stored exactly like the
 *  Anthropic/OpenAI keys — instead of a free-form endpoint manager. The set
 *  is deliberately short: these five cover practically everyone (OpenRouter
 *  is itself an aggregator of hundreds of models), and anything else fits
 *  the compat provider's custom base URL. All five ride the shared Chat
 *  Completions path with the quote contract. URLs verified on the monthly
 *  pass (docs/MAINTENANCE.md row 4). */
export type CompatServiceId = 'openrouter' | 'gemini' | 'xai' | 'mistral' | 'groq'

export const COMPAT_SERVICES: Record<CompatServiceId, { baseUrl: string }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  // Google's official OpenAI-compatible endpoint — the reason the native
  // Gemini path (old fase 3) was dropped
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  xai: { baseUrl: 'https://api.x.ai/v1' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1' }
}

export function isCompatService(provider: AiProviderId): provider is CompatServiceId {
  return provider in COMPAT_SERVICES
}

export const PROVIDER_PROFILES: Record<AiProviderId, AiProviderProfile> = {
  anthropic: {
    citations: 'native',
    webSearch: true,
    thinking: 'per-model',
    vision: true,
    keyRequired: true
  },
  openai: {
    citations: 'contract',
    webSearch: true,
    thinking: 'effort',
    vision: true,
    keyRequired: true
  },
  // The same Responses request as 'openai', sent to the ChatGPT plan's Codex
  // backend. keyRequired stands for "signed in" here — hasKey.chatgpt is the
  // token bundle, never a pasted key.
  chatgpt: {
    citations: 'contract',
    webSearch: true,
    thinking: 'effort',
    vision: true,
    keyRequired: true
  },
  // Azure deployments go through Chat Completions, which has no server-side
  // web-search tool — the toggle must not exist there.
  azure: {
    citations: 'contract',
    webSearch: false,
    thinking: 'effort',
    vision: true,
    keyRequired: true
  },
  // The five hosted services share one row shape: Chat Completions + quote
  // contract, no server-side web-search tool, OpenAI-style effort where the
  // model id says so, images passed through (the model errors honestly when
  // it cannot read them), ordinary key requirement.
  openrouter: { citations: 'contract', webSearch: false, thinking: 'effort', vision: true, keyRequired: true },
  gemini: { citations: 'contract', webSearch: false, thinking: 'effort', vision: true, keyRequired: true },
  xai: { citations: 'contract', webSearch: false, thinking: 'effort', vision: true, keyRequired: true },
  mistral: { citations: 'contract', webSearch: false, thinking: 'effort', vision: true, keyRequired: true },
  groq: { citations: 'contract', webSearch: false, thinking: 'effort', vision: true, keyRequired: true },
  // Custom OpenAI-compatible endpoints and local servers (Ollama/LM Studio).
  // Keyless local servers are the point, so no key requirement — readiness is
  // base URL + model id, enforced per request (AI_ERRORS.compatUnconfigured)
  // and in each platform's hasKey view.
  compat: {
    citations: 'contract',
    webSearch: false,
    thinking: 'effort',
    vision: true,
    keyRequired: false
  },
  // The mock mirrors the richest real provider so every chip and citation UI
  // stays testable offline; 'none' thinking because there is nothing to tune.
  mock: {
    citations: 'native',
    webSearch: true,
    thinking: 'none',
    vision: true,
    keyRequired: false
  }
}

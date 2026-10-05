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
import type { AiProviderId } from './types'

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
 *  stored selection from before either switch keeps working. The match is
 *  deliberately narrow — other grok ids (4.3) stay out until someone
 *  verifies them, per the fewer-models-that-work rule.
 *
 *  gpt-oss (Groq's openai/gpt-oss-120b and openai/gpt-oss-20b) is included
 *  because Groq documents reasoning_effort low/medium/high for both
 *  (console.groq.com/docs/reasoning, verified 2026-08-17). */
export const OPENAI_REASONING_RE = /gpt-[5-9]|o[0-9]|grok-4\.[5-7]|gpt-oss/i

/** Models whose reasoning cannot be switched off, so «Av» maps to the lowest
 *  effort instead of `none` — the same honest mapping the Anthropic path uses
 *  for its always-thinking models. Each one documents the refusal:
 *  - GPT-6 Astra 400s on `reasoning.effort: "none"` (developers.openai.com/
 *    api/docs/guides/reasoning, verified 2026-09-05). NOT GPT-6 Sol or Luna:
 *    both document `none` (their model pages, verified 2026-09-26).
 *  - grok-4.5/4.6/4.7: «Reasoning cannot be disabled» (docs.x.ai/developers/
 *    model-capabilities/text/reasoning, verified 2026-09-26).
 *  - gpt-oss on Groq takes low/medium/high only; `none` is reserved for the
 *    Qwen models Groq also hosts (console.groq.com/docs/reasoning, verified
 *    2026-08-31).
 *  Until 2026-09-26 «Av» sent `none` to the last two — a value neither
 *  documents — and leaned on the degrade-on-400 net when it was refused. */
export const OPENAI_ALWAYS_REASONS_RE = /gpt-6-astra|grok-4\.[5-7]|gpt-oss/i

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

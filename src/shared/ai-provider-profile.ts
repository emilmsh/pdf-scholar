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
  // Azure deployments go through Chat Completions, which has no server-side
  // web-search tool — the toggle must not exist there.
  azure: {
    citations: 'contract',
    webSearch: false,
    thinking: 'effort',
    vision: true,
    keyRequired: true
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

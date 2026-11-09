// A model id the reader types into the model menu's search field, offered as
// a choice of its own — «Bruk «gpt-6.2-sol» hos OpenAI» — so a model launched
// before the curated list catches up is reachable (Emil, 2026-11-02: the menu
// is curated-only by rule, but the curation is a human step and can be late).
//
// Pure: the menu hands in the text, the providers in its own order with their
// state, and the ids it already lists; this decides what to offer. Nothing is
// verified here — the row's hint says so. Request shaping falls back to name
// patterns (OPENAI_REASONING_RE and friends) and the degrade-on-400 net, which
// is what makes an unseen id from a known provider usually answer.
import type { AiProviderId } from './types'

/** What a model id may look like, at any provider we know: lowercase-ish
 *  tokens joined by dots, dashes, underscores, a vendor slash or a `:tag`
 *  (`gpt-6.2-sol`, `claude-opus-6`, `anthropic/claude-opus-6:beta`). At least
 *  two characters (OpenAI's `o5` is an id), at least one letter (a bare number
 *  is a count, not a model), no whitespace — a search phrase with a space is a
 *  search, not an id. */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._:/-]{1,119}$/i

/** The id the text names, trimmed — or null when the text is a search, not an id */
export function typedModelId(text: string): string | null {
  const id = text.trim()
  if (!MODEL_ID_RE.test(id)) return null
  if (!/[a-z]/i.test(id)) return null
  // A trailing separator is a reader still typing, not an id
  if (/[._:/-]$/.test(id)) return null
  return id
}

export interface TypedModelProvider {
  id: AiProviderId
  /** Has a key here — a provider without one cannot be asked anyway */
  keyed: boolean
  /** Carries a curated list (the live list IS the menu elsewhere: OpenRouter
   *  and the compat endpoint list everything they serve, Azure takes the
   *  deployment name in the settings) */
  curated: boolean
}

export interface TypedModelOffer {
  provider: AiProviderId
  id: string
}

/** The rows to offer for `text`: one per keyed curated provider, in the order
 *  given, skipping a provider that already lists the id (that one is a hit,
 *  not an offer). Empty when the text is not an id. `listed` holds
 *  "<provider>:<id>" for every entry the menu knows, compared case-folded —
 *  ids are case-sensitive at the providers, so the offer keeps the case typed. */
export function typedModelOffers(
  text: string,
  providers: readonly TypedModelProvider[],
  listed: ReadonlySet<string>
): TypedModelOffer[] {
  const id = typedModelId(text)
  if (!id) return []
  const lower = new Set([...listed].map((v) => v.toLowerCase()))
  return providers
    .filter((p) => p.keyed && p.curated && !lower.has(`${p.id}:${id}`.toLowerCase()))
    .map((p) => ({ provider: p.id, id }))
}

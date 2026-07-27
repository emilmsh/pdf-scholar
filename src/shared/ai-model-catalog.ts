// Live model catalogs, fetched from the providers with the user's own API key.
//
// Why this exists: the app ships a curated model list (ai-models.ts) and a set
// of per-family request-shaping rules (ai-chat.ts). Both drift as providers
// launch and retire models. This module is the counterweight — it asks the
// providers what actually exists right now:
//
//   - Anthropic GET /v1/models returns every model with a `capabilities` tree
//     (adaptive thinking? which effort levels?). That data replaces the
//     name-regex guessing in ai-chat.ts wherever a fetched snapshot exists.
//   - OpenAI GET /v1/models returns bare ids only — useful for discovering new
//     models and noticing retired ones, useless for capabilities.
//   - Azure deployments are per-account and have no reliable data-plane listing;
//     they stay manual.
//
// Platform-neutral on purpose (same rule as ai-chat.ts): Electron main and the
// browser extension both call these fetchers and cache the result themselves
// (pdfx-state.json / chrome.storage.local). Fetch failures throw — callers keep
// the previous snapshot, so a flaky network can never make the app dumber than
// the shipped curated list.
import type { AiModelCaps, AiModelCatalog, AiRemoteModel } from './types'

/** How long a fetched snapshot counts as fresh. Model launches are rare enough
 *  that a day-old list is fine, and the TTL keeps the refresh call free to
 *  sprinkle anywhere in the UI without hammering the providers. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/** Providers the catalog can be refreshed for (Azure is manual, mock is fake) */
export type CatalogProviderId = 'anthropic' | 'openai'
export const CATALOG_PROVIDERS: CatalogProviderId[] = ['anthropic', 'openai']

export function catalogStale(catalog: AiModelCatalog, provider: CatalogProviderId): boolean {
  const entry = catalog[provider]
  return !entry || Date.now() - entry.fetchedAt > CATALOG_TTL_MS
}

/** The live entry for a model id, when that provider's list has been fetched */
export function remoteModel(
  catalog: AiModelCatalog | undefined,
  provider: CatalogProviderId,
  id: string
): AiRemoteModel | undefined {
  return catalog?.[provider]?.models.find((m) => m.id === id)
}

// ---------- Anthropic ----------

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** Normalize the API's capabilities tree into the few facts request shaping
 *  needs. Every access is defensive: the tree is documented but untyped, and a
 *  missing branch must read as "not supported", never crash the refresh. */
function anthropicCaps(raw: unknown): AiModelCaps | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const caps = raw as {
    thinking?: { types?: Record<string, { supported?: boolean }> }
    effort?: Record<string, { supported?: boolean }>
  }
  return {
    adaptiveThinking: caps.thinking?.types?.adaptive?.supported === true,
    budgetThinking: caps.thinking?.types?.enabled?.supported === true,
    effort: EFFORT_LADDER.filter((level) => caps.effort?.[level]?.supported === true)
  }
}

/** GET https://api.anthropic.com/v1/models — works with the user's ordinary
 *  API key, no beta header. Throws on any HTTP failure. */
export async function fetchAnthropicModels(apiKey: string): Promise<AiRemoteModel[]> {
  const out: AiRemoteModel[] = []
  let after: string | null = null
  // has_more/last_id pagination; the bound is a runaway guard, not a limit
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after_id', after)
    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Lets the extension call this endpoint from a page (same reason the
        // SDK runs with dangerouslyAllowBrowser there); harmless in Node.
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    })
    if (!res.ok) throw new Error(`Anthropic models: HTTP ${res.status}`)
    const body = (await res.json()) as {
      data?: { id?: string; display_name?: string; capabilities?: unknown }[]
      has_more?: boolean
      last_id?: string
    }
    for (const m of body.data ?? []) {
      if (!m.id) continue
      const caps = anthropicCaps(m.capabilities)
      out.push({
        id: m.id,
        ...(m.display_name ? { displayName: m.display_name } : {}),
        ...(caps ? { caps } : {})
      })
    }
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  return out
}

// ---------- OpenAI ----------

/** Chat-capable base models only. The raw list is dominated by embeddings/tts/
 *  image/audio models and dated snapshots of the same base model; showing those
 *  would bury the three ids anyone actually wants. Ids are kept when they look
 *  like a chat family (gpt-*, o-series) and are not a dated snapshot. */
function isOpenAiChatModel(id: string): boolean {
  if (!/^(gpt-[0-9]|o[0-9])/i.test(id)) return false
  if (/(audio|realtime|image|embed|tts|whisper|moderation|transcribe|dall|instruct|codex|search)/i.test(id)) return false
  // Dated or numbered snapshots (gpt-4o-2024-08-06, gpt-4-0125): the alias id
  // stays in the list, so hide the frozen duplicates.
  if (/-\d{4}(-\d{2}-\d{2})?$/.test(id)) return false
  return true
}

/** GET https://api.openai.com/v1/models — ids only; no capability data exists. */
export async function fetchOpenAiModels(apiKey: string): Promise<AiRemoteModel[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) throw new Error(`OpenAI models: HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { id?: string; created?: number }[] }
  return (body.data ?? [])
    .filter((m): m is { id: string; created?: number } => !!m.id && isOpenAiChatModel(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({ id: m.id }))
}

/** Fetch fresh lists for every provider that has a key and a stale (or absent)
 *  snapshot. Returns the updated catalog; a provider whose fetch fails keeps
 *  its previous entry. Both platforms' refresh endpoints are this + their own
 *  persistence. */
export async function refreshCatalog(
  catalog: AiModelCatalog,
  keys: { [K in CatalogProviderId]?: string | undefined },
  force: boolean
): Promise<AiModelCatalog> {
  const next: AiModelCatalog = { ...catalog }
  await Promise.all(
    CATALOG_PROVIDERS.map(async (provider) => {
      const key = keys[provider]?.trim()
      if (!key) return
      if (!force && !catalogStale(catalog, provider)) return
      try {
        const models =
          provider === 'anthropic' ? await fetchAnthropicModels(key) : await fetchOpenAiModels(key)
        // An empty list is a provider hiccup, not "all models retired"
        if (models.length > 0) next[provider] = { fetchedAt: Date.now(), models }
      } catch {
        /* keep the previous snapshot */
      }
    })
  )
  return next
}

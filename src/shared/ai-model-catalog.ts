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
 *  that a day-old list is fine for the hosted providers, and the TTL keeps the
 *  refresh call free to sprinkle anywhere in the UI without hammering them.
 *  The compat entry is much shorter: a local Ollama's list changes whenever
 *  the user pulls a model, and asking localhost again costs nothing. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const COMPAT_TTL_MS = 5 * 60 * 1000

/** Providers the catalog can be refreshed for (Azure is manual, mock is fake) */
export type CatalogProviderId = 'anthropic' | 'openai' | 'compat'
export const CATALOG_PROVIDERS: CatalogProviderId[] = ['anthropic', 'openai', 'compat']

export function catalogStale(catalog: AiModelCatalog, provider: CatalogProviderId): boolean {
  const entry = catalog[provider]
  const ttl = provider === 'compat' ? COMPAT_TTL_MS : CATALOG_TTL_MS
  return !entry || Date.now() - entry.fetchedAt > ttl
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

// ---------- OpenAI-compatible endpoints (the compat provider) ----------

/** Ollama's out-of-the-box context (OLLAMA_CONTEXT_LENGTH default). This is
 *  the number that actually governs a default install: sending more does not
 *  error, it silently drops the OLDEST tokens — which for us is the system
 *  prompt and the document's start. So when /api/show reports no explicit
 *  num_ctx, we assume this and let the BM25 excerpt mode do its job, rather
 *  than trusting the architecture's maximum and getting silently truncated.
 *  Verified against Ollama's docs on the monthly pass (docs/MAINTENANCE.md). */
const OLLAMA_DEFAULT_NUM_CTX = 4096

/** How many models get the per-model /api/show enrichment. Local lists are
 *  short; this is a runaway guard for a hoarder's Ollama, not a limit. */
const OLLAMA_SHOW_CAP = 30

/** Ollama enrichment for one model: what /api/show knows that /v1/models
 *  does not — the context the server will really serve, and vision support.
 *  Every access is defensive (the tree varies by architecture); a missing
 *  branch reads as "unknown", never breaks the refresh. */
async function ollamaShow(
  origin: string,
  name: string
): Promise<Pick<AiRemoteModel, 'contextTokens' | 'vision'>> {
  const res = await fetch(`${origin}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Older Ollama expects `name`, newer `model` — sending both is harmless
    body: JSON.stringify({ model: name, name })
  })
  if (!res.ok) return {}
  const body = (await res.json()) as {
    capabilities?: string[]
    parameters?: string
    model_info?: Record<string, unknown>
  }
  const out: Pick<AiRemoteModel, 'contextTokens' | 'vision'> = {}
  if (Array.isArray(body.capabilities)) out.vision = body.capabilities.includes('vision')
  // The architecture's maximum lives under '<arch>.context_length'
  const info = body.model_info ?? {}
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null
  const maxRaw = arch ? info[`${arch}.context_length`] : Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1]
  const max = typeof maxRaw === 'number' && maxRaw > 0 ? maxRaw : undefined
  // num_ctx in the modelfile parameters is the served context; without it the
  // server uses its default regardless of what the architecture could do
  const numCtx = Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(body.parameters ?? '')?.[1])
  const served = numCtx > 0 ? numCtx : OLLAMA_DEFAULT_NUM_CTX
  out.contextTokens = max ? Math.min(served, max) : served
  return out
}

/** The model list for an OpenAI-compatible endpoint. Two shapes of server:
 *
 *  - An Ollama behind the base URL (detected by {origin}/api/tags answering):
 *    list from /api/tags and enrich each model via /api/show with the REAL
 *    served context and vision support — this is what makes local models
 *    first-class instead of guessed-at (docs/ROADMAP.md fase 10.2).
 *  - Anything else: GET {baseUrl}/models, the listing most compatible servers
 *    implement (OpenRouter, Mistral, Groq, LM Studio). Ids only, no
 *    filtering: the server lists exactly what it serves.
 *
 *  Throws on HTTP failure of the listing itself; enrichment failures degrade
 *  to an id-only entry. */
export async function fetchCompatModels(baseUrl: string, apiKey?: string): Promise<AiRemoteModel[]> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  let origin: string | null = null
  try {
    origin = new URL(base).origin
  } catch {
    /* not a parseable URL — let the /models fetch below produce the error */
  }
  if (origin) {
    try {
      const tags = await fetch(`${origin}/api/tags`)
      if (tags.ok) {
        const body = (await tags.json()) as { models?: { name?: string }[] }
        const names = (body.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => !!n)
        if (names.length > 0) {
          return await Promise.all(
            names.slice(0, OLLAMA_SHOW_CAP).map(async (name) => ({
              id: name,
              ...(await ollamaShow(origin, name).catch(() => ({})))
            }))
          )
        }
      }
    } catch {
      /* not an Ollama — fall through to the generic listing */
    }
  }
  const res = await fetch(`${base}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  })
  if (!res.ok) throw new Error(`Compat models: HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { id?: string }[] }
  return (body.data ?? [])
    .filter((m): m is { id: string } => !!m.id)
    .map((m) => ({ id: m.id }))
}

/** Loopback host = a local model server: no cost reminder applies, and the
 *  model menu says «lokal». Host-based on purpose — it is true for any local
 *  OpenAI-compatible server, not only a detected Ollama. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** What refreshCatalog needs per provider: the hosted providers are reachable
 *  with a key alone; compat needs the endpoint too (key optional there). An
 *  absent entry means "cannot refresh this one right now". */
export interface CatalogSources {
  anthropic?: { key: string }
  openai?: { key: string }
  compat?: { baseUrl: string; key?: string | undefined }
}

/** Fetch fresh lists for every reachable provider with a stale (or absent)
 *  snapshot. Returns the updated catalog; a provider whose fetch fails keeps
 *  its previous entry. The compat snapshot is keyed to its base URL — a
 *  changed endpoint refetches regardless of TTL, so the menu never shows one
 *  server's models against another server's config. Both platforms' refresh
 *  endpoints are this + their own persistence. */
export async function refreshCatalog(
  catalog: AiModelCatalog,
  sources: CatalogSources,
  force: boolean
): Promise<AiModelCatalog> {
  const next: AiModelCatalog = { ...catalog }
  await Promise.all(
    CATALOG_PROVIDERS.map(async (provider) => {
      try {
        if (provider === 'compat') {
          const src = sources.compat
          const baseUrl = src?.baseUrl.trim().replace(/\/+$/, '')
          if (!src || !baseUrl) return
          const moved = catalog.compat?.baseUrl !== baseUrl
          if (!force && !moved && !catalogStale(catalog, provider)) return
          const models = await fetchCompatModels(baseUrl, src.key?.trim() || undefined)
          if (models.length > 0) next.compat = { fetchedAt: Date.now(), models, baseUrl }
          return
        }
        const key = sources[provider]?.key.trim()
        if (!key) return
        if (!force && !catalogStale(catalog, provider)) return
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

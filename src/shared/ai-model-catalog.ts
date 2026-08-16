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
import { COMPAT_SERVICES, isCompatService } from './ai-provider-profile'

/** How long a fetched snapshot counts as fresh. Model launches are rare enough
 *  that a day-old list is fine for the hosted providers, and the TTL keeps the
 *  refresh call free to sprinkle anywhere in the UI without hammering them.
 *  A compat snapshot from a LOCAL endpoint is much shorter-lived: an Ollama's
 *  list changes whenever the user pulls a model, and asking localhost again
 *  costs nothing — while a hosted compat endpoint (OpenRouter's list is
 *  hundreds of models) keeps the ordinary daily cadence. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const LOCAL_TTL_MS = 5 * 60 * 1000

/** Providers the catalog can be refreshed for (Azure is manual, mock is fake).
 *  The hosted compat services live-fetch exactly like OpenAI: ids from
 *  /models with the user's key, plus context_length where the service
 *  reports it (OpenRouter does). */
export type CatalogProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'groq'
  | 'compat'
export const CATALOG_PROVIDERS: CatalogProviderId[] = [
  'anthropic',
  'openai',
  'openrouter',
  'gemini',
  'xai',
  'mistral',
  'groq',
  'compat'
]

/** Is this a provider the catalog can hold a live list for? Azure (no listing)
 *  and mock are the two that are not. */
export function isCatalogProvider(provider: string): provider is CatalogProviderId {
  return (CATALOG_PROVIDERS as string[]).includes(provider)
}

export function catalogStale(catalog: AiModelCatalog, provider: CatalogProviderId): boolean {
  const entry = catalog[provider]
  if (!entry) return true
  const ttl =
    provider === 'compat' && isLocalEndpoint((entry as { baseUrl?: string }).baseUrl ?? '')
      ? LOCAL_TTL_MS
      : CATALOG_TTL_MS
  return Date.now() - entry.fetchedAt > ttl
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
export async function fetchCompatModels(
  baseUrl: string,
  apiKey?: string,
  opts?: { probeOllama?: boolean }
): Promise<AiRemoteModel[]> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  let origin: string | null = null
  try {
    origin = new URL(base).origin
  } catch {
    /* not a parseable URL — let the /models fetch below produce the error */
  }
  // The Ollama probe only makes sense for user-typed endpoints; the known
  // hosted services (COMPAT_SERVICES) skip straight to /models.
  if (opts?.probeOllama === false) origin = null
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
  type CompatListing = {
    id?: string
    name?: string
    context_length?: number
    created?: number
    /** OpenRouter states each model's modalities here. Nothing else we talk to
     *  does today, and every read below is optional — a server that omits the
     *  block is described as "unknown", never as "cannot". */
    architecture?: { input_modalities?: string[]; output_modalities?: string[] }
    /** Quoted per token, as decimal strings ("0.000015") */
    pricing?: { completion?: string }
  }
  const body = (await res.json()) as { data?: CompatListing[] }
  return (body.data ?? [])
    .filter((m): m is CompatListing & { id: string } => !!m.id)
    .map((m) => {
      const inputs = m.architecture?.input_modalities
      const outputs = m.architecture?.output_modalities
      // Quoted per token; carried as USD per million, the unit anyone reading
      // it would expect. A free model quotes "0" — a real price, not unknown.
      const perToken = Number(m.pricing?.completion)
      return {
        id: m.id,
        // OpenRouter ships a human name and the model's real context window in
        // its listing — both are strictly better than guessing
        ...(m.name ? { displayName: m.name } : {}),
        ...(typeof m.context_length === 'number' && m.context_length > 0
          ? { contextTokens: m.context_length }
          : {}),
        ...(Array.isArray(inputs) ? { vision: inputs.includes('image') } : {}),
        ...(Array.isArray(outputs) ? { emitsNonText: outputs.some((o) => o !== 'text') } : {}),
        ...(typeof m.created === 'number' && m.created > 0 ? { createdAt: m.created } : {}),
        ...(Number.isFinite(perToken) ? { outputPrice: perToken * 1e6 } : {})
      }
    })
}

/** Vendors inside an aggregator, ordered by our best guess at how likely a
 *  reader is to want one — in practice the size of the lab's API business
 *  (Emil, 2026-08-13). It mirrors `keyProviders()` where the names overlap, so
 *  the vendor level under OpenRouter reads in the same order as the root menu,
 *  and continues by the same standard: the big three, the most-used open-weight
 *  family, then the rest of the frontier labs.
 *
 *  It is a judgement call and says so — no listing carries usage figures. Move
 *  an entry when the world moves; anything not named here sorts after these,
 *  alphabetically, which is a fine place for a long tail of one-model vendors. */
const VENDOR_RANK = [
  'openai',
  'anthropic',
  'google',
  'meta',
  'meta-llama',
  'x-ai',
  'mistralai',
  'deepseek',
  'qwen',
  'moonshotai',
  'amazon',
  'microsoft',
  'nvidia',
  'perplexity',
  'z-ai',
  'minimax',
  'bytedance-seed'
]

/** Sort comparator for vendor ids: ranked ones first in rank order, the rest
 *  alphabetically behind them. */
export function compareVendors(a: string, b: string): number {
  const ra = VENDOR_RANK.indexOf(a)
  const rb = VENDOR_RANK.indexOf(b)
  if (ra !== -1 && rb !== -1) return ra - rb
  if (ra !== -1) return -1
  if (rb !== -1) return 1
  return a.localeCompare(b)
}

/** A version number above this is not a version. Model ids carry parameter
 *  counts in the same position (`gpt-oss-120b`, `qwen3.6-35b-a3b`), and reading
 *  one as a generation would put the small open model above the flagship. */
const MAX_PLAUSIBLE_GENERATION = 30

/** The lineup an id belongs to, and where in that lineup it sits:
 *  `anthropic/claude-opus-4.8` → claude, 4.8. The family is the leading word,
 *  so Opus, Sonnet and Fable are correctly ONE lineup while Gemma is not Gemini
 *  — different families age separately, and comparing a Gemma 4 against a
 *  Gemini 3.7 by number alone would rank the small open model first.
 *
 *  Heuristic, and it says so: an id with no version we trust (`gpt-chat-latest`)
 *  comes back generation-less and sorts after the ones we could read, since
 *  "probably current" is not something to promote a model on. */
function lineageOf(id: string): { family: string; generation: number | null } {
  const name = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const family = (/^[a-z]+/i.exec(name)?.[0] ?? name).toLowerCase()
  for (const m of name.slice(family.length).matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0])
    if (n > 0 && n <= MAX_PLAUSIBLE_GENERATION) return { family, generation: n }
  }
  return { family, generation: null }
}

/** One vendor's models, strongest first.
 *
 *  Generation outranks price (Emil, 2026-08-13). Price alone had
 *  `claude-opus-4.7-fast` at $150/1M leading Anthropic, ahead of Fable 5 at
 *  $50 — last year's flagship still carrying last year's flagship price, which
 *  says more about how little it is used than about how good it is. So the
 *  order is: newest lineage first, then generation within it, and only among
 *  models of the SAME generation does price decide — which is where it is
 *  genuinely informative, because a vendor prices its own simultaneous models
 *  against each other (Sol above Terra above Luna).
 *
 *  Everything after that is tie-breaking: newest, then id, so the list never
 *  reshuffles between two renders of the same data. */
export function rankByStrength(models: AiRemoteModel[]): AiRemoteModel[] {
  const lineage = new Map(models.map((m) => [m.id, lineageOf(m.id)]))
  // A family is as current as its newest member: that is what puts Gemini
  // ahead of Gemma without either one's version number entering into it.
  const newestIn = new Map<string, number>()
  for (const m of models) {
    const { family } = lineage.get(m.id)!
    newestIn.set(family, Math.max(newestIn.get(family) ?? 0, m.createdAt ?? 0))
  }
  return [...models].sort((a, b) => {
    const la = lineage.get(a.id)!
    const lb = lineage.get(b.id)!
    if (la.family !== lb.family)
      return (newestIn.get(lb.family) ?? 0) - (newestIn.get(la.family) ?? 0) ||
        la.family.localeCompare(lb.family)
    return (
      (lb.generation ?? -1) - (la.generation ?? -1) ||
      (b.outputPrice ?? -1) - (a.outputPrice ?? -1) ||
      (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
      a.id.localeCompare(b.id)
    )
  })
}

/** The selection rule for a live list too long to be a menu
 *  (docs/MODEL-UPDATE.md § Curation rules, Emil 2026-08-13).
 *
 *  OpenRouter listed 409 models on 2026-08-13, and "the endpoint decides" made
 *  every one of them a menu row — including generators that answer in pictures
 *  (Nano Banana) or music (Lyria), the `:batch` twin of an id already listed,
 *  and generations nobody should start a new conversation on. This keeps what
 *  can actually do our job: takes images in (the composer pastes screenshots
 *  and figures), answers in text ONLY, is current, and is one of at most seven
 *  from its vendor. On that day's list it left 73 models across 22 vendors.
 *
 *  Two gates keep it from ever emptying a small or self-describing-poorly
 *  endpoint: short lists pass through untouched, and so does a list where most
 *  entries say nothing about their modalities (an LM Studio, a plain vLLM). The
 *  models it removes stay REACHABLE — the menu's filter field searches the
 *  unfiltered list, and an id already selected always stays pickable — they
 *  just stop being offered. */
export const CURATE_MIN_LIST = 25
export const CURATE_PER_VENDOR = 7
const CURATE_MAX_AGE_S = 365 * 24 * 60 * 60

export function curateRemoteModels(models: AiRemoteModel[], now = Date.now()): AiRemoteModel[] {
  if (models.length <= CURATE_MIN_LIST) return models
  const described = models.filter((m) => m.vision !== undefined || m.emitsNonText !== undefined)
  if (described.length * 2 < models.length) return models

  const vendorOf = (id: string): string => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '')
  // Ids listed WITHOUT a suffix — an id that only ever appears as `x:free` has
  // no base to be a duplicate of, and dropping it would remove the vendor
  const baseIds = new Set(models.filter((m) => !m.id.includes(':')).map((m) => m.id))
  const nowS = now / 1000

  const kept = models.filter((m) => {
    // Reads a document's figures, answers in text. Unknown counts as "no" here
    // and only here: this branch is reached on a list that describes itself, so
    // a silent entry among talkative ones is the odd one out, not the norm.
    if (m.vision !== true || m.emitsNonText === true) return false
    // `openai/gpt-5.6-luna:batch` next to `openai/gpt-5.6-luna` is the same
    // model twice. A `:suffix` whose base is NOT listed is a real choice (a
    // `:free` tier can be the only way a vendor appears) and survives. Only
    // vendor-namespaced ids are judged this way: in Ollama's naming the tag IS
    // the model (`llama3.1:8b` is not a variant of `llama3.1`, it is what you
    // pulled), and those ids carry no vendor prefix.
    if (m.id.includes('/') && m.id.includes(':') && baseIds.has(m.id.split(':')[0])) return false
    // OpenRouter's `~vendor/...` routing aliases mirror ids listed properly
    if (vendorOf(m.id).startsWith('~')) return false
    // Current generation only — same rule the curated lists follow. A model
    // with no date keeps the benefit of the doubt.
    if (m.createdAt !== undefined && nowS - m.createdAt > CURATE_MAX_AGE_S) return false
    return true
  })

  // A selection that selects nothing is not a selection. Whatever this list
  // turned out to be, the user is better served by all of it than by an empty
  // menu they cannot even re-pick their own model from.
  if (kept.length === 0) return models

  const byVendor = new Map<string, AiRemoteModel[]>()
  for (const m of kept) {
    const list = byVendor.get(vendorOf(m.id)) ?? []
    list.push(m)
    byVendor.set(vendorOf(m.id), list)
  }
  // Two different questions, deliberately answered by two different orders:
  // WHICH models survive is about generation (newest first, then the cap), and
  // that must not be decided by price — a cheap new model would lose its slot
  // to last year's flagship. HOW they are then listed is about strength, which
  // is what a reader scanning a vendor's models is actually looking for.
  return [...byVendor.entries()]
    .sort(([a], [b]) => compareVendors(a, b))
    .flatMap(([, list]) =>
      rankByStrength(
        list
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))
          .slice(0, CURATE_PER_VENDOR)
      )
    )
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
  openrouter?: { key: string }
  gemini?: { key: string }
  xai?: { key: string }
  mistral?: { key: string }
  groq?: { key: string }
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
        const models = isCompatService(provider)
          ? await fetchCompatModels(COMPAT_SERVICES[provider].baseUrl, key, { probeOllama: false })
          : provider === 'anthropic'
            ? await fetchAnthropicModels(key)
            : await fetchOpenAiModels(key)
        // An empty list is a provider hiccup, not "all models retired"
        if (models.length > 0) next[provider] = { fetchedAt: Date.now(), models }
      } catch {
        /* keep the previous snapshot */
      }
    })
  )
  return next
}

// Browser-extension AI implementation — the real, multi-provider BYO-key chat
// that replaces the offline mock the plain-web fallback ships.
//
// Why this can call providers directly from a page when a normal website can't:
// the extension's manifest host_permissions (http/https/*) let the viewer page
// make cross-origin fetches to api.anthropic.com / api.openai.com / Azure
// without CORS blocking them, and the Anthropic SDK runs with
// dangerouslyAllowBrowser. The provider logic itself is the SAME core the
// Electron main process uses (src/shared/ai-chat.ts) — this module only owns
// the browser-side seams: config + key storage in chrome.storage.local, and
// the delta/abort plumbing the renderer subscribes to via onAiDelta.
//
// Key safety: an extension has no access to an OS key store, so it cannot match
// the desktop's DPAPI/Keychain. Keys are therefore encrypted at rest with
// AES-GCM under a non-extractable WebCrypto key (extension-key-crypto.ts) before
// they go into chrome.storage.local — and the settings panel states exactly what
// that protects against and what it does not, rather than claiming parity. Full
// parity would need a native-messaging host (see docs/BROWSER-EXTENSION.md).
import type {
  AiChatRequest,
  AiChatResult,
  AiConfig,
  AiConfigView,
  AiModelCatalog,
  AiProviderId,
  PdfxApi
} from '../../shared/types'
import { runProviderChat } from '../../shared/ai-chat'
import { PROVIDER_PROFILES } from '../../shared/ai-provider-profile'
import { AI_ERRORS } from '../../shared/engine-errors'
import { CATALOG_PROVIDERS, refreshCatalog } from '../../shared/ai-model-catalog'
import { store } from './extension-store'
import { isSealed, seal, sealingAvailable, unseal } from './extension-key-crypto'
import { DEFAULT_AI_MODELS } from '../../shared/defaults'

const K_AI_CONFIG = 'pdfx-ai-config'
const K_AI_KEYS = 'pdfx-ai-keys'
const K_AI_CATALOG = 'pdfx-ai-model-catalog'

const DEFAULT_CONFIG: AiConfig = {
  provider: 'mock',
  models: { ...DEFAULT_AI_MODELS },
  azure: { endpoint: '', deployment: '', apiVersion: '' },
  thinking: 'medium'
}

type Keys = Partial<Record<AiProviderId, string>>

const PROVIDER_IDS: AiProviderId[] = ['anthropic', 'openai', 'azure', 'mock']

async function loadConfig(): Promise<AiConfig> {
  const stored = await store.get<Partial<AiConfig>>(K_AI_CONFIG, {})
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    models: { ...DEFAULT_CONFIG.models, ...stored.models },
    azure: { ...DEFAULT_CONFIG.azure, ...stored.azure }
  }
}

/** Keys held only for this session, used when this profile has no working
 *  crypto store. Never written to chrome.storage.local — a browser that cannot
 *  encrypt must not be handed plaintext instead. */
const sessionKeys: Keys = {}

/** Stored (sealed) keys → usable plaintext, session keys taking precedence. */
async function usableKeys(stored: Keys): Promise<Keys> {
  const out: Keys = {}
  for (const p of PROVIDER_IDS) {
    if (sessionKeys[p] !== undefined) {
      out[p] = sessionKeys[p]
      continue
    }
    const raw = stored[p]
    if (raw) out[p] = await unseal(raw)
  }
  return out
}

async function toView(config: AiConfig, keys: Keys, catalog: AiModelCatalog): Promise<AiConfigView> {
  const usable = await usableKeys(keys)
  const hasKey = {} as Record<AiProviderId, boolean>
  for (const p of PROVIDER_IDS) {
    hasKey[p] = PROVIDER_PROFILES[p].keyRequired ? (usable[p]?.trim() ?? '') !== '' : true
  }
  return {
    provider: config.provider,
    models: { ...config.models },
    azure: { ...config.azure },
    thinking: config.thinking,
    hasKey,
    keyStorage: (await sealingAvailable()) ? 'browser-nonextractable' : 'session-only',
    keysSupported: true,
    catalog
  }
}

const loadCatalog = (): Promise<AiModelCatalog> => store.get<AiModelCatalog>(K_AI_CATALOG, {})

/** Re-seal any key an older version stored as plaintext. Runs on the first
 *  config read, so an upgrade takes the plaintext out of chrome.storage.local
 *  without the user doing anything. */
async function migrateUnsealedKeys(keys: Keys): Promise<Keys> {
  const legacy = PROVIDER_IDS.filter((p) => keys[p] && !isSealed(keys[p]))
  if (legacy.length === 0) return keys
  const next: Keys = { ...keys }
  for (const p of legacy) {
    const plain = next[p]
    if (!plain) continue
    const sealed = await seal(plain)
    if (sealed) next[p] = sealed
    else {
      // Cannot encrypt here: keep it for the session and stop storing it.
      sessionKeys[p] = plain
      delete next[p]
    }
  }
  store.set(K_AI_KEYS, next)
  return next
}

// Delta streaming + abort plumbing. The renderer subscribes with onAiDelta and
// aborts by requestId; both must share these module-level registries with
// aiChat (which is why the extension overrides all of onAiDelta/aiChat/aiAbort
// together rather than inheriting any from the web fallback).
const deltaListeners = new Set<(requestId: number, text: string) => void>()
const activeControllers = new Map<number, AbortController>()

export function createExtensionAi(): Pick<
  PdfxApi,
  'aiGetConfig' | 'aiSetConfig' | 'aiRefreshModels' | 'aiChat' | 'aiAbort' | 'onAiDelta'
> {
  return {
    aiGetConfig: async () => {
      const [config, stored, catalog] = await Promise.all([
        loadConfig(),
        store.get<Keys>(K_AI_KEYS, {}),
        loadCatalog()
      ])
      return toView(config, await migrateUnsealedKeys(stored), catalog)
    },

    aiSetConfig: async (patch) => {
      const [current, keys, catalog] = await Promise.all([
        loadConfig(),
        store.get<Keys>(K_AI_KEYS, {}),
        loadCatalog()
      ])
      const next: AiConfig = {
        provider: patch.provider ?? current.provider,
        models: { ...current.models, ...patch.models },
        azure: { ...current.azure, ...patch.azure },
        thinking: patch.thinking ?? current.thinking
      }
      store.set(K_AI_CONFIG, next)
      if (patch.keys) {
        // Empty/blank means "no change" — mirrors the Electron app so a blank
        // field never wipes a stored key by accident.
        for (const p of Object.keys(patch.keys) as AiProviderId[]) {
          const value = patch.keys[p]
          if (value === undefined || value.trim() === '') continue
          const trimmed = value.trim()
          const sealed = await seal(trimmed)
          if (sealed) {
            keys[p] = sealed
            delete sessionKeys[p]
          } else {
            // No usable crypto store: hold it in memory rather than writing it
            sessionKeys[p] = trimmed
            delete keys[p]
          }
        }
        store.set(K_AI_KEYS, keys)
      }
      return toView(next, keys, catalog)
    },

    // Same contract as the desktop's ai:refresh-models IPC: TTL-gated fetch of
    // the providers' live model lists with the stored keys; failures keep the
    // previous snapshot. The updated view comes back so callers just re-render.
    aiRefreshModels: async (force?: boolean) => {
      const [config, stored, catalog] = await Promise.all([
        loadConfig(),
        store.get<Keys>(K_AI_KEYS, {}),
        loadCatalog()
      ])
      const usable = await usableKeys(stored)
      const next = await refreshCatalog(
        catalog,
        { anthropic: usable.anthropic, openai: usable.openai },
        force === true
      )
      if (CATALOG_PROVIDERS.some((p) => next[p] !== catalog[p])) store.set(K_AI_CATALOG, next)
      return toView(config, stored, next)
    },

    aiChat: async (request: AiChatRequest): Promise<AiChatResult> => {
      const [config, stored] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {})])
      const usable = await usableKeys(stored)
      const key = usable[config.provider]?.trim() ?? ''
      if (PROVIDER_PROFILES[config.provider].keyRequired && !key) {
        // A sealed value that will not open reads as no key at all, so say what
        // to do about it rather than only that it is missing.
        return stored[config.provider] ? AI_ERRORS.keyUndecryptable : AI_ERRORS.keyMissing
      }
      const controller = new AbortController()
      activeControllers.set(request.requestId, controller)
      const emit = (text: string): void => {
        for (const cb of deltaListeners) cb(request.requestId, text)
      }
      try {
        return await runProviderChat({
          provider: config.provider,
          key,
          models: config.models,
          azure: config.azure,
          thinking: config.thinking,
          catalog: await loadCatalog(),
          req: request,
          emit,
          signal: controller.signal
        })
      } finally {
        activeControllers.delete(request.requestId)
      }
    },

    aiAbort: (requestId: number) => {
      activeControllers.get(requestId)?.abort()
    },

    onAiDelta: (cb) => {
      deltaListeners.add(cb)
      return () => {
        deltaListeners.delete(cb)
      }
    }
  }
}

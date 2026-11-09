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
//
// The ChatGPT plan is the one provider that does go through such a host: the
// extension cannot sign in itself, so it borrows the installed desktop app's
// sign-in, and the app — started windowless by the browser — runs the request
// (shared/native-host.ts, src/main/native-host.ts). The permission that needs
// is optional and asked for only when the reader turns the plan on.
import type {
  AiChatRequest,
  AiChatResult,
  AiCitation,
  AiConfig,
  AiConfigView,
  AiDeltaKind,
  AiModelCatalog,
  AiProviderId,
  ChatgptLoginResult,
  FileError,
  PdfxApi
} from '../../shared/types'
import { runProviderChat } from '../../shared/ai-chat'
import { PROVIDER_PROFILES } from '../../shared/ai-provider-profile'
import { AI_ERRORS } from '../../shared/engine-errors'
import { CATALOG_PROVIDERS, refreshCatalog } from '../../shared/ai-model-catalog'
import { store } from './extension-store'
import { isSealed, seal, sealingAvailable, unseal } from './extension-key-crypto'
import { DEFAULT_AI_MODELS } from '../../shared/defaults'
import {
  NATIVE_HOST_NAME,
  NATIVE_HOST_PROTOCOL,
  nativePortFailure,
  type HostMessage,
  type HostRequest
} from '../../shared/native-host'

const K_AI_CONFIG = 'pdfx-ai-config'
const K_AI_KEYS = 'pdfx-ai-keys'
const K_AI_CATALOG = 'pdfx-ai-model-catalog'

const DEFAULT_CONFIG: AiConfig = {
  provider: 'mock',
  models: { ...DEFAULT_AI_MODELS },
  azure: { endpoint: '', deployment: '', apiVersion: '' },
  compat: { baseUrl: '' },
  thinking: 'medium',
  access: 'on'
}

type Keys = Partial<Record<AiProviderId, string>>

const PROVIDER_IDS: AiProviderId[] = [
  'anthropic',
  'openai',
  'azure',
  'openrouter',
  'gemini',
  'xai',
  'mistral',
  'groq',
  'compat',
  'mock'
]

async function loadConfig(): Promise<AiConfig> {
  const stored = await store.get<Partial<AiConfig>>(K_AI_CONFIG, {})
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    models: { ...DEFAULT_CONFIG.models, ...stored.models },
    azure: { ...DEFAULT_CONFIG.azure, ...stored.azure },
    compat: { ...DEFAULT_CONFIG.compat, ...stored.compat }
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

// ---------- The ChatGPT plan, borrowed from the desktop app ----------

const NATIVE = { permissions: ['nativeMessaging'] }

async function mayStartHost(): Promise<boolean> {
  try {
    return (await chrome?.permissions?.contains(NATIVE)) ?? false
  } catch {
    return false
  }
}

type NativeRuntime = NonNullable<typeof chrome>['runtime'] & {
  connectNative(application: string): ChromeNativePort
}

/** The `chrome.runtime` that carries `connectNative`. Chromium builds a
 *  context's `chrome.runtime` ONCE, from the permissions held at that moment,
 *  so the page that asks for the optional `nativeMessaging` permission never
 *  gains the method — `permissions.request` resolves true, `contains` says
 *  true, and `chrome.runtime.connectNative` stays undefined until the page is
 *  reloaded (measured in Edge, 2026-11-02; v0.82.0 read that as «denied»
 *  right after the reader had allowed it). A frame of our own origin created
 *  AFTER the grant is a new context and has it, so one hidden frame is opened
 *  on demand and kept for the page's life. Null = the permission is not held. */
let hostFrame: Promise<NativeRuntime | null> | null = null

function nativeRuntime(): Promise<NativeRuntime | null> {
  const own = chrome?.runtime
  if (own?.connectNative) return Promise.resolve(own as NativeRuntime)
  if (!own?.getURL) return Promise.resolve(null)
  return (hostFrame ??= new Promise<NativeRuntime | null>((resolve) => {
    const frame = document.createElement('iframe')
    frame.src = own.getURL('host-frame.html')
    frame.style.display = 'none'
    frame.setAttribute('aria-hidden', 'true')
    const done = (): void => {
      const runtime = (frame.contentWindow as unknown as { chrome?: typeof chrome } | null)?.chrome?.runtime
      if (runtime?.connectNative) {
        resolve(runtime as NativeRuntime)
      } else {
        // Not granted after all (or the frame failed): try again next time
        frame.remove()
        hostFrame = null
        resolve(null)
      }
    }
    frame.addEventListener('load', done, { once: true })
    frame.addEventListener('error', done, { once: true })
    document.body.appendChild(frame)
  }))
}

/** One exchange with a host the browser starts for it: post `request`, hand
 *  each message to `onMessage` until it returns the final value. The port
 *  closing first is a failure named by what the browser says; an abort
 *  closes the port, which is what stops the host's request. */
async function hostExchange<T>(
  request: HostRequest,
  onMessage: (m: HostMessage) => T | undefined,
  signal?: AbortSignal
): Promise<T | FileError> {
  const runtime = await nativeRuntime()
  if (!runtime) return AI_ERRORS.chatgptHostDenied
  return new Promise((resolve) => {
    let settled = false
    let port: ChromeNativePort | null = null
    const finish = (value: T | FileError): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try {
        port?.disconnect()
      } catch {
        /* already gone */
      }
      resolve(value)
    }
    const onAbort = (): void => finish(AI_ERRORS.aborted)
    try {
      port = runtime.connectNative(NATIVE_HOST_NAME)
    } catch (err) {
      finish(AI_ERRORS.chatgptHostFailed(err instanceof Error ? err.message : String(err)))
      return
    }
    port.onMessage.addListener((raw) => {
      const m = raw as HostMessage
      if (m?.type === 'error') {
        finish(m.error)
        return
      }
      const value = onMessage(m)
      if (value !== undefined) finish(value)
    })
    port.onDisconnect.addListener(() => {
      const message = runtime.lastError?.message
      finish(
        nativePortFailure(message) === 'host-missing'
          ? AI_ERRORS.chatgptHostMissing
          : AI_ERRORS.chatgptHostFailed(message || 'the host closed the connection')
      )
    })
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
    port.postMessage(request)
  })
}

/** The desktop app's signed-in account, asked of a fresh host — cached, since
 *  the settings and the model menu read the config often and each ask starts
 *  the app once. A failure is cached briefly too: a missing app stays missing. */
let statusCache: { at: number; value: string | FileError } | null = null

async function hostAccount(): Promise<string | FileError> {
  const ttl = statusCache && typeof statusCache.value === 'string' ? 60_000 : 10_000
  if (statusCache && Date.now() - statusCache.at < ttl) return statusCache.value
  const value = await hostExchange<string>({ type: 'status', protocol: NATIVE_HOST_PROTOCOL }, (m) =>
    m.type === 'status' ? m.account || '—' : undefined
  )
  statusCache = { at: Date.now(), value }
  return value
}

/** '' while the plan is not turned on here, or the app cannot lend it */
async function borrowedAccount(): Promise<string> {
  if (!(await mayStartHost())) return ''
  const account = await hostAccount()
  return typeof account === 'string' ? account : ''
}

/** One chat request run by the host, its deltas streamed through `emit` */
async function chatThroughHost(
  config: AiConfig,
  request: AiChatRequest,
  emit: (text: string, kind?: AiDeltaKind, citation?: AiCitation) => void,
  signal: AbortSignal
): Promise<AiChatResult> {
  const pieces: string[] = []
  const result = await hostExchange<AiChatResult>(
    { type: 'chat', protocol: NATIVE_HOST_PROTOCOL, model: config.models.chatgpt, thinking: config.thinking, request },
    (m) => {
      if (m.type === 'delta') emit(m.text, m.kind, m.citation)
      else if (m.type === 'result-part') pieces.push(m.data)
      else if (m.type === 'result') return JSON.parse(pieces.join('')) as AiChatResult
      return undefined
    },
    signal
  )
  // A sign-in the host found gone is worth asking about again next time
  if ('code' in result && result.code?.startsWith('ai-chatgpt-')) statusCache = null
  return result
}

async function toView(config: AiConfig, keys: Keys, catalog: AiModelCatalog): Promise<AiConfigView> {
  const usable = await usableKeys(keys)
  const hasKey = {} as Record<AiProviderId, boolean>
  for (const p of PROVIDER_IDS) {
    hasKey[p] = PROVIDER_PROFILES[p].keyRequired ? (usable[p]?.trim() ?? '') !== '' : true
  }
  // Same rule as the desktop: compat's key is optional, so "has key" means
  // "ready to use" — endpoint + model id configured.
  hasKey.compat = config.compat.baseUrl.trim() !== '' && config.models.compat.trim() !== ''
  // The ChatGPT plan is the desktop app's sign-in, lent through its native
  // host: «ready» once the reader allowed the browser to start it and it
  // reports an account
  const chatgptAccount = await borrowedAccount()
  hasKey.chatgpt = chatgptAccount !== ''
  return {
    provider: config.provider,
    models: { ...config.models },
    azure: { ...config.azure },
    compat: { ...config.compat },
    thinking: config.thinking,
    access: config.access,
    hasKey,
    keyStorage: (await sealingAvailable()) ? 'browser-nonextractable' : 'session-only',
    keysSupported: true,
    catalog,
    chatgpt: { supported: true, account: chatgptAccount, borrowed: true }
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
const deltaListeners = new Set<Parameters<PdfxApi['onAiDelta']>[0]>()
const activeControllers = new Map<number, AbortController>()

export function createExtensionAi(): Pick<
  PdfxApi,
  | 'aiGetConfig'
  | 'aiSetConfig'
  | 'aiRefreshModels'
  | 'aiChat'
  | 'aiAbort'
  | 'onAiDelta'
  | 'aiChatgptLogin'
  | 'aiChatgptLogout'
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
        compat: { ...current.compat, ...patch.compat },
        thinking: patch.thinking ?? current.thinking,
        access: patch.access ?? current.access
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
      const compatBase = config.compat.baseUrl.trim()
      const next = await refreshCatalog(
        catalog,
        {
          anthropic: { key: usable.anthropic ?? '' },
          openai: { key: usable.openai ?? '' },
          openrouter: { key: usable.openrouter ?? '' },
          gemini: { key: usable.gemini ?? '' },
          xai: { key: usable.xai ?? '' },
          mistral: { key: usable.mistral ?? '' },
          groq: { key: usable.groq ?? '' },
          ...(compatBase ? { compat: { baseUrl: compatBase, key: usable.compat || undefined } } : {})
        },
        force === true
      )
      if (CATALOG_PROVIDERS.some((p) => next[p] !== catalog[p])) store.set(K_AI_CATALOG, next)
      return toView(config, stored, next)
    },

    aiChat: async (request: AiChatRequest): Promise<AiChatResult> => {
      const [config, stored] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {})])
      // Dead-man switch, checked before any key is unsealed or provider named —
      // same contract as the desktop's ai:chat handler.
      if (config.access === 'off') return AI_ERRORS.disabled
      if (config.provider === 'chatgpt') {
        if (!(await mayStartHost())) return AI_ERRORS.chatgptHostDenied
        const controller = new AbortController()
        activeControllers.set(request.requestId, controller)
        try {
          return await chatThroughHost(
            config,
            request,
            (text, kind, citation) => {
              for (const cb of deltaListeners) cb(request.requestId, text, kind, citation)
            },
            controller.signal
          )
        } finally {
          activeControllers.delete(request.requestId)
        }
      }
      const usable = await usableKeys(stored)
      const key = usable[config.provider]?.trim() ?? ''
      if (PROVIDER_PROFILES[config.provider].keyRequired && !key) {
        // A sealed value that will not open reads as no key at all, so say what
        // to do about it rather than only that it is missing.
        return stored[config.provider] ? AI_ERRORS.keyUndecryptable : AI_ERRORS.keyMissing
      }
      const controller = new AbortController()
      activeControllers.set(request.requestId, controller)
      const emit = (text: string, kind?: AiDeltaKind, citation?: AiCitation): void => {
        for (const cb of deltaListeners) cb(request.requestId, text, kind, citation)
      }
      try {
        return await runProviderChat({
          provider: config.provider,
          key,
          models: config.models,
          azure: config.azure,
          compat: config.compat,
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

    // «Turn the plan on»: the browser's own prompt for the optional
    // permission — asked here, from the click, before anything is awaited
    // (a permission request needs the gesture) — then the app's account.
    aiChatgptLogin: async (): Promise<ChatgptLoginResult> => {
      let granted = false
      try {
        granted = (await chrome?.permissions?.request(NATIVE)) ?? false
      } catch {
        granted = false
      }
      if (!granted) return AI_ERRORS.chatgptHostDenied
      statusCache = null
      const account = await hostAccount()
      if (typeof account !== 'string') return account
      const [current, keys, catalog] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {}), loadCatalog()])
      const next: AiConfig = { ...current, provider: 'chatgpt' }
      store.set(K_AI_CONFIG, next)
      return { ok: true, config: await toView(next, keys, catalog) }
    },

    // «Disconnect»: the extension gives the permission back — the desktop
    // app's sign-in is the app's, and stays
    aiChatgptLogout: async () => {
      try {
        await chrome?.permissions?.remove(NATIVE)
      } catch {
        /* nothing held */
      }
      // The frame's runtime would keep connectNative after the permission is
      // gone (the same staleness the other way) — drop it, so the next ask
      // reads the permission afresh
      hostFrame = null
      document.querySelectorAll('iframe[src$="host-frame.html"]').forEach((f) => f.remove())
      statusCache = null
      const [config, keys, catalog] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {}), loadCatalog()])
      return toView(config, keys, catalog)
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

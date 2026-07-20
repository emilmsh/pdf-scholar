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
// Key safety note (surfaced in the UI via encryptionAvailable:false): unlike
// the Electron app, which encrypts keys at rest with the OS keychain, keys here
// sit in chrome.storage.local. That store is isolated per-extension but not
// encrypted; the full-parity path is a native-messaging host (see
// docs/BROWSER-EXTENSION.md). This is the pragmatic first step.
import type {
  AiChatRequest,
  AiChatResult,
  AiConfig,
  AiConfigView,
  AiProviderId,
  PdfxApi
} from '../../shared/types'
import { runProviderChat } from '../../shared/ai-chat'
import { store } from './extension-store'

const K_AI_CONFIG = 'pdfx-ai-config'
const K_AI_KEYS = 'pdfx-ai-keys'

const DEFAULT_CONFIG: AiConfig = {
  provider: 'mock',
  models: { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', azure: '', mock: 'mock-1' },
  azure: { endpoint: '', deployment: '' },
  thinking: 'medium'
}

type Keys = Partial<Record<AiProviderId, string>>

async function loadConfig(): Promise<AiConfig> {
  const stored = await store.get<Partial<AiConfig>>(K_AI_CONFIG, {})
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    models: { ...DEFAULT_CONFIG.models, ...stored.models },
    azure: { ...DEFAULT_CONFIG.azure, ...stored.azure }
  }
}

function toView(config: AiConfig, keys: Keys): AiConfigView {
  const hasKey = {} as Record<AiProviderId, boolean>
  for (const p of ['anthropic', 'openai', 'azure', 'mock'] as AiProviderId[]) {
    hasKey[p] = p === 'mock' ? true : (keys[p]?.trim() ?? '') !== ''
  }
  return {
    provider: config.provider,
    models: { ...config.models },
    azure: { ...config.azure },
    thinking: config.thinking,
    hasKey,
    // chrome.storage.local is not an encrypted store; the UI shows a warning.
    encryptionAvailable: false,
    keysSupported: true
  }
}

// Delta streaming + abort plumbing. The renderer subscribes with onAiDelta and
// aborts by requestId; both must share these module-level registries with
// aiChat (which is why the extension overrides all of onAiDelta/aiChat/aiAbort
// together rather than inheriting any from the web fallback).
const deltaListeners = new Set<(requestId: number, text: string) => void>()
const activeControllers = new Map<number, AbortController>()

export function createExtensionAi(): Pick<
  PdfxApi,
  'aiGetConfig' | 'aiSetConfig' | 'aiChat' | 'aiAbort' | 'onAiDelta'
> {
  return {
    aiGetConfig: async () => {
      const [config, keys] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {})])
      return toView(config, keys)
    },

    aiSetConfig: async (patch) => {
      const [current, keys] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {})])
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
          if (value !== undefined && value.trim() !== '') keys[p] = value.trim()
        }
        store.set(K_AI_KEYS, keys)
      }
      return toView(next, keys)
    },

    aiChat: async (request: AiChatRequest): Promise<AiChatResult> => {
      const [config, keys] = await Promise.all([loadConfig(), store.get<Keys>(K_AI_KEYS, {})])
      const key = keys[config.provider]?.trim() ?? ''
      if (config.provider !== 'mock' && !key) {
        return { error: 'Ingen API-nøkkel er lagret for valgt leverandør. Åpne KI-innstillingene.' }
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

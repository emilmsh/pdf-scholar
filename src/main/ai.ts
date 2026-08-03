// AI chat IPC for the Electron app (BYO API key). The renderer never sees keys:
// they are encrypted at rest with safeStorage and only decrypted here at call
// time. The provider logic itself (Anthropic native citations, OpenAI/Azure
// prompt quote-contract, mock) lives in the platform-neutral core
// src/shared/ai-chat.ts, shared verbatim with the browser-extension target so
// citation + thinking rules can never drift. This module owns only what is
// genuinely Electron-specific: key encryption, persistence, and the IPC surface.
import { app, ipcMain, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  AiChatRequest,
  AiChatResult,
  AiConfig,
  AiConfigView,
  AiProviderId,
  KeyStorageMode
} from '../shared/types'
import { runProviderChat } from '../shared/ai-chat'
import { PROVIDER_PROFILES } from '../shared/ai-provider-profile'
import { AI_ERRORS } from '../shared/engine-errors'
import { CATALOG_PROVIDERS, refreshCatalog } from '../shared/ai-model-catalog'
import { getState, mergeAiConfig, saveState } from './storage'

const PROVIDERS: AiProviderId[] = ['anthropic', 'openai', 'azure', 'mock']

// ---------- Recorded answers, for the screenshot run ----------
//
// The README's two assistant shots are of the same feature on the same paper,
// so the answer behind them only has to be produced ONCE. `PDFX_AI_RECORD=<dir>`
// saves each real answer; `PDFX_AI_FIXTURE=<dir>` replays it. Everything the
// screenshot is actually evidence for still runs live — the chips, the jump to
// the cited sentence, the highlight, the snipped image in the chat — because
// only the provider call is served from disk. So the shots keep working when
// that UI changes, and re-record only when the answer itself should change.
//
// Never available in a shipped app: both are opt-in environment variables AND
// gated on an unpackaged build.
const devOnlyDir = (name: string): string | null => {
  const dir = process.env[name]
  return dir && !app.isPackaged ? dir : null
}

/** One fixture per kind of request the shoot makes. Keyed by shape, not by the
 *  prompt text, so re-wording a question does not orphan the recording. */
const fixtureFile = (dir: string, req: AiChatRequest): string =>
  join(dir, req.messages.some((m) => (m.images?.length ?? 0) > 0) ? 'figure.json' : 'answer.json')

function readFixture(req: AiChatRequest): AiChatResult | null {
  const dir = devOnlyDir('PDFX_AI_FIXTURE')
  if (!dir) return null
  const file = fixtureFile(dir, req)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AiChatResult
  } catch {
    return null
  }
}

function writeFixture(req: AiChatRequest, result: AiChatResult): void {
  const dir = devOnlyDir('PDFX_AI_RECORD')
  if (!dir || !('ok' in result) || !result.ok) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(fixtureFile(dir, req), JSON.stringify(result, null, 2), 'utf8')
  } catch {
    /* recording is best-effort; the shot itself already has its answer */
  }
}

/** Replay an answer the way the UI met it the first time: streamed. The panel
 *  renders deltas as they arrive and only settles when they stop, so handing it
 *  the whole text at once would photograph a state no reader ever sees. */
async function replay(result: AiChatResult, emit: (t: string) => void): Promise<AiChatResult> {
  const full = 'parts' in result ? result.parts.map((p) => p.text).join('') : ''
  const step = Math.max(1, Math.ceil(full.length / 8))
  for (let i = 0; i < full.length; i += step) {
    emit(full.slice(i, i + step))
    await new Promise((r) => setTimeout(r, 60))
  }
  return result
}

// ---------- Key storage ----------
//
// Windows and macOS always have a key store, so the normal path is DPAPI /
// Keychain via safeStorage. Linux needs a keyring daemon (gnome-keyring or
// kwallet) and may not have one; `safeStorage.isEncryptionAvailable()` reports
// false there.
//
// In that case we keep the key in memory for the session instead of writing it
// to userData/pdfx-state.json. The app used to store `plain:<base64>` — which is
// not encryption, only an encoding — so a readable file held a live billable
// credential for as long as the user kept it. Forgetting the key on quit is
// worse UX and better security, and it is the most protection the platform
// actually offers: with no OS key store there is nowhere safe to keep a
// key-encryption key either, so anything we derived locally would be
// obfuscation dressed up as encryption.

/** Provider → plaintext key, for the session-only path. Never persisted. */
const sessionKeys = new Map<AiProviderId, string>()

const canUseKeystore = (): boolean => safeStorage.isEncryptionAvailable()

function keyStorageMode(): KeyStorageMode {
  // A surviving `plain:` blob outranks everything else we could say. Migration
  // clears these at startup, but it has to write the state file to do so — if
  // that write failed (read-only profile, full disk), the plaintext is still
  // there and still being read. Reporting the mode we WISH we had would be the
  // one lie this type exists to prevent.
  const keys = getState().ai.keys
  if (PROVIDERS.some((p) => (keys[p] ?? '').startsWith('plain:'))) return 'plaintext'
  if (canUseKeystore()) return 'os-keystore'
  return 'session-only'
}

/** Encrypt for persistence, or null when this platform must not persist. */
function encryptKey(plain: string): string | null {
  if (!plain) return ''
  if (!canUseKeystore()) return null
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptKey(stored: string): string {
  if (!stored) return ''
  // Legacy: written by versions that fell back to plaintext when no keyring was
  // present. Still read so an upgrade does not silently lose the key, but
  // migrateLegacyPlaintextKeys() clears it from disk on the next launch.
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf-8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

/** The usable key for a provider: the session one when we are not persisting,
 *  otherwise whatever is on disk. */
function keyFor(provider: AiProviderId): string {
  const session = sessionKeys.get(provider)
  if (session !== undefined) return session
  return decryptKey(getState().ai.keys[provider] ?? '')
}

/** Take any `plain:` key off disk at startup. Where a key store exists we
 *  re-encrypt it properly; where none does we move it into memory for this
 *  session. Either way the plaintext stops sitting in a readable file — a
 *  security fix that applies to keys stored by older versions. */
function migrateLegacyPlaintextKeys(): void {
  const ai = getState().ai
  const rewritten: Partial<Record<AiProviderId, string>> = {}
  let changed = false
  for (const p of PROVIDERS) {
    const stored = ai.keys[p] ?? ''
    if (!stored.startsWith('plain:')) continue
    const plain = Buffer.from(stored.slice(6), 'base64').toString('utf-8')
    if (canUseKeystore()) {
      rewritten[p] = safeStorage.encryptString(plain).toString('base64')
    } else {
      sessionKeys.set(p, plain)
      rewritten[p] = ''
    }
    changed = true
  }
  if (!changed) return
  const state = getState()
  state.ai = mergeAiConfig(state.ai, { keys: rewritten })
  saveState()
  console.log(
    `[pdfx] migrated ${Object.keys(rewritten).length} plaintext API key(s) off disk (${keyStorageMode()})`
  )
}

function configView(): AiConfigView {
  const ai = getState().ai
  const hasKey = {} as Record<AiProviderId, boolean>
  // "Has a key" means the key is actually usable — a blob that fails DPAPI
  // decryption must show as not-set so the user re-enters it, instead of the
  // settings claiming a key exists while every request fails.
  for (const p of PROVIDERS) hasKey[p] = PROVIDER_PROFILES[p].keyRequired ? keyFor(p) !== '' : true
  return {
    provider: ai.provider,
    models: { ...ai.models },
    azure: { ...ai.azure },
    thinking: ai.thinking,
    hasKey,
    keyStorage: keyStorageMode(),
    keysSupported: true,
    catalog: getState().modelCatalog
  }
}

// ---------- IPC ----------

const activeRequests = new Map<number, AbortController>()

export function registerAiIpc(): void {
  // Before anything can read a key: get any legacy plaintext off disk.
  migrateLegacyPlaintextKeys()

  ipcMain.handle('ai:get-config', () => configView())

  ipcMain.handle(
    'ai:set-config',
    (_e, patch: Partial<AiConfig> & { keys?: Partial<Record<AiProviderId, string>> }) => {
      const state = getState()
      const encryptedKeys: Partial<Record<AiProviderId, string>> = {}
      if (patch.keys) {
        for (const p of PROVIDERS) {
          const value = patch.keys[p]
          // Empty/blank means "no change" — there is no remove-key UI, and
          // treating '' as a wipe is how stored keys get lost by accident
          if (value === undefined || value.trim() === '') continue
          const trimmed = value.trim()
          const sealed = encryptKey(trimmed)
          if (sealed === null) {
            // No key store on this platform: hold it for the session and make
            // sure nothing lands on disk for this provider.
            sessionKeys.set(p, trimmed)
            encryptedKeys[p] = ''
          } else {
            encryptedKeys[p] = sealed
          }
        }
      }
      state.ai = mergeAiConfig(state.ai, {
        provider: patch.provider,
        models: patch.models,
        azure: patch.azure,
        thinking: patch.thinking,
        keys: encryptedKeys
      })
      saveState()
      return configView()
    }
  )

  // Refresh the live model catalog from every provider with a usable key.
  // TTL-gated inside refreshCatalog unless forced, so the UI can call this on
  // every settings/menu open without hammering the providers; failures keep
  // the previous snapshot and are invisible here by design.
  ipcMain.handle('ai:refresh-models', async (_e, force: boolean) => {
    const state = getState()
    const next = await refreshCatalog(
      state.modelCatalog,
      { anthropic: keyFor('anthropic'), openai: keyFor('openai') },
      force === true
    )
    if (CATALOG_PROVIDERS.some((p) => next[p] !== state.modelCatalog[p])) {
      state.modelCatalog = next
      saveState()
    }
    return configView()
  })

  ipcMain.handle('ai:chat', async (e: IpcMainInvokeEvent, req: AiChatRequest): Promise<AiChatResult> => {
    const sender = e.sender
    const controller = new AbortController()
    activeRequests.set(req.requestId, controller)
    const emit = (text: string): void => {
      if (!sender.isDestroyed()) sender.send('ai:delta', req.requestId, text)
    }
    try {
      const recorded = readFixture(req)
      if (recorded) return await replay(recorded, emit)
      const ai = getState().ai
      const key = keyFor(ai.provider)
      if (PROVIDER_PROFILES[ai.provider].keyRequired && !key) {
        // Three different reasons, three different remedies: a stored blob that
        // will not decrypt (DPAPI ties encryption to the OS user, so credential
        // changes or a copied profile invalidate it), a session-only key that
        // this launch has not been given yet, or simply never entered.
        if (ai.keys[ai.provider] !== '') return AI_ERRORS.keyUndecryptable
        return keyStorageMode() === 'session-only' ? AI_ERRORS.keySessionOnly : AI_ERRORS.keyMissing
      }
      const result = await runProviderChat({
        provider: ai.provider,
        key,
        models: ai.models,
        azure: ai.azure,
        thinking: ai.thinking,
        catalog: getState().modelCatalog,
        req,
        emit,
        signal: controller.signal
      })
      writeFixture(req, result)
      return result
    } finally {
      activeRequests.delete(req.requestId)
    }
  })

  ipcMain.on('ai:abort', (_e, requestId: number) => {
    activeRequests.get(requestId)?.abort()
  })
}

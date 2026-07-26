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
  AiProviderId
} from '../shared/types'
import { runProviderChat } from '../shared/ai-chat'
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

// ---------- Key encryption ----------

function encryptKey(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  return `plain:${Buffer.from(plain, 'utf-8').toString('base64')}`
}

function decryptKey(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf-8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

function configView(): AiConfigView {
  const ai = getState().ai
  const hasKey = {} as Record<AiProviderId, boolean>
  // "Has a key" means the stored blob actually decrypts — a blob that fails
  // DPAPI decryption must show as not-set so the user re-enters it, instead
  // of the settings claiming a key exists while every request fails.
  for (const p of PROVIDERS) hasKey[p] = p === 'mock' ? true : decryptKey(ai.keys[p]) !== ''
  return {
    provider: ai.provider,
    models: { ...ai.models },
    azure: { ...ai.azure },
    thinking: ai.thinking,
    hasKey,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    keysSupported: true
  }
}

// ---------- IPC ----------

const activeRequests = new Map<number, AbortController>()

export function registerAiIpc(): void {
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
          if (value !== undefined && value.trim() !== '') encryptedKeys[p] = encryptKey(value.trim())
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
      const key = decryptKey(ai.keys[ai.provider])
      if (ai.provider !== 'mock' && !key) {
        // Distinguish "never entered" from "stored but undecryptable"
        // (DPAPI ties encryption to the Windows user — credential changes
        // or a copied profile can invalidate the blob)
        return ai.keys[ai.provider] !== ''
          ? { error: 'API-nøkkelen kunne ikke dekrypteres (Windows-kontoen kan ha endret seg). Legg den inn på nytt i KI-innstillingene.' }
          : { error: 'Ingen API-nøkkel er lagret for valgt leverandør. Åpne KI-innstillingene.' }
      }
      const result = await runProviderChat({
        provider: ai.provider,
        key,
        models: ai.models,
        azure: ai.azure,
        thinking: ai.thinking,
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

// AI chat providers (BYO API key). The renderer never sees keys: they are
// encrypted at rest with safeStorage and only decrypted here at call time.
// Providers:
//  - anthropic: official SDK, native Citations (char offsets into our text)
//  - openai / azure: raw REST (SSE), grounding via a prompt quote-contract
//    that the renderer resolves back to page positions
//  - mock: deterministic offline provider for dev/preview testing
import { ipcMain, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  AiChatRequest,
  AiChatResult,
  AiConfig,
  AiConfigView,
  AiContentPart,
  AiProviderId,
  AiUsage
} from '../shared/types'
import { getState, mergeAiConfig, saveState } from './storage'

const PROVIDERS: AiProviderId[] = ['anthropic', 'openai', 'azure', 'mock']

// Prompt contract for providers without native citations (mirrors the
// oe-intervju QUOTE_GROUNDING_RULES pattern): verbatim quotes we can locate.
// Instructions address the model and stay English for both UI languages; the
// [KILDE ...] marker syntax is fixed (parsed by regex in parseQuoteContract).
const QUOTE_CONTRACT = `

CITATION RULES (important):
- When you draw on the document, cite the source inline in the form [KILDE s.N: "verbatim excerpt"].
- The excerpt MUST be an exact, verbatim substring of the document text (10–200 characters), and N is the page number where it appears (pages are marked "[Side N]" or "[Page N]" in the document).
- Never invent quotes. If you cannot support a claim with a verbatim excerpt, say so explicitly.`

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
  for (const p of PROVIDERS) hasKey[p] = p === 'mock' ? true : ai.keys[p] !== ''
  return {
    provider: ai.provider,
    models: { ...ai.models },
    azure: { ...ai.azure },
    hasKey,
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

// ---------- Providers ----------

const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

type Emit = (text: string) => void

async function chatAnthropic(
  apiKey: string,
  model: string,
  req: AiChatRequest,
  emit: Emit,
  signal: AbortSignal
): Promise<AiChatResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })

  type ContentBlock =
    | { type: 'text'; text: string }
    | {
        type: 'document'
        source: { type: 'text'; media_type: 'text/plain'; data: string }
        title: string
        citations: { enabled: boolean }
        cache_control: { type: 'ephemeral' }
      }

  const messages = req.messages.map((m, index) => {
    if (index === 0 && m.role === 'user' && req.document) {
      const content: ContentBlock[] = [
        {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: req.document.text },
          title: req.document.title,
          citations: { enabled: true },
          cache_control: { type: 'ephemeral' }
        },
        { type: 'text', text: m.text }
      ]
      return { role: 'user' as const, content }
    }
    return { role: m.role, content: m.text }
  })

  const stream = client.messages.stream(
    { model, max_tokens: 4096, system: req.system, messages },
    { signal }
  )
  stream.on('text', (delta) => emit(delta))
  const final = await stream.finalMessage()

  const parts: AiContentPart[] = []
  for (const block of final.content) {
    if (block.type !== 'text') continue
    parts.push({
      text: block.text,
      citations: (block.citations ?? [])
        .filter((c) => c.type === 'char_location')
        .map((c) => ({
          kind: 'char' as const,
          start: c.start_char_index,
          end: c.end_char_index,
          citedText: c.cited_text
        }))
    })
  }
  return {
    ok: true,
    parts,
    usage: {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0
    },
    model: final.model
  }
}

/** Split text on [KILDE s.N: "quote"] markers into parts with quote citations */
function parseQuoteContract(text: string): AiContentPart[] {
  const regex = /\s*\[KILDE s\.?\s*(\d+):\s*[«"]([^"»]{5,300})[»"]\]/g
  const parts: AiContentPart[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    parts.push({
      text: text.slice(last, match.index),
      citations: [{ kind: 'quote', pageNumber: parseInt(match[1], 10), quote: match[2] }]
    })
    last = regex.lastIndex
  }
  const tail = text.slice(last)
  if (tail.trim() || parts.length === 0) parts.push({ text: tail, citations: [] })
  return parts
}

async function chatOpenAiCompatible(
  url: string,
  headers: Record<string, string>,
  model: string | null,
  req: AiChatRequest,
  emit: Emit,
  signal: AbortSignal,
  includeUsageOption: boolean
): Promise<AiChatResult> {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: req.system + (req.document ? QUOTE_CONTRACT : '') }
  ]
  if (req.document) {
    messages.push({
      role: 'user',
      content: `DOKUMENT («${req.document.title}») — svar basert på dette:\n\n${req.document.text}`
    })
    messages.push({ role: 'assistant', content: 'Jeg har lest dokumentet og er klar.' })
  }
  for (const m of req.messages) messages.push({ role: m.role, content: m.text })

  const body: Record<string, unknown> = { messages, stream: true }
  if (model) body.model = model
  if (includeUsageOption) body.stream_options = { include_usage: true }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    return { error: `HTTP ${response.status}: ${detail.slice(0, 300)}` }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  const usage: AiUsage = { ...EMPTY_USAGE }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload)
        const delta: string | undefined = parsed.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          emit(delta)
        }
        if (parsed.usage) {
          usage.inputTokens = parsed.usage.prompt_tokens ?? 0
          usage.outputTokens = parsed.usage.completion_tokens ?? 0
          usage.cacheReadTokens = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
        }
      } catch {
        /* ignore malformed keep-alives */
      }
    }
  }
  return { ok: true, parts: parseQuoteContract(fullText), usage, model: model ?? 'azure' }
}

async function chatMock(req: AiChatRequest, emit: Emit, signal: AbortSignal): Promise<AiChatResult> {
  const doc = req.document
  const answerA =
    'Dette er et testsvar fra mock-leverandøren. Dokumentets innledning slår an tonen for resten av teksten'
  const answerB =
    ' og lenger ut i dokumentet utdypes dette med et konkret resonnement du kan hoppe rett til.'
  const full = answerA + answerB
  for (const word of full.split(/(?<= )/)) {
    if (signal.aborted) return { error: 'Avbrutt' }
    emit(word)
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const parts: AiContentPart[] = doc
    ? [
        {
          text: answerA,
          citations: [
            { kind: 'char', start: 0, end: Math.min(90, doc.text.length), citedText: doc.text.slice(0, 90) }
          ]
        },
        {
          text: answerB,
          citations: [
            {
              kind: 'char',
              start: Math.floor(doc.text.length * 0.4),
              end: Math.min(Math.floor(doc.text.length * 0.4) + 120, doc.text.length),
              citedText: doc.text.slice(Math.floor(doc.text.length * 0.4), Math.floor(doc.text.length * 0.4) + 120)
            }
          ]
        }
      ]
    : [{ text: full, citations: [] }]
  return {
    ok: true,
    parts,
    usage: {
      inputTokens: doc ? Math.ceil(doc.text.length / 4) : 50,
      outputTokens: Math.ceil(full.length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    },
    model: 'mock-1'
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
          if (value !== undefined) encryptedKeys[p] = encryptKey(value)
        }
      }
      state.ai = mergeAiConfig(state.ai, {
        provider: patch.provider,
        models: patch.models,
        azure: patch.azure,
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
    const emit: Emit = (text) => {
      if (!sender.isDestroyed()) sender.send('ai:delta', req.requestId, text)
    }
    try {
      const ai = getState().ai
      const key = decryptKey(ai.keys[ai.provider])
      if (ai.provider !== 'mock' && !key) {
        return { error: 'Ingen API-nøkkel er lagret for valgt leverandør. Åpne KI-innstillingene.' }
      }
      switch (ai.provider) {
        case 'anthropic':
          return await chatAnthropic(key, ai.models.anthropic, req, emit, controller.signal)
        case 'openai':
          return await chatOpenAiCompatible(
            'https://api.openai.com/v1/chat/completions',
            { authorization: `Bearer ${key}` },
            ai.models.openai,
            req,
            emit,
            controller.signal,
            true
          )
        case 'azure': {
          const endpoint = ai.azure.endpoint.replace(/\/+$/, '')
          if (!endpoint || !ai.azure.deployment) {
            return { error: 'Azure-endepunkt og deployment må fylles ut i KI-innstillingene.' }
          }
          return await chatOpenAiCompatible(
            `${endpoint}/openai/deployments/${ai.azure.deployment}/chat/completions?api-version=2024-12-01-preview`,
            { 'api-key': key },
            null,
            req,
            emit,
            controller.signal,
            false
          )
        }
        case 'mock':
          return await chatMock(req, emit, controller.signal)
      }
    } catch (err) {
      if (controller.signal.aborted) return { error: 'Avbrutt' }
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      activeRequests.delete(req.requestId)
    }
  })

  ipcMain.on('ai:abort', (_e, requestId: number) => {
    activeRequests.get(requestId)?.abort()
  })
}

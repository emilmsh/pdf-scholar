// Platform-neutral AI chat provider core (BYO API key, multi-provider).
//
// This module holds ALL the provider logic — request shaping, streaming,
// citation extraction, reasoning-effort tuning — with no dependency on Electron
// or the browser-extension runtime. Both platforms drive it through
// `runProviderChat`:
//   - Electron main (src/main/ai.ts) decrypts the key with safeStorage, then
//     calls this; keys never reach the renderer.
//   - The browser extension (src/renderer/src/extension-ai.ts) reads the key
//     from chrome.storage and calls this directly from the viewer page — the
//     extension's host_permissions let cross-origin fetches to the provider
//     bypass CORS, and the Anthropic SDK runs with dangerouslyAllowBrowser.
//
// Keeping it here means the grounded-citation contract and the (fiddly,
// model-specific) thinking rules have exactly ONE implementation, so the native
// app and the extension can never drift apart.
import type {
  AiChatRequest,
  AiChatResult,
  AiContentPart,
  AiProviderId,
  AiUsage,
  ThinkingLevel
} from './types'

// ---------- Reasoning-effort mapping (verified 2026-07, see docs/agent-notes/modeller-api.md) ----------

type Effort = 'low' | 'medium' | 'high'
const EFFORT: Record<Exclude<ThinkingLevel, 'off'>, Effort> = {
  low: 'low',
  medium: 'medium',
  high: 'high'
}

/** Anthropic thinking params for a model + level. Rules that bite:
 *  budget_tokens is rejected (400) on Fable/Opus 4.8/Sonnet 5 — use adaptive
 *  thinking + output_config.effort; Haiku rejects effort entirely; Sonnet 5
 *  thinks by default so "off" must be explicit. */
function anthropicThinking(
  model: string,
  level: ThinkingLevel
): {
  thinking?: { type: 'adaptive' } | { type: 'disabled' }
  outputConfig?: { effort: Effort }
  maxTokens: number
} {
  const isHaiku = /haiku/i.test(model)
  const isFable = /fable|mythos/i.test(model)
  // Haiku: no effort support; keep it simple (no thinking)
  if (isHaiku) return { maxTokens: 4096 }
  if (level === 'off') {
    // Fable always thinks; Sonnet 5 thinks by default → disable explicitly
    if (isFable) return { outputConfig: { effort: 'low' }, maxTokens: 12000 }
    if (/sonnet-5/i.test(model)) return { thinking: { type: 'disabled' }, maxTokens: 4096 }
    return { maxTokens: 4096 } // Opus: omitting thinking = off
  }
  const effort = EFFORT[level]
  // Fable: thinking always on, don't send the thinking field
  if (isFable) return { outputConfig: { effort }, maxTokens: 16000 }
  return { thinking: { type: 'adaptive' }, outputConfig: { effort }, maxTokens: 12000 }
}

/** OpenAI reasoning_effort value (none maps 'off') */
function openAiEffort(level: ThinkingLevel): string {
  return level === 'off' ? 'none' : level
}

// Prompt contract for providers without native citations (mirrors the
// oe-intervju QUOTE_GROUNDING_RULES pattern): verbatim quotes we can locate.
// Instructions address the model and stay English for both UI languages; the
// [KILDE ...] marker syntax is fixed (parsed by regex in parseQuoteContract).
const QUOTE_CONTRACT = `

CITATION RULES (important):
- When you draw on the document, cite the source inline in the form [KILDE s.N: "verbatim excerpt"].
- The excerpt MUST be an exact, verbatim substring of the document text (10–200 characters), and N is the page number where it appears (pages are marked "[Side N]" or "[Page N]" in the document).
- Never invent quotes. If you cannot support a claim with a verbatim excerpt, say so explicitly.`

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
  thinking: ThinkingLevel,
  req: AiChatRequest,
  emit: Emit,
  signal: AbortSignal
): Promise<AiChatResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  // dangerouslyAllowBrowser: harmless in Node (Electron main), and required for
  // the SDK to run in the extension viewer page. It also makes the SDK send the
  // anthropic-dangerous-direct-browser-access header; the extension's
  // host_permissions are what actually let the cross-origin call through.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

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

  const tuning = anthropicThinking(model, thinking)
  const isFable = /fable|mythos/i.test(model)
  const params: Record<string, unknown> = {
    model,
    max_tokens: tuning.maxTokens,
    system: req.system,
    messages
  }
  if (tuning.thinking) params.thinking = tuning.thinking
  if (tuning.outputConfig) params.output_config = tuning.outputConfig
  // Fable: safety-classifier refusals are opt-in recoverable via server-side
  // fallback to Opus 4.8 (see docs/agent-notes/modeller-api.md)
  if (isFable) {
    params.betas = ['server-side-fallback-2026-06-01']
    params.fallbacks = [{ model: 'claude-opus-4-8' }]
  }
  const api = isFable ? client.beta.messages : client.messages
  type AnthropicStream = ReturnType<typeof client.messages.stream>
  // Bind to `api`: the SDK's stream() reads this._client internally, so calling it
  // detached from client.messages throws "Cannot read properties of undefined
  // (reading '_client')". The cast is only to bridge the beta/non-beta type gap.
  const streamFn = api.stream.bind(api) as unknown as (p: unknown, o: unknown) => AnthropicStream
  const stream = streamFn(params, { signal })
  stream.on('text', (delta: string) => emit(delta))
  const final = await stream.finalMessage()

  interface CharLoc {
    type: string
    start_char_index: number
    end_char_index: number
    cited_text: string
  }
  const parts: AiContentPart[] = []
  for (const block of final.content) {
    if (block.type !== 'text') continue
    const citations = (block.citations ?? []) as CharLoc[]
    parts.push({
      text: block.text,
      citations: citations
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
  // Tolerant: curly quotes, «Kilde» casing, flexible spacing around the colon, and
  // inner quotes inside the excerpt — the content is matched lazily and only closes
  // on a quote immediately followed by "]", so a model that puts (often escaped)
  // quotes inside the excerpt no longer breaks the match. Escapes are stripped below
  // so the quote stays a verbatim document substring for locate + highlight.
  const regex = /\s*\[KILDE\s+s\.?\s*(\d+)\s*:\s*[«"“]([\s\S]{5,300}?)["»”]\]/gi
  const parts: AiContentPart[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    parts.push({
      text: text.slice(last, match.index),
      citations: [
        {
          kind: 'quote',
          pageNumber: parseInt(match[1], 10),
          // Unescape \" and \\ so the quote is a verbatim document substring
          quote: match[2].replace(/\\(["\\])/g, '$1').trim()
        }
      ]
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
  thinking: ThinkingLevel,
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
  // gpt-5.6 reasoning control (harmless on models that ignore it)
  if (/gpt-5|o[0-9]/i.test(model ?? '')) body.reasoning_effort = openAiEffort(thinking)
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

// ---------- Dispatcher ----------

export interface ProviderChatParams {
  provider: AiProviderId
  /** Decrypted/plaintext key for the chosen provider (empty for mock) */
  key: string
  models: Record<AiProviderId, string>
  azure: { endpoint: string; deployment: string }
  thinking: ThinkingLevel
  req: AiChatRequest
  emit: Emit
  signal: AbortSignal
}

/** Route a chat request to the configured provider. The caller is responsible
 *  for having a key when the provider is not mock (each platform reports the
 *  missing-key case in its own words); this only validates provider-specific
 *  extras (Azure endpoint/deployment). Aborts surface as { error: 'Avbrutt' }. */
export async function runProviderChat(params: ProviderChatParams): Promise<AiChatResult> {
  const { provider, key, models, azure, thinking, req, emit, signal } = params
  try {
    switch (provider) {
      case 'anthropic':
        return await chatAnthropic(key, models.anthropic, thinking, req, emit, signal)
      case 'openai':
        return await chatOpenAiCompatible(
          'https://api.openai.com/v1/chat/completions',
          { authorization: `Bearer ${key}` },
          models.openai,
          thinking,
          req,
          emit,
          signal,
          true
        )
      case 'azure': {
        const endpoint = azure.endpoint.replace(/\/+$/, '')
        if (!endpoint || !azure.deployment) {
          return { error: 'Azure-endepunkt og deployment må fylles ut i KI-innstillingene.' }
        }
        return await chatOpenAiCompatible(
          `${endpoint}/openai/deployments/${azure.deployment}/chat/completions?api-version=2024-12-01-preview`,
          { 'api-key': key },
          null,
          thinking,
          req,
          emit,
          signal,
          false
        )
      }
      case 'mock':
        return await chatMock(req, emit, signal)
    }
  } catch (err) {
    if (signal.aborted) return { error: 'Avbrutt' }
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

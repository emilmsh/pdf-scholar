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
  AiCitation,
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

// ---------- Web search (server-side provider tool) ----------

/** Cap on searches per answer so token cost stays bounded */
const WEB_SEARCH_MAX_USES = 5

/** Anthropic web-search tool for a model. The dynamic-filtering variant
 *  (_20260209) needs Opus 4.6+/Sonnet 4.6+/Sonnet 5/Fable; Haiku and older
 *  models only accept the basic variant. */
function anthropicWebSearchTool(model: string): Record<string, unknown> {
  const modern = /fable|mythos|opus-4-[6-9]|sonnet-4-[6-9]|sonnet-[5-9]/i.test(model)
  return {
    type: modern ? 'web_search_20260209' : 'web_search_20250305',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES
  }
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
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | {
        type: 'document'
        source: { type: 'text'; media_type: 'text/plain'; data: string }
        title: string
        citations: { enabled: boolean }
        cache_control: { type: 'ephemeral' }
      }

  const messages = req.messages.map((m, index) => {
    const images: ContentBlock[] = (m.images ?? []).map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mediaType, data: img.dataBase64 }
    }))
    if (index === 0 && m.role === 'user' && req.document) {
      const content: ContentBlock[] = [
        {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: req.document.text },
          title: req.document.title,
          citations: { enabled: true },
          cache_control: { type: 'ephemeral' }
        },
        ...images,
        { type: 'text', text: m.text }
      ]
      return { role: 'user' as const, content }
    }
    if (images.length > 0) {
      return { role: m.role, content: [...images, { type: 'text' as const, text: m.text }] }
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
  if (req.webSearch) params.tools = [anthropicWebSearchTool(model)]
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

  // Server-side tools run in a server sampling loop that may pause after ~10
  // iterations (stop_reason 'pause_turn'). Append the assistant turn and
  // re-send; the server resumes where it left off. Each round returns only
  // that round's new content, so blocks accumulate across rounds.
  type FinalMessage = Awaited<ReturnType<AnthropicStream['finalMessage']>>
  const usage: AiUsage = { ...EMPTY_USAGE }
  const blocks: FinalMessage['content'] = []
  let final: FinalMessage
  for (let round = 0; ; round++) {
    const stream = streamFn(params, { signal })
    stream.on('text', (delta: string) => emit(delta))
    final = await stream.finalMessage()
    blocks.push(...final.content)
    usage.inputTokens += final.usage.input_tokens
    usage.outputTokens += final.usage.output_tokens
    usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0
    if (final.stop_reason !== 'pause_turn' || round >= 5) break
    ;(params.messages as unknown[]).push({ role: 'assistant', content: final.content })
  }

  // char_location = grounded document citation; web_search_result_location =
  // external source from the web-search tool. Other types are dropped.
  interface Loc {
    type: string
    start_char_index?: number
    end_char_index?: number
    cited_text?: string
    url?: string
    title?: string | null
  }
  const parts: AiContentPart[] = []
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const citations = (block.citations ?? []) as Loc[]
    parts.push({
      text: block.text,
      citations: citations.flatMap((c): AiCitation[] => {
        if (c.type === 'char_location') {
          return [
            {
              kind: 'char',
              start: c.start_char_index ?? 0,
              end: c.end_char_index ?? 0,
              citedText: c.cited_text ?? ''
            }
          ]
        }
        if (c.type === 'web_search_result_location' && c.url) {
          return [{ kind: 'web', url: c.url, title: c.title || c.url }]
        }
        return []
      })
    })
  }
  return { ok: true, parts, usage, model: final.model }
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

interface OpenAiAnnotation {
  type: string
  url?: string
  title?: string | null
  end_index?: number
}

/** Split an OpenAI output_text on url_citation annotations (web-search
 *  sources), then run the quote contract on each slice so document citations
 *  survive alongside. Each web citation attaches to the slice ending at its
 *  end_index — the sentence it supports, mirroring Anthropic's block model. */
function partsFromAnnotatedText(text: string, annotations: OpenAiAnnotation[]): AiContentPart[] {
  const anns = annotations
    .filter((a) => a.type === 'url_citation' && typeof a.url === 'string')
    .sort((a, b) => (a.end_index ?? 0) - (b.end_index ?? 0))
  const parts: AiContentPart[] = []
  let last = 0
  for (const a of anns) {
    const end = Math.min(Math.max(a.end_index ?? 0, last), text.length)
    const sub = parseQuoteContract(text.slice(last, end))
    sub[sub.length - 1].citations.push({ kind: 'web', url: a.url!, title: a.title || a.url! })
    parts.push(...sub)
    last = end
  }
  const tail = text.slice(last)
  if (tail.trim() || parts.length === 0) parts.push(...parseQuoteContract(tail))
  return parts
}

/** OpenAI Responses API (streaming SSE). The 'openai' provider lives here —
 *  Chat Completions has no server-side web_search tool; Azure deployments
 *  stay on chatOpenAiCompatible below. */
async function chatOpenAiResponses(
  apiKey: string,
  model: string,
  thinking: ThinkingLevel,
  req: AiChatRequest,
  emit: Emit,
  signal: AbortSignal
): Promise<AiChatResult> {
  type InputPart =
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string }
  const input: { role: string; content: string | InputPart[] }[] = []
  if (req.document) {
    input.push({
      role: 'user',
      content: `DOKUMENT («${req.document.title}») — svar basert på dette:\n\n${req.document.text}`
    })
    input.push({ role: 'assistant', content: 'Jeg har lest dokumentet og er klar.' })
  }
  for (const m of req.messages) {
    const images = m.images ?? []
    input.push({
      role: m.role,
      content:
        images.length > 0
          ? [
              ...images.map((img) => ({
                type: 'input_image' as const,
                image_url: `data:${img.mediaType};base64,${img.dataBase64}`
              })),
              { type: 'input_text' as const, text: m.text }
            ]
          : m.text
    })
  }

  const body: Record<string, unknown> = {
    model,
    instructions: req.system + (req.document ? QUOTE_CONTRACT : ''),
    input,
    stream: true
  }
  if (req.webSearch) body.tools = [{ type: 'web_search' }]
  if (/gpt-5|o[0-9]/i.test(model)) body.reasoning = { effort: openAiEffort(thinking) }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    return { error: `HTTP ${response.status}: ${detail.slice(0, 300)}` }
  }

  // Typed SSE events; each data payload carries its own `type`, so the
  // `event:` lines can be ignored. Text arrives as output_text.delta; the
  // completed event carries the full response (output items, usage, model).
  interface OutputPiece {
    type: string
    text?: string
    annotations?: OpenAiAnnotation[]
  }
  interface FinalResponse {
    output?: { type: string; content?: OutputPiece[] }[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
    model?: string
    error?: { message?: string } | null
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResp: FinalResponse | null = null
  let errorMsg: string | null = null
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
        switch (parsed.type) {
          case 'response.output_text.delta':
            if (typeof parsed.delta === 'string') emit(parsed.delta)
            break
          case 'response.completed':
          case 'response.incomplete':
            finalResp = parsed.response
            break
          case 'response.failed':
            errorMsg = parsed.response?.error?.message ?? 'Ukjent feil fra OpenAI'
            break
          case 'error':
            errorMsg = parsed.message ?? 'Ukjent feil fra OpenAI'
            break
        }
      } catch {
        /* ignore malformed keep-alives */
      }
    }
  }
  if (errorMsg) return { error: errorMsg }
  if (!finalResp) return { error: 'Strømmen ble avbrutt uten fullført svar.' }

  const parts: AiContentPart[] = []
  for (const item of finalResp.output ?? []) {
    if (item.type !== 'message') continue
    for (const piece of item.content ?? []) {
      if (piece.type !== 'output_text' || typeof piece.text !== 'string') continue
      parts.push(...partsFromAnnotatedText(piece.text, piece.annotations ?? []))
    }
  }
  if (parts.length === 0) parts.push({ text: '', citations: [] })
  return {
    ok: true,
    parts,
    usage: {
      inputTokens: finalResp.usage?.input_tokens ?? 0,
      outputTokens: finalResp.usage?.output_tokens ?? 0,
      cacheReadTokens: finalResp.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0
    },
    model: finalResp.model ?? model
  }
}

/** Chat Completions fallback — used by Azure deployments only (OpenAI proper
 *  goes through chatOpenAiResponses). No server-side web search here. */
async function chatOpenAiCompatible(
  url: string,
  headers: Record<string, string>,
  model: string | null,
  thinking: ThinkingLevel,
  req: AiChatRequest,
  emit: Emit,
  signal: AbortSignal
): Promise<AiChatResult> {
  type OpenAiPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  const messages: { role: string; content: string | OpenAiPart[] }[] = [
    { role: 'system', content: req.system + (req.document ? QUOTE_CONTRACT : '') }
  ]
  if (req.document) {
    messages.push({
      role: 'user',
      content: `DOKUMENT («${req.document.title}») — svar basert på dette:\n\n${req.document.text}`
    })
    messages.push({ role: 'assistant', content: 'Jeg har lest dokumentet og er klar.' })
  }
  for (const m of req.messages) {
    const images = m.images ?? []
    messages.push({
      role: m.role,
      content:
        images.length > 0
          ? [
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` }
              })),
              { type: 'text' as const, text: m.text }
            ]
          : m.text
    })
  }

  const body: Record<string, unknown> = { messages, stream: true }
  if (model) body.model = model
  // gpt-5.6 reasoning control (harmless on models that ignore it)
  if (/gpt-5|o[0-9]/i.test(model ?? '')) body.reasoning_effort = openAiEffort(thinking)

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
  const imageCount = req.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0)
  const answerA = imageCount
    ? `Dette er et testsvar fra mock-leverandøren. Jeg mottok ${imageCount} bilde${imageCount > 1 ? 'r' : ''} og ser innholdet`
    : 'Dette er et testsvar fra mock-leverandøren. Dokumentets innledning slår an tonen for resten av teksten'
  const answerB = doc
    ? ' og lenger ut i dokumentet utdypes dette med et konkret resonnement du kan hoppe rett til.'
    : '.'
  // Web-search toggle on → fake an external source so the chip UI is testable
  const answerC = req.webSearch ? ' Et nettsøk bekrefter dette i en ekstern kilde.' : ''
  const full = answerA + answerB + answerC
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
    : [{ text: answerA + answerB, citations: [] }]
  if (answerC) {
    parts.push({
      text: answerC,
      citations: [{ kind: 'web', url: 'https://example.org/kilde', title: 'Eksempelkilde (mock)' }]
    })
  }
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
        return await chatOpenAiResponses(key, models.openai, thinking, req, emit, signal)
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
          signal
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

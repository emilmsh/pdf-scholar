// Proof for src/shared/ai-chat.ts — the provider core both platforms share —
// against a mocked HTTP layer (no keys, no network, no tokens spent).
//
// What matters here, per provider path:
//   - request SHAPING: the parameters we add (thinking/effort, web-search
//     tools, the quote contract, document + image blocks) match the rules
//     docs/MODEL-UPDATE.md documents;
//   - response PARSING: SSE deltas stream through emit, citations/usage/model
//     survive into the result, pause_turn rounds accumulate, refusals get a
//     named code;
//   - the DEGRADE-ON-400 nets: a rejected parameter is stripped and retried
//     once instead of surfacing a raw 400;
//   - PROFILE agreement: what each path actually sends matches its row in
//     PROVIDER_PROFILES (src/shared/ai-provider-profile.ts) — the table the UI
//     gates affordances on. A lying profile fails here, not in front of a user.
// Run: node scripts/test-ai-chat.mjs
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'scripts', '.ai-chat-test-bundle.mjs')

// Bundle the shared core + profile table into one importable ESM file. The
// bundle lands inside the repo (not tmp) so the externalized @anthropic-ai/sdk
// still resolves from node_modules at import time.
await build({
  stdin: {
    contents: `export * from './src/shared/ai-chat'\nexport * from './src/shared/ai-provider-profile'`,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: BUNDLE,
  logLevel: 'silent'
})
const { runProviderChat, PROVIDER_PROFILES } = await import(pathToFileURL(BUNDLE).href)

let failures = 0
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}
function section(name) {
  console.log('— ' + name)
}

// ---------- fetch mock ----------
//
// Everything (the Anthropic SDK included — it uses global fetch) goes through
// here. Each test sets `responder` and reads captured calls back out of
// `calls`; multi-round tests (degrade retry, pause_turn) branch on call count.

const calls = []
let responder = null

async function normalizeFetchArgs(input, init) {
  // The SDK may pass (url, init) or a Request object; handle both.
  if (input && typeof input === 'object' && typeof input.url === 'string' && 'method' in input) {
    return { url: input.url, headers: new Headers(input.headers), rawBody: await input.clone().text() }
  }
  return { url: String(input), headers: new Headers(init?.headers), rawBody: init?.body ?? '' }
}

globalThis.fetch = async (input, init) => {
  const { url, headers, rawBody } = await normalizeFetchArgs(input, init)
  let body = null
  try {
    body = rawBody ? JSON.parse(rawBody) : null
  } catch {
    body = rawBody
  }
  const call = { url, headers, body }
  calls.push(call)
  if (!responder) throw new Error('unmocked fetch: ' + url)
  return responder(call)
}

const sse = (text) =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const http400 = (message) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  })

// ---------- SSE builders ----------

/** Anthropic Messages SSE for one assistant turn (the SDK accumulates these) */
function anthropicSse({ model = 'claude-sonnet-5', deltas = [], citations = [], stopReason = 'end_turn', inTok = 100, outTok = 7, cacheRead = 0, cacheWrite = 0 }) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inTok, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }
      }
    }
  ]
  if (deltas.length > 0 || citations.length > 0) {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } })
    for (const d of deltas) events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } })
    for (const c of citations) events.push({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: c } })
    events.push({ type: 'content_block_stop', index: 0 })
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTok } })
  events.push({ type: 'message_stop' })
  return sse(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
}

/** OpenAI Responses SSE: text deltas + a completed event */
function openAiSse({ deltas = [], response }) {
  const events = [
    ...deltas.map((d) => ({ type: 'response.output_text.delta', delta: d })),
    ...(response ? [{ type: 'response.completed', response }] : [])
  ]
  return sse(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
}

/** Chat Completions SSE (Azure path) */
function chatCompletionsSse({ deltas = [], usage }) {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
  if (usage) lines.push(`data: ${JSON.stringify({ usage })}\n\n`)
  lines.push('data: [DONE]\n\n')
  return sse(lines.join(''))
}

// ---------- shared request scaffolding ----------

const IMAGE = { mediaType: 'image/png', dataBase64: 'aWJpbGRl' }
const DOC = { title: 'Testdokument', text: '[Side 1] Innledningen setter rammen. [Side 2] Metoden er enkel.' }

function baseParams(overrides) {
  return {
    provider: 'anthropic',
    key: 'sk-test',
    models: { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', azure: '', mock: 'mock-1' },
    azure: { endpoint: 'https://unit.openai.azure.com', deployment: 'dep1', apiVersion: '' },
    thinking: 'medium',
    req: {
      requestId: 1,
      system: 'SYSTEM PROMPT',
      messages: [{ role: 'user', text: 'Hva sier dokumentet?', images: [IMAGE] }],
      document: DOC,
      webSearch: 'on'
    },
    emit: () => {},
    signal: new AbortController().signal,
    ...overrides
  }
}

function run(overrides) {
  calls.length = 0
  let streamed = ''
  const params = baseParams({ emit: (t) => (streamed += t), ...overrides })
  return runProviderChat(params).then((result) => ({ result, streamed }))
}

// What each provider's happy-path request actually carried — compared against
// PROVIDER_PROFILES at the end, so the table stays a tested contract.
const observed = {}

// ---------- Anthropic ----------

section('anthropic: request shaping + SSE parse')
{
  responder = () =>
    anthropicSse({
      deltas: ['Hei ', 'verden'],
      citations: [
        { type: 'char_location', cited_text: 'Innledningen', document_index: 0, document_title: DOC.title, start_char_index: 9, end_char_index: 21 },
        { type: 'web_search_result_location', url: 'https://example.org/k', title: 'Kilde' }
      ],
      cacheRead: 5, cacheWrite: 25
    })
  const { result, streamed } = await run({})
  const body = calls[0]?.body
  ok(calls.length === 1, `one request (got ${calls.length})`)
  ok(calls[0].headers.get('x-api-key') === 'sk-test', 'key travels as x-api-key')
  ok(body?.system?.startsWith('SYSTEM PROMPT') && /WEB SEARCH/.test(body?.system ?? ''), 'system prompt + web hint')
  const first = body?.messages?.[0]?.content
  ok(first?.[0]?.type === 'document' && first[0].citations?.enabled === true, 'document block with citations enabled')
  ok(first?.[0]?.cache_control?.type === 'ephemeral', 'document block is cache-marked')
  ok(first?.some((b) => b.type === 'image'), 'image block attached')
  ok(body?.tools?.[0]?.type === 'web_search_20260209', 'modern web-search tool for sonnet-5')
  ok(body?.thinking?.type === 'adaptive' && body?.output_config?.effort === 'medium', 'adaptive thinking + medium effort')
  ok(body?.max_tokens === 12000, `max_tokens 12000 (got ${body?.max_tokens})`)
  ok(result.ok === true, `result ok (got ${JSON.stringify(result).slice(0, 120)})`)
  ok(streamed === 'Hei verden', `deltas streamed through emit (got "${streamed}")`)
  const cits = (result.parts ?? []).flatMap((p) => p.citations)
  ok(cits.some((c) => c.kind === 'char' && c.start === 9 && c.end === 21), 'char citation parsed')
  ok(cits.some((c) => c.kind === 'web' && c.url === 'https://example.org/k'), 'web citation parsed')
  ok(result.usage?.inputTokens === 100 && result.usage?.outputTokens === 7, 'token usage mapped')
  ok(result.usage?.cacheReadTokens === 5 && result.usage?.cacheWriteTokens === 25, 'cache usage mapped')
  observed.anthropic = {
    quoteContract: /CITATION RULES/.test(body?.system ?? ''),
    nativeCitations: first?.[0]?.citations?.enabled === true,
    webTool: (body?.tools ?? []).length > 0,
    images: first?.some((b) => b.type === 'image') === true
  }
}

section('anthropic: family rules (fable / haiku / caps override)')
{
  // Fable, thinking off: always-thinks family — no thinking field, lowest
  // effort, the server-side fallback beta, and the beta API endpoint.
  responder = () => anthropicSse({ model: 'claude-fable-5', deltas: ['ok'] })
  await run({ models: { anthropic: 'claude-fable-5', openai: '', azure: '', mock: '' }, thinking: 'off' })
  const fable = calls[0]
  ok(fable?.body?.thinking === undefined, 'fable: no thinking param ever')
  ok(fable?.body?.output_config?.effort === 'low', 'fable off → effort low')
  ok(fable?.body?.max_tokens === 12000, 'fable off → 12000 max_tokens')
  const beta = fable?.headers.get('anthropic-beta') ?? ''
  ok(beta.includes('server-side-fallback') || Array.isArray(fable?.body?.betas), 'fable: fallback beta requested')
  ok(fable?.body?.fallbacks === 'default', 'fable: fallbacks default')

  // Haiku ignores thinking AND effort entirely.
  responder = () => anthropicSse({ model: 'claude-haiku-4-5', deltas: ['ok'] })
  await run({ models: { anthropic: 'claude-haiku-4-5', openai: '', azure: '', mock: '' }, thinking: 'high' })
  ok(calls[0]?.body?.thinking === undefined && calls[0]?.body?.output_config === undefined, 'haiku: no thinking, no effort')
  ok(calls[0]?.body?.max_tokens === 4096, 'haiku: 4096 max_tokens')

  // A fetched capability snapshot beats the name heuristics: this id LOOKS
  // adaptive-capable to the regex fallback, but caps say no.
  responder = () => anthropicSse({ model: 'claude-x-test', deltas: ['ok'] })
  await run({
    models: { anthropic: 'claude-x-test', openai: '', azure: '', mock: '' },
    catalog: { anthropic: { fetchedAt: 1, models: [{ id: 'claude-x-test', caps: { adaptiveThinking: false, budgetThinking: true, effort: [] } }] } }
  })
  ok(calls[0]?.body?.thinking === undefined && calls[0]?.body?.output_config === undefined, 'live caps override the name regex')
}

section('anthropic: degrade-on-400, pause_turn, refusal')
{
  // A model the traits misjudged: the API rejects `thinking`, the net strips
  // exactly that group and retries once — the user still gets an answer.
  responder = (call) =>
    'thinking' in (call.body ?? {}) ? http400('thinking: not supported on this model') : anthropicSse({ deltas: ['svar'] })
  const degraded = await run({})
  ok(calls.length === 2, `degrade retried once (got ${calls.length} calls)`)
  ok(calls[1]?.body?.thinking === undefined && calls[1]?.body?.output_config === undefined, 'retry stripped thinking + effort')
  ok(degraded.result.ok === true && degraded.streamed === 'svar', 'degraded request still answers')

  // Server-side tool loop pausing: blocks and usage accumulate across rounds,
  // and the resume request carries the assistant turn back.
  responder = () =>
    calls.length === 1
      ? anthropicSse({ deltas: ['Del 1. '], stopReason: 'pause_turn', inTok: 100, outTok: 5 })
      : anthropicSse({ deltas: ['Del 2.'], inTok: 40, outTok: 6 })
  const paused = await run({})
  ok(calls.length === 2, 'pause_turn resumes with a second round')
  ok(calls[1]?.body?.messages?.some((m) => m.role === 'assistant'), 'resume carries the assistant turn')
  ok(paused.streamed === 'Del 1. Del 2.', `both rounds streamed (got "${paused.streamed}")`)
  ok(paused.result.usage?.inputTokens === 140 && paused.result.usage?.outputTokens === 11, 'usage summed across rounds')

  // Safety refusal with no text at all: a named code, never a blank answer.
  responder = () => anthropicSse({ deltas: [], stopReason: 'refusal' })
  const refused = await run({})
  ok(refused.result.code === 'ai-refusal', `refusal surfaces as ai-refusal (got ${refused.result.code})`)
}

// ---------- OpenAI (Responses API) ----------

section('openai: request shaping + SSE parse')
{
  const answer = 'Alpha [KILDE s.2: "Metoden er enkel"] beta. Ekstern kilde.'
  responder = () =>
    openAiSse({
      deltas: ['Alpha ', 'beta.'],
      response: {
        model: 'gpt-5.6-terra-2026',
        usage: { input_tokens: 11, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: answer,
                annotations: [{ type: 'url_citation', url: 'https://ex.org/a', title: 'Ex', end_index: answer.length }]
              }
            ]
          }
        ]
      }
    })
  const { result, streamed } = await run({ provider: 'openai' })
  const body = calls[0]?.body
  ok(calls[0]?.url === 'https://api.openai.com/v1/responses', 'Responses API endpoint')
  ok(calls[0]?.headers.get('authorization') === 'Bearer sk-test', 'bearer auth')
  ok(/CITATION RULES/.test(body?.instructions ?? '') && /WEB SEARCH/.test(body?.instructions ?? ''), 'quote contract + web hint in instructions')
  ok(typeof body?.input?.[0]?.content === 'string' && body.input[0].content.startsWith('DOCUMENT'), 'document rides as first user turn')
  ok(body?.input?.[1]?.role === 'assistant', 'synthetic document acknowledgement')
  const userParts = body?.input?.[2]?.content
  ok(Array.isArray(userParts) && userParts.some((p) => p.type === 'input_image'), 'image as input_image part')
  ok(body?.tools?.[0]?.type === 'web_search', 'web-search tool attached')
  ok(body?.reasoning?.effort === 'medium', 'reasoning effort for gpt-5.6')
  ok(result.ok === true && streamed === 'Alpha beta.', 'deltas streamed, result ok')
  const cits = (result.parts ?? []).flatMap((p) => p.citations)
  ok(cits.some((c) => c.kind === 'quote' && c.pageNumber === 2 && c.quote === 'Metoden er enkel'), 'quote-contract citation parsed')
  ok(cits.some((c) => c.kind === 'web' && c.url === 'https://ex.org/a'), 'url_citation annotation parsed')
  ok(result.usage?.inputTokens === 11 && result.usage?.cacheReadTokens === 4, 'usage mapped (incl. cached)')
  ok(result.model === 'gpt-5.6-terra-2026', 'model echoed from the response')
  observed.openai = {
    quoteContract: /CITATION RULES/.test(body?.instructions ?? ''),
    nativeCitations: false,
    webTool: (body?.tools ?? []).length > 0,
    images: Array.isArray(userParts) && userParts.some((p) => p.type === 'input_image')
  }
}

section('openai: degrade-on-400 + response.failed')
{
  responder = (call) =>
    'reasoning' in (call.body ?? {})
      ? new Response('Unsupported parameter: reasoning', { status: 400 })
      : openAiSse({ deltas: ['ok'], response: { model: 'm', usage: {}, output: [] } })
  const degraded = await run({ provider: 'openai' })
  ok(calls.length === 2 && calls[1]?.body?.reasoning === undefined, 'reasoning stripped and retried once')
  ok(degraded.result.ok === true, 'degraded openai request still answers')

  responder = () => sse(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'boom' } } })}\n\n`)
  const failed = await run({ provider: 'openai' })
  ok(failed.result.error === 'boom', `response.failed carries the provider sentence (got ${failed.result.error})`)
}

// ---------- Azure (Chat Completions path) ----------

section('azure: config gate + shaping + quote contract + overflow')
{
  const unconfigured = await run({ provider: 'azure', azure: { endpoint: '', deployment: '', apiVersion: '' } })
  ok(unconfigured.result.code === 'ai-azure-unconfigured', 'missing endpoint/deployment is a named error')

  const answer =
    'Funnet står tidlig. [KILDE s.1: "den \\"viktigste\\" rammen"] Og mer. [KILDE s.12: «sekundært funn»] Hale.'
  responder = () => chatCompletionsSse({
    deltas: [answer],
    usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } }
  })
  const { result } = await run({ provider: 'azure' })
  const body = calls[0]?.body
  ok(
    calls[0]?.url.startsWith('https://unit.openai.azure.com/openai/deployments/dep1/chat/completions?api-version='),
    'deployment URL with api-version'
  )
  ok(calls[0]?.headers.get('api-key') === 'sk-test', 'key travels as api-key header')
  ok(body?.messages?.[0]?.role === 'system' && /CITATION RULES/.test(body.messages[0].content), 'quote contract in the system turn')
  ok(body?.tools === undefined, 'no web-search tool on the azure path even when requested')
  ok(body?.model === undefined, 'deployment URLs carry no model field')
  const azUser = body?.messages?.find((m) => Array.isArray(m.content))
  ok(azUser?.content?.some((p) => p.type === 'image_url'), 'image as image_url part')
  const cits = (result.parts ?? []).flatMap((p) => p.citations)
  ok(
    cits.some((c) => c.kind === 'quote' && c.pageNumber === 1 && c.quote === 'den "viktigste" rammen'),
    'escaped quotes unescape to a verbatim substring'
  )
  ok(cits.some((c) => c.kind === 'quote' && c.pageNumber === 12 && c.quote === 'sekundært funn'), 'guillemet quotes accepted')
  ok((result.parts ?? []).at(-1)?.text.includes('Hale.'), 'tail text after the last marker survives')
  ok(result.usage?.inputTokens === 9 && result.usage?.cacheReadTokens === 1, 'usage mapped from the usage chunk')
  observed.azure = {
    quoteContract: /CITATION RULES/.test(body?.messages?.[0]?.content ?? ''),
    nativeCitations: false,
    webTool: (body?.tools ?? []).length > 0,
    images: azUser?.content?.some((p) => p.type === 'image_url') === true
  }

  responder = () => new Response("This model's maximum context length is 128000 tokens.", { status: 400 })
  const overflow = await run({ provider: 'azure' })
  ok(overflow.result.code === 'ai-context-overflow', 'provider overflow rejection gets the named code')
  ok(/128000/.test(overflow.result.error ?? ''), 'provider sentence (with the counts) is kept')
}

// ---------- mock ----------

section('mock: keyless offline provider')
{
  responder = () => {
    throw new Error('mock must not touch the network')
  }
  const { result, streamed } = await run({ provider: 'mock', key: '' })
  ok(result.ok === true && result.model === 'mock-1', 'mock answers with no key and no network')
  ok(streamed.length > 0, 'mock streams its answer')
  const cits = (result.parts ?? []).flatMap((p) => p.citations)
  ok(cits.some((c) => c.kind === 'char'), 'mock emits char citations (native-style)')
  ok(cits.some((c) => c.kind === 'web'), 'mock emits a web citation in webSearch on-mode')
  observed.mock = { quoteContract: false, nativeCitations: true, webTool: true, images: true }
}

// ---------- profile conformance ----------

section('profile ↔ path agreement (PROVIDER_PROFILES is a tested contract)')
for (const [provider, profile] of Object.entries(PROVIDER_PROFILES)) {
  const seen = observed[provider]
  ok(seen, `observed a run for ${provider}`)
  if (!seen) continue
  if (profile.citations === 'contract') {
    ok(seen.quoteContract, `${provider}: profile says contract citations → request carries the quote contract`)
  } else {
    ok(seen.nativeCitations && !seen.quoteContract, `${provider}: profile says native citations → citations enabled, no contract`)
  }
  ok(seen.webTool === profile.webSearch, `${provider}: web-search tool attachment matches profile (${profile.webSearch})`)
  ok(seen.images === profile.vision, `${provider}: image handling matches profile (${profile.vision})`)
}
ok(PROVIDER_PROFILES.mock.keyRequired === false, 'mock declared keyless (ran with an empty key above)')

// ---------- verdict ----------

if (failures > 0) {
  console.error(`\ntest-ai-chat: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\ntest-ai-chat: all assertions passed')

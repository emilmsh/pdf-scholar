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
    contents: [
      `export * from './src/shared/ai-chat'`,
      `export * from './src/shared/ai-provider-profile'`,
      `export * from './src/shared/ai-model-catalog'`
    ].join('\n'),
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
const {
  runProviderChat,
  PROVIDER_PROFILES,
  COMPAT_SERVICES,
  fetchCompatModels,
  refreshCatalog,
  isLocalEndpoint,
  catalogStale
} = await import(pathToFileURL(BUNDLE).href)

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
function anthropicSse({ model = 'claude-sonnet-5', deltas = [], citations = [], stopReason = 'end_turn', inTok = 100, outTok = 7, cacheRead = 0, cacheWrite = 0, fallback = null }) {
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
  // Server-side fallback's handoff marker: a content block with no deltas
  // (refusals-and-fallback, «Streaming»), first when the decline came before
  // any output
  const t0 = fallback ? 1 : 0
  if (fallback) {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'fallback', from: { model: fallback.from }, to: { model: fallback.to } } })
    events.push({ type: 'content_block_stop', index: 0 })
  }
  if (deltas.length > 0 || citations.length > 0) {
    events.push({ type: 'content_block_start', index: t0, content_block: { type: 'text', text: '', citations: [] } })
    for (const d of deltas) events.push({ type: 'content_block_delta', index: t0, delta: { type: 'text_delta', text: d } })
    for (const c of citations) events.push({ type: 'content_block_delta', index: t0, delta: { type: 'citations_delta', citation: c } })
    events.push({ type: 'content_block_stop', index: t0 })
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
    models: {
      anthropic: 'claude-sonnet-5',
      openai: 'gpt-6-sol',
      chatgpt: 'gpt-6-sol',
      azure: '',
      // The curated ids (ai-models.ts) — the harness must exercise what the
      // menu actually offers, not ids the providers retired
      openrouter: 'anthropic/claude-sonnet-5',
      gemini: 'gemini-3.8-flash',
      xai: 'grok-4.3',
      mistral: 'mistral-medium-2604',
      groq: 'openai/gpt-oss-120b',
      compat: 'llama3.1',
      mock: 'mock-1'
    },
    azure: { endpoint: 'https://unit.openai.azure.com', deployment: 'dep1', apiVersion: '' },
    compat: { baseUrl: 'http://localhost:11434/v1/' },
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

  // Fable 5.1 (curated since 2026-09-05) rides the same family rules — and
  // never sees the two things it rejects that Fable 5 accepted: a forced
  // tool_choice and replayed thinking blocks (history is text-only here).
  responder = () => anthropicSse({ model: 'claude-fable-5-1', deltas: ['ok'] })
  await run({
    models: { anthropic: 'claude-fable-5-1', openai: '', azure: '', mock: '' },
    thinking: 'high',
    req: { ...baseParams({}).req, messages: [
      { role: 'user', text: 'Første spørsmål', images: [] },
      { role: 'assistant', text: 'Første svar', images: [] },
      { role: 'user', text: 'Oppfølging', images: [] }
    ] }
  })
  const fable51 = calls[0]
  ok(fable51?.body?.thinking === undefined, 'fable 5.1: no thinking param')
  ok(fable51?.body?.output_config?.effort === 'high', 'fable 5.1: effort travels')
  ok(fable51?.body?.fallbacks === 'default', 'fable 5.1: fallbacks default')
  ok(fable51?.body?.tool_choice === undefined, 'fable 5.1: no forced tool_choice (400 on 5.1)')
  ok(
    (fable51?.body?.messages ?? []).every((m) => typeof m.content === 'string' || m.content.every((b) => b.type !== 'thinking')),
    'fable 5.1: no thinking blocks replayed in history'
  )

  // Opus 5.5 (curated since 2026-09-26) cannot turn thinking off either —
  // thinking {type:'disabled'} is a 400 there, where Opus 5 accepted it. «Av»
  // is the lowest effort with no thinking field, also when a live capability
  // snapshot (adaptive, no budget) would otherwise read it as an explicit-off
  // model like Sonnet 5. It carries classifiers like Fable, so it asks for
  // server-side fallback too (Emil, 2026-09-27).
  const opus55Caps = { adaptiveThinking: true, budgetThinking: false, effort: ['low', 'medium', 'high', 'xhigh', 'max'] }
  for (const catalog of [undefined, { anthropic: { fetchedAt: 1, models: [{ id: 'claude-opus-5-5', caps: opus55Caps }] } }]) {
    const how = catalog ? 'live caps' : 'regex'
    responder = () => anthropicSse({ model: 'claude-opus-5-5', deltas: ['ok'] })
    await run({ models: { anthropic: 'claude-opus-5-5', openai: '', azure: '', mock: '' }, thinking: 'off', catalog })
    ok(calls[0]?.body?.thinking === undefined, `opus 5.5 off (${how}): no thinking field (disabled → 400)`)
    ok(calls[0]?.body?.output_config?.effort === 'low', `opus 5.5 off (${how}) → effort low`)
    ok(calls[0]?.body?.fallbacks === 'default', `opus 5.5 (${how}): fallbacks default`)
    const beta55 = calls[0]?.headers.get('anthropic-beta') ?? ''
    ok(beta55.includes('server-side-fallback') || Array.isArray(calls[0]?.body?.betas), `opus 5.5 (${how}): fallback beta requested`)
    ok(calls[0]?.body?.tools?.[0]?.type === 'web_search_20260209', `opus 5.5 (${how}): modern web-search tool`)
  }
  // Opus 5 (stored selections) is a Claude 4.6+ model too — it was getting
  // the basic search tool because the regex only knew opus-4-[6-9]
  responder = () => anthropicSse({ model: 'claude-opus-5', deltas: ['ok'] })
  await run({ models: { anthropic: 'claude-opus-5', openai: '', azure: '', mock: '' }, thinking: 'high' })
  ok(calls[0]?.body?.tools?.[0]?.type === 'web_search_20260209', 'opus 5: modern web-search tool')
  // ...and it thinks when the field is left out, so «Av» must say disabled
  // (the regex fallback used to omit it, which left thinking ON offline)
  await run({ models: { anthropic: 'claude-opus-5', openai: '', azure: '', mock: '' }, thinking: 'off' })
  ok(calls[0]?.body?.thinking?.type === 'disabled', `opus 5 off (regex) → explicit disabled (got ${JSON.stringify(calls[0]?.body?.thinking)})`)
  ok(calls[0]?.body?.fallbacks === 'default', 'opus 5: fallbacks default (it has classifiers too)')
  // Sonnet 5 ships no classifiers — no fallback, no beta endpoint
  responder = () => anthropicSse({ model: 'claude-sonnet-5', deltas: ['ok'] })
  await run({})
  ok(calls[0]?.body?.fallbacks === undefined, 'sonnet 5: no server-side fallback')

  // Sonnet 5.5 (curated since 2026-10-05): adaptive thinking, NOT always-on
  // like Opus 5.5 — but {type:'disabled'} is itself a 400 there, so «Av» must
  // say {type:'between_tools'} instead (platform.claude.com/docs/en/models/
  // sonnet-5-5/whats-new-sonnet-5-5, verified 2026-10-05). Unlike Sonnet 5, it
  // ships classifiers, so fallback joins it too.
  responder = () => anthropicSse({ model: 'claude-sonnet-5-5', deltas: ['ok'] })
  await run({ models: { anthropic: 'claude-sonnet-5-5', openai: '', azure: '', mock: '' }, thinking: 'off' })
  ok(
    calls[0]?.body?.thinking?.type === 'between_tools',
    `sonnet 5.5 off → between_tools (got ${JSON.stringify(calls[0]?.body?.thinking)})`
  )
  ok(calls[0]?.body?.fallbacks === 'default', 'sonnet 5.5: fallbacks default (has classifiers, unlike sonnet 5)')
  responder = () => anthropicSse({ model: 'claude-sonnet-5-5', deltas: ['ok'] })
  await run({ models: { anthropic: 'claude-sonnet-5-5', openai: '', azure: '', mock: '' }, thinking: 'medium' })
  ok(calls[0]?.body?.thinking?.type === 'adaptive', 'sonnet 5.5 medium → adaptive thinking (not always-on)')
  ok(calls[0]?.body?.tools?.[0]?.type === 'web_search_20260209', 'sonnet 5.5: modern web-search tool')

  // When the fallback DID answer, the result names the model that did — read
  // from the handoff block, since message_start can still name the chosen one
  responder = () =>
    anthropicSse({ model: 'claude-opus-5-5', deltas: ['Svar'], fallback: { from: 'claude-opus-5-5', to: 'claude-opus-4-8' } })
  const served = await run({ models: { anthropic: 'claude-opus-5-5', openai: '', azure: '', mock: '' } })
  ok(served.result.ok === true && served.result.fallbackModel === 'claude-opus-4-8', `fallback answer names its model (got ${served.result.fallbackModel})`)
  ok(served.result.parts?.map((p) => p.text).join('') === 'Svar', 'fallback answer text survives the handoff block')
  responder = () => anthropicSse({ model: 'claude-opus-5-5', deltas: ['ok'] })
  const own = await run({ models: { anthropic: 'claude-opus-5-5', openai: '', azure: '', mock: '' } })
  ok(own.result.ok === true && own.result.fallbackModel === undefined, 'no fallbackModel when the chosen model answered')

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

  // A paused turn after a fallback handoff: the declining model's thinking
  // before the LAST fallback block is dropped from the echo, the block itself
  // stays in place (refusals-and-fallback, «Continuing the conversation»)
  const handoffRound = () => {
    const ev = [
      { type: 'message_start', message: { id: 'msg_fb', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: [] } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Del 1. ' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ]
    return sse(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  }
  responder = () => (calls.length === 1 ? handoffRound() : anthropicSse({ model: 'claude-opus-4-8', deltas: ['Del 2.'] }))
  const resumed = await run({ models: { anthropic: 'claude-opus-5-5', openai: '', azure: '', mock: '' } })
  const echoed = (calls[1]?.body?.messages ?? []).filter((m) => m.role === 'assistant').at(-1)?.content ?? []
  ok(
    echoed.map((b) => b.type).join(',') === 'fallback,text',
    `resume after a handoff drops the declined model's thinking, keeps the block (got ${echoed.map((b) => b.type).join(',')})`
  )
  ok(resumed.result.fallbackModel === 'claude-opus-4-8' && resumed.result.parts?.map((p) => p.text).join('') === 'Del 1. Del 2.', `handoff + pause_turn still answers whole (got ${resumed.result.fallbackModel}, "${resumed.result.parts?.map((p) => p.text).join('')}")`)

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

section('openai: gpt-6 (Astra curated 2026-09-05, Sol/Luna 2026-09-26)')
{
  // The reasoning regex must cover the 6-series — /gpt-5/ alone would have
  // left Astra without thinking-level control in silence.
  responder = () => openAiSse({ deltas: ['ok'], response: { model: 'gpt-6-astra', output: [] } })
  await run({ provider: 'openai', models: { anthropic: '', openai: 'gpt-6-astra', azure: '', mock: '' }, thinking: 'high' })
  ok(calls[0]?.body?.reasoning?.effort === 'high', 'gpt-6: reasoning effort sent')
  // Astra 400s on effort "none" (OpenAI reasoning guide, 2026-09-05): «Av»
  // maps to the lowest effort, like Fable — and NOT through the degrade net,
  // which would have cost a second request per question.
  await run({ provider: 'openai', models: { anthropic: '', openai: 'gpt-6-astra', azure: '', mock: '' }, thinking: 'off' })
  ok(calls.length === 1 && calls[0]?.body?.reasoning?.effort === 'low', `gpt-6 off → effort low in ONE request (got ${calls.length}, ${calls[0]?.body?.reasoning?.effort})`)
  // gpt-5.6 (stored selections) keeps `none` — documented there, and cheaper
  await run({ provider: 'openai', models: { anthropic: '', openai: 'gpt-5.6-terra', azure: '', mock: '' }, thinking: 'off' })
  ok(calls[0]?.body?.reasoning?.effort === 'none', 'gpt-5.6 off → none unchanged')
  // GPT-6 Sol and Luna DO document `none` (their model pages, 2026-09-26) —
  // the always-reasons list names Astra, not the whole 6-series
  for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
    responder = () => openAiSse({ deltas: ['ok'], response: { model: id, output: [] } })
    await run({ provider: 'openai', models: { anthropic: '', openai: id, azure: '', mock: '' }, thinking: 'off' })
    ok(calls[0]?.body?.reasoning?.effort === 'none', `${id} off → none (got ${calls[0]?.body?.reasoning?.effort})`)
  }
  // GPT-6.1 Sol (curated 2026-10-05, DevDay launch 2026-09-29): near-Astra
  // quality, and like Astra it 400s on `reasoning.effort: "none"`
  // (developers.openai.com/api/docs/models/gpt-6.1-sol, verified 2026-10-05)
  // — «Av» maps to the lowest effort, in one request.
  responder = () => openAiSse({ deltas: ['ok'], response: { model: 'gpt-6.1-sol', output: [] } })
  await run({ provider: 'openai', models: { anthropic: '', openai: 'gpt-6.1-sol', azure: '', mock: '' }, thinking: 'off' })
  ok(
    calls.length === 1 && calls[0]?.body?.reasoning?.effort === 'low',
    `gpt-6.1-sol off → effort low in ONE request (got ${calls.length}, ${calls[0]?.body?.reasoning?.effort})`
  )
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

// ---------- ChatGPT plan (Codex backend, Responses shape) ----------

section('chatgpt: plan backend — address, sign-in headers, store:false, named failures')
{
  responder = () =>
    openAiSse({
      deltas: ['Svar.'],
      response: {
        model: 'gpt-6-sol',
        usage: { input_tokens: 9, output_tokens: 2 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Svar [KILDE s.1: "Innledningen setter rammen"].' }] }]
      }
    })
  const { result } = await run({ provider: 'chatgpt', key: 'access-tok', chatgptAccountId: 'acct-1' })
  const call = calls[0]
  const body = call?.body
  ok(call?.url === 'https://chatgpt.com/backend-api/codex/responses', `plan backend endpoint (got ${call?.url})`)
  ok(call?.headers.get('authorization') === 'Bearer access-tok', 'the ACCESS token is the bearer')
  ok(call?.headers.get('chatgpt-account-id') === 'acct-1', 'account id header')
  ok(call?.headers.get('originator') === 'pdf-scholar', 'we name ourselves, never Codex CLI')
  ok(body?.store === false, 'store:false — the backend keeps nothing')
  ok(body?.model === 'gpt-6-sol' && body?.stream === true, 'model + stream')
  ok(!('max_output_tokens' in (body ?? {})), 'no output cap (Codex sends none)')
  ok(result.ok === true && (result.parts ?? []).some((p) => p.citations.some((c) => c.kind === 'quote')), 'quote contract parsed as for openai')
  const userParts = body?.input?.[2]?.content
  observed.chatgpt = {
    quoteContract: /CITATION RULES/.test(body?.instructions ?? ''),
    nativeCitations: false,
    webTool: (body?.tools ?? []).length > 0,
    images: Array.isArray(userParts) && userParts.some((p) => p.type === 'input_image')
  }

  // The API path must be untouched by the plan's extras
  responder = () => openAiSse({ deltas: ['ok'], response: { model: 'm', output: [] } })
  await run({ provider: 'openai' })
  ok(!('store' in (calls[0]?.body ?? {})), 'openai (API key) does not send store')

  responder = () => new Response('{"detail":"Unauthorized"}', { status: 401 })
  const lapsed = await run({ provider: 'chatgpt', key: 'stale', chatgptAccountId: 'acct-1' })
  ok(lapsed.result.code === 'ai-chatgpt-session-expired', `401 → session expired (got ${lapsed.result.code})`)

  responder = () =>
    new Response(
      JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 1800 } }),
      { status: 429 }
    )
  const spent = await run({ provider: 'chatgpt', key: 'tok', chatgptAccountId: 'acct-1' })
  ok(spent.result.code === 'ai-subscription-limit', `usage_limit_reached → subscription limit (got ${spent.result.code})`)
  ok(/30 min/.test(spent.result.error ?? ''), `the reset time is named (got ${spent.result.error})`)
  ok(calls.length === 1, 'no retry on a spent plan window')

  // A plain 429 without the plan's wording stays the ordinary rate-limit family
  responder = () => new Response('Rate limit reached for requests', { status: 429 })
  const busy = await run({ provider: 'chatgpt', key: 'tok', chatgptAccountId: 'acct-1' })
  ok(busy.result.code === 'ai-rate-limited', `other 429 → rate limited (got ${busy.result.code})`)
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

  // A per-minute token quota rejection is NOT a context overflow, and ONE
  // request bigger than the whole minute's budget is not an ordinary rate
  // limit either: waiting cannot fix it, so it carries its own name and its
  // own advice (observed live against gpt-4.1, 2026-08-12).
  responder = () =>
    new Response(
      'Request too large for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Requested 45047.',
      { status: 429 }
    )
  const tpm = await run({ provider: 'azure' })
  ok(
    tpm.result.code === 'ai-request-too-large',
    `a request-too-large rejection is not a plain rate limit (got ${tpm.result.code})`
  )
  ok(/45047/.test(tpm.result.error ?? ''), 'provider sentence (with the counts) is kept')
  // …and the ceiling it named is handed back, so the next request's excerpt
  // can be cut to fit it (ai-token-limits.ts). Prose is the fallback path —
  // this rejection carried no rate-limit headers.
  ok(tpm.result.tokenLimit === 30000, `the ceiling is read out of the sentence (got ${tpm.result.tokenLimit})`)

  // A rate limit someone ELSE's request is holding: the same question succeeds
  // in a minute, so this one keeps the wait-and-retry advice.
  responder = () =>
    new Response('Rate limit reached for gpt-4.1. Please try again in 20s.', { status: 429 })
  const busyMinute = await run({ provider: 'azure' })
  ok(
    busyMinute.result.code === 'ai-rate-limited',
    `a plain rate limit stays waitable (got ${busyMinute.result.code})`
  )

  // The header is authoritative where both are present: a gateway may name a
  // per-request limit in prose that is not the account's token ceiling.
  responder = () =>
    new Response('Request too large: Limit 999, Requested 45047.', {
      status: 429,
      headers: { 'x-ratelimit-limit-tokens': '450000' }
    })
  const headed = await run({ provider: 'azure' })
  ok(headed.result.tokenLimit === 450000, `the rate-limit header wins over the prose (got ${headed.result.tokenLimit})`)

  // The ceiling is learned from a SUCCESSFUL answer too — which is the point:
  // a small question teaches it, so the first big one is cut to fit rather
  // than failing and teaching us afterwards.
  responder = () =>
    new Response(chatCompletionsSse({ deltas: ['Hei.'] }).body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-ratelimit-limit-tokens': '30000' }
    })
  const good = await run({ provider: 'azure' })
  ok(good.result.ok === true && good.result.tokenLimit === 30000, `a successful answer reports the ceiling too (got ${good.result.tokenLimit})`)

  // An account with no money still wins over both: waiting and excerpting are
  // equally useless there.
  responder = () =>
    new Response(
      JSON.stringify({ error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } }),
      { status: 429, headers: { 'x-ratelimit-limit-tokens': '30000' } }
    )
  const dryTier = await run({ provider: 'azure' })
  ok(dryTier.result.code === 'ai-no-credit', `billing beats the quota codes (got ${dryTier.result.code})`)

  // Models substitute the document filename for the literal KILDE token
  // (Gemini, observed 2026-08-12) — the parser accepts any short source name
  responder = () => chatCompletionsSse({
    deltas: ['Se her. [grebe2015-edoc.pdf s.3: "forhandlingsmakt i sekvensielle mekanismer"] Slutt.']
  })
  const named = await run({ provider: 'azure' })
  ok(
    (named.result.parts ?? [])
      .flatMap((p) => p.citations)
      .some((c) => c.kind === 'quote' && c.pageNumber === 3 && c.quote === 'forhandlingsmakt i sekvensielle mekanismer'),
    'filename in place of KILDE still parses to a quote citation'
  )
}

// ---------- compat (OpenAI-compatible endpoint, keyless local server) ----------

section('compat: config gate + keyless request + URL join')
{
  const unconfigured = await run({ provider: 'compat', compat: { baseUrl: '' } })
  ok(unconfigured.result.code === 'ai-compat-unconfigured', 'missing base URL is a named error')
  const noModel = await run({
    provider: 'compat',
    models: { anthropic: '', openai: '', azure: '', compat: '', mock: '' }
  })
  ok(noModel.result.code === 'ai-compat-unconfigured', 'missing model id is the same named error')

  const answer = 'Modellen svarer. [KILDE s.2: "Metoden er enkel"] Slutt.'
  responder = () => chatCompletionsSse({
    deltas: [answer],
    usage: { prompt_tokens: 7, completion_tokens: 2 }
  })
  // key: '' — the keyless local-server case is the whole point of the provider
  const { result } = await run({ provider: 'compat', key: '' })
  const body = calls[0]?.body
  ok(
    calls[0]?.url === 'http://localhost:11434/v1/chat/completions',
    `trailing slash normalised in the URL join (got ${calls[0]?.url})`
  )
  ok(!calls[0]?.headers.get('authorization'), 'no auth header without a key')
  ok(body?.model === 'llama3.1', 'model id from models.compat')
  ok(body?.tools === undefined, 'no web-search tool even when requested')
  ok(body?.reasoning_effort === undefined, 'no reasoning_effort for a non-reasoning id')
  ok(/CITATION RULES/.test(body?.messages?.[0]?.content ?? ''), 'quote contract in the system turn')
  const compatUser = body?.messages?.find((m) => Array.isArray(m.content))
  ok(compatUser?.content?.some((p) => p.type === 'image_url'), 'image as image_url part')
  ok(result.ok === true && result.model === 'llama3.1', 'answers with no key at all')
  const cits = (result.parts ?? []).flatMap((p) => p.citations)
  ok(cits.some((c) => c.kind === 'quote' && c.pageNumber === 2), 'quote-contract citation parsed')
  observed.compat = {
    quoteContract: /CITATION RULES/.test(body?.messages?.[0]?.content ?? ''),
    nativeCitations: false,
    webTool: (body?.tools ?? []).length > 0,
    images: compatUser?.content?.some((p) => p.type === 'image_url') === true
  }

  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({ provider: 'compat' })
  ok(calls[0]?.headers.get('authorization') === 'Bearer sk-test', 'key (when given) travels as Bearer')

  await run({
    provider: 'compat',
    models: { anthropic: '', openai: '', azure: '', compat: 'gpt-5.6-terra', mock: '' }
  })
  ok(calls[0]?.body?.reasoning_effort === 'medium', 'reasoning_effort for an OpenAI-style reasoning id')
}

section('compat: transport failures get their names')
{
  responder = () => {
    throw new TypeError('fetch failed')
  }
  const down = await run({ provider: 'compat', key: '' })
  ok(down.result.code === 'ai-endpoint-unreachable', `nothing listening → ai-endpoint-unreachable (got ${down.result.code})`)
  ok(/localhost:11434/.test(down.result.error ?? ''), 'the host rides in the log sentence')

  responder = () =>
    new Response('<!doctype html><html><body>Not an API</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  const wrong = await run({ provider: 'compat', key: '' })
  ok(wrong.result.code === 'ai-endpoint-incompatible', `HTML answer → ai-endpoint-incompatible (got ${wrong.result.code})`)

  // A minimal server that ignores `stream: true` and answers with one
  // complete Chat Completions JSON — accepted quietly, not an error.
  responder = () =>
    new Response(
      JSON.stringify({
        model: 'llama3.1',
        choices: [{ message: { role: 'assistant', content: 'Alt i ett svar. [KILDE s.1: "Innledningen setter rammen"]' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  const single = await run({ provider: 'compat', key: '' })
  ok(single.result.ok === true, 'non-streaming JSON body still answers')
  ok(single.streamed.includes('Alt i ett svar.'), 'the one-shot answer still reaches emit')
  ok(
    (single.result.parts ?? []).flatMap((p) => p.citations).some((c) => c.kind === 'quote' && c.pageNumber === 1),
    'quote contract parsed from the one-shot body'
  )
  ok(single.result.usage?.inputTokens === 5, 'usage mapped from the one-shot body')
}

// ---------- reasoning models over Chat Completions ----------
//
// Kimi K2.5 via OpenRouter (observed 2026-08-16): the model spends minutes
// streaming reasoning before its first content delta. Three separate failures
// conspired to make that look like a hang — reasoning deltas were ignored (no
// liveness), a mid-stream error event was ignored, and a stream that ended
// with no content came back as a SUCCESSFUL empty answer.
section('compat: reasoning deltas, mid-stream errors, empty streams')
{
  const reasoningSse = (extra = '') =>
    sse(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'La meg tenke' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ' litt til' } }] })}\n\n`,
        extra,
        'data: [DONE]\n\n'
      ].join('')
    )

  // Reasoning is liveness, never answer text
  let events = []
  const collect = (t, kind) => events.push([kind ?? 'text', t])
  responder = () =>
    reasoningSse(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Svaret.' } }] })}\n\n`)
  const reasoned = await run({ provider: 'openrouter', emit: collect })
  ok(reasoned.result.ok === true, 'reasoning followed by content answers normally')
  ok(
    events.some(([k, t]) => k === 'thinking' && t === 'La meg tenke'),
    'OpenRouter delta.reasoning is forwarded as thinking'
  )
  ok(
    events.some(([k, t]) => k === 'thinking' && t === ' litt til'),
    'Moonshot-style delta.reasoning_content too'
  )
  const answer = (reasoned.result.parts ?? []).map((p) => p.text).join('')
  ok(answer === 'Svaret.', `reasoning never lands in the answer text (got "${answer}")`)

  // A stream that reasons and then ends is not an empty success
  responder = () => reasoningSse()
  const dry = await run({ provider: 'openrouter' })
  ok(dry.result.code === 'ai-stream-aborted', `reasoning with no answer → named error (got ${dry.result.code})`)

  // OpenRouter reports upstream failures as SSE error events on an HTTP 200
  responder = () =>
    sse(
      `data: ${JSON.stringify({ error: { message: 'Upstream provider error' } })}\n\ndata: [DONE]\n\n`
    )
  const upstream = await run({ provider: 'openrouter' })
  ok(upstream.result.error === 'Upstream provider error', `mid-stream error is surfaced (got ${upstream.result.error})`)

  // …but a provider that errors and then recovers with an answer has not failed
  responder = () =>
    sse(
      [
        `data: ${JSON.stringify({ error: { message: 'transient' } })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Gikk bra likevel.' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join('')
    )
  const recovered = await run({ provider: 'openrouter' })
  ok(recovered.result.ok === true, 'an error followed by content still answers')
}

// ---------- provider conditions the user can act on ----------
//
// All three arrived as raw HTTP dumps in the live run of 2026-08-18, and the
// three remedies are different: wait, top up, or narrow the question. Telling
// someone to wait when their card needs attention wastes their afternoon, so
// the ORDER these are matched in is as much under test as the matching.
section('provider state: overloaded, out of credit, rate limited')
{
  const fail = (status, body) => () => new Response(JSON.stringify(body), { status })

  // Gemini, observed live: 503 while the model is saturated
  responder = fail(503, { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand may cause errors.' } })
  const busy = await run({ provider: 'gemini' })
  ok(busy.result.code === 'ai-model-overloaded', `503 high demand → ai-model-overloaded (got ${busy.result.code})`)

  // xAI, observed live: a 403 that is really a billing state
  responder = fail(403, { code: 'permission-denied', error: "Your newly created team doesn't have any credits or licenses yet." })
  const broke = await run({ provider: 'xai' })
  ok(broke.result.code === 'ai-no-credit', `403 no credits → ai-no-credit (got ${broke.result.code})`)

  // OpenAI bills an empty account as a 429 — the status says rate limit and the
  // body says otherwise. The body wins, or the user is told to wait forever.
  responder = fail(429, { error: { type: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } })
  const dry = await run({ provider: 'openai' })
  ok(dry.result.code === 'ai-no-credit', `429 insufficient_quota → ai-no-credit (got ${dry.result.code})`)

  // …but a plain quota exhaustion with no billing language is a free tier
  // resetting, and must stay a rate limit: waiting IS the remedy there.
  responder = fail(429, { error: { code: 429, message: 'You exceeded your current quota. Please retry in 41 seconds.' } })
  const later = await run({ provider: 'gemini' })
  ok(later.result.code === 'ai-rate-limited', `plain quota 429 stays ai-rate-limited (got ${later.result.code})`)

  // A 500 is not an overload: it stays unnamed, with the provider's own words,
  // because we have nothing useful to add to it.
  responder = fail(500, { error: { message: 'Internal error' } })
  const boom = await run({ provider: 'gemini' })
  ok(boom.result.code === undefined, `a plain 500 is not dressed up as overload (got ${boom.result.code})`)
}

// ---------- a picture sent to a model with no eyes ----------
//
// The one failure the raw provider sentence describes worst. OpenRouter answers
// «No endpoints found that support image input» with an HTTP 404, which reads
// as "that model is gone" — and since the menu now offers only image-capable
// models, anyone who hits this got there by typing a name into the filter or by
// keeping an older selection, i.e. exactly the person who needs to be told what
// really happened.
section('images: a text-only model is named as such')
{
  const noEndpoints = () =>
    new Response(JSON.stringify({ error: { message: 'No endpoints found that support image input.' } }), {
      status: 404
    })

  responder = noEndpoints
  const rejected = await run({ provider: 'openrouter' })
  ok(rejected.result.code === 'ai-model-no-images', `image rejection → ai-model-no-images (got ${rejected.result.code})`)
  ok(
    /anthropic\/claude-sonnet-5/.test(rejected.result.error ?? ''),
    'the model id rides in the log sentence (the renderer cannot name it)'
  )

  // The same sentence, but this question carried no image: whatever that 404 is
  // about, it is not this — and guessing would put a wrong diagnosis on screen.
  responder = noEndpoints
  const noImage = await run({
    provider: 'openrouter',
    req: { requestId: 2, system: 'S', messages: [{ role: 'user', text: 'Hei' }], document: DOC }
  })
  ok(noImage.result.code !== 'ai-model-no-images', 'a request without images is never diagnosed this way')

  // When the catalogue already says the model is text-only, the images are not
  // sent at all — the user gets the same named answer without a round trip.
  calls.length = 0
  responder = () => new Response('should not be called', { status: 500 })
  const known = await run({
    provider: 'openrouter',
    catalog: {
      openrouter: {
        fetchedAt: Date.now(),
        models: [{ id: 'anthropic/claude-sonnet-5', vision: false }]
      }
    }
  })
  ok(known.result.code === 'ai-model-no-images', `a known text-only model fails up front (got ${known.result.code})`)
  ok(calls.length === 0, 'and the images never leave the machine')

  // vision:true and vision-unknown both still go out — an unverified model gets
  // to try, and the rejection net above catches it if the provider says no.
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  const seeing = await run({
    provider: 'openrouter',
    catalog: {
      openrouter: { fetchedAt: Date.now(), models: [{ id: 'anthropic/claude-sonnet-5', vision: true }] }
    }
  })
  ok(seeing.result.ok === true, 'a vision model is sent as before')
  const unknown = await run({
    provider: 'openrouter',
    catalog: { openrouter: { fetchedAt: Date.now(), models: [{ id: 'other/model' }] } }
  })
  ok(unknown.result.ok === true, 'a model the catalogue says nothing about is still tried')
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

// ---------- first-class hosted services (fase 10.3) ----------

section('services: one key each, fixed base URL, shared Chat Completions path')
for (const [svc, info] of Object.entries(COMPAT_SERVICES)) {
  responder = () => chatCompletionsSse({
    deltas: ['Svar. [KILDE s.1: "Innledningen setter rammen"]'],
    usage: { prompt_tokens: 4, completion_tokens: 2 }
  })
  const { result } = await run({ provider: svc })
  const body = calls[0]?.body
  ok(
    calls[0]?.url === `${info.baseUrl}/chat/completions`,
    `${svc}: fixed base URL (got ${calls[0]?.url})`
  )
  ok(calls[0]?.headers.get('authorization') === 'Bearer sk-test', `${svc}: key as Bearer`)
  ok(/CITATION RULES/.test(body?.messages?.[0]?.content ?? ''), `${svc}: quote contract attached`)
  ok(body?.tools === undefined, `${svc}: no web-search tool`)
  const svcUser = body?.messages?.find((m) => Array.isArray(m.content))
  ok(svcUser?.content?.some((p) => p.type === 'image_url'), `${svc}: image as image_url part`)
  ok(result.ok === true, `${svc}: answers`)
  ok(
    (result.parts ?? []).flatMap((p) => p.citations).some((c) => c.kind === 'quote'),
    `${svc}: quote citation parsed`
  )
  observed[svc] = {
    quoteContract: /CITATION RULES/.test(body?.messages?.[0]?.content ?? ''),
    nativeCitations: false,
    webTool: (body?.tools ?? []).length > 0,
    images: svcUser?.content?.some((p) => p.type === 'image_url') === true
  }
}
{
  // Key present but no model picked yet: a named, one-click-fixable state
  const unchosen = await run({
    provider: 'openrouter',
    models: { anthropic: '', openai: '', azure: '', openrouter: '', gemini: '', xai: '', mistral: '', groq: '', compat: '', mock: '' }
  })
  ok(unchosen.result.code === 'ai-model-unchosen', `no model picked → ai-model-unchosen (got ${unchosen.result.code})`)

  // OpenRouter forwards OpenAI-style reasoning ids — the shared regex decides
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({
    provider: 'openrouter',
    models: { anthropic: '', openai: '', azure: '', openrouter: 'openai/gpt-5.2', gemini: '', xai: '', mistral: '', groq: '', compat: '', mock: '' }
  })
  ok(calls[0]?.body?.reasoning_effort === 'medium', 'vendor-prefixed reasoning id gets reasoning_effort')

  // grok-4.7 (curated), grok-4.6 and grok-4.5 (retired from the menu, kept in
  // the regex for stored selections) all document reasoning_effort (low/
  // medium/high/xhigh) — grok-4.3 stays out until someone verifies it (fewer
  // models that work beats more that might, 2026-08-12/13)
  const xaiModel = (id) => ({ anthropic: '', openai: '', azure: '', openrouter: '', gemini: '', xai: id, mistral: '', groq: '', compat: '', mock: '' })
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({ provider: 'xai', models: xaiModel('grok-4.7') })
  ok(calls[0]?.body?.reasoning_effort === 'medium', 'grok-4.7 gets reasoning_effort')
  // «Reasoning cannot be disabled» on 4.5–4.7 (xAI reasoning docs, 2026-09-26),
  // and gpt-oss on Groq takes low/medium/high only: «Av» is the lowest effort,
  // never a `none` neither documents
  await run({ provider: 'xai', models: xaiModel('grok-4.7'), thinking: 'off' })
  ok(calls[0]?.body?.reasoning_effort === 'low', `grok-4.7 off → low (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'groq', thinking: 'off' })
  ok(calls[0]?.body?.reasoning_effort === 'low', `gpt-oss off → low (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'xai', models: xaiModel('grok-4.6') })
  ok(calls[0]?.body?.reasoning_effort === 'medium', 'grok-4.6 (retired, still stored) gets reasoning_effort')
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({
    provider: 'xai',
    models: { anthropic: '', openai: '', azure: '', openrouter: '', gemini: '', xai: 'grok-4.5', mistral: '', groq: '', compat: '', mock: '' }
  })
  ok(calls[0]?.body?.reasoning_effort === 'medium', 'grok-4.5 (retired, still stored) gets reasoning_effort')
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({ provider: 'xai' })
  ok(calls[0]?.body?.reasoning_effort === undefined, 'grok-4.3 sends no reasoning_effort (unverified)')

  // Mistral documents exactly two reasoning_effort values, high and none
  // (docs.mistral.ai/capabilities/reasoning, 2026-10-05): every «on» level is
  // high, «Av» is none, and Mistral Large 3 — which documents neither — is
  // asked without the parameter
  const mistralModel = (id) => ({ anthropic: '', openai: '', azure: '', openrouter: '', gemini: '', xai: '', mistral: id, groq: '', compat: '', mock: '' })
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({ provider: 'mistral', models: mistralModel('mistral-medium-2604') })
  ok(calls[0]?.body?.reasoning_effort === 'high', `Mistral Medium 3.5 medium → high (got ${calls[0]?.body?.reasoning_effort})`)
  const noImage = { requestId: 3, system: 'S', messages: [{ role: 'user', text: 'Hva sier dokumentet?' }], document: DOC, webSearch: 'off' }
  await run({ provider: 'mistral', models: mistralModel('mistral-small-2603'), thinking: 'low', req: noImage })
  ok(calls[0]?.body?.reasoning_effort === 'high', `Mistral Small 4 low → high, the only «on» value (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'mistral', models: mistralModel('mistral-medium-latest'), thinking: 'off' })
  ok(calls[0]?.body?.reasoning_effort === 'none', `Mistral off → none (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'mistral', models: mistralModel('mistral-large-2512') })
  ok(calls[0]?.body?.reasoning_effort === undefined, 'Mistral Large 3 sends no reasoning_effort (undocumented)')
  // Small 4 goes blind under `high` (probed 2026-10-05: «Rød.» at none, «Jeg
  // kan ikke se bildet» at high) — an image in the request forces none on
  // THAT model only; Medium 3.5 reads images while reasoning. Small 4 is no
  // longer in the menu, but a stored or typed id keeps the rule
  responder = () => chatCompletionsSse({ deltas: ['ok'] })
  await run({ provider: 'mistral', models: mistralModel('mistral-small-2603') })
  ok(calls[0]?.body?.reasoning_effort === 'none', `Small 4 with an image → none (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'mistral', models: mistralModel('mistral-small-2603'), req: noImage })
  ok(calls[0]?.body?.reasoning_effort === 'high', `Small 4 without an image → high (got ${calls[0]?.body?.reasoning_effort})`)
  await run({ provider: 'mistral', models: mistralModel('mistral-medium-2604') })
  ok(calls[0]?.body?.reasoning_effort === 'high', `Medium 3.5 with an image → still high (got ${calls[0]?.body?.reasoning_effort})`)

  // With reasoning on, Mistral streams `delta.content` as CHUNKS — a
  // ThinkChunk while it reasons, then a TextChunk — before dropping back to
  // plain strings. Thinking is liveness, never answer text; before 2026-10-05
  // the parser concatenated the array and would have shown «[object Object]».
  responder = () =>
    sse(
      [
        { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Leser side 2 … ' }] }] } }] },
        { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'ferdig.' }] }, { type: 'text', text: 'Metoden ' }] } }] },
        { choices: [{ delta: { content: 'er enkel [KILDE s.2: "Metoden er enkel"].' } }] },
        { usage: { prompt_tokens: 9, completion_tokens: 4 } }
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    )
  let mistralAnswer = ''
  let mistralThinking = ''
  const chunked = await run({
    provider: 'mistral',
    models: mistralModel('mistral-medium-2604'),
    emit: (t, kind) => {
      if (kind === 'thinking') mistralThinking += t
      else mistralAnswer += t
    }
  })
  ok(chunked.result.ok === true, 'chunked Mistral stream answers')
  ok(mistralAnswer === 'Metoden er enkel [KILDE s.2: "Metoden er enkel"].', `text chunks and plain strings join into the answer (got "${mistralAnswer}")`)
  ok(mistralThinking === 'Leser side 2 … ferdig.', `thinking chunks reach the panel as liveness only (got "${mistralThinking}")`)
  ok(!/object Object/.test(mistralAnswer + JSON.stringify(chunked.result.parts ?? [])), 'no «[object Object]» anywhere in the answer')
  ok((chunked.result.parts ?? []).flatMap((p) => p.citations).some((c) => c.kind === 'quote' && c.pageNumber === 2), 'quote-contract citation survives the chunked stream')
}

// ---------- compat catalog fetcher (fase 10.2: Ollama enrichment) ----------

section('catalog: plain /v1 server vs Ollama enrichment')
{
  // A plain OpenAI-compatible server: no /api/tags, ids from /models
  calls.length = 0
  responder = (call) =>
    call.url.endsWith('/api/tags')
      ? new Response('not found', { status: 404 })
      : new Response(
          JSON.stringify({
            data: [
              { id: 'mixtral', name: 'Mixtral', context_length: 131072 },
              { id: 'gemma' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
  const plain = await fetchCompatModels('https://api.example.com/v1', 'sk-x')
  ok(
    plain.map((m) => m.id).join(',') === 'mixtral,gemma',
    `plain server lists from /models (got ${plain.map((m) => m.id).join(',')})`
  )
  ok(
    plain[0]?.contextTokens === 131072 && plain[0]?.displayName === 'Mixtral',
    'context_length + name from the listing survive (OpenRouter-style)'
  )
  ok(plain[1]?.contextTokens === undefined, 'no invented context data where the listing is silent')
  ok(
    calls.some((c) => c.url === 'https://api.example.com/v1/models' && c.headers.get('authorization') === 'Bearer sk-x'),
    'listing carries the key when one exists'
  )

  // An Ollama behind the URL: /api/tags lists, /api/show enriches
  calls.length = 0
  const SHOW = {
    'llama3.1:8b': {
      capabilities: ['completion', 'tools'],
      parameters: 'num_gpu 1\nnum_ctx 8192',
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }
    },
    'llava:13b': {
      capabilities: ['completion', 'vision'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 }
    },
    // The safety-critical case: a 128k-capable model with NO num_ctx set — the
    // server truncates silently at its default, so WE must assume the default
    'qwen3:32b': {
      capabilities: ['completion'],
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 131072 }
    }
  }
  responder = (call) => {
    if (call.url === 'http://localhost:11434/api/tags')
      return new Response(
        JSON.stringify({ models: Object.keys(SHOW).map((name) => ({ name })) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    if (call.url === 'http://localhost:11434/api/show')
      return new Response(JSON.stringify(SHOW[call.body?.model] ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    throw new Error('unexpected url ' + call.url)
  }
  const local = await fetchCompatModels('http://localhost:11434/v1')
  const byId = Object.fromEntries(local.map((m) => [m.id, m]))
  ok(local.length === 3, `Ollama lists from /api/tags (got ${local.length})`)
  ok(byId['llama3.1:8b']?.contextTokens === 8192, 'explicit num_ctx wins')
  ok(byId['llama3.1:8b']?.vision === false, 'no vision capability → vision false')
  ok(byId['llava:13b']?.vision === true, 'vision capability recognised')
  ok(byId['llava:13b']?.contextTokens === 4096, 'default capped by the architecture maximum')
  ok(
    byId['qwen3:32b']?.contextTokens === 4096,
    `no num_ctx → the server DEFAULT is assumed, never the architecture max (got ${byId['qwen3:32b']?.contextTokens})`
  )

  // A moved base URL refetches immediately — a fresh snapshot from another
  // endpoint must never satisfy this one
  const moved = await refreshCatalog(
    { compat: { fetchedAt: Date.now(), models: [{ id: 'old' }], baseUrl: 'http://other:9999/v1' } },
    { compat: { baseUrl: 'http://localhost:11434/v1' } },
    false
  )
  ok(moved.compat?.baseUrl === 'http://localhost:11434/v1', 'changed endpoint refetches despite fresh TTL')
  ok(moved.compat?.models.some((m) => m.id === 'llava:13b'), 'new endpoint\'s models replace the old list')

  ok(isLocalEndpoint('http://localhost:11434/v1') && isLocalEndpoint('http://127.0.0.1:1234/v1'), 'loopback hosts read as local')
  ok(!isLocalEndpoint('https://openrouter.ai/api/v1'), 'hosted endpoints do not')

  // TTL follows locality: a local list changes when the user pulls a model
  // (minutes), a hosted list keeps the ordinary daily cadence
  const tenMinAgo = Date.now() - 10 * 60 * 1000
  ok(
    !catalogStale({ compat: { fetchedAt: tenMinAgo, models: [{ id: 'x' }], baseUrl: 'https://openrouter.ai/api/v1' } }, 'compat'),
    'hosted compat snapshot keeps the daily TTL (10 min old = fresh)'
  )
  ok(
    catalogStale({ compat: { fetchedAt: tenMinAgo, models: [{ id: 'x' }], baseUrl: 'http://localhost:11434/v1' } }, 'compat'),
    'local compat snapshot goes stale in minutes (10 min old = stale)'
  )
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

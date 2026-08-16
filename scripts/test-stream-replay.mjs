// Replay every provider stream we have ever recorded, keylessly, in CI.
//
// The companion to test-live.mjs. That script asks the real providers and costs
// money; this one takes the bytes it captured and holds the parser to exactly
// what those bytes produced the day they were real — no keys, no network, no
// tokens, on every push.
//
// The distinction that makes this worth having: test-ai-chat.mjs proves the
// parser against streams we IMAGINED, and every AI bug that reached a user came
// from a stream nobody imagined. A recording cannot flatter our assumptions. It
// still has the chunk boundaries the provider chose, the keep-alives its proxy
// inserted, and the fields we did not know to look for — Kimi's `reasoning`
// went unread for exactly that reason.
//
// Adding one is a single paid run: `node scripts/test-live.mjs --record`.
// Run: node scripts/test-stream-replay.mjs
import { loadAiCore, loadRecordings, STREAM_DIR } from './lib/ai-core.mjs'

const { runProviderChat } = await loadAiCore()

let failures = 0
let checks = 0
const ok = (cond, msg) => {
  checks++
  if (!cond) {
    failures++
    console.error(`    ✗ ${msg}`)
  }
}

const recordings = loadRecordings()
if (recordings.length === 0) {
  // Not a pass: an empty library means the replay gate is protecting nothing,
  // and the self-check recordings are committed precisely so it never is.
  console.error(`No recordings in ${STREAM_DIR}`)
  console.error('Record the keyless set with: node scripts/test-live.mjs --self-check --record')
  process.exit(1)
}

const DOC = {
  title: 'Testdokument',
  text: '[Side 1] Innledningen setter rammen. [Side 2] Metoden er enkel. [Side 3] Papirgruppen brukte 12 prosent lengre tid.'
}

for (const rec of recordings) {
  const { provider, model } = rec.meta
  // Serve the recorded writes back exactly as they arrived. Re-joining them
  // into one body would quietly stop testing the buffering — and a frame the
  // provider cut down the middle of a JSON object is precisely the shape worth
  // keeping. (`body` is the pre-chunk-array fixture format.)
  const chunks = rec.chunks ?? [rec.body ?? '']
  console.log(`${rec.name}  (${provider} · ${model}, ${chunks.length} chunks)`)

  const real = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) if (c) controller.enqueue(enc.encode(c))
          controller.close()
        }
      }),
      {
        status: rec.http?.status ?? 200,
        headers: { 'content-type': rec.meta.contentType ?? 'text/event-stream' }
      }
    )

  const deltas = []
  try {
    const result = await runProviderChat({
      provider,
      key: 'replay',
      models: { [provider]: model },
      azure: { endpoint: 'https://replay.invalid', deployment: 'd', apiVersion: '' },
      compat: { baseUrl: 'https://replay.invalid/v1' },
      thinking: 'medium',
      catalog: {},
      req: {
        requestId: 1,
        system: 'S',
        messages: [{ role: 'user', text: 'Hvor mye lengre tid?' }],
        document: DOC,
        webSearch: 'off'
      },
      emit: (text, kind) => deltas.push([kind ?? 'text', text]),
      signal: new AbortController().signal
    })
    const want = rec.expect ?? {}
    if (want.ok) {
      ok('ok' in result, `still answers (got ${'ok' in result ? 'ok' : (result.code ?? result.error)})`)
      if ('ok' in result) {
        const text = (result.parts ?? []).map((p) => p.text).join('')
        if (want.text !== undefined) ok(text === want.text, `same text as when recorded (got "${text.slice(0, 60)}")`)
        if (want.citations !== undefined) {
          const n = (result.parts ?? []).flatMap((p) => p.citations).length
          ok(n === want.citations, `same citation count (${n}, recorded ${want.citations})`)
        }
      }
    } else {
      if (want.code !== undefined && want.code !== null)
        ok(result.code === want.code, `same named failure (${result.code ?? 'none'}, recorded ${want.code})`)
      else if (want.error !== undefined)
        ok(result.error === want.error, `same failure text (recorded "${want.error}")`)
    }
    if (want.thinking !== undefined)
      ok(
        deltas.some(([k]) => k === 'thinking') === want.thinking,
        `reasoning liveness ${want.thinking ? 'still' : 'still not'} reported`
      )
  } catch (err) {
    ok(false, `threw: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    globalThis.fetch = real
  }
}

console.log(
  failures === 0
    ? `\ntest-stream-replay: ${recordings.length} recording(s), ${checks} checks passed`
    : `\ntest-stream-replay: ${failures} of ${checks} checks FAILED`
)
process.exit(failures === 0 ? 0 : 1)

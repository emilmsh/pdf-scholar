// A local OpenAI-compatible endpoint that answers on purpose badly.
//
// The live conformance run (test-live.mjs) needs real API keys, so it cannot
// run in CI and does not run at all for a contributor without an account. This
// server gives the same harness something to talk to keylessly — and, more
// usefully, lets us aim shapes at the parser that no real provider can be asked
// to produce on demand: a JSON frame split down the middle of a chunk, a stream
// of keep-alive comments, a body that stops mid-answer, an error event on an
// HTTP 200.
//
// Every scenario below is a shape observed in the wild or one chunk boundary
// away from one. The model id selects the scenario, so the harness drives it
// exactly the way it drives a real provider: through the compat base URL.
import { createServer } from 'node:http'

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const content = (text) => frame({ choices: [{ delta: { content: text } }] })
const reasoning = (text) => frame({ choices: [{ delta: { reasoning: text } }] })
const DONE = 'data: [DONE]\n\n'

/** Each scenario is a list of chunks — the array boundaries ARE the TCP write
 *  boundaries, which is the point of writing them out by hand. */
export const SCENARIOS = {
  /** The everyday case, one frame per write */
  answer: {
    chunks: [
      content('Dokumentet slår an tonen tidlig. '),
      content('[KILDE s.1: "Innledningen setter rammen"]'),
      frame({ usage: { prompt_tokens: 42, completion_tokens: 12 } }),
      DONE
    ],
    expect: { ok: true, citations: 1 }
  },
  /** A reasoning model: minutes of thinking, then an answer (Kimi K2.5 shape) */
  reasoning: {
    chunks: [
      reasoning('Først må jeg lese side 1. '),
      frame({ choices: [{ delta: { reasoning_content: 'Så vurderer jeg spørsmålet.' } }] }),
      content('Kort svar. [KILDE s.2: "Metoden er enkel"]'),
      DONE
    ],
    expect: { ok: true, citations: 1, thinking: true }
  },
  /** One JSON object arriving as two TCP writes. The parser buffers by line, so
   *  a frame cut mid-object must not be parsed, dropped or double-counted. */
  'split-json': {
    chunks: [
      'data: {"choices":[{"delta":{"content":"Halve ',
      'frasen kom i to biter."}}]}\n\n',
      DONE
    ],
    expect: { ok: true, text: 'Halve frasen kom i to biter.' }
  },
  /** Comment keep-alives (`: ping`) and blank lines between real frames —
   *  what a proxy sends to hold an idle connection open. */
  keepalive: {
    chunks: [': ping\n\n', '\n', content('Svar etter stillhet.'), ': ping\n\n', DONE],
    expect: { ok: true, text: 'Svar etter stillhet.' }
  },
  /** The connection dies mid-answer: no [DONE], no usage. Whatever arrived is
   *  a real partial answer and must not be thrown away. */
  truncated: {
    chunks: [content('Svaret begynte, men '), content('så stoppet')],
    expect: { ok: true, text: 'Svaret begynte, men så stoppet' }
  },
  /** HTTP 200, then the upstream provider fails (OpenRouter's shape) */
  'upstream-error': {
    chunks: [frame({ error: { message: 'Upstream provider error' } }), DONE],
    expect: { error: 'Upstream provider error' }
  },
  /** A stream that reasons and then simply ends — the Kimi hang. Not an empty
   *  success: the app owes the reader a named failure. */
  'reasoning-only': {
    chunks: [reasoning('Tenker … '), reasoning('tenker fortsatt …'), DONE],
    expect: { code: 'ai-stream-aborted', thinking: true }
  },
  /** An account with nothing to spend. Comes back as a 402 here; the live run
   *  of 2026-08-18 met the same state as xAI's 403 "your team doesn't have any
   *  credits" and OpenAI's 429 insufficient_quota. Three statuses, one remedy,
   *  and none of them a bug in the app — which is why the suite skips a model
   *  in this state rather than failing it. */
  'no-credit': {
    status: 402,
    body: JSON.stringify({ error: { message: 'Insufficient credits on this account.' } }),
    contentType: 'application/json',
    expect: { code: 'ai-no-credit' }
  },
  /** A long think before a short answer — the shape that makes a UI look hung.
   *  Eight reasoning frames means a caller that spaces its writes out (see
   *  `delayMs`) can hold the answer past any wait-hint threshold it wants to
   *  test, without this scenario being slow when nobody asks it to be.
   *  The marker in the reasoning text is deliberately unmistakable: a test
   *  asserts it never reaches the answer. */
  'long-reasoning': {
    chunks: [
      ...Array.from({ length: 8 }, (_, i) => reasoning(`INTERNAL-THOUGHT-${i} `)),
      content('Kort svar til slutt.'),
      DONE
    ],
    expect: { ok: true, text: 'Kort svar til slutt.', thinking: true }
  },

  /** A server that ignores `stream: true` and answers with one JSON body */
  'non-streaming': {
    body: JSON.stringify({
      model: 'self/non-streaming',
      choices: [{ message: { role: 'assistant', content: 'Alt i ett svar.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    }),
    contentType: 'application/json',
    expect: { ok: true, text: 'Alt i ett svar.' }
  }
}

/**
 * Start the fake endpoint. Returns { baseUrl, close }.
 *
 * `delayMs` spaces the chunks out so the stream is genuinely incremental (the
 * harness measures time-to-first-delta, which is meaningless if the whole body
 * lands in one packet).
 */
export async function startFakeProvider({ delayMs = 5 } = {}) {
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const url = req.url ?? ''
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: Object.keys(SCENARIOS).map((id) => ({
            id: `self/${id}`,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
          }))
        })
      )
      return
    }
    const model = (() => {
      try {
        return JSON.parse(raw).model ?? ''
      } catch {
        return ''
      }
    })()
    const scenario = SCENARIOS[String(model).replace(/^self\//, '')]
    if (!scenario) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `No such scenario: ${model}` } }))
      return
    }
    if (scenario.body) {
      res.writeHead(200, { 'content-type': scenario.contentType ?? 'application/json' })
      res.end(scenario.body)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const chunk of scenario.chunks) {
      res.write(chunk)
      await new Promise((r) => setTimeout(r, delayMs))
    }
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((r) => server.close(r))
  }
}

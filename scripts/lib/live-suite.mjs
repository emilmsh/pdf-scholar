// The conformance suite that asks the REAL providers, with real keys and real
// money. Two entry points drive it, and the difference between them is only
// where the keys come from:
//
//   scripts/test-live.mjs        keys from the environment, plain Node
//   scripts/live-in-electron.mjs keys from the app's own encrypted store,
//                                decrypted by safeStorage inside Electron
//
// The suite itself never reads a key from anywhere: it is handed a map, and it
// never prints one. That is the whole reason it lives in its own module.
//
// Why this exists: test-ai-chat.mjs proves the parser against streams WE
// imagined. Every AI bug that has actually reached Emil came from a stream we
// had not imagined — Kimi K2.5 spending minutes in a `reasoning` field nothing
// read, Gemini labelling citations with the document's filename, OpenRouter
// reporting an upstream failure inside an HTTP 200. A mocked suite cannot find
// those, because the mock is written from the same assumptions as the code.
// This one asks the providers.
//
// It is NOT part of CI: it needs keys, it costs tokens (a few øre a run), and
// a provider outage is not a broken build. It is a release gate you run by
// hand — docs/RELEASE.md — and the monthly pass (docs/MAINTENANCE.md row 1).
//
// Run it through the CLI: `npm run test:live` (see scripts/test-live.mjs).
//
// --record writes the raw bytes to scripts/fixtures/streams/, where
// test-stream-replay.mjs (which DOES run in CI) replays them keylessly forever
// after. That is the point of the whole exercise: one paid run turns a live
// discovery into a permanent regression test.
import { curatedIds, instrumentFetch, loadAiCore, saveRecording } from './ai-core.mjs'
import { startFakeProvider, SCENARIOS } from './fake-provider.mjs'
import { encodePng } from './tiny-png.mjs'

/** The providers this suite knows how to ask, and the environment variable each
 *  one's key arrives in when the plain-Node entry point is used. Also the order
 *  the run reports in. */
export const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY'
}

/**
 * Run the conformance suite.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.keys   provider id -> API key. Never read
 *   from the environment here and never printed: whoever obtained them decides
 *   how, and this module only spends them.
 * @param {string[]} opts.args                CLI flags (--record, --provider=, …)
 * @returns {Promise<{failures:number, checks:number}>}
 */
export async function runLiveSuite({ keys = {}, args = [] } = {}) {
  const flag = (name) => args.includes(`--${name}`)
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

  const RECORD = flag('record')
  const SELF_CHECK = flag('self-check')
  const ONLY_PROVIDER = value('provider')
  const ONLY_MODEL = value('model')
  /** A reasoning model can legitimately think for a long time before its first
   *  token; this is the point past which the app would be reported as hung. */
  const DEADLINE_MS = Number(value('deadline') ?? 120_000)

  const { runProviderChat, PROVIDER_PROFILES } = await loadAiCore()
  const keyFor = (provider) => keys[provider] ?? ''

  let failures = 0
  let checks = 0
  let skipped = 0
  const ok = (cond, msg) => {
    checks++
    if (cond) console.log(`    ✓ ${msg}`)
    else {
      failures++
      console.error(`    ✗ ${msg}`)
    }
  }

  // ---------- the question we ask ----------
  //
  // Short on purpose: every provider is asked the same thing, the answer is
  // cheap, and the document is small enough that a citation is unambiguous.
  const DOC = {
    title: 'Testdokument',
    text: [
      '[Side 1] Innledningen setter rammen: studien måler lesehastighet i to grupper.',
      '[Side 2] Metoden er enkel: deltakerne leste den samme artikkelen på skjerm og på papir.',
      '[Side 3] Resultatet var at papirgruppen brukte 12 prosent lengre tid.'
    ].join('\n')
  }
  const QUESTION = 'Hvor mye lengre tid brukte papirgruppen? Svar kort og siter siden.'
  const SYSTEM =
    'Du er en forskningsassistent som svarer kort (1–2 setninger) om et vedlagt dokument. ' +
    'Siter alltid passasjen du bygger svaret på.'
  // A solid red square. It was 2×2 until the live run of 2026-08-18, where three
  // OpenAI models called it orange or turquoise and Haiku said it saw no image
  // at all — every provider resizes what it is sent, and there is nothing left
  // of a 2×2 after that. 64×64 is still a rounding error in tokens and
  // impossible to misread.
  const RED_PNG = Buffer.from(encodePng(64, 64, () => [220, 30, 30, 255])).toString('base64')

  /** Provider or account states that say nothing about whether the APP works:
   *  no credit, an exhausted quota, a model saturated right now. The app naming
   *  them correctly IS the pass — counting them as failures would make a run's
   *  score depend on someone's billing page. */
  const NOT_OUR_FAULT = new Set(['ai-no-credit', 'ai-rate-limited', 'ai-model-overloaded'])

  function baseParams(provider, model, req, emit, signal, compatBaseUrl) {
    return {
      provider,
      key: keyFor(provider),
      models: { [provider]: model },
      azure: { endpoint: '', deployment: '', apiVersion: '' },
      compat: { baseUrl: compatBaseUrl ?? '' },
      thinking: 'medium',
      catalog: {},
      req,
      emit,
      signal
    }
  }

  /**
   * One request, fully instrumented.
   *
   * Returns what the app would have shown AND what it cost to get there: how many
   * HTTP requests it really took (more than one means the degrade-on-400 net
   * fired), how long until the first sign of life, and the raw stream.
   */
  async function ask({ provider, model, req, compatBaseUrl }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    const deltas = []
    let firstDeltaMs = null
    const started = Date.now()
    const emit = (text, kind) => {
      firstDeltaMs ??= Date.now() - started
      deltas.push([kind ?? 'text', text])
    }
    const { calls, restore } = instrumentFetch()
    try {
      const result = await runProviderChat(
        baseParams(provider, model, req, emit, controller.signal, compatBaseUrl)
      )
      return {
        result,
        calls,
        deltas,
        firstDeltaMs,
        elapsedMs: Date.now() - started,
        thinking: deltas.some(([k]) => k === 'thinking')
      }
    } finally {
      clearTimeout(timer)
      restore()
    }
  }

  const answerText = (result) =>
    'ok' in result ? (result.parts ?? []).map((p) => p.text).join('') : ''
  const citationsOf = (result) =>
    'ok' in result ? (result.parts ?? []).flatMap((p) => p.citations) : []

  /** Store what actually happened, so CI can hold the parser to it forever. */
  function record(name, provider, model, run, note) {
    if (!RECORD) return
    const streamed = run.calls.find((c) => c.body)
    if (!streamed) return
    const result = run.result
    const fixture = {
      meta: {
        provider,
        model,
        source: 'recorded',
        recordedAt: new Date().toISOString().slice(0, 10),
        note: note ?? ''
      },
      http: { status: streamed.status },
      // Verbatim, with the provider's own write boundaries preserved
      chunks: streamed.chunks,
      // The expectation is the OBSERVED behaviour, not an ideal: this fixture
      // exists to catch a future parser change silently altering it.
      expect:
        'ok' in result
          ? { ok: true, text: answerText(result), citations: citationsOf(result).length, thinking: run.thinking }
          : { code: result.code ?? null, error: result.error, thinking: run.thinking }
    }
    const file = saveRecording(name, fixture)
    console.log(`    ⤓ recorded ${file.split(/[\\/]/).pop()} (${streamed.chunks.length} chunks)`)
  }

  // ---------- the case suite, run per provider × model ----------

  async function runModel(provider, model, compatBaseUrl) {
    const label = `${provider} · ${model}`
    console.log(`\n${label}`)
    const profile = PROVIDER_PROFILES[provider]

    // 1. It answers at all, in time, grounded, without the degrade net firing.
    const run = await ask({
      provider,
      model,
      compatBaseUrl,
      req: {
        requestId: 1,
        system: SYSTEM,
        messages: [{ role: 'user', text: QUESTION }],
        document: DOC,
        webSearch: 'off'
      }
    })
    const text = answerText(run.result)
    if ('error' in run.result && NOT_OUR_FAULT.has(run.result.code)) {
      // Named correctly, and the rest of the suite has nothing left to measure:
      // the provider never got as far as answering. Say so and move on.
      skipped++
      const why = String(run.result.error).replace(/\s+/g, ' ').slice(0, 90)
      console.log(`    ⊘ skipped — ${run.result.code}: ${why}`)
      return
    }
    if ('error' in run.result) {
      ok(false, `answered (got ${run.result.code ?? 'error'}: ${String(run.result.error).slice(0, 120)})`)
    } else {
      ok(text.trim().length > 0, `answered in ${(run.elapsedMs / 1000).toFixed(1)}s`)
      // The whole point of the panel: an answer you can jump into the PDF from.
      const cits = citationsOf(run.result)
      ok(
        cits.length > 0,
        `citation survived into the answer (${cits.length}× ${cits[0]?.kind ?? 'none'}, expected ${profile.citations})`
      )
      // 12 percent is the one fact in the document; a model that misses it is
      // not reading what we attached.
      ok(/12/.test(text), 'the answer used the attached document')
    }
    // A second POST for one question means a parameter we sent was refused and
    // silently dropped — the user keeps working, but with a degraded request.
    const posts = run.calls.filter((c) => !c.url.endsWith('/models')).length
    ok(posts === 1, `no degrade retry (${posts} request${posts === 1 ? '' : 's'})`)
    // Liveness: the panel shows «Leser dokumentet …» until the first delta of
    // any kind. Long is fine; silent is not.
    ok(
      run.firstDeltaMs !== null && run.firstDeltaMs < DEADLINE_MS,
      `first sign of life after ${run.firstDeltaMs === null ? 'never' : (run.firstDeltaMs / 1000).toFixed(1) + 's'}${run.thinking ? ' (thinking)' : ''}`
    )
    record(`${provider}-${model.replace(/[^a-z0-9.]+/gi, '-')}-answer`, provider, model, run)

    // 2. An image is either read or refused BY NAME. Silence, a raw 400 or a
    // confident answer about a picture the model never saw are all failures.
    const img = await ask({
      provider,
      model,
      compatBaseUrl,
      req: {
        requestId: 2,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            text: 'Hvilken farge har bildet? Svar med ett ord.',
            images: [{ mediaType: 'image/png', dataBase64: RED_PNG }]
          }
        ],
        document: null,
        webSearch: 'off'
      }
    })
    if ('error' in img.result) {
      ok(
        img.result.code === 'ai-model-no-images',
        `image refused by name (got ${img.result.code ?? 'unnamed'}: ${String(img.result.error).slice(0, 100)})`
      )
    } else {
      const seen = answerText(img.result)
      ok(seen.trim().length > 0, 'image answered')
      if (profile.vision) ok(/rød|red/i.test(seen), `the model saw the image (said "${seen.trim().slice(0, 40)}")`)
    }
    record(`${provider}-${model.replace(/[^a-z0-9.]+/gi, '-')}-image`, provider, model, img)
  }

  // ---------- self-check: the same harness, no keys ----------

  async function selfCheck() {
    console.log('self-check — local fake endpoint, no keys, no tokens spent\n')
    const fake = await startFakeProvider()
    try {
      for (const [name, scenario] of Object.entries(SCENARIOS)) {
        console.log(`self/${name}`)
        const run = await ask({
          provider: 'compat',
          model: `self/${name}`,
          compatBaseUrl: fake.baseUrl,
          req: {
            requestId: 1,
            system: SYSTEM,
            messages: [{ role: 'user', text: QUESTION }],
            document: DOC,
            webSearch: 'off'
          }
        })
        const want = scenario.expect
        const result = run.result
        if (want.ok) {
          ok('ok' in result, `answers (got ${'ok' in result ? 'ok' : result.code ?? result.error})`)
          if (want.text !== undefined) {
            const got = answerText(result)
            ok(got === want.text, `text survives chunking exactly (got "${got}")`)
          }
          if (want.citations !== undefined)
            ok(citationsOf(result).length === want.citations, `${want.citations} citation(s) parsed`)
        } else if (want.code) {
          ok(result.code === want.code, `named ${want.code} (got ${result.code ?? result.error})`)
        } else if (want.error) {
          ok(result.error === want.error, `surfaced "${want.error}" (got ${result.error})`)
        }
        if (want.thinking) ok(run.thinking, 'reasoning reached the panel as liveness')
        record(`self-${name}`, 'compat', `self/${name}`, run, 'fake endpoint (scripts/lib/fake-provider.mjs)')
      }
    } finally {
      await fake.close()
    }
  }

    // ---------- go ----------

    if (SELF_CHECK) {
      await selfCheck()
    } else {
      const providers = Object.keys(KEY_ENV).filter(
        (p) => (!ONLY_PROVIDER || p === ONLY_PROVIDER) && keyFor(p)
      )
      const noKeys = Object.keys(KEY_ENV).filter((p) => !keyFor(p))
      // Nothing to ask: the caller decides what to say about it, because the
      // remedy depends on where it was looking for keys.
      if (providers.length === 0) return { failures: 0, checks: 0, noKeys: true }
      console.log(`Live conformance run — ${providers.join(', ')}`)
      if (noKeys.length) console.log(`skipped (no key): ${noKeys.join(', ')}`)
      for (const provider of providers) {
        // OpenRouter has no curated list: its menu is live, so name the model to
        // test with --model. Everyone else is asked about every model we OFFER.
        const models = (ONLY_MODEL ? [ONLY_MODEL] : curatedIds(provider)).filter(Boolean)
        if (models.length === 0) {
          console.log(`\n${provider}: no curated models — pass --model=<id> to test one`)
          continue
        }
        for (const model of models) await runModel(provider, model)
      }
    }

    const tail = skipped ? ` (${skipped} model(s) skipped: provider or account state)` : ''
    console.log(
      failures === 0
        ? `\ntest-live: ${checks} checks passed${tail}`
        : `\ntest-live: ${failures} of ${checks} checks FAILED${tail}`
    )
    return { failures, checks, skipped }
}

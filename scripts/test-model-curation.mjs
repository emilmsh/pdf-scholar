// The selection rule for live model lists — src/shared/ai-model-catalog.ts.
//
// OpenRouter listed 409 models on 2026-08-13 and every one of them was a menu
// row: image generators (Nano Banana answers with pictures), `:batch` twins of
// an id already listed, and generations nobody should start a conversation on.
// curateRemoteModels is what turns that into a menu, so both directions matter.
// Too eager and it empties a local LM Studio that simply does not describe its
// models, or hides the only model a vendor offers; too timid and the menu goes
// back to being a 409-row scroll. The gates below are the ones that decide it.
//
// Also pins the FIELD NAMES the whole rule reads: OpenRouter's
// architecture.input_modalities / output_modalities / created. Those come from
// someone else's API — if a rename slips past, everything downstream silently
// treats "unknown" as "keep" and the menu quietly fills up again.
// Run: node scripts/test-model-curation.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/ai-model-catalog.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'model-curation-'))
const out = join(dir, 'ai-model-catalog.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const { curateRemoteModels, fetchCompatModels, CURATE_PER_VENDOR, CURATE_MIN_LIST } = await import(
  pathToFileURL(out).href
)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${got}\n      want ${want}`)
  }
}

// A fixed clock: the age rule must be reproducible, not "whenever CI ran".
const NOW = Date.UTC(2026, 7, 13)
const AGO = (days) => NOW / 1000 - days * 24 * 60 * 60
/** A chat model as OpenRouter describes one: takes images, answers in text */
const chat = (id, days = 30) => ({ id, vision: true, emitsNonText: false, createdAt: AGO(days) })
/** Pad a list past CURATE_MIN_LIST so the short-list gate is not what passes it */
const padded = (models, n = CURATE_MIN_LIST + 1) => {
  const out = [...models]
  for (let i = out.length; i < n; i++) out.push(chat(`filler/model-${i}`))
  return out
}
const ids = (list) => list.map((m) => m.id).join(', ')

// --- The two gates: when the rule must not fire at all ------------------------
// Both protect endpoints that are not OpenRouter. A menu that empties itself is
// worse than a menu that is long — the user cannot even pick what they had.
console.log('gates')
{
  const short = [chat('openai/a'), { id: 'plain-text-model' }]
  eq(curateRemoteModels(short, NOW).length, 2, 'a short list is never touched')

  // An LM Studio / vLLM lists ids and nothing else. Judging those by modality
  // would delete every one of them.
  const silent = padded([], 40).map((m) => ({ id: m.id }))
  eq(curateRemoteModels(silent, NOW).length, 40, 'a list that describes nothing passes through')

  // Half-described is still not enough to judge the silent half by.
  const half = padded([], 40).map((m, i) => (i % 3 === 0 ? m : { id: m.id }))
  eq(curateRemoteModels(half, NOW).length, 40, 'a mostly-silent list passes through')

  // A described list where nothing qualifies — an Ollama full of text-only
  // models, say. An empty menu cannot even be used to re-pick the model the
  // user already had, so the rule stands down instead.
  const noneQualify = padded([], 40).map((m) => ({ ...m, vision: false }))
  eq(curateRemoteModels(noneQualify, NOW).length, 40, 'a selection of nothing returns everything')

  // Ollama names a pull `llama3.1:8b`; the tag IS the model, not a variant of
  // `llama3.1`. Only vendor-namespaced ids are treated as base+suffix.
  const tagged = padded([
    { id: 'llama3.1', vision: true, emitsNonText: false },
    { id: 'llama3.1:8b', vision: true, emitsNonText: false }
  ])
  const keptTags = new Set(curateRemoteModels(tagged, NOW).map((m) => m.id))
  eq(keptTags.has('llama3.1:8b'), true, 'an Ollama tag is not a duplicate of its base name')
}

// --- What the selection drops -------------------------------------------------
console.log('what is left out')
{
  const list = padded([
    chat('google/gemini-3.6-flash'),
    // Nano Banana: it is a chat completion endpoint like any other, and it
    // answers with pictures. This is the case that started the rule.
    { id: 'google/gemini-3-pro-image', vision: true, emitsNonText: true, createdAt: AGO(10) },
    // Lyria answers with AUDIO (`text+image->text+audio`) and survived the
    // first cut of this rule, which only knew how to reject pictures — the
    // requirement is text and nothing else out, not "no images"
    { id: 'google/lyria-3-pro-preview', vision: true, emitsNonText: true, createdAt: AGO(10) },
    // Text-only models cannot see a pasted figure — the composer offers images
    // on every provider, so the menu must not offer a model that ignores them.
    { id: 'deepseek/deepseek-r1', vision: false, emitsNonText: false, createdAt: AGO(10) },
    // The same model twice: `:batch` alongside its base id
    { id: 'openai/gpt-5.6-luna', vision: true, emitsNonText: false, createdAt: AGO(10) },
    { id: 'openai/gpt-5.6-luna:batch', vision: true, emitsNonText: false, createdAt: AGO(10) },
    // …but a suffix whose base is NOT listed is a real, and sometimes the only,
    // way to reach that model
    { id: 'z-ai/glm-5:free', vision: true, emitsNonText: false, createdAt: AGO(10) },
    // OpenRouter's routing aliases mirror ids that are listed properly
    { id: '~anthropic/claude-sonnet-5', vision: true, emitsNonText: false, createdAt: AGO(10) },
    // Current generation only — the same rule the curated lists follow
    chat('mistralai/mistral-medium-2', 800),
    // …and a model with no date keeps the benefit of the doubt
    { id: 'moonshotai/kimi-k3', vision: true, emitsNonText: false }
  ])
  const kept = new Set(curateRemoteModels(list, NOW).map((m) => m.id))
  eq(kept.has('google/gemini-3.6-flash'), true, 'a current multimodal chat model stays')
  eq(kept.has('google/gemini-3-pro-image'), false, 'an image generator is dropped')
  eq(kept.has('google/lyria-3-pro-preview'), false, 'a music generator is dropped too')
  eq(kept.has('deepseek/deepseek-r1'), false, 'a text-only model is dropped')
  eq(kept.has('openai/gpt-5.6-luna'), true, 'the base id stays')
  eq(kept.has('openai/gpt-5.6-luna:batch'), false, 'its :batch twin is dropped')
  eq(kept.has('z-ai/glm-5:free'), true, 'a :suffix with no base id survives')
  eq(kept.has('~anthropic/claude-sonnet-5'), false, 'a ~vendor routing alias is dropped')
  eq(kept.has('mistralai/mistral-medium-2'), false, 'a model over a year old is dropped')
  eq(kept.has('moonshotai/kimi-k3'), true, 'an undated model is kept')
}

// --- The per-vendor cap -------------------------------------------------------
// The rule that actually shortens the menu: OpenAI alone contributed 40 entries
// to that 409-model list.
console.log('per-vendor cap')
{
  const many = []
  for (let i = 0; i < 12; i++) many.push(chat(`openai/model-${i}`, 12 - i))
  for (let i = 0; i < 3; i++) many.push(chat(`x-ai/grok-${i}`, 5))
  const kept = curateRemoteModels(padded(many, 40), NOW)
  const openai = kept.filter((m) => m.id.startsWith('openai/'))
  eq(openai.length, CURATE_PER_VENDOR, `at most ${CURATE_PER_VENDOR} from one vendor`)
  // Newest first: model-11 is a day old, model-0 twelve days
  eq(openai[0].id, 'openai/model-11', 'the newest survives the cap')
  eq(
    openai.some((m) => m.id === 'openai/model-0'),
    false,
    'the oldest is the one cut'
  )
  eq(kept.filter((m) => m.id.startsWith('x-ai/')).length, 3, 'a vendor under the cap keeps all')
  // Same input, same output — a menu that reshuffles between renders is a bug
  eq(ids(curateRemoteModels(padded(many, 40), NOW)), ids(kept), 'the order is stable')
}

// --- The order the menu reads them in -----------------------------------------
// Two orders, two questions: which models survive is about generation, how they
// are then listed is about strength. Getting these the same way round is the
// whole point — sorting the CAP by price would hand a new cheap model's slot to
// last year's flagship.
console.log('ranking')
{
  const priced = (id, price, days) => ({ ...chat(id, days), outputPrice: price })
  const list = padded([
    // One generation, listed cheapest-first on purpose: within a generation the
    // vendor's own prices are the ranking (Sol above Terra above Luna)
    priced('openai/gpt-5.6-luna', 0.6, 38),
    priced('openai/gpt-5.6-terra', 6, 38),
    priced('openai/gpt-5.6-sol', 30, 38),
    // An id with no version we trust: "probably the latest" is not a reason to
    // promote a model, so it sorts after the ones we could read
    priced('openai/gpt-chat-latest', 30, 103),
    // The case that prompted the rule: last year's flagship still carries last
    // year's flagship price ($150 against Fable 5's $50). Generation decides.
    priced('anthropic/claude-opus-4.7-fast', 150, 96),
    priced('anthropic/claude-sonnet-5', 10, 47),
    priced('anthropic/claude-fable-5', 50, 68),
    priced('anthropic/claude-opus-5', 25, 23),
    // A different family from the same vendor: Gemma 4's bigger number must not
    // outrank Gemini 3.7 — families age separately
    priced('google/gemini-3.7-flash', 1.875, 3),
    priced('google/gemma-4-31b-it', 0.34, 136),
    // A parameter count sitting where a version would (120b is not generation
    // 120), so this one has no readable generation at all
    priced('openai/gpt-oss-120b', 0.5, 40),
    priced('qwen/qwen3.8-max', 6, 13),
    priced('z-ai/glm-5', 1, 10),
    priced('sakana/one-1', 1, 10)
  ])
  const kept = curateRemoteModels(list, NOW)
  const of = (v) => kept.filter((m) => m.id.startsWith(v + '/')).map((m) => m.id)
  eq(
    of('openai').join(' '),
    'openai/gpt-5.6-sol openai/gpt-5.6-terra openai/gpt-5.6-luna openai/gpt-chat-latest openai/gpt-oss-120b',
    'within one generation price ranks, and an unreadable version sorts last'
  )
  eq(
    of('anthropic').join(' '),
    // Fable leads Opus 5 on price INSIDE generation 5, which is right — that is
    // the order the curated Anthropic list is written in by hand too
    'anthropic/claude-fable-5 anthropic/claude-opus-5 anthropic/claude-sonnet-5 anthropic/claude-opus-4.7-fast',
    'generation beats price: last year’s flagship sinks despite costing the most'
  )
  eq(
    of('google').join(' '),
    'google/gemini-3.7-flash google/gemma-4-31b-it',
    'a newer family outranks an older one whatever its version number says'
  )

  // Vendor order is our ranked guess at what people reach for, not the alphabet
  const vendors = [...new Set(kept.map((m) => m.id.split('/')[0]))].filter((v) =>
    ['openai', 'anthropic', 'qwen', 'z-ai', 'sakana', 'filler'].includes(v)
  )
  eq(vendors[0], 'openai', 'the biggest API vendor leads')
  eq(vendors[1], 'anthropic', 'then the next')
  eq(vendors.indexOf('qwen') < vendors.indexOf('z-ai'), true, 'ranked vendors beat unranked ones')
  eq(
    vendors.indexOf('filler') < vendors.indexOf('sakana'),
    true,
    'and unranked vendors fall in alphabetically among themselves'
  )

  // The cap still selects by generation: an old flagship does not keep a slot
  // just because it was expensive.
  const many = []
  for (let i = 0; i < 10; i++) many.push(priced(`openai/new-${i}`, 1, 10 + i))
  many.push(priced('openai/legacy-flagship', 900, 300))
  const capped = curateRemoteModels(padded(many, 40), NOW).filter((m) => m.id.startsWith('openai/'))
  eq(capped.length, CURATE_PER_VENDOR, 'the cap still holds')
  eq(
    capped.some((m) => m.id === 'openai/legacy-flagship'),
    false,
    'the cap is by generation, not by price'
  )

  // A list with no prices at all (a local server) keeps the newest-first order
  const unpriced = curateRemoteModels(
    padded([chat('vendor/old', 100), chat('vendor/new', 1)]),
    NOW
  ).filter((m) => m.id.startsWith('vendor/'))
  eq(unpriced.map((m) => m.id).join(' '), 'vendor/new vendor/old', 'no prices → newest first')
}

// --- The listing fields the rule reads ---------------------------------------
// Everything above is only true if fetchCompatModels actually gets these three
// facts out of the provider's JSON.
console.log('parsing the provider listing')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) throw new Error('not an ollama')
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'google/gemini-3.6-flash',
            name: 'Google: Gemini 3.6 Flash',
            created: 1771200000,
            context_length: 1048576,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { completion: '0.00000375' }
          },
          {
            id: 'google/gemini-3-pro-image',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['image', 'text']
            }
          },
          {
            id: 'google/lyria-3-pro-preview',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text', 'audio']
            }
          },
          // A server that says nothing about modalities must come back unknown
          // (undefined), never as false — false would mean "cannot", and the
          // gates above count on being able to tell those apart.
          { id: 'local-model' }
        ]
      })
    }
  }
  try {
    const models = await fetchCompatModels('https://openrouter.ai/api/v1', 'k')
    const [flash, image, audio, plain] = models
    eq(flash.vision, true, 'input_modalities image → vision')
    eq(flash.emitsNonText, false, 'output_modalities text alone → answers in text')
    eq(flash.createdAt, 1771200000, 'created is carried through')
    // Quoted per token, carried per million — the sort compares these to each
    // other, but anyone reading one expects the unit prices are published in
    eq(flash.outputPrice, 3.75, 'pricing.completion → USD per million output tokens')
    eq(plain.outputPrice, undefined, 'no pricing block → unknown, not free')
    eq(flash.contextTokens, 1048576, 'context_length still parsed')
    eq(flash.displayName, 'Google: Gemini 3.6 Flash', 'name still parsed')
    eq(image.emitsNonText, true, 'output_modalities image → not a text answer')
    eq(audio.emitsNonText, true, 'output_modalities audio → not a text answer either')
    eq(plain.vision, undefined, 'no architecture block → vision unknown, not false')
    eq(plain.emitsNonText, undefined, 'no architecture block → output unknown, not false')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

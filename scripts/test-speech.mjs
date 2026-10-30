// Read-aloud with a provider's voice — the two pure halves, keyless:
//
//   - src/shared/speech-text.ts: what is SPOKEN (citation brackets, line-break
//     hyphens and addresses out; «[see 5]» and «well-known» kept), where reading
//     stops (the reference list's heading), sentence offsets that still address
//     the page text the highlight resolves, and the chunks a voice is asked for
//     (never across a page, every sentence in exactly one, the highlight moving
//     through a chunk by its sentences' share of the characters).
//   - src/shared/ai-speech.ts against a mocked fetch: the Gemini Interactions
//     request (endpoint, key header, model, voice, the reading style), the WAV
//     read back out of the model_output step, and the failures named the way the
//     assistant names them (a rate limit, no answer at all, no audio).
// Run: node scripts/test-speech.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'speech-'))
async function load(name) {
  const src = fileURLToPath(new URL(`../src/shared/${name}.ts`, import.meta.url))
  const out = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [src],
    outfile: out,
    format: 'esm',
    bundle: true,
    platform: 'node',
    packages: 'external',
    logLevel: 'silent'
  })
  return import(pathToFileURL(out).href)
}
const { buildSentences, chunkSentences, referencesStart, sentenceAt, speakable } = await load('speech-text')
const { runProviderSpeech, geminiSpeechBody, audioFromInteraction } = await load('ai-speech')
const { GEMINI_READING_VOICES, GEMINI_TTS_MODEL } = await load('ai-voices')

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}
const ok = (cond, msg) => eq(!!cond, true, msg)

console.log('what is spoken')
eq(speakable('as shown in [12].'), 'as shown in.', 'a numeric citation goes, the full stop stays put')
eq(speakable('prior work [3, 5–9] and [1-4] agree'), 'prior work and agree', 'lists and ranges go')
eq(speakable('as noted [see 5] and [sic]'), 'as noted [see 5] and [sic]', 'a bracket with words is the author’s')
eq(speakable('the infor-\nmation set'), 'the information set', 'a line-break hyphen is joined')
eq(speakable('a well-known COVID-\n19 result'), 'a well-known COVID-\n19 result'.replace(/\s+/g, ' '), 'a hyphen before a digit or mid-line stays')
eq(speakable('see https://doi.org/10.1/x and doi: 10.2/y here'), 'see and here', 'addresses are not read')
eq(speakable('  two\n\nlines  '), 'two lines', 'whitespace collapses')

console.log('where reading stops')
eq(referencesStart('Conclusion text.\nReferences\n[1] A. Author'), 'Conclusion text.\n'.length, 'a bare heading')
ok(referencesStart('end.\n7 References\nx') > 0, 'a numbered heading')
ok(referencesStart('end.\n8. Bibliography\nx') > 0, 'a numbered heading with a dot')
ok(referencesStart('slutt.\nReferanser\nx') > 0, 'Norwegian')
eq(referencesStart('as the references below show.\nMore text'), -1, 'the word in prose is not a heading')
eq(referencesStart('References are listed at the end.'), -1, 'a sentence opening on it is not a heading')

console.log('sentences')
{
  const pages = [
    { text: 'First sentence here. Second one [4] follows!\nThird line' },
    { text: 'Page two opens. It ends.\nReferences\n[1] Not read at all.' },
    { text: 'An appendix nobody hears.' }
  ]
  const s = buildSentences(pages, 1)
  eq(s.map((x) => x.text), ['First sentence here.', 'Second one [4] follows!', 'Third line', 'Page two opens.', 'It ends.'], 'stops at the heading')
  ok(s.every((x) => pages[x.pageNumber - 1].text.slice(x.start, x.end) === x.text), 'offsets address the page text')
  eq(buildSentences(pages, 2).map((x) => x.pageNumber), [2, 2], 'starts at the page asked for')
}

console.log('chunks')
{
  const sent = []
  for (let p = 1; p <= 3; p++)
    for (let i = 0; i < 12; i++) sent.push({ pageNumber: p, start: 0, end: 0, text: `Sentence ${i} on page ${p} says a little about the model.` })
  sent.splice(5, 0, { pageNumber: 1, start: 0, end: 0, text: '[7]' })
  const chunks = chunkSentences(sent)
  eq(chunks[0].first, 0, 'starts at the first sentence')
  eq(chunks[chunks.length - 1].end, sent.length, 'ends at the last')
  ok(chunks.every((c, i) => i === 0 || c.first === chunks[i - 1].end), 'every sentence in exactly one chunk')
  ok(chunks.every((c) => new Set(sent.slice(c.first, c.end).map((x) => x.pageNumber)).size === 1), 'never across a page')
  ok(chunks.every((c) => c.weights.length === c.end - c.first), 'one weight per sentence')
  ok(chunks.every((c) => c.text.length <= 1200), 'none past the ceiling')
  ok(chunks.length > 3 && chunks.length < 20, `paragraph-sized (${chunks.length} chunks)`)
  const withCitation = chunks.find((c) => c.first <= 5 && c.end > 5)
  eq(withCitation.weights[5 - withCitation.first], 0, 'a lone citation speaks as nothing')
  ok(!withCitation.text.includes('[7]'), 'and is not in the text')
  eq(chunkSentences([{ pageNumber: 1, start: 0, end: 0, text: 'x'.repeat(3000) }]).length, 1, 'one overlong sentence is still one chunk')
}

console.log('the highlight inside a chunk')
eq(sentenceAt([10, 30, 60], 0), 0, 'the start is the first sentence')
eq(sentenceAt([10, 30, 60], 0.05), 0, 'inside the first')
eq(sentenceAt([10, 30, 60], 0.1), 1, 'its end is the second’s start')
eq(sentenceAt([10, 30, 60], 0.5), 2, 'half way is in the third')
eq(sentenceAt([10, 30, 60], 1), 2, 'the end is the last')
eq(sentenceAt([0, 10], 0.01), 1, 'a silent sentence is passed over')
eq(sentenceAt([], 0.5), 0, 'nothing to say')
eq(sentenceAt([5, 5], NaN), 0, 'no duration yet')

console.log('the Gemini request')
{
  const body = geminiSpeechBody('Hei på deg.', 'Kore')
  eq(body.model, GEMINI_TTS_MODEL, 'the model')
  eq(body.input[0].content[0].text, 'Hei på deg.', 'the text, untouched')
  eq(body.input[0].content[0].annotations[0].type, 'speech_metadata', 'the style rides as speech metadata')
  eq(body.response_format, { type: 'audio' }, 'audio back')
  eq(body.generation_config.speech_config, [{ voice: 'Kore' }], 'one speaker, the voice asked for')
}

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 255])
const b64 = Buffer.from(wav).toString('base64')
function mockFetch(status, json, record) {
  return async (url, init) => {
    record?.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => {
        if (json === undefined) throw new SyntaxError('not json')
        return json
      }
    }
  }
}
const okBody = {
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
    { type: 'model_output', content: [{ type: 'audio', data: Buffer.from('old').toString('base64') }, { type: 'audio', data: b64, mime_type: 'audio/wav' }] }
  ]
}
{
  const calls = []
  const r = await runProviderSpeech({ key: 'k-123', req: { provider: 'gemini', text: 'Hello.', voice: 'Iapetus' }, fetchImpl: mockFetch(200, okBody, calls) })
  eq(r.ok, true, 'success')
  eq(Array.from(r.audio), Array.from(wav), 'the last audio part, decoded byte for byte')
  eq(r.mime, 'audio/wav', 'its type')
  eq(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions', 'the Interactions endpoint')
  eq(calls[0].init.headers['x-goog-api-key'], 'k-123', 'the key in its header, never the URL')
  ok(!calls[0].url.includes('k-123'), 'no key in the URL')
  eq(JSON.parse(calls[0].init.body).generation_config.speech_config[0].voice, 'Iapetus', 'the voice asked for')
}
{
  const calls = []
  await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Fenrir; drop' }, fetchImpl: mockFetch(200, okBody, calls) })
  eq(JSON.parse(calls[0].init.body).generation_config.speech_config[0].voice, GEMINI_READING_VOICES[0], 'a voice not on the list reads as the default')
}
eq(audioFromInteraction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] }), null, 'no audio part → null')
eq(audioFromInteraction('garbage'), null, 'garbage → null')

console.log('failures')
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Kore' }, fetchImpl: mockFetch(429, { error: { message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }) })
  eq(r.code, 'ai-rate-limited', 'a quota is a rate limit, as in the assistant')
}
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Kore' }, fetchImpl: mockFetch(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }) })
  eq(r.error, 'API key not valid. Please pass a valid API key.', 'anything else in the provider’s own words')
}
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Kore' }, fetchImpl: mockFetch(502, undefined) })
  eq(r.error, 'HTTP 502', 'a body that is not JSON still names the status')
}
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Kore' }, fetchImpl: async () => { throw new TypeError('fetch failed') } })
  eq(r.code, 'ai-endpoint-unreachable', 'no answer at all')
}
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'gemini', text: 'x', voice: 'Kore' }, fetchImpl: mockFetch(200, { steps: [] }) })
  eq(r.code, 'ai-provider-unknown', 'an answer with no audio')
}
{
  const r = await runProviderSpeech({ key: 'k', req: { provider: 'openai', text: 'x', voice: 'Kore' }, fetchImpl: mockFetch(200, okBody) })
  eq(r.code, 'ai-provider-unknown', 'a provider with no voice here asks nothing')
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall speech checks passed')

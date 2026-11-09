// A model id typed into the model menu — src/shared/typed-model.ts.
//
// The menu is curated-only (docs/MODEL-UPDATE.md), so a model launched before
// the list is updated is unreachable unless the reader can type its id. These
// pin what counts as an id (a search phrase must never become an offer), which
// providers get a row (keyed, curated, not already listing it), and the order.
// Run: node scripts/test-typed-model.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/typed-model.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'typed-model-'))
const out = join(dir, 'typed-model.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const { typedModelId, typedModelOffers } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// ---- what is an id
for (const id of ['gpt-6.2-sol', 'claude-opus-6', 'gemini-4.1-pro', 'grok-5', 'mistral-large-4-0', 'o5', 'anthropic/claude-opus-6:beta', 'GPT-6.2-Sol', 'llama4_70b'])
  eq(typedModelId(` ${id} `), id, `«${id}» reads as an id (trimmed, case kept)`)
for (const text of ['gpt 6', 'rask modell', '', '  ', 'a', '123', '6.2', 'gpt-', 'gpt-6.', '-gpt', 'gpt 6.2 sol', 'a'.repeat(121), 'gpt-6?', 'navn@sted'])
  eq(typedModelId(text), null, `«${text.slice(0, 20)}» is a search, not an id`)

// ---- which rows, in which order
const providers = [
  { id: 'openai', keyed: true, curated: true },
  { id: 'chatgpt', keyed: true, curated: true },
  { id: 'anthropic', keyed: false, curated: true },
  { id: 'gemini', keyed: true, curated: true },
  { id: 'azure', keyed: true, curated: false },
  { id: 'openrouter', keyed: true, curated: false },
  { id: 'mistral', keyed: true, curated: true }
]
const listed = new Set(['openai:gpt-6-sol', 'openai:gpt-6.1-sol', 'chatgpt:gpt-6-sol', 'gemini:gemini-4-argon', 'openrouter:openai/gpt-6.2-sol'])

eq(
  typedModelOffers('gpt-6.2-sol', providers, listed),
  [
    { provider: 'openai', id: 'gpt-6.2-sol' },
    { provider: 'chatgpt', id: 'gpt-6.2-sol' },
    { provider: 'gemini', id: 'gpt-6.2-sol' },
    { provider: 'mistral', id: 'gpt-6.2-sol' }
  ],
  'one row per KEYED CURATED provider, in the menu order; keyless (anthropic) and live-list providers (azure, openrouter) get none'
)
eq(
  typedModelOffers('gpt-6.1-sol', providers, listed),
  [
    { provider: 'chatgpt', id: 'gpt-6.1-sol' },
    { provider: 'gemini', id: 'gpt-6.1-sol' },
    { provider: 'mistral', id: 'gpt-6.1-sol' }
  ],
  'a provider that already lists the id is a hit, not an offer'
)
eq(
  typedModelOffers('GPT-6.1-SOL', providers, listed).map((o) => o.provider),
  ['chatgpt', 'gemini', 'mistral'],
  'already-listed is judged case-folded…'
)
eq(typedModelOffers('GPT-6.2-Sol', providers, listed)[0], { provider: 'openai', id: 'GPT-6.2-Sol' }, '…but the offer keeps the case typed (ids are case-sensitive at the provider)')
eq(typedModelOffers('gpt 6', providers, listed), [], 'a search phrase offers nothing')
eq(typedModelOffers('gpt-6.2-sol', providers.map((p) => ({ ...p, keyed: false })), listed), [], 'no key anywhere → nothing to offer')
eq(typedModelOffers('gpt-6.2-sol', [], listed), [], 'no providers → nothing')

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('test-typed-model: all assertions passed')

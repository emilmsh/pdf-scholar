// Report drift between the shipped AI model catalogue and what the providers
// actually serve right now.
// Run: npm run check:models   (ANTHROPIC_API_KEY / OPENAI_API_KEY in env for
// the live checks; without keys only the static consistency checks run)
//
// This is the dev-time half of the model-robustness story. The runtime half
// (live catalog fetch + capability-driven request shaping + degrade-on-400,
// see src/shared/ai-model-catalog.ts and ai-chat.ts) keeps users working when
// the curated data goes stale; this script tells the maintainer WHAT went
// stale so the curated labels, hints, defaults and heuristics can be brought
// back in line. It is a REPORT, not a gate — follow docs/MODEL-UPDATE.md for
// what to do with each finding.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

// ---------- Curated data, parsed from source ----------
// Light regex parsing on purpose: importing the TS modules would drag in the
// renderer's i18n. The shapes parsed here are simple literals; if a rewrite of
// ai-models.ts breaks the parse, the empty result is loudly visible below.

function curatedIds(provider) {
  const src = readFileSync(join(root, 'src/renderer/src/components/ai-models.ts'), 'utf8')
  const block = src.match(new RegExp(`${provider}:\\s*\\[([\\s\\S]*?)\\]`))
  if (!block) return []
  return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
}

function defaultModel(provider) {
  const src = readFileSync(join(root, 'src/shared/defaults.ts'), 'utf8')
  const m = src.match(new RegExp(`${provider}:\\s*'([^']*)'`))
  return m ? m[1] : ''
}

// ---------- Live lists ----------

async function anthropicLive(key) {
  const models = []
  let after = null
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after_id', after)
    const res = await fetch(url, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    models.push(...(body.data ?? []))
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  return models
}

async function openAiLive(key) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${key}` }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  // Same chat-model filter as src/shared/ai-model-catalog.ts — keep in sync
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => /^(gpt-[0-9]|o[0-9])/i.test(id))
    .filter((id) => !/(audio|realtime|image|embed|tts|whisper|moderation|transcribe|dall|instruct|codex|search)/i.test(id))
    .filter((id) => !/-\d{4}(-\d{2}-\d{2})?$/.test(id))
}

// ---------- Report ----------

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
let findings = 0
const flag = (msg) => {
  findings++
  console.log(`  ! ${msg}`)
}

function diff(provider, curated, live, fallbackDefault) {
  console.log(`\n${provider}: ${curated.length} curated, ${live.length} live`)
  for (const id of curated) {
    if (!live.includes(id)) flag(`curated model '${id}' is NOT listed by the provider (retired?)`)
  }
  for (const id of live) {
    if (!curated.includes(id)) console.log(`  + new at provider, not curated: ${id}`)
  }
  if (fallbackDefault && !live.includes(fallbackDefault)) {
    flag(`DEFAULT model '${fallbackDefault}' is not listed by the provider — urgent`)
  }
}

console.log('Model catalogue drift report (see docs/MODEL-UPDATE.md for the protocol)')

// Static sanity: every default must be in the curated list it belongs to
for (const provider of ['anthropic', 'openai']) {
  const ids = curatedIds(provider)
  if (ids.length === 0) flag(`could not parse curated ${provider} ids from ai-models.ts`)
  const def = defaultModel(provider)
  if (def && !ids.includes(def)) {
    flag(`default '${def}' (defaults.ts) is missing from the curated ${provider} list`)
  }
}

const anthropicKey = process.env.ANTHROPIC_API_KEY
if (anthropicKey) {
  try {
    const live = await anthropicLive(anthropicKey)
    diff('anthropic', curatedIds('anthropic'), live.map((m) => m.id), defaultModel('anthropic'))
    // Capability summary: eyeball this against the traits/regexes in
    // src/shared/ai-chat.ts (anthropicTraits) and the notes in MODEL-UPDATE.md.
    console.log('\n  capabilities (adaptive thinking / budget thinking / effort levels):')
    for (const m of live) {
      const caps = m.capabilities ?? {}
      const adaptive = caps.thinking?.types?.adaptive?.supported === true
      const budget = caps.thinking?.types?.enabled?.supported === true
      const effort = EFFORT_LADDER.filter((l) => caps.effort?.[l]?.supported === true)
      console.log(
        `    ${m.id.padEnd(28)} adaptive=${adaptive ? 'yes' : 'no '} budget=${budget ? 'yes' : 'no '} effort=[${effort.join(',')}]`
      )
    }
  } catch (err) {
    flag(`anthropic live check failed: ${err.message}`)
  }
} else {
  console.log('\nanthropic: skipped live check (set ANTHROPIC_API_KEY to enable)')
}

const openAiKey = process.env.OPENAI_API_KEY
if (openAiKey) {
  try {
    diff('openai', curatedIds('openai'), await openAiLive(openAiKey), defaultModel('openai'))
    console.log('  (OpenAI exposes no capability data — verify reasoning support by hand)')
  } catch (err) {
    flag(`openai live check failed: ${err.message}`)
  }
} else {
  console.log('\nopenai: skipped live check (set OPENAI_API_KEY to enable)')
}

console.log(
  findings === 0
    ? '\nNo drift flagged. New-at-provider lines above (if any) are candidates, not problems.'
    : `\n${findings} finding(s) flagged — walk through docs/MODEL-UPDATE.md before shipping.`
)

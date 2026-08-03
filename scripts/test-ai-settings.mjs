// Proof, in the REAL desktop app, that the AI key/provider settings flow
// works end to end — the part test:ai-chat cannot see because it lives in the
// UI: the keyless first-run lands in settings, the compat (OpenAI-compatible)
// group renders with its preset menu, saving a local endpoint auto-switches
// the provider, the header chip names the model, the composer follows the
// capability profile (no web-search globe for compat; snip/attach stay
// enabled while vision is unknown), and the model menu keeps the configured
// id pickable with the server offline and hides the reasoning selector for a
// non-reasoning id.
//
// Run: npm run build && npm run test:ai-settings
// Desktop-session test (CDP against the built app) — same harness as
// test:windows / shoot-screenshots; throwaway profile, never touches real state.
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PDF = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const PORT = 9345

let failures = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const app = launchApp({ root: ROOT, mainJs: join(ROOT, 'out', 'main', 'index.js'), args: [PDF], port: PORT })
try {
  const targets = await waitForPageTargets(PORT, 1)
  const send = cdp(await openSocket(targets[0].webSocketDebuggerUrl))
  await send('Runtime.enable')

  // Tooltips are matched in both languages (auto language follows the OS)
  const PRELUDE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const byTitle = (prefix) => [...document.querySelectorAll('button')].find((b) => b.title.startsWith(prefix))
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // The compat group is the field-group holding the base-URL input
    const compatGroup = () => [...document.querySelectorAll('.ai-field-group')]
      .find((g) => g.querySelector('input[placeholder="http://localhost:11434/v1"]'))
  `

  // Keyless factory profile: opening the assistant lands in the settings
  await evaluate(send, `
    for (let i = 0; i < 100 && !(byTitle('Assistent') || byTitle('Assistant')); i++) await sleep(200)
    ;(byTitle('Assistent') ?? byTitle('Assistant')).click()
    for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(200)
  `, PRELUDE)

  const settings = await evaluate(send, `
    const g = compatGroup()
    return {
      settingsShown: !!document.querySelector('.ai-settings'),
      groups: document.querySelectorAll('.ai-field-group').length,
      hasCompatGroup: !!g,
      presets: g ? [...g.querySelectorAll('select option')].map((o) => o.textContent) : [],
      keyPlaceholder: g?.querySelector('input[type="password"]')?.placeholder ?? ''
    }
  `, PRELUDE)
  ok(settings.settingsShown, 'keyless start lands in the AI settings')
  ok(settings.groups === 4, `four provider groups render (got ${settings.groups})`)
  ok(settings.hasCompatGroup, 'compat group with the base-URL field renders')
  ok(
    ['Ollama', 'OpenRouter', 'Gemini', 'Grok'].every((s) => settings.presets.some((p) => p.includes(s))),
    'preset menu lists Ollama + OpenRouter + Gemini + Grok'
  )
  ok(/valgfri|optional/i.test(settings.keyPlaceholder), 'key field says the key is optional')

  // Pick the Ollama preset, type a model id, save
  await evaluate(send, `
    const g = compatGroup()
    const preset = g.querySelector('select')
    preset.value = 'http://localhost:11434/v1'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(100)
    const inputs = [...g.querySelectorAll('.ai-field input:not([type="password"])')]
    setVal(inputs[1], 'llama3.1')   // [0] = base URL (prefilled), [1] = model id
    await sleep(100)
    document.querySelector('.ai-settings-actions .btn-primary').click()
    for (let i = 0; i < 60 && document.querySelector('.ai-settings'); i++) await sleep(200)
  `, PRELUDE)

  const after = await evaluate(send, `
    return {
      settingsGone: !document.querySelector('.ai-settings'),
      chip: document.querySelector('.ai-model-name')?.textContent ?? '',
      buttons: [...document.querySelectorAll('.ai-composer-controls button')]
        .map((b) => ({ title: b.title, cls: b.className, disabled: b.disabled }))
    }
  `, PRELUDE)
  ok(after.settingsGone, 'save closes the settings takeover')
  ok(after.chip === 'Llama3.1', `auto-switch to compat, chip shows the model (got "${after.chip}")`)
  ok(
    !after.buttons.some((b) => /[Nn]ettsøk|web search/i.test(b.title)),
    'no web-search globe for compat (capability profile)'
  )
  const attach = after.buttons.filter((b) => b.cls.includes('ai-attach-add'))
  ok(
    attach.length === 2 && attach.every((b) => !b.disabled),
    'snip + attach enabled (vision unknown → permissive)'
  )

  // The model menu with the server OFFLINE: configured id stays pickable,
  // reasoning selector hidden for a non-reasoning id
  await evaluate(send, `
    document.querySelector('.ai-model').click()
    for (let i = 0; i < 30 && !document.querySelector('.ai-model-menu'); i++) await sleep(100)
    await sleep(600) // the TTL-gated refresh resolves (fails silently: no server)
  `, PRELUDE)
  const menu = await evaluate(send, `
    const menu = document.querySelector('.ai-model-menu')
    return {
      open: !!menu,
      selected: menu?.querySelector('select')?.value ?? '',
      hasCompatOption: [...(menu?.querySelectorAll('option') ?? [])].some((o) => o.value === 'compat:llama3.1'),
      selects: menu?.querySelectorAll('select').length ?? 0
    }
  `, PRELUDE)
  ok(menu.open, 'model menu opens')
  ok(menu.selected === 'compat:llama3.1', `configured compat model is the selection (got ${menu.selected})`)
  ok(menu.hasCompatOption, 'configured id stays pickable with the server offline')
  ok(menu.selects === 1, `reasoning selector hidden for a non-reasoning compat id (selects: ${menu.selects})`)

  console.log(failures === 0 ? '\ntest-ai-settings: all checks passed' : `\ntest-ai-settings: ${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('test-ai-settings failed:', err.message)
  console.error(app.log().slice(-2000))
  process.exitCode = 1
} finally {
  await app.cleanup()
}

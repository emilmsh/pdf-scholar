// Proof, in the REAL desktop app, that the AI key/provider settings flow
// works end to end — the part test:ai-chat cannot see because it lives in the
// UI: the keyless first-run lands in settings, every provider is one folded
// block (Azure's four fields stay behind their row until asked for), the
// local-server row opens onto its preset menu, saving a local endpoint switches
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
    // Every provider is one .ai-field-group. The two that need more than a key
    // carry a disclosure control (.ai-provider-row) where the others carry a
    // key field; their fields exist only once it is opened.
    const groups = () => [...document.querySelectorAll('.ai-field-group')]
    const discGroups = () => groups().filter((g) => g.querySelector('.ai-provider-row'))
    const discGroup = (re) => discGroups().find((g) => re.test(g.textContent))
    const openDisc = async (re) => {
      const g = discGroup(re)
      if (!g.querySelector('.ai-provider-body')) g.querySelector('.ai-provider-row').click()
      for (let i = 0; i < 30 && !g.querySelector('.ai-provider-body'); i++) await sleep(50)
      return g
    }
    // Every provider's name, in the order they are listed
    const rowNames = () => groups().map((g) => g.querySelector('.ai-field > span').textContent)
    // The Ollama row: its base-URL field is prefilled with our default
    const ollamaGroup = () =>
      groups().find((g) => g.querySelector('input[placeholder="http://localhost:11434/v1"]'))
  `

  // Keyless factory profile: opening the assistant lands in the settings
  await evaluate(send, `
    for (let i = 0; i < 100 && !(byTitle('Assistent') || byTitle('Assistant')); i++) await sleep(200)
    ;(byTitle('Assistent') ?? byTitle('Assistant')).click()
    for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(200)
  `, PRELUDE)

  const folded = await evaluate(send, `
    return {
      settingsShown: !!document.querySelector('.ai-settings'),
      blocks: groups().length,
      names: rowNames(),
      // Folded shut: the multi-field providers show no inputs at all until asked
      inputsInDiscRows: discGroups()
        .reduce((n, g) => n + g.querySelectorAll('input, select').length, 0)
    }
  `, PRELUDE)
  ok(folded.settingsShown, 'keyless start lands in the AI settings')
  ok(folded.blocks === 11, `eleven provider blocks render, ranked (got ${folded.blocks})`)
  ok(
    folded.names[0] === 'OpenAI' && /Gemini/.test(folded.names[2] ?? ''),
    `ranked order: OpenAI first, Gemini third (got ${folded.names.slice(0, 3).join(' | ')})`
  )
  ok(
    ['OpenRouter', 'xAI (Grok)', 'Mistral', 'Groq'].every((n) => folded.names.includes(n)),
    'the hosted services each have their own key row'
  )
  ok(
    ['Ollama', 'LM Studio'].every((n) => folded.names.some((r) => r.startsWith(n))),
    `Ollama and LM Studio are providers in their own right (got ${folded.names.slice(-3).join(' | ')})`
  )
  ok(
    folded.inputsInDiscRows === 0,
    `the multi-field rows start folded — one line each, no loose fields (got ${folded.inputsInDiscRows} inputs)`
  )

  // Unfold the Ollama row and read its fields
  const settings = await evaluate(send, `
    await openDisc(/^Ollama/)
    const g = ollamaGroup()
    const fields = g ? [...g.querySelectorAll('.ai-field > span')].map((x) => x.textContent) : []
    return {
      opened: !!g,
      fields,
      noPresetMenu: g ? g.querySelectorAll('select').length === 0 : false,
      keyPlaceholder: g?.querySelector('input[type="password"]')?.placeholder ?? '',
      keyTip: g?.querySelector('input[type="password"]')?.closest('.ai-field')?.title ?? ''
    }
  `, PRELUDE)
  ok(settings.opened, 'the Ollama row opens onto a base-URL field prefilled with its own address')
  ok(settings.noPresetMenu, 'no service dropdown left inside — the row IS the service')
  ok(/valgfri|optional/i.test(settings.keyPlaceholder), 'key field says the key is optional')
  ok(
    /proxy/i.test(settings.keyTip),
    `the optional key explains itself on hover (got "${settings.keyTip.slice(0, 40)}…")`
  )

  // Type a model id and save
  await evaluate(send, `
    const g = ollamaGroup()
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
  ok(after.chip === 'Llama3.1', `auto-switch to Ollama, chip shows the model (got "${after.chip}")`)
  ok(
    !after.buttons.some((b) => /[Nn]ettsøk|web search/i.test(b.title)),
    'no web-search globe for a local server (capability profile)'
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
      hasLocalOption: [...(menu?.querySelectorAll('option') ?? [])].some((o) => o.value === 'ollama:llama3.1'),
      selects: menu?.querySelectorAll('select').length ?? 0
    }
  `, PRELUDE)
  ok(menu.open, 'model menu opens')
  ok(menu.selected === 'ollama:llama3.1', `the configured local model is the selection (got ${menu.selected})`)
  ok(menu.hasLocalOption, 'configured id stays pickable with the server offline')
  ok(menu.selects === 1, `reasoning selector hidden for a non-reasoning local id (selects: ${menu.selects})`)

  // Back into settings from that menu: with one provider configured the «hide
  // empty» toggle appears — off by default (the full list is what you came
  // for), and it collapses to what is in use when asked
  const second = await evaluate(send, `
    document.querySelector('.ai-model-more').click()
    for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(200)
    const filter = document.querySelector('.ai-settings-filter input')
    const before = groups().length
    filter.click()
    await sleep(150)
    return { hasFilter: !!filter, before, after: groups().length }
  `, PRELUDE)
  ok(second.hasFilter, 'with something configured, the «hide empty» toggle is offered')
  ok(second.before === 11, `it starts off — all eleven still listed (got ${second.before})`)
  ok(second.after === 1, `switching it on leaves only the configured provider (got ${second.after})`)

  console.log(failures === 0 ? '\ntest-ai-settings: all checks passed' : `\ntest-ai-settings: ${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('test-ai-settings failed:', err.message)
  console.error(app.log().slice(-2000))
  process.exitCode = 1
} finally {
  await app.cleanup()
}

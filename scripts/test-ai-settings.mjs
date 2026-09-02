// Proof, in the REAL desktop app, that the AI key/provider settings flow
// works end to end — the part test:ai-chat cannot see because it lives in the
// UI: the keyless first-run lands in settings, the compat (OpenAI-compatible)
// group renders with its preset menu, saving a local endpoint auto-switches
// the provider, the header chip names the model, the composer follows the
// capability profile (no web-search globe for compat; snip/attach stay
// enabled while vision is unknown), and the model menu keeps the configured
// id pickable with the server offline and hides the reasoning selector for a
// non-reasoning id. Then KI-tilgang, the dead-man switch: 'off' must gate the
// transport itself (a direct window.api.aiChat answers ai-disabled) and swap
// the composer for the off notice, and 'confirm' must stage every send behind
// the strip that names the receiving model.
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
    const groupNames = [...document.querySelectorAll('.ai-field-group > .ai-field > span')]
      .map((s) => s.textContent)
    return {
      settingsShown: !!document.querySelector('.ai-settings'),
      groups: document.querySelectorAll('.ai-field-group').length,
      groupNames,
      hasCompatGroup: !!g,
      presets: g ? [...g.querySelectorAll('select option')].map((o) => o.textContent) : [],
      keyPlaceholder: g?.querySelector('input[type="password"]')?.placeholder ?? ''
    }
  `, PRELUDE)
  ok(settings.settingsShown, 'keyless start lands in the AI settings')
  // KI-tilgang (the access switch) sits first, then the nine provider groups
  ok(settings.groups === 10, `access group + nine provider groups render (got ${settings.groups})`)
  ok(
    /KI-tilgang|AI access/.test(settings.groupNames[0] ?? '') &&
      settings.groupNames[1] === 'OpenAI' &&
      /Gemini/.test(settings.groupNames[3] ?? ''),
    `ranked order: access first, then OpenAI, Gemini third provider (got ${settings.groupNames.slice(0, 4).join(' | ')})`
  )
  ok(
    ['OpenRouter', 'xAI (Grok)', 'Mistral', 'Groq'].every((n) => settings.groupNames.includes(n)),
    'the hosted services each have their own key row'
  )
  ok(settings.hasCompatGroup, 'compat group with the base-URL field renders')
  ok(
    ['Ollama', 'LM Studio'].every((s) => settings.presets.some((p) => p.includes(s))),
    'compat presets are the local servers'
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
  // The list is rows, not a <select>: each carries data-value "<provider>:<id>"
  // and the picked one is aria-checked. The only <select> left in this menu is
  // the reasoning one, so counting them still answers whether it is showing.
  const menu = await evaluate(send, `
    const menu = document.querySelector('.ai-model-menu')
    const rows = [...(menu?.querySelectorAll('[data-menuitem]') ?? [])]
    return {
      open: !!menu,
      selected: rows.find((r) => r.getAttribute('aria-checked') === 'true')?.dataset.value ?? '',
      hasCompatOption: rows.some((r) => r.dataset.value === 'compat:llama3.1'),
      selects: menu?.querySelectorAll('select').length ?? 0
    }
  `, PRELUDE)
  ok(menu.open, 'model menu opens')
  ok(menu.selected === 'compat:llama3.1', `configured compat model is the picked row (got ${menu.selected})`)
  ok(menu.hasCompatOption, 'configured id stays pickable with the server offline')
  ok(menu.selects === 0, `reasoning selector hidden for a non-reasoning compat id (selects: ${menu.selects})`)

  // ---------- KI-tilgang (the dead-man switch) ----------
  // The settings select carries the mode; 'off' must gate the TRANSPORT (a
  // direct window.api.aiChat, no UI involved, answers ai-disabled) and swap the
  // composer for the off notice; 'confirm' must stage a send behind the strip.
  await evaluate(send, `
    document.querySelector('.ai-model-more').click()
    for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(100)
  `, PRELUDE)
  const accessUi = await evaluate(send, `
    const group = [...document.querySelectorAll('.ai-settings .ai-field-group')]
      .find((g) => g.querySelector('select') && [...g.querySelectorAll('option')].some((o) => /Bekreft|Confirm/.test(o.textContent)))
    return {
      hasAccessSelect: !!group,
      options: group ? [...group.querySelectorAll('option')].map((o) => o.textContent) : [],
      hint: group?.querySelector('.ai-field-hint')?.textContent ?? ''
    }
  `, PRELUDE)
  ok(accessUi.hasAccessSelect, 'the KI-tilgang select renders in settings')
  ok(accessUi.options.length === 3, `three modes offered (got ${accessUi.options.length})`)
  ok(
    /hele dokumentteksten|whole document text/.test(accessUi.hint),
    'the hint discloses that the whole document text is sent'
  )

  // Switch OFF and save: the transport must refuse before any provider is named
  await evaluate(send, `
    const group = [...document.querySelectorAll('.ai-settings .ai-field-group')]
      .find((g) => g.querySelector('select') && [...g.querySelectorAll('option')].some((o) => /Bekreft|Confirm/.test(o.textContent)))
    const sel = group.querySelector('select')
    sel.value = 'off'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(100)
    document.querySelector('.ai-settings-actions .btn-primary').click()
    for (let i = 0; i < 60 && document.querySelector('.ai-settings'); i++) await sleep(200)
  `, PRELUDE)
  const off = await evaluate(send, `
    const gate = await window.api.aiChat({ requestId: 990001, system: 'x', messages: [{ role: 'user', text: 'ping' }], document: null })
    return {
      gateCode: gate.code ?? '',
      offNotice: !!document.querySelector('.ai-off-notice'),
      composerGone: !document.querySelector('.ai-composer'),
      suggestionsGone: !document.querySelector('.ai-suggestions')
    }
  `, PRELUDE)
  ok(off.gateCode === 'ai-disabled', `off gates the transport itself: aiChat answers ai-disabled (got "${off.gateCode}")`)
  ok(off.offNotice, 'the composer gives way to the off notice')
  ok(off.composerGone && off.suggestionsGone, 'composer and one-click suggestions are gone while off')

  // Switch to CONFIRM via the notice's own door, then a send must stage first
  await evaluate(send, `
    document.querySelector('.ai-off-notice button').click()
    for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(100)
    const group = [...document.querySelectorAll('.ai-settings .ai-field-group')]
      .find((g) => g.querySelector('select') && [...g.querySelectorAll('option')].some((o) => /Bekreft|Confirm/.test(o.textContent)))
    const sel = group.querySelector('select')
    sel.value = 'confirm'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(100)
    document.querySelector('.ai-settings-actions .btn-primary').click()
    for (let i = 0; i < 60 && document.querySelector('.ai-settings'); i++) await sleep(200)
    const ta = document.querySelector('.ai-composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Stages, not sends')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
    document.querySelector('.ai-composer .ai-send').click()
    await sleep(300)
  `, PRELUDE)
  const confirm = await evaluate(send, `
    return {
      strip: document.querySelector('.ai-confirm')?.textContent ?? '',
      taDisabled: document.querySelector('.ai-composer textarea')?.disabled ?? false,
      sentAlready: document.querySelectorAll('.ai-msg').length
    }
  `, PRELUDE)
  ok(/Llama3.1/.test(confirm.strip), `the strip names the receiving model (got "${confirm.strip.slice(0, 60)}")`)
  ok(confirm.taDisabled, 'the composer is held while the send is staged')
  ok(confirm.sentAlready === 0, 'nothing was sent before the strip was answered')
  // Confirming fires the real request (the offline compat server answers with
  // a named failure — which is the proof the transport was actually reached)
  const fired = await evaluate(send, `
    const go = [...document.querySelectorAll('.ai-confirm button')].find((b) => /^(Send)$/.test(b.textContent))
    go.click()
    for (let i = 0; i < 60 && !document.querySelector('.ai-msg.ai-assistant'); i++) await sleep(200)
    return { msgs: document.querySelectorAll('.ai-msg').length, stripGone: !document.querySelector('.ai-confirm') }
  `, PRELUDE)
  ok(fired.stripGone && fired.msgs >= 2, `confirming sends for real (got ${fired.msgs} messages)`)

  console.log(failures === 0 ? '\ntest-ai-settings: all checks passed' : `\ntest-ai-settings: ${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('test-ai-settings failed:', err.message)
  console.error(app.log().slice(-2000))
  process.exitCode = 1
} finally {
  await app.cleanup()
}

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
// the composer for the off notice, and 'confirm' must stage a send behind
// the strip that names the receiving model.
//
// Last, the ACCOUNT QUOTA loop, which only exists as UI: a local server
// refuses the first request the way OpenAI refuses one bigger than the whole
// minute's token budget, and the panel must name it as a quota (not a context
// overflow), say that waiting cannot fix it, keep the provider's counts
// readable, name the ceiling it published — and cut the NEXT request's
// attachment to fit that ceiling.
//
// Run: npm run build && npm run test:ai-settings
// Desktop-session test (CDP against the built app) — same harness as
// test:windows / shoot-screenshots; throwaway profile, never touches real state.
import { createServer } from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate } from './lib/cdp.mjs'

/** A local OpenAI-compatible endpoint with an ACCOUNT QUOTA: the first request
 *  is refused the way OpenAI refuses one bigger than the minute's whole token
 *  budget (429, the counts in prose, the ceiling in the rate-limit header),
 *  and later ones answer normally. Deliberately NOT a scripts/lib scenario —
 *  it is stateful, and the shared fake provider's table is consumed by
 *  test:live and test:streams, which expect one answer per model id. */
async function startQuotaServer() {
  const prompts = []
  let calls = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    if (!(req.url ?? '').includes('/chat/completions')) {
      // The model-list refresh, and anything else the client probes for
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'self/quota' }] }))
      return
    }
    // What the document block actually cost us this time
    const body = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return {}
      }
    })()
    prompts.push(
      (body.messages ?? []).reduce(
        (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
        0
      )
    )
    if (++calls === 1) {
      res.writeHead(429, {
        'content-type': 'text/plain',
        'x-ratelimit-limit-tokens': '1200'
      })
      res.end(
        'Request too large for self/quota in organization org-x on tokens per min (TPM): Limit 1200, Requested 9000.'
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Svar fra kvoteserveren.' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    promptLengths: () => prompts,
    close: () => new Promise((r) => server.close(r))
  }
}

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

  // «Bekreft før deling» asks ONCE per document and provider (ai-sharing.ts):
  // a follow-up to the same document with the same provider is not staged —
  // it goes straight out, strip and all skipped
  const again = await evaluate(send, `
    for (let i = 0; i < 60 && document.querySelector('.ai-composer textarea')?.disabled; i++) await sleep(200)
    const ta = document.querySelector('.ai-composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Follow-up, same document, same provider')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
    const before = document.querySelectorAll('.ai-msg').length
    document.querySelector('.ai-composer .ai-send').click()
    await sleep(400)
    const strip = !!document.querySelector('.ai-confirm')
    for (let i = 0; i < 60 && document.querySelectorAll('.ai-msg').length <= before; i++) await sleep(200)
    return { strip, before, after: document.querySelectorAll('.ai-msg').length }
  `, PRELUDE)
  ok(!again.strip, 'a follow-up to the same document and provider is NOT staged again')
  ok(again.after > again.before, `…and it was sent (${again.before} -> ${again.after} messages)`)

  // ---------- the ACCOUNT's token ceiling, end to end ----------
  //
  // The failure this covers shipped for a while: a document well inside the
  // model's context window, refused because ONE request was bigger than the
  // whole per-minute quota behind the key. Waiting could never fix it, and the
  // excerpt machinery was budgeted against the context window, so it never
  // fired. Here, in the real app: the rejection is named as its own thing, the
  // provider's counts stay readable, the ceiling it published is remembered,
  // and the NEXT question attaches an excerpt cut to fit it.
  const quota = await startQuotaServer()
  try {
    await evaluate(send, `
      // Point compat at the quota server and ask again. Settings open the way
      // a reader opens them: the model chip, then its «Åpne KI-innstillinger».
      document.querySelector('.ai-model').click()
      for (let i = 0; i < 30 && !document.querySelector('.ai-model-menu'); i++) await sleep(100)
      document.querySelector('.ai-model-more').click()
      for (let i = 0; i < 50 && !document.querySelector('.ai-settings'); i++) await sleep(100)
      const g = compatGroup()
      const inputs = [...g.querySelectorAll('.ai-field input:not([type="password"])')]
      setVal(inputs[0], ${JSON.stringify(quota.baseUrl)})
      setVal(inputs[1], 'self/quota')
      await sleep(100)
      document.querySelector('.ai-settings-actions .btn-primary').click()
      for (let i = 0; i < 60 && document.querySelector('.ai-settings'); i++) await sleep(200)
      // The chip renders the view main returned from the save, so waiting for
      // it to name the new model is waiting for the config to be LIVE — a send
      // fired before that races the save and goes to the old endpoint.
      for (let i = 0; i < 60 && !/Quota/i.test(document.querySelector('.ai-model-name')?.textContent ?? ''); i++)
        await sleep(100)
    `, PRELUDE)

    const refused = await evaluate(send, `
      const ta = document.querySelector('.ai-composer textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Hva er hovedpoenget?')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(100)
      const before = document.querySelectorAll('.ai-msg').length
      document.querySelector('.ai-composer .ai-send').click()
      const lastErr = () => [...document.querySelectorAll('.ai-error')].at(-1)
      for (let i = 0; i < 100 && document.querySelectorAll('.ai-msg').length <= before; i++) await sleep(200)
      const err = lastErr()
      return {
        text: err?.textContent ?? '',
        detail: err?.querySelector('.ai-error-detail')?.textContent ?? '',
        note: err?.querySelector('.ai-error-note')?.textContent ?? '',
        grew: document.querySelectorAll('.ai-msg').length > before
      }
    `, PRELUDE)
    ok(
      /minuttkvoten|per-minute token quota/.test(refused.text),
      `the refusal is named as a quota, not a context overflow (got "${refused.text.slice(0, 70)}")`
    )
    ok(
      /vente hjelper ikke|Waiting does not help/.test(refused.text),
      'and it says outright that waiting cannot fix this one'
    )
    ok(
      /Requested 9000/.test(refused.detail),
      `the provider's own counts stay readable (got "${refused.detail.slice(0, 80)}")`
    )
    ok(
      /1[\s,. ]?200/.test(refused.note),
      `the ceiling the provider published is named back (got "${refused.note.slice(0, 80)}")`
    )

    // Same model, same document, asked again: the ceiling is known now, so the
    // attachment is an excerpt that fits it — the chip says so, and the server
    // sees a far shorter prompt than the refused one.
    const excerpted = await evaluate(send, `
      for (let i = 0; i < 60 && document.querySelector('.ai-composer textarea')?.disabled; i++) await sleep(200)
      const ta = document.querySelector('.ai-composer textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Hva er hovedpoenget?')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(100)
      document.querySelector('.ai-composer .ai-send').click()
      for (let i = 0; i < 100 && !document.querySelector('.ai-excerpt-chip'); i++) await sleep(200)
      return {
        chip: document.querySelector('.ai-excerpt-chip')?.textContent ?? '',
        answered: [...document.querySelectorAll('.ai-msg.ai-assistant')].at(-1)?.textContent ?? ''
      }
    `, PRELUDE)
    ok(
      /Utdrag|Excerpt/.test(excerpted.chip),
      `the retry attaches an excerpt instead (got "${excerpted.chip}")`
    )
    ok(/Svar fra kvoteserveren/.test(excerpted.answered), 'and the retry is actually answered')
    const [first, second] = quota.promptLengths()
    ok(
      second < first,
      `the second request carried less document than the refused one (${first} -> ${second} chars)`
    )
  } finally {
    await quota.close()
  }

  console.log(failures === 0 ? '\ntest-ai-settings: all checks passed' : `\ntest-ai-settings: ${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('test-ai-settings failed:', err.message)
  console.error(app.log().slice(-2000))
  process.exitCode = 1
} finally {
  await app.cleanup()
}

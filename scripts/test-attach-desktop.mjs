// Earlier conversations attached as context, in the REAL app (issue #46;
// the rules are scripts/test-conversation-context.mjs).
//
// A local OpenAI-compatible endpoint records every request body, so this
// proves what actually LEAVES the machine, not what the panel shows: the
// picker attaches a conversation from another document; «Bekreft før
// deling» names that document before anything is sent; the request carries
// the attached conversation in the system prompt — its question and answer,
// never its image — and nowhere else; the answer's [SAMTALE 1] tag becomes a
// «Samtale» chip beside the document's page chip; the attachment rides along
// with the next question and is stored with the conversation; taken off, it
// is gone from the next request; and the chip opens the conversation it
// names, in its own document.
// Needs `npm run build` first. Run: node scripts/test-attach-desktop.mjs
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9359
const MAIN = join(ROOT, 'out', 'main', 'index.js')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const QUOTE = 'God typografi og rolige farger gjør lange lesestunder behagelige.'
const ANSWER = `Metoden fra den andre artikkelen er differanse-i-differanser [SAMTALE 1]. Dette dokumentet handler om lesing [KILDE s.3: "${QUOTE}"].`

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

async function waitFor(fn, ready, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (ready(last)) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

/** An OpenAI-compatible endpoint that answers every question the same way
 *  and keeps every request body it was sent */
async function recordingEndpoint() {
  const bodies = []
  const frame = (o) => `data: ${JSON.stringify(o)}\n\n`
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'rec/model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] }))
      return
    }
    try {
      bodies.push(JSON.parse(raw))
    } catch {
      bodies.push(null)
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame({ choices: [{ delta: { content: ANSWER } }] }))
    res.write(frame({ usage: { prompt_tokens: 10, completion_tokens: 10 } }))
    res.end('data: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => new Promise((r) => server.close(r)) }
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

const PRELUDE = `
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ask = async (question) => {
  const ta = document.querySelector('.ai-composer textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, question);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(200);
  click(document.querySelector('.ai-send'));
};
const chips = () => [...document.querySelectorAll('.ai-attach-conv')].map((c) => c.textContent.replace('✕', '').trim());
`
const run = (send, body) => evaluate(send, body, PRELUDE)

/** The system prompt and the rest of a recorded request, as text */
const parts = (body) => {
  const msgs = body?.messages ?? []
  const text = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''))
  return {
    system: msgs.filter((m) => m.role === 'system').map(text).join('\n'),
    rest: msgs.filter((m) => m.role !== 'system').map(text).join('\n'),
    raw: JSON.stringify(body)
  }
}

async function main() {
  const endpoint = await recordingEndpoint()
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-attach-'))
  const HERE = join(dir, 'reading.pdf')
  const OTHER = join(dir, 'Other paper.pdf')
  copyFileSync(SAMPLE, HERE)
  copyFileSync(SAMPLE, OTHER)
  const app = launchApp({
    root: ROOT, mainJs: MAIN, args: [HERE], port: PORT,
    prepareProfile: (p) => {
      writeFileSync(join(p, 'pdfx-state.json'), JSON.stringify({
        settings: { language: 'nb' },
        // «Bekreft før deling» on: the strip must name the other document
        ai: { provider: 'compat', models: { compat: 'rec/model' }, compat: { baseUrl: endpoint.baseUrl }, access: 'confirm' }
      }))
      mkdirSync(join(p, 'chats'))
      writeFileSync(join(p, 'chats', `${sha1(OTHER)}.json`), JSON.stringify({
        path: OTHER, name: 'Other paper.pdf',
        conversations: [{
          id: 'o1', title: 'Metode', createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000,
          messages: [
            { role: 'user', text: 'Hvilken metode brukes?', images: [{ mediaType: 'image/png', dataBase64: 'SECRETPIXELS' }] },
            { role: 'assistant', parts: [{ text: 'Differanse-i-differanser med paneldata.', citations: [] }] }
          ]
        }]
      }))
    }
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')
    await waitFor(() => run(send, `return document.querySelectorAll('.pdf-page').length`), (n) => n > 0, 'the document')
    await run(send, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); await settle(600)`)
    await waitFor(() => run(send, `return !!document.querySelector('.ai-attach-convs')`), (v) => v, 'the composer')

    console.log('\n1. the picker attaches a conversation from another document')
    await run(send, `click(document.querySelector('.ai-attach-convs')); await settle(500)`)
    const offered = await waitFor(
      () => run(send, `return [...document.querySelectorAll('.ai-conv-pick')].map((l) => l.textContent)`),
      (v) => v.length > 0,
      'the picker rows'
    )
    check('the other document’s conversation is offered', offered.length === 1 && offered[0].includes('Metode') && offered[0].includes('Other paper.pdf'), JSON.stringify(offered))
    check('the picker says what leaves and to whom', /sendes til/.test(await run(send, `return document.querySelector('.ai-conv-picker-note').textContent`)))
    check('nothing is ticked for the reader', await run(send, `return [...document.querySelectorAll('.ai-conv-pick input')].every((i) => !i.checked)`))
    await run(send, `click(document.querySelector('.ai-conv-pick input')); await settle(200); click([...document.querySelectorAll('.ai-conv-picker-foot button')].at(-1)); await settle(400)`)
    const chipText = await run(send, `return chips()`)
    check('it shows as a chip above the composer', chipText.length === 1 && chipText[0] === 'Other paper.pdf: Metode', JSON.stringify(chipText))
    check('nothing has been sent yet', endpoint.bodies.length === 0)

    console.log('\n2. «Bekreft før deling» names the other document first')
    await run(send, `await ask('Hva er forskjellen på metodene?'); await settle(400)`)
    const strip = await run(send, `return document.querySelector('.ai-confirm')?.textContent ?? null`)
    check('the strip names the attached conversation’s document', !!strip && strip.includes('Other paper.pdf'), String(strip))
    check('still nothing sent', endpoint.bodies.length === 0)
    await run(send, `click([...document.querySelectorAll('.ai-confirm-actions button')].at(-1))`)
    await waitFor(() => Promise.resolve(endpoint.bodies.length), (n) => n >= 1, 'the request')

    console.log('\n3. what left the machine')
    const first = parts(endpoint.bodies[0])
    check('the system prompt carries the attached conversation, tagged', first.system.includes('[SAMTALE 1] About "Other paper.pdf"') && first.system.includes('Differanse-i-differanser med paneldata.'))
    check('…with the rules: the document is the only source', /only thing you cite as a source/.test(first.system))
    check('its image never travels', !first.raw.includes('SECRETPIXELS'))
    check('nothing of it is in the question or the document', !first.rest.includes('Differanse-i-differanser') && !first.rest.includes('SAMTALE'))

    console.log('\n4. the answer: a conversation chip beside the page chip')
    const answer = await waitFor(
      () => run(send, `const m = [...document.querySelectorAll('.right-pane .ai-assistant')].at(-1); return m ? { text: m.textContent, conv: m.querySelectorAll('.ai-chip-conversation').length, page: [...m.querySelectorAll('.ai-chip:not(.ai-chip-conversation)')].map((c) => c.textContent) } : null`),
      (v) => !!v && v.conv > 0,
      'the answer with its chips'
    )
    check('the [SAMTALE 1] tag became a «Samtale» chip', answer.conv === 1 && answer.text.includes('Samtale'))
    check('the document’s own source is a page chip', answer.page.includes('s. 3'), JSON.stringify(answer.page))
    check('no raw tag is shown', !answer.text.includes('[SAMTALE'))

    console.log('\n5. it rides along, is stored, and comes off')
    await run(send, `await ask('Og dataene?')`)
    await waitFor(() => Promise.resolve(endpoint.bodies.length), (n) => n >= 2, 'the follow-up')
    check('the follow-up carries it again, without asking again', parts(endpoint.bodies[1]).system.includes('[SAMTALE 1]'))
    const stored = await waitFor(
      () => run(send, `return (await window.api.getConversations(${JSON.stringify(HERE)}))[0]?.attached ?? []`),
      (v) => v.length === 1,
      'the stored attachment'
    )
    check('the conversation stores what is attached', stored[0].id === 'o1' && stored[0].docPath === OTHER)
    await waitFor(() => run(send, `return !document.querySelector('.ai-send')?.disabled || document.querySelectorAll('.right-pane .ai-assistant').length >= 2`), (v) => v, 'the follow-up answer')
    await sleep(600)
    await run(send, `click(document.querySelector('.ai-attach-conv .ai-attach-x')); await settle(300)`)
    check('the chip is off', (await run(send, `return chips()`)).length === 0)
    await run(send, `await ask('Og nå uten?')`)
    await waitFor(() => Promise.resolve(endpoint.bodies.length), (n) => n >= 3, 'the request without it')
    check('taken off, it is gone from the next request', !parts(endpoint.bodies[2]).system.includes('SAMTALE') && !endpoint.bodies[2].messages.some((m) => JSON.stringify(m).includes('paneldata')))

    console.log('\n6. the chip opens the conversation it names')
    await sleep(800)
    await run(send, `click(document.querySelector('.right-pane .ai-chip-conversation')); await settle(300)`)
    const opened = await waitFor(
      () => run(send, `return { tabs: [...document.querySelectorAll('.tab-label')].map((t) => t.textContent), panel: [...document.querySelectorAll('.right-pane .ai-messages')].map((e) => e.innerText).join(' | ') }`),
      (v) => v.tabs.some((t) => t.includes('Other paper')) && v.panel.includes('Hvilken metode brukes?'),
      'the other document on that conversation',
      25_000
    )
    check('the other document opened in a tab', opened.tabs.some((t) => t.includes('Other paper')), JSON.stringify(opened.tabs))
    check('…on the conversation the chip names', opened.panel.includes('Hvilken metode brukes?'))
  } finally {
    await app.cleanup()
    await endpoint.close()
  }
}

main()
  .catch((err) => {
    console.error(err)
    failures++
  })
  .finally(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall passed')
    process.exit(failures ? 1 : 0)
  })

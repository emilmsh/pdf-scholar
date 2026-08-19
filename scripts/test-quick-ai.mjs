// Proof, in the REAL desktop app, that the selection bubble behaves while it
// waits — the one AI surface no other test drives.
//
// It exists because of a bug none of the four test layers caught (v0.39,
// 2026-08-19): when the provider core learned to separate a model's reasoning
// stream from its answer, the panel was taught to ignore the reasoning and the
// bubble was not. Every reasoning model would have printed its private thinking
// into the bubble as if it were the explanation the user asked for. test:ai-chat
// tests the core, not who listens to it; test:assistant drives the panel, not
// the bubble. Only pressing «Forklar» in the app finds this.
//
// The provider here is the local fake endpoint (scripts/lib/fake-provider.mjs)
// pointed at by a throwaway profile, on the `long-reasoning` scenario: eight
// reasoning frames and then a short answer. Spacing its writes 1.5s apart holds
// the answer back past the ten-second wait hint, so the same run proves both
// halves — what the bubble must NOT show, and what it must.
//
// Run: npm run build && npm run test:quick-ai
// Desktop-session test (CDP against the built app); throwaway profile, never
// touches real state, no keys, no network beyond localhost.
import { writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'
import { startFakeProvider } from './lib/fake-provider.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PDF = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const PORT = 9347
/** Must match WAIT_HINT_S in src/renderer/src/ai.ts */
const WAIT_HINT_S = 10

let failures = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const fake = await startFakeProvider({ delayMs: 1500 })
const app = launchApp({
  root: ROOT,
  mainJs: join(ROOT, 'out', 'main', 'index.js'),
  args: [PDF],
  port: PORT,
  prepareProfile: (profile) =>
    writeFileSync(
      join(profile, 'pdfx-state.json'),
      JSON.stringify({
        settings: { language: 'nb' },
        // compat needs no key: a base URL and a model id are the whole setup
        ai: {
          provider: 'compat',
          models: { compat: 'self/long-reasoning' },
          compat: { baseUrl: fake.baseUrl }
        }
      })
    )
})

try {
  const targets = await waitForPageTargets(PORT, 1)
  const send = cdp(await openSocket(targets[0].webSocketDebuggerUrl))
  await send('Runtime.enable')

  const PRELUDE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const bubble = () => document.querySelector('.ai-quick')
    const bubbleText = () => bubble()?.textContent ?? ''
    const waitNote = () => document.querySelector('.ai-wait-note')
    const thinkingLine = () => document.querySelector('.ai-thinking')
  `

  // A real selection, raised the way a mouse would: the chip grid only appears
  // for a selection the app considers finished (pointerup, then selectionchange).
  const selection = await evaluate(
    send,
    `
    for (let i = 0; i < 100 && document.querySelectorAll('.textLayer span').length === 0; i++) await sleep(200)
    const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 12)
    const target = spans[1] ?? spans[0]
    const range = document.createRange()
    range.selectNodeContents(target)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const r = target.getBoundingClientRect()
    for (const type of ['pointerup', 'mouseup'])
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.right, clientY: r.bottom }))
    document.dispatchEvent(new Event('selectionchange'))
    for (let i = 0; i < 40 && document.querySelectorAll('.menu-ai-chip').length === 0; i++) await sleep(100)
    return {
      text: sel.toString().slice(0, 40),
      chips: [...document.querySelectorAll('.menu-ai-chip')].map((c) => c.textContent.trim())
    }
  `,
    PRELUDE
  )
  ok(selection.text.length > 0, `text selected ("${selection.text}")`)
  // The standing rule: no AI action may live only in a right-click menu
  ok(selection.chips.length >= 4, `the chip grid offers the AI actions (${selection.chips.join(', ')})`)

  // «Forklar» is the first chip. Asserted by position rather than by label so a
  // reworded chip is a copy change, not a broken test.
  await evaluate(
    send,
    `
    document.querySelectorAll('.menu-ai-chip')[0].click()
    for (let i = 0; i < 50 && !bubble(); i++) await sleep(100)
  `,
    PRELUDE
  )

  const early = await evaluate(
    send,
    `
    for (let i = 0; i < 40 && !thinkingLine(); i++) await sleep(100)
    return { line: thinkingLine()?.textContent ?? null, note: !!waitNote(), body: bubbleText() }
  `,
    PRELUDE
  )
  ok(early.line?.includes('Tenker') === true, `the bubble says it is thinking (got "${early.line}")`)
  ok(!early.note, 'no wait note before the threshold')

  // The reasoning stream is already arriving here — and must never be visible.
  // This is the regression the whole file exists for.
  const leaked = await evaluate(send, `return /INTERNAL-THOUGHT/.test(bubbleText())`, PRELUDE)
  ok(!leaked, 'the model’s reasoning is not printed into the bubble')

  // Past the threshold the wait becomes visible: a counter that ticks, and a
  // line saying the wait is a provider trait rather than a fault.
  const hint = await evaluate(
    send,
    `
    for (let i = 0; i < 160 && !waitNote(); i++) await sleep(100)
    return { line: thinkingLine()?.textContent ?? '', note: waitNote()?.textContent ?? null }
  `,
    PRELUDE
  )
  ok(hint.note !== null, `the wait note appears past ${WAIT_HINT_S}s (got "${hint.note}")`)
  const seconds = /·\s*(\d+)\s*s/.exec(hint.line)
  ok(seconds !== null && Number(seconds[1]) >= WAIT_HINT_S, `the counter shows the wait (got "${hint.line}")`)

  // …and gets out of the way the moment there is something real to read.
  const answered = await evaluate(
    send,
    `
    for (let i = 0; i < 200 && !/Kort svar til slutt/.test(bubbleText()); i++) await sleep(100)
    return { body: bubbleText(), note: !!waitNote(), thinking: !!thinkingLine(), leaked: /INTERNAL-THOUGHT/.test(bubbleText()) }
  `,
    PRELUDE
  )
  ok(/Kort svar til slutt/.test(answered.body), 'the answer arrives in the bubble')
  ok(!answered.note && !answered.thinking, 'counter and note disappear once the answer is there')
  ok(!answered.leaked, 'and the reasoning never appeared, start to finish')

  console.log(failures === 0 ? '\ntest-quick-ai: all checks passed' : `\ntest-quick-ai: ${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('test-quick-ai failed:', err instanceof Error ? err.message : String(err))
  console.error(app.log().slice(-2000))
  process.exitCode = 1
} finally {
  await app.cleanup()
  await fake.close()
  await sleep(100)
}

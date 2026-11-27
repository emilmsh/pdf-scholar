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

  // «Lagre som kommentar» (issue #137): the bubble is gone at the first Esc or
  // click outside, so the answer can be kept ON the passage it was asked about —
  // a highlight over the selection with the answer as its comment. The button
  // is the first in the action row (asserted by position, like the chip).
  const saved = await evaluate(
    send,
    `
    const marks = () => document.querySelectorAll('.annot-highlights > *').length
    const before = marks()
    const btn = bubble().querySelector('.ai-quick-actions button')
    const label = btn.textContent.trim()
    for (let i = 0; i < 100 && btn.disabled; i++) await sleep(100)
    const enabled = !btn.disabled
    btn.click()
    for (let i = 0; i < 40 && marks() === before; i++) await sleep(100)
    const again = bubble().querySelector('.ai-quick-actions button')
    const r = [...document.querySelectorAll('.annot-highlights > *')].at(-1)?.getBoundingClientRect()
    return {
      label, enabled, before, after: marks(),
      spent: again.disabled, bubbleOpen: !!bubble(),
      at: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    }
  `,
    PRELUDE
  )
  ok(saved.enabled, `the finished answer can be kept ("${saved.label}")`)
  ok(saved.after === saved.before + 1, `the selection is highlighted (${saved.before} → ${saved.after} marks)`)
  ok(saved.spent && saved.bubbleOpen, 'the bubble stays open and the button cannot make a second comment')

  // The comment is the answer: close the bubble and open the mark with a real click
  await evaluate(send, `Array.from(bubble().querySelectorAll('.ai-quick-actions button')).at(-1).click(); await sleep(200)`, PRELUDE)
  if (saved.at) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: saved.at.x, y: saved.at.y, button: 'left', clickCount: 1 })
  }
  const comment = await evaluate(
    send,
    `
    for (let i = 0; i < 40 && !document.querySelector('.annot-popover-text'); i++) await sleep(100)
    return document.querySelector('.annot-popover-text')?.value ?? null
  `,
    PRELUDE
  )
  ok(comment !== null && /Kort svar til slutt/.test(comment), `the mark carries the answer as its comment (got "${comment}")`)
  ok(comment !== null && !/INTERNAL-THOUGHT/.test(comment), 'and none of the reasoning')

  // The answer's SOURCES go into the comment too (issue #168). A comment is
  // plain text in the file, so a chip is kept as a «[s. 1]» with the cited
  // passage listed under the answer — and the app draws the marker as a chip
  // again and follows it. «Spør …» attaches the document, and the `answer`
  // scenario cites page 1; asked from page 2, so the jump can be seen.
  await evaluate(send, `await window.api.aiSetConfig({ models: { compat: 'self/answer' } })`, PRELUDE)
  const chipAt = await evaluate(
    send,
    `
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector('.annot-popover-text')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    for (let i = 0; i < 20 && document.querySelector('.annot-popover'); i++) await sleep(100)
    const page2 = () => document.querySelector('.pdf-page[data-page="2"]')
    page2().scrollIntoView()
    document.querySelector('.pages').dispatchEvent(new Event('scroll'))
    const spans = () => [...page2().querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 12)
    for (let i = 0; i < 100 && spans().length < 4; i++) await sleep(200)
    const target = spans()[3]
    const range = document.createRange()
    range.selectNodeContents(target)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const r = target.getBoundingClientRect()
    for (const type of ['pointerup', 'mouseup'])
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.right, clientY: r.bottom }))
    document.dispatchEvent(new Event('selectionchange'))
    for (let i = 0; i < 40 && !document.querySelector('.menu-ai-chip-wide'); i++) await sleep(100)
    const c = document.querySelector('.menu-ai-chip-wide').getBoundingClientRect()
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
  `,
    PRELUDE
  )
  // «Spør …» is the wide chip; its bubble first asks for the question. Chosen
  // and typed with REAL input events, because that is where it broke
  // (2026-11-27): the menu keeps the focus on the pages, the bubble mounts
  // hidden until measured, so `autoFocus` on its field was a no-op — and a
  // question typed straight away ran the viewer's one-key shortcuts instead.
  // «Hva …» hid every annotation (H), and the answer then kept as a comment
  // was a mark nobody could see. Dispatched clicks and a value set from script
  // never notice any of it.
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: chipAt.x, y: chipAt.y, button: 'left', clickCount: 1 })
  const focused = await evaluate(
    send,
    `
    for (let i = 0; i < 50 && !document.querySelector('.ai-quick-ask input'); i++) await sleep(100)
    await sleep(200)
    return document.activeElement === document.querySelector('.ai-quick-ask input')
  `,
    PRELUDE
  )
  ok(focused, 'the question field has the keyboard as soon as «Spør …» opens')
  for (const ch of 'Hva sier innledningen?') {
    if (/[a-z]/i.test(ch)) {
      const code = `Key${ch.toUpperCase()}`
      const vk = ch.toUpperCase().charCodeAt(0)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk })
    } else await send('Input.insertText', { text: ch })
  }
  const asked = await evaluate(
    send,
    `
    const typed = document.querySelector('.ai-quick-ask input')?.value ?? null
    const marksShown = document.querySelectorAll('.annot-highlights > *').length
    document.querySelector('.ai-quick-ask .ai-send').click()
    const save = () => bubble()?.querySelector('.ai-quick-actions button.btn-secondary')
    for (let i = 0; i < 300 && (!save() || save().disabled); i++) await sleep(100)
    return {
      typed, marksShown,
      chips: [...bubble().querySelectorAll('.ai-quick-body .ai-chip')].map((c) => c.textContent.trim()),
      error: bubble().querySelector('.ai-error')?.textContent ?? null,
      page: document.querySelector('.toolbar input').value
    }
  `,
    PRELUDE
  )
  ok(asked.typed === 'Hva sier innledningen?', `what is typed lands in the field (got "${asked.typed}")`)
  ok(asked.marksShown > 0, `and ran no shortcut: the marks are still shown (${asked.marksShown})`)
  ok(asked.error === null, `«Spør …» is answered (${asked.error ?? 'no error'})`)
  ok(asked.chips.length === 1 && /1/.test(asked.chips[0]), `the answer carries its source chip (${asked.chips.join(', ')})`)
  ok(asked.page === '2', `asked from page 2 (page field says ${asked.page})`)

  // A mark that was just made is SHOWN, also with the annotations hidden (H):
  // hidden, it existed in the Merknader tab and nowhere on the page.
  await evaluate(send, `document.querySelector('.pages').focus()`, PRELUDE)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'h', code: 'KeyH', text: 'h', unmodifiedText: 'h', windowsVirtualKeyCode: 72 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72 })
  const kept = await evaluate(
    send,
    `
    const marks = () => document.querySelectorAll('.annot-highlights > *').length
    await sleep(300)
    const hidden = marks() === 0
    // The new mark is page 2's first; the pages come back from hidden a
    // render later, so wait for it rather than read at once
    const here = () => [...document.querySelectorAll('.pdf-page[data-page="2"] .annot-highlights > *')]
    bubble().querySelector('.ai-quick-actions button.btn-secondary').click()
    for (let i = 0; i < 60 && here().length === 0; i++) await sleep(100)
    const r = here().at(-1)?.getBoundingClientRect()
    Array.from(bubble().querySelectorAll('.ai-quick-actions button')).at(-1).click()
    await sleep(200)
    return { hidden, made: here().length === 1, shownAgain: marks() >= ${asked.marksShown} + 1, at: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }
  `,
    PRELUDE
  )
  ok(kept.hidden, 'H hides the marks')
  ok(kept.made && kept.at !== null, 'the cited answer is kept as a comment on the selection — and shown, though the marks were hidden')
  ok(kept.shownAgain, 'with the marks that were there before')
  if (kept.at) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: kept.at.x, y: kept.at.y, button: 'left', clickCount: 1 })
  }
  const sourced = await evaluate(
    send,
    `
    for (let i = 0; i < 40 && !document.querySelector('.annot-popover-text'); i++) await sleep(100)
    const text = document.querySelector('.annot-popover-text')?.value ?? null
    const chip = document.querySelector('.annot-popover .comment-source')
    const label = chip?.textContent.trim() ?? null
    const tip = chip?.title ?? ''
    // A real pointer must reach the chip: it sits in the bubble's last row
    const c = chip?.getBoundingClientRect()
    const reachable = !!c && document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) === chip
    chip?.click()
    for (let i = 0; i < 50 && document.querySelector('.toolbar input').value !== '1'; i++) await sleep(100)
    return {
      text, label, tip, reachable,
      page: document.querySelector('.toolbar input').value,
      bubbleGone: !document.querySelector('.annot-popover')
    }
  `,
    PRELUDE
  )
  ok(
    sourced.text !== null && sourced.text.startsWith('Hva sier innledningen?') && /Dokumentet slår an tonen tidlig\. \[s\. 1\]/.test(sourced.text),
    `the comment reads question, answer and «[s. 1]» where the chip stood (got "${sourced.text}")`
  )
  ok(
    sourced.text !== null && /\n\[s\. 1\] «Innledningen setter rammen»$/.test(sourced.text),
    'and lists the cited passage under the answer, word for word'
  )
  ok(sourced.label !== null && /1/.test(sourced.label) && sourced.reachable, `the comment bubble draws the marker as a chip a pointer reaches (${sourced.label})`)
  ok(/Innledningen setter rammen/.test(sourced.tip), 'whose hover shows the passage')
  ok(sourced.page === '1' && sourced.bubbleGone, `pressing it goes to the cited page and puts the bubble away (page ${sourced.page})`)

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

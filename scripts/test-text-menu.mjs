// Proof, in the REAL desktop app, that text outside the pages can be copied.
//
// Electron ships no context menu: a right-click nobody handles does nothing,
// and until 2026-09-08 that was every surface but the pages, the tab strip and
// the sidebar header — the assistant's answers could be selected but never
// copied the way a Windows user copies anything. TextContextMenu is the
// fallback; this drives it with REAL right-clicks (Input.dispatchMouseEvent, so
// the contextmenu event is the browser's own) and checks the two things that
// matter: it appears where nothing else owns the click, and NEVER alongside the
// pages' own selection menu (Emil: two menus at once is the failure mode).
//
// Run: npm run build && npm run test:text-menu
// Desktop-session test (CDP against the built app); throwaway profile.
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PDF = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const PORT = 9351

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

  const PRELUDE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const menus = () => ({
      text: !!document.querySelector('.text-menu'),
      selection: !!document.querySelector('.selection-menu'),
      tab: !!document.querySelector('.tab-menu')
    })
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
    const items = () => [...document.querySelectorAll('.text-menu .menu-item')].map((b) => b.textContent.trim() + (b.disabled ? ' (av)' : ''))
  `
  const rightClick = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: 2, clickCount: 1 })
    await sleep(150)
  }
  const leftClick = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(150)
  }

  // Wait for the pages, then plant a text block + a textarea that stand in for
  // the surfaces without their own menu (an assistant answer, a comment field).
  await evaluate(
    send,
    `
    for (let i = 0; i < 100 && document.querySelectorAll('.textLayer span').length === 0; i++) await sleep(200)
    const host = document.createElement('div')
    host.id = 'probe'
    host.style.cssText = 'position:fixed;left:24px;top:120px;z-index:9;background:white;padding:8px;width:260px'
    host.innerHTML = '<div class="ai-msg"><p id="probe-text">Attention is a function of queries and keys.</p></div><textarea id="probe-field" style="width:240px">draft text in a field</textarea>'
    document.body.appendChild(host)
  `,
    PRELUDE
  )

  // 1. Right-click on plain text, nothing selected: the menu, copy greyed out
  let pos = await evaluate(send, `return centre(document.getElementById('probe-text'))`, PRELUDE)
  await rightClick(pos.x, pos.y)
  let state = await evaluate(send, `const m = menus(); return { text: m.text, selection: m.selection, tab: m.tab, items: items() }`, PRELUDE)
  ok(state.text && !state.selection, `right-click on text opens the text menu alone (${JSON.stringify(state)})`)
  ok(state.items.some((i) => /^Kopier \(av\)$/.test(i)), `copy is greyed out with nothing selected (${state.items.join(' · ')})`)
  ok(!state.items.some((i) => /Lim inn|Klipp ut/.test(i)), 'no cut/paste outside a text field')

  // «Marker alt» takes the whole message block and closes the menu
  await evaluate(send, `const all = [...document.querySelectorAll('.text-menu .menu-item')]; all.find((b) => b.textContent.includes('Marker alt')).click()`, PRELUDE)
  let sel = await evaluate(send, `const m = menus(); return { text: getSelection().toString(), textMenu: m.text, selection: m.selection, tab: m.tab }`, PRELUDE)
  ok(sel.text.includes('queries and keys'), `«Marker alt» selected the block ("${sel.text.slice(0, 30)}…")`)
  ok(!sel.textMenu && !sel.selection && !sel.tab, 'the menu closed after the action')

  // 2. Right-click on the selection: copy is live and lands on the clipboard
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `const m = menus(); return { text: m.text, selection: m.selection, tab: m.tab, items: items() }`, PRELUDE)
  ok(state.text && state.items.includes('Kopier'), `copy is offered for a selection (${state.items.join(' · ')})`)
  await evaluate(send, `await navigator.clipboard.writeText('sentinel'); const all = [...document.querySelectorAll('.text-menu .menu-item')]; all.find((b) => b.textContent === 'Kopier').click()`, PRELUDE)
  await sleep(200)
  let clip = await evaluate(send, `return await navigator.clipboard.readText()`, PRELUDE)
  ok(clip.includes('queries and keys'), `«Kopier» put the selection on the clipboard ("${clip.slice(0, 30)}…")`)

  // 3. Ctrl+C on a selection works with no menu at all (Emil was not sure it did)
  await evaluate(send, `await navigator.clipboard.writeText('sentinel')`, PRELUDE)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await sleep(200)
  clip = await evaluate(send, `return await navigator.clipboard.readText()`, PRELUDE)
  ok(clip.includes('queries and keys'), `Ctrl+C copies the selection ("${clip.slice(0, 30)}…")`)

  // 4. Inside a text field: cut and paste appear, paste inserts the clipboard
  pos = await evaluate(send, `const f = document.getElementById('probe-field'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); return centre(f)`, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `const m = menus(); return { text: m.text, selection: m.selection, tab: m.tab, items: items() }`, PRELUDE)
  ok(state.text && state.items.some((i) => i.startsWith('Lim inn')) && state.items.some((i) => i.startsWith('Klipp ut')), `a text field gets cut and paste (${state.items.join(' · ')})`)
  await evaluate(send, `await navigator.clipboard.writeText(' +pasted'); const all = [...document.querySelectorAll('.text-menu .menu-item')]; all.find((b) => b.textContent === 'Lim inn').click()`, PRELUDE)
  await sleep(300)
  let value = await evaluate(send, `return document.getElementById('probe-field').value`, PRELUDE)
  // The right-click itself moves the caret to the click point (as in any
  // browser), so the text lands mid-field — what matters is that it landed.
  ok(value.includes('+pasted') && value.includes('draft text'), `«Lim inn» inserted the clipboard into the field ("${value}")`)

  // 5. Never two menus: a right-click on the PAGE opens the pages' own menu only
  await evaluate(send, `getSelection().removeAllRanges(); document.getElementById('probe').remove()`, PRELUDE)
  pos = await evaluate(send, `const s = [...document.querySelectorAll('.textLayer span')].find((x) => x.textContent.trim().length > 12); s.scrollIntoView({ block: 'center' }); await sleep(300); return centre(s)`, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `return menus()`, PRELUDE)
  ok(state.selection && !state.text, `a right-click on the page opens the page menu and NOT the text menu (${JSON.stringify(state)})`)
  // …and while the page menu STAYS open, text in the chat can still be selected
  // and copied: the two menus are independent, one right-click opens one
  // (Emil, 2026-09-08 — the page menu must not be lost to a copy from the chat)
  await evaluate(send, `
    const host = document.createElement('div'); host.id = 'probe2'
    host.style.cssText = 'position:fixed;right:24px;top:160px;z-index:9;background:white;padding:8px;width:220px'
    host.innerHTML = '<div class="ai-msg"><p id="probe2-text">Chat answer to copy while the page menu stands.</p></div>'
    document.body.appendChild(host)
    const r = document.createRange(); r.selectNodeContents(document.getElementById('probe2-text'))
    getSelection().removeAllRanges(); getSelection().addRange(r)
  `, PRELUDE)
  pos = await evaluate(send, `return centre(document.getElementById('probe2-text'))`, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `const m = menus(); return { text: m.text, selection: m.selection, tab: m.tab, items: items() }`, PRELUDE)
  ok(state.text && state.selection, `right-click on selected chat text opens the text menu while the page menu stays (${JSON.stringify({ text: state.text, selection: state.selection })})`)
  await evaluate(send, `await navigator.clipboard.writeText('sentinel'); const all = [...document.querySelectorAll('.text-menu .menu-item')]; all.find((b) => b.textContent === 'Kopier').click()`, PRELUDE)
  await sleep(200)
  clip = await evaluate(send, `return await navigator.clipboard.readText()`, PRELUDE)
  state = await evaluate(send, `return menus()`, PRELUDE)
  ok(clip.includes('Chat answer to copy'), `«Kopier» took the chat text ("${clip.slice(0, 30)}…")`)
  ok(!state.text && state.selection, `the text menu closed, the page menu is still standing (${JSON.stringify(state)})`)
  await evaluate(send, `document.getElementById('probe2').remove()`, PRELUDE)

  // …but a text field INSIDE the pages container (a margin comment) gets the
  // text menu, not the page menu: the container yields text fields
  await leftClick(pos.x, pos.y)
  await sleep(200)
  pos = await evaluate(send, `
    const pages = document.querySelector('.textLayer').closest('[data-dockey]')
    const f = document.createElement('textarea'); f.id = 'probe-inner'; f.value = 'a comment'
    f.style.cssText = 'position:absolute;left:40px;top:40px;z-index:20;width:160px'
    pages.appendChild(f)
    return centre(f)
  `, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `const m = menus(); return { text: m.text, selection: m.selection, tab: m.tab, items: items() }`, PRELUDE)
  ok(state.text && !state.selection && state.items.some((i) => i.startsWith('Lim inn')), `a text field inside the pages gets the text menu with paste, not the page menu (${JSON.stringify(state)})`)
  await evaluate(send, `document.getElementById('probe-inner').remove()`, PRELUDE)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(150)
  // …and a right-click on a tab opens the tab menu only
  await leftClick(pos.x, pos.y)
  await sleep(200)
  pos = await evaluate(send, `return centre(document.querySelector('.tab-label'))`, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `return menus()`, PRELUDE)
  ok(state.tab && !state.text && !state.selection, `a right-click on a tab opens the tab menu alone (${JSON.stringify(state)})`)
  // …and an icon button gets no menu at all
  await leftClick(pos.x, pos.y)
  await sleep(200)
  pos = await evaluate(send, `return centre(document.querySelector('.toolbar button svg') ?? document.querySelector('.tab-new'))`, PRELUDE)
  await rightClick(pos.x, pos.y)
  state = await evaluate(send, `return menus()`, PRELUDE)
  ok(!state.text && !state.selection && !state.tab, `a right-click on a toolbar button opens nothing (${JSON.stringify(state)})`)
} finally {
  app.cleanup()
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ntext menu: all checks passed')

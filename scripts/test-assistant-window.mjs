// End-to-end test of the detached assistant: the chat panel leaves the viewer
// and lives in its own window, and the two windows keep talking.
//
//   npm run test:assistant        (needs `npm run build` first)
//
// Why a real-app test: the promise spans the renderer panel, main's
// createAssistantWindow, the assistant:jump relay routed via openDocs, and the
// receiving viewer's scroll/flash — none of which exists below the app. With
// provider `mock` (the offline provider main's chat core ships for exactly
// this) the whole flow runs keyless:
//   detach button -> a chat-only window (no pages, its own title, no detach
//   button of its own) while the docked panel closes; a question streams an
//   answer with citation chips; a chip click scrolls AND flash-highlights the
//   passage in the viewer window; the docked panel reopened later lists the
//   same conversation (shared store + storage-event refresh); and closing the
//   assistant window records its bounds under state.assistantWindow WITHOUT
//   touching the main window's saved bounds.
import { existsSync, copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, listPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9336
const FILE = join(tmpdir(), 'pdfx-assistant-test.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------- in-page UI helpers

/** Injected into every evaluate. The title regexes match both app languages —
 *  a throwaway profile resolves language 'auto' from the machine it runs on. */
const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ui = {
  settle,
  /** Toggle the AI panel exactly as the user does (the bare-letter shortcut) */
  async toggleAiPanel() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await settle(500);
  },
  panelOpen() {
    return !!document.querySelector('.right-panel.open');
  },
  headerBtn(re) {
    return [...document.querySelectorAll('.ai-header .tb-btn')].find((b) => re.test(b.title || ''));
  },
  /** Type into the composer through React's own value setter and send */
  async ask(question) {
    const ta = document.querySelector('.ai-composer textarea');
    if (!ta) throw new Error('no composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, question);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    const send = document.querySelector('.ai-send');
    if (!send || send.disabled) throw new Error('send button missing or disabled');
    click(send);
  },
  async waitFor(selector, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector(selector)) return true;
      await settle(200);
    }
    return false;
  }
};
`

const evalIn = (send, body) => evaluate(send, body, PRELUDE)

/** Attach Runtime to a target and wait until a selector exists in its page */
async function attach(target) {
  const ws = await openSocket(target.webSocketDebuggerUrl)
  const send = cdp(ws)
  await send('Runtime.enable')
  return { ws, send }
}

// ---------------------------------------------------------------------- main

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
copyFileSync(join(ROOT, 'src', 'renderer', 'public', 'sample.pdf'), FILE)

// The profile remembers the assistant window on a display that no longer
// exists (y −20000 — no real monitor arrangement reaches it). v0.38.0 restored
// those coordinates blindly and the window opened with nothing visible
// anywhere; the detach below must land it on a live display instead.
const app = launchApp({
  root: ROOT,
  mainJs,
  args: [FILE],
  port: PORT,
  prepareProfile: (dir) =>
    writeFileSync(
      join(dir, 'pdfx-state.json'),
      JSON.stringify({ assistantWindow: { x: 300, y: -20000, width: 574, height: 915 } })
    )
})
const sockets = []

try {
  // ---- viewer window A on the document
  const [targetA] = await waitForPageTargets(PORT, 1)
  const A = await attach(targetA)
  sockets.push(A.ws)
  for (let i = 0; i < 60; i++) {
    if (await evalIn(A.send, `return !!document.querySelector('.pdf-page canvas')`)) break
    await sleep(500)
  }
  check('window A opened the document', true)

  // Keyless run: the offline mock provider, set through the same config IPC
  // the settings UI uses (config is app-global in main, so the assistant
  // window inherits it).
  await evalIn(A.send, `await window.api.aiSetConfig({ provider: 'mock' })`)

  // ---- detach: the panel's own header button
  await evalIn(A.send, `await ui.toggleAiPanel()`)
  check('the docked panel opened', await evalIn(A.send, `return ui.panelOpen()`))
  const hasDetach = await evalIn(
    A.send,
    `const b = ui.headerBtn(/eget vindu|its own window/i); if (b) click(b); return !!b`
  )
  check('the header has a detach button and it was clicked', hasDetach)

  const targets = await waitForPageTargets(PORT, 2)
  const targetB = targets.find((t) => t.id !== targetA.id)
  check('a second window opened', !!targetB)
  if (!targetB) throw new Error('no assistant window appeared')
  check("the assistant window's URL names the document", (targetB.url || '').includes('assistant='))

  const B = await attach(targetB)
  sockets.push(B.ws)
  check('assistant window shows the chat shell', await evalIn(B.send, `return await ui.waitFor('.assistant-window .ai-panel')`))
  // The seeded phantom position must not be restored verbatim: the window has
  // to intersect the display it reports as its own (screen.avail* is the live
  // monitor Windows assigned it to — at y −20000 the two rects cannot meet).
  const onScreen = await evalIn(
    B.send,
    `const r = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
     const a = { x: screen.availLeft, y: screen.availTop, w: screen.availWidth, h: screen.availHeight };
     return { hit: r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y, r, a };`
  )
  check(
    'bounds remembered on a dead display are clamped onto a live one',
    onScreen.hit,
    `window=${JSON.stringify(onScreen.r)} display=${JSON.stringify(onScreen.a)}`
  )
  check(
    'the assistant window mounts no pages',
    (await evalIn(B.send, `return document.querySelectorAll('.pdf-page').length`)) === 0
  )
  const bTitle = await evalIn(B.send, `return document.title`)
  check('the window titles itself with the document name', bTitle.includes('pdfx-assistant-test.pdf'), bTitle)
  check(
    'no detach button inside the detached window',
    !(await evalIn(B.send, `return !!ui.headerBtn(/eget vindu|its own window/i)`))
  )
  check('the docked panel closed behind the detach', !(await evalIn(A.send, `return ui.panelOpen()`)))

  // ---- a question streams an answer with citation chips (mock provider)
  await evalIn(B.send, `await ui.ask('Hva handler dokumentet om?')`)
  check('an answer arrived', await evalIn(B.send, `return await ui.waitFor('.ai-msg.ai-assistant')`))
  check('the answer carries citation chips', await evalIn(B.send, `return await ui.waitFor('.ai-chip')`))

  // ---- chip click -> the VIEWER window scrolls and flash-highlights
  await evalIn(B.send, `click(document.querySelectorAll('.ai-chip')[1] ?? document.querySelector('.ai-chip'))`)
  check(
    "the viewer window flash-highlights the cited passage",
    await evalIn(A.send, `return await ui.waitFor('.search-hit.cite-flash', 15000)`)
  )
  check(
    'no «document not open» toast in the assistant',
    !(await evalIn(B.send, `return !!document.querySelector('.assistant-toast')`))
  )

  // ---- the docked panel reopened shows the same conversation (shared store)
  await evalIn(A.send, `await ui.toggleAiPanel()`)
  const histShown = await evalIn(
    A.send,
    `const b = ui.headerBtn(/historikk|history/i); if (!b) return false; click(b); await settle(400);
     return document.querySelectorAll('.ai-history-item').length > 0`
  )
  check('the reopened docked panel lists the assistant-window conversation', histShown)

  // ---- closing the assistant window records ITS bounds, not the main window's
  // The page destroys its own context here, so the CDP response may never
  // arrive (awaiting it once hung a run for its full timeout) — fire without
  // awaiting; the target poll below is the real confirmation.
  evalIn(B.send, `window.close()`).catch(() => {})
  let remaining = []
  for (let i = 0; i < 25; i++) {
    remaining = await listPageTargets(PORT)
    if (remaining.length === 1) break
    await sleep(400)
  }
  check('the assistant window closed; the viewer lives on', remaining.length === 1)
  await sleep(1500) // the close handler's state write happens around target teardown
  const state = JSON.parse(readFileSync(join(app.profile, 'pdfx-state.json'), 'utf8'))
  check(
    'the assistant bounds landed under their own key',
    !!state.assistantWindow && state.assistantWindow.width < 700,
    `assistantWindow=${JSON.stringify(state.assistantWindow ?? null)}`
  )
  check(
    "the main window's saved bounds were not touched",
    state.window === undefined,
    `window=${JSON.stringify(state.window ?? null)}`
  )
} catch (err) {
  failures++
  console.log(`FAIL  ${err.message}`)
  const log = app.log().trim()
  if (log) console.error(`--- app output ---\n${log}`)
} finally {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* already gone */
    }
  }
  await app.cleanup()
  try {
    unlinkSync(FILE)
  } catch {
    /* a leftover temp pdf is harmless */
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)

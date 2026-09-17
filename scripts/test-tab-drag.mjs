// The tab-drag GATE in the built app (`npm run test:tab-drag`, after `npm run build`).
//
// A tab dragged by the mouse becomes a native OS file drag (main's
// webContents.startDrag) so it can be dropped into another window, a browser's
// upload field, an e-mail. That drag loop ends when the mouse button that was
// down at its start is released — and called with NO button down it never
// returns: main is wedged for good, no IPC, no DevTools, Task Manager only
// (measured 2026-09-17 with a synthetic dragstart against the built app).
// Electron has no API to check the button, so the strip's own record of the
// pointerdown before the drag is the whole guard. This test is that guard's
// regression net: touch, pen, a buttonless mouse and a dragstart with no
// pointer at all must every one stay on the in-window HTML5 drag, and main must
// answer IPC after each. The native drag itself is NOT driven here — it needs a
// really held mouse button, which no CDP call provides — so a real mouse drag
// into another window stays a hand check before a release.
import { existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9352
const FILE = join(tmpdir(), 'pdfx-tab-drag-test.pdf')
const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js missing — run `npm run build` first')
  process.exit(1)
}
copyFileSync(join(ROOT, 'src', 'renderer', 'public', 'sample.pdf'), FILE)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
/** A wedged main never answers — every call that crosses IPC gets a deadline */
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms — main is blocked`)), ms)
    )
  ])

const app = launchApp({ root: ROOT, mainJs, args: [FILE], port: PORT })
const sockets = []
try {
  const [target] = await waitForPageTargets(PORT, 1)
  const ws = await openSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  const A = cdp(ws)
  await A('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    const r = await A('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page canvas')`,
      returnByValue: true
    })
    if (r.result?.value) break
    await sleep(500)
  }
  check('the window opened the document', true)

  const mainAlive = async (label) => {
    const ms = await withTimeout(
      evaluate(A, `const t0 = Date.now(); await window.api.getVersion(); return Date.now() - t0`),
      4000,
      'IPC round trip'
    ).catch((e) => e.message)
    check(`main answers IPC ${label}`, typeof ms === 'number', String(ms))
  }
  await mainAlive('at start')

  // ---- 1. the gate, per pointer kind: a pointerdown of that kind, then the
  //         dragstart the browser would fire. Only mouse + left button may
  //         cancel the HTML5 drag in favour of the native one — and that case is
  //         deliberately NOT dispatched here (see the header).
  // The opt-out modifier is the platform's primary one (Ctrl, Cmd on macOS) —
  // never Shift, which Chromium reads as «extend the selection» and starts no
  // drag from at all
  const MOD = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'
  const gate = (pointerType, pdButtons, dsButtons, mod = false) =>
    withTimeout(
      evaluate(
        A,
        `
        const tab = document.querySelector('.tab');
        if (!tab) return { error: 'no tab' };
        tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: ${JSON.stringify(pointerType)}, buttons: ${pdButtons}, button: 0, isPrimary: true, ${MOD}: ${mod} }));
        const dt = new DataTransfer();
        // Chromium reports buttons: 0 on real drag events — the gate must not read it
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, buttons: ${dsButtons}, ${MOD}: ${mod} });
        tab.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r, 200));
        return { prevented: ev.defaultPrevented, hadOurType: dt.types.includes('application/x-pdf-scholar-tab'), hadText: dt.types.includes('text/plain'), tabs: document.querySelectorAll('.tab').length };
      `
      ),
      6000,
      `${pointerType} dragstart`
    )

  const touch = await gate('touch', 1, 0)
  check('touch keeps the HTML5 drag (dragstart not cancelled, our MIME set)', touch.prevented === false && touch.hadOurType, JSON.stringify(touch))
  check('the in-window drag carries no text/plain (nothing to paste into a foreign text field)', touch.hadText === false, JSON.stringify(touch))
  await mainAlive('after a touch drag')

  // Ctrl/Cmd + a real mouse press: the opt-out into the in-app move. The one
  // mouse case that may be dispatched here — without the modifier it would
  // start the native drag, which no CDP call can end.
  const modded = await gate('mouse', 1, 0, true)
  check(`${MOD} + mouse keeps the HTML5 drag (the in-app move / tear-off)`, modded.prevented === false && modded.hadOurType, JSON.stringify(modded))
  await mainAlive('after a modifier+mouse drag')

  const pen = await gate('pen', 1, 0)
  check('pen keeps the HTML5 drag', pen.prevented === false && pen.hadOurType, JSON.stringify(pen))
  await mainAlive('after a pen drag')

  const noButton = await gate('mouse', 0, 0)
  check('a mouse with no button down keeps the HTML5 drag', noButton.prevented === false, JSON.stringify(noButton))
  await mainAlive('after a buttonless mouse drag')

  const orphan = await withTimeout(
    evaluate(
      A,
      `
      const tab = document.querySelector('.tab');
      const dt = new DataTransfer();
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, buttons: 1 });
      tab.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 200));
      return { prevented: ev.defaultPrevented, tabs: document.querySelectorAll('.tab').length };
    `
    ),
    6000,
    'dragstart without a pointerdown'
  )
  check('a dragstart with no pointerdown before it keeps the HTML5 drag', orphan.prevented === false, JSON.stringify(orphan))
  await mainAlive('after a dragstart without a pointer')
  check('the tab is still open after the four probes', orphan.tabs === 1, `tabs=${orphan.tabs}`)

  // ---- 2. a landing report with no drag in flight is inert (main matches it
  //         against the drag in flight, and there is none)
  await evaluate(A, `window.api.fileDropLanded(${JSON.stringify(FILE)}); await new Promise((r) => setTimeout(r, 300)); return true`)
  const tabsAfter = await evaluate(A, `return document.querySelectorAll('.tab').length`)
  check('a stray file:drop-landed changes nothing', tabsAfter === 1, `tabs=${tabsAfter}`)

  // ---- 3. the HTML5 path's end: dragend runs main's cursor hit-test. The REAL
  //         cursor is wherever the person running this left it — inside the
  //         test window ('same', the tab stays) or outside ('new', torn off
  //         into a second window on the same path, the source tab closes). Both
  //         are the fallback working; a hang is the failure.
  const ended = await withTimeout(
    evaluate(
      A,
      `
      const tab = document.querySelector('.tab');
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
      await new Promise((r) => setTimeout(r, 1200));
      return { tabs: document.querySelectorAll('.tab').length, dragging: !!document.querySelector('.tab.dragging') };
    `
    ),
    8000,
    'dragend hit-test'
  )
  const windows = await waitForPageTargets(PORT, ended.tabs === 0 ? 2 : 1, 8000).catch(() => [])
  check(
    'dragend → cursor hit-test: the tab stays (cursor over the window) or moves to a new window (cursor outside)',
    (ended.tabs === 1 && windows.length === 1) || (ended.tabs === 0 && windows.length >= 2),
    `tabs=${ended.tabs} windows=${windows.length}`
  )
  check('the dragging state is cleared after dragend', ended.dragging === false)
  await mainAlive('at the end')

  check('main logged no tab:drag-file failure', !/tab:drag-file failed/.test(app.log()))
} catch (err) {
  console.error('ERROR', err)
  failures++
} finally {
  for (const s of sockets) {
    try {
      s.close()
    } catch {
      /* already closed */
    }
  }
  await app.cleanup()
  if (existsSync(FILE)) {
    try {
      unlinkSync(FILE)
    } catch {
      /* a leftover temp file is harmless */
    }
  }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed')
process.exit(failures ? 1 : 0)

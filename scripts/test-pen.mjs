// Pen and finger, in the real app.
//
//   npm run test:pen      (needs `npm run build` first)
//
// What a Surface owner's hand will actually do, driven without the hardware:
// a pen (CDP pointerType 'pen' + synthetic PointerEvents with pressure) must
// DRAW — with pressure varying the width — and its arrival must flip the
// finger over to navigation; a finger must then SCROLL, not draw; the pen's
// eraser end must erase whatever tool is armed; and the «Tegner»-toggle in
// the tool menu must hand drawing back to the finger. Asserted against the
// app's own geometry (the rendered outline, the scroll position, the stored
// prefs), never against "the event was dispatched".
import { existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9338
const FILE = join(tmpdir(), 'pdfx-pen-test.pdf')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------- in-page UI helpers

const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const btn = (prefix) =>
  [...document.querySelectorAll('.tb-btn')].find((b) => (b.title || '').startsWith(prefix));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ui = {
  settle,
  pages() {
    const el = document.querySelector('.pages[data-pane="a"]');
    if (!el) throw new Error('no pages container');
    return el;
  },
  layer() {
    const el = document.querySelector('.pages[data-pane="a"] .draw-layer');
    if (!el) throw new Error('no draw layer (tool not armed?)');
    return el;
  },
  /** Ink marks on the first page, as render facts we can compare */
  inkMarks() {
    return [...document.querySelectorAll('.pages[data-pane="a"] .annot-marks path')].map((p) => {
      const d = p.getAttribute('d') || '';
      return { fill: p.getAttribute('fill'), stroke: p.getAttribute('stroke'), closed: d.trim().endsWith('Z') };
    });
  },
  /** y-spread of the LAST ink outline near its left vs right end — pressure
   *  variance made geometry, or it did not. Parsed from the path itself. */
  outlineSpread() {
    const paths = [...document.querySelectorAll('.pages[data-pane="a"] .annot-marks path')];
    const d = paths[paths.length - 1]?.getAttribute('d') || '';
    const pts = [...d.matchAll(/([\\d.,-]+) ([\\d.,-]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (pts.length < 8) return null;
    const xs = pts.map((p) => p[0]);
    const min = Math.min(...xs), max = Math.max(...xs), band = (max - min) * 0.12;
    const spread = (sel) => {
      const ys = pts.filter(sel).map((p) => p[1]);
      return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
    };
    return { left: spread((p) => p[0] <= min + band), right: spread((p) => p[0] >= max - band) };
  },
  /** Arm the pen tool via its toolbar button */
  async armPen() {
    const pen = btn('Penn');
    if (!pen) throw new Error('no pen button');
    if (!pen.classList.contains('is-active')) { click(pen); await settle(350); }
  },
  /** Draw with synthetic pen PointerEvents carrying a pressure ramp — a
   *  STRAIGHT horizontal line, so the outline's y-spread at each end measures
   *  the stroke's thickness and nothing else. Returns the client coords of the
   *  stroke's midpoint (for the eraser to hit). */
  async penStroke(y0, ramp) {
    const layer = this.layer();
    const r = this.pages().getBoundingClientRect();
    const x = Math.round(r.left + 60);
    const y = Math.round(r.top + y0);
    const P = (type, dx, pressure, extra = {}) => layer.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 61, isPrimary: true, pointerType: 'pen',
      button: 0, buttons: 1, clientX: x + dx, clientY: y, pressure, ...extra
    }));
    P('pointerdown', 0, ramp ? 0.2 : 0.5);
    for (let i = 1; i <= 20; i++) P('pointermove', i * 9, ramp ? 0.2 + (0.7 * i) / 20 : 0.5);
    P('pointerup', 180, 0, { buttons: 0 });
    await settle(900);
    return { x: x + 90, y };
  },
  /** The pen's eraser end: buttons bit 32, button 5 */
  async eraserEnd(at) {
    const layer = this.layer();
    const opt = { bubbles: true, cancelable: true, pointerId: 63, isPrimary: true,
      pointerType: 'pen', clientX: at.x, clientY: at.y };
    layer.dispatchEvent(new PointerEvent('pointerdown', { ...opt, button: 5, buttons: 32 }));
    layer.dispatchEvent(new PointerEvent('pointerup', { ...opt, button: 5, buttons: 0 }));
    await settle(800);
  },
  prefs() {
    return JSON.parse(localStorage.getItem('pdfx-tool-prefs') || '{}').input ?? null;
  }
};
`

const evalIn = (send, body) => evaluate(send, body, PRELUDE)

/** A CDP call the renderer never acknowledges (a dispatch can hang when the
 *  page is mid-navigation) must FAIL the run, not hang it forever. */
const withTimeout = (promise, label, ms = 15000) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP call timed out: ${label}`)), ms))
  ])

/** CDP touch drag: start → moves → end, straight line, ~real spacing */
async function touchDrag(A, from, to, steps = 8) {
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 4, radiusY: 4, force: 0.5 }]
  await A('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) })
  for (let i = 1; i <= steps; i++) {
    await A('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    })
    await sleep(16)
  }
  await A('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

// ---------------------------------------------------------------------- main

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
copyFileSync(SAMPLE, FILE)

const app = launchApp({ root: ROOT, mainJs, args: [FILE], port: PORT })
const sockets = []

try {
  const [target] = await waitForPageTargets(PORT, 1)
  const ws = await openSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  const send = cdp(ws)
  const A = (method, params) => withTimeout(send(method, params), method)
  await A('Runtime.enable')
  await A('Page.enable')
  // Make the page touch-capable for the whole run: CDP touch events need it,
  // and after the reload below the tool menus must show their touch rows
  // (module-level navigator.maxTouchPoints is read once per page load).
  await A('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await A('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 })"
  })

  let ready = false
  for (let i = 0; i < 80; i++) {
    const r = await A('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page .text-host .textLayer span')`,
      returnByValue: true
    })
    if (r.result?.value) { ready = true; break }
    await sleep(500)
  }
  check('the document opened with a text layer', ready)
  if (!ready) throw new Error('no text layer')

  // ---- 1. a pen draws, with pressure in the geometry ----
  await evalIn(A, `await ui.armPen()`)
  const mid = await evalIn(A, `return await ui.penStroke(240, true)`)
  const afterPen = await evalIn(A, `return ui.inkMarks()`)
  check('the pen stroke landed', afterPen.length === 1, `${afterPen.length} mark(s)`)
  const m0 = afterPen[0] ?? {}
  check('it is a filled outline (pressure), not a stroked line',
    m0.fill && m0.fill !== 'none' && !m0.stroke && m0.closed === true, JSON.stringify(m0))
  const spread = await evalIn(A, `return ui.outlineSpread()`)
  check('harder press = wider stroke (right ≥ 1.3× left)',
    !!spread && spread.left > 0 && spread.right / spread.left >= 1.3,
    spread ? `${spread.left.toFixed(1)} vs ${spread.right.toFixed(1)} pt` : 'no outline points')

  // ---- 2. seeing a pen flips the finger to navigation, once ----
  const prefs1 = await evalIn(A, `return ui.prefs()`)
  check('penSeen flipped, finger now navigates',
    prefs1?.penSeen === true && prefs1?.fingerDraws === false, JSON.stringify(prefs1))

  // ---- 3. a finger scrolls instead of drawing ----
  await sleep(900) // let the pen-near palm guard expire
  const box = await evalIn(A, `
    const r = ui.pages().getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollTop: ui.pages().scrollTop };
  `)
  await touchDrag(A, { x: box.x, y: box.y }, { x: box.x, y: box.y - 150 })
  await sleep(600)
  const afterTouch = await evalIn(A, `
    return { scrollTop: ui.pages().scrollTop, marks: ui.inkMarks().length };
  `)
  check('the finger scrolled the page', afterTouch.scrollTop > box.scrollTop + 40,
    `scrollTop ${Math.round(box.scrollTop)} -> ${Math.round(afterTouch.scrollTop)}`)
  check('…and drew nothing', afterTouch.marks === 1, `${afterTouch.marks} mark(s)`)
  await evalIn(A, `ui.pages().scrollTop = 0; ui.pages().dispatchEvent(new Event('scroll')); await settle(400);`)

  // ---- 4. the pen's eraser end erases, with the PEN tool still armed ----
  await evalIn(A, `await ui.eraserEnd(${JSON.stringify(mid)})`)
  const afterErase = await evalIn(A, `return ui.inkMarks()`)
  check('the eraser end erased the stroke', afterErase.length === 0, `${afterErase.length} mark(s) left`)

  // ---- 5. the CDP input pipeline agrees it is a pen ----
  // dispatchMouseEvent pointerType 'pen' goes through the same browser input
  // path a real digitizer feeds. Like a real digitizer, HOVER comes first: the
  // hover move is what flips the draw layer to touch-action:none (html.pen-near)
  // before contact — going straight to mousePressed would let Chromium run its
  // pen-pan gesture instead, cancel the pointer, and prove nothing a real pen
  // does. (Pressure fidelity varies by CDP version, so width variance is
  // asserted on the synthetic path above, not here.)
  // Fractions of the pane, like test-annot-edit: absolute offsets from the
  // pane's LEFT edge land in the grey margin beside the centered page, where
  // there is no draw layer to hit.
  const layerBox = await evalIn(A, `
    const r = ui.pages().getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.4), scrollTop: ui.pages().scrollTop };
  `)
  const penEvt = (type, dx, extra = {}) =>
    A('Input.dispatchMouseEvent', {
      type, x: layerBox.x + dx, y: layerBox.y,
      button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6, ...extra
    })
  await penEvt('mouseMoved', 0, { button: 'none', buttons: 0, force: 0 }) // hover, like a real pen
  await sleep(120)
  await penEvt('mousePressed', 0)
  for (let i = 1; i <= 12; i++) await penEvt('mouseMoved', i * 12)
  await penEvt('mouseReleased', 144, { buttons: 0, force: 0 })
  await sleep(900)
  const afterCdpPen = await evalIn(A, `
    return { marks: ui.inkMarks().length, scrollTop: ui.pages().scrollTop };
  `)
  check('a CDP pen stroke draws (after hover), not pans', afterCdpPen.marks === 1 && afterCdpPen.scrollTop === layerBox.scrollTop,
    `${afterCdpPen.marks} mark(s), scrollTop ${Math.round(layerBox.scrollTop)} -> ${Math.round(afterCdpPen.scrollTop)}`)

  // ---- 6. «Tegner»: the toggle hands drawing back to the finger ----
  await A('Page.reload')
  await sleep(1500)
  let welcomed = false
  for (let i = 0; i < 40; i++) {
    const r = await A('Runtime.evaluate', {
      expression: `!!document.querySelector('.recent-row')`, returnByValue: true
    })
    if (r.result?.value) { welcomed = true; break }
    await sleep(400)
  }
  check('reload lands on Velkommen with the file in recents', welcomed)
  if (welcomed) {
    await evalIn(A, `click(document.querySelector('.recent-row')); await settle(500);`)
    let reopened = false
    for (let i = 0; i < 60; i++) {
      const r = await A('Runtime.evaluate', {
        expression: `!!document.querySelector('.pdf-page .text-host .textLayer span')`,
        returnByValue: true
      })
      if (r.result?.value) { reopened = true; break }
      await sleep(500)
    }
    check('the recent reopens the document', reopened)

    // The tool menu now runs with maxTouchPoints > 0: the Finger row must exist
    const rows = await evalIn(A, `
      await ui.armPen();
      const pen = btn('Penn');
      const chevron = pen.parentElement.querySelector('.tb-chevron');
      click(chevron);
      await settle(300);
      const labels = [...document.querySelectorAll('.tool-menu .theme-menu-label')].map((el) => el.textContent.trim());
      const options = [...document.querySelectorAll('.tool-menu .scope-option strong')].map((el) => el.textContent.trim());
      return { labels, options };
    `)
    check('the pen menu offers Finger and Pennetrykk rows',
      rows.labels.includes('Finger') && rows.labels.includes('Pennetrykk'), JSON.stringify(rows.labels))
    check('with Tegner/Blar and Følsom/Fast options',
      rows.options.includes('Tegner') && rows.options.includes('Blar') &&
      rows.options.includes('Følsom') && rows.options.includes('Fast'), JSON.stringify(rows.options))

    // Flip finger drawing back ON through the real control, then a touch drag
    // must DRAW instead of scrolling.
    await evalIn(A, `
      const on = [...document.querySelectorAll('.tool-menu .scope-option')]
        .find((b) => b.querySelector('strong')?.textContent.trim() === 'Tegner');
      if (!on) throw new Error('no Tegner option');
      click(on);
      await settle(300);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(300);
      await ui.armPen();
    `)
    const prefs2 = await evalIn(A, `return ui.prefs()`)
    check('the toggle persisted fingerDraws: true', prefs2?.fingerDraws === true, JSON.stringify(prefs2))

    const box2 = await evalIn(A, `
      const r = ui.pages().getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 260, marks: ui.inkMarks().length };
    `)
    await touchDrag(A, { x: box2.x - 70, y: box2.y }, { x: box2.x + 70, y: box2.y + 30 })
    await sleep(900)
    const afterFingerDraw = await evalIn(A, `return ui.inkMarks().length`)
    check('a finger draws again once allowed', afterFingerDraw === box2.marks + 1,
      `${box2.marks} -> ${afterFingerDraw} mark(s)`)
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
} catch (err) {
  console.error('FATAL:', err.message)
  console.error(app.log().slice(-2000))
  failures++
} finally {
  for (const ws of sockets) try { ws.close() } catch { /* closing */ }
  await app.cleanup()
}
process.exit(failures === 0 ? 0 : 1)

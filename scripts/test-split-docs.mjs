// End-to-end test of the TWO-DOCUMENT split in the real app: another file in
// the split view's second column, reading and writing into the document each
// column actually shows.
//
//   npm run test:split-docs     (needs `npm run build` first)
//
// What it pins, in order:
//   1. 's' is still the INSTANT same-file split (both columns, same dockey) —
//      the regression the whole architecture was designed around.
//   2. A second launch with another file lands as a tab in the same window
//      (the single-instance route «Åpne i delt visning» builds on).
//   3. The tab context menu's «Åpne i delt visning» puts that file in the
//      second column: two different data-dockeys, the toolbar's page count
//      following whichever column is active.
//   4. «Bytt plass» (Shift+S) visually trades the columns' sides.
//   5. A text markup made in the foreign column dirties THAT file's draft and
//      not the host's — the wrong-document write is the bug class this guards.
//   6. The same file's own tab converges on the mark (the intra-window bus),
//      and saving there bakes exactly one new annotation into the bytes,
//      verified with mupdf; the host file's draft stays clean.
//   7. 's' with a foreign document closes it (the other tab survives), and the
//      next 's' is the instant same-file split again.
import { existsSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import {
  cdp,
  openSocket,
  waitForPageTargets,
  launchApp,
  electronBinary,
  evaluate,
  sleep
} from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9339
const FILE_A = join(tmpdir(), 'pdfx-splitdocs-vert.pdf')
const FILE_B = join(tmpdir(), 'pdfx-splitdocs-annen.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------------ the two files

/** A minimal one-page PDF (US letter, a little text) — visibly NOT sample.pdf,
 *  and 1 page vs sample's 6 so the toolbar's page count tells them apart. */
function onePageFixture() {
  const objs = []
  const add = (body) => {
    objs.push(body)
    return objs.length
  }
  const text = 'BT /F1 24 Tf 72 700 Td (Vertsdokument A) Tj ET'
  const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const page = add(
    `<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
  )
  const pages = add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`)
  let out = '%PDF-1.7\n'
  const offsets = [0]
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Annotations already in a PDF, counted with mupdf (the final verifier). */
function annotsOnDisk(file) {
  const pdf = mupdf.Document.openDocument(readFileSync(file), 'application/pdf').asPDF()
  let total = 0
  for (let p = 0; p < pdf.countPages(); p++) total += pdf.loadPage(p).getAnnotations().length
  pdf.destroy()
  return total
}

// ------------------------------------------------------- in-page UI helpers

/** No backticks or ${} in here — PRELUDE itself is a template literal. */
const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ui = {
  settle,
  activeView() {
    return document.querySelector('.tab-view.active');
  },
  panes() {
    return [...this.activeView().querySelectorAll('.pages')].map((p) => ({
      pane: p.dataset.pane,
      dockey: p.dataset.dockey,
      left: Math.round(p.getBoundingClientRect().left)
    }));
  },
  key(k, opts) {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opts || {})));
  },
  tabRects() {
    return [...document.querySelectorAll('.tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { name: (t.textContent || '').replace(/[•✕]/g, '').trim(),
               active: t.classList.contains('active'),
               x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  },
  clickMenuItem(label) {
    const item = [...document.querySelectorAll('.tab-menu .menu-item')]
      .find((b) => (b.textContent || '').trim() === label);
    if (!item) throw new Error('menu item not found: ' + label);
    click(item);
  },
  pageCountText() {
    return (this.activeView().querySelector('.page-indicator span') || {}).textContent || '';
  },
  activatePaneBtn(which) {
    const btns = [...this.activeView().querySelectorAll('.pane-switch-btn')];
    if (btns.length !== 2) throw new Error('pane switch not found');
    click(btns[which === 'b' ? 1 : 0]);
  },
  /** Arm the text-markup tool from the toolbar (nb or en tooltip) */
  armMarkup() {
    const b = [...this.activeView().querySelectorAll('.tb-btn')].find((x) =>
      /^(Marker tekst|Mark up text)/.test(x.title || ''));
    if (!b) throw new Error('markup tool button not found');
    if (!b.classList.contains('is-active')) click(b);
  },
  /** Select a line of text in the given pane and release the mouse over it —
   *  with the markup tool armed this commits a highlight into THAT column's
   *  document. */
  async markupInPane(pane) {
    const pages = this.activeView().querySelector('.pages[data-pane="' + pane + '"]');
    const box = pages.getBoundingClientRect();
    const spans = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 12)
      .filter((s) => {
        const r = s.getBoundingClientRect();
        return r.top > box.top + 40 && r.bottom < box.bottom - 40 && r.width > 60;
      });
    if (spans.length === 0) throw new Error('no on-screen text in pane ' + pane);
    const span = spans[0];
    // A pointerdown in the column makes it the ACTIVE pane, exactly as a real
    // selection drag would — the write path routes by that.
    const r0 = span.getBoundingClientRect();
    pages.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: Math.round(r0.left), clientY: Math.round(r0.top)
    }));
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await settle(150);
    pages.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0, clientX: Math.round(r0.right), clientY: Math.round(r0.bottom)
    }));
    await settle(800);
    window.getSelection()?.removeAllRanges();
    return (span.textContent || '').trim().slice(0, 30);
  },
  async save() {
    const b = this.activeView().querySelector('.tb-save');
    if (!b) throw new Error('no Save button');
    if (b.disabled) throw new Error('Save is disabled — nothing to save');
    click(b);
    await settle(2500);
  }
};
`

const evalIn = (send, body) => evaluate(send, body, PRELUDE)

/** A REAL click through CDP input (some chrome — the tab strip — ignores
 *  synthetic MouseEvents; trusted input behaves like the user's mouse). */
async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}

// ---------------------------------------------------------------------- main

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
writeFileSync(FILE_A, onePageFixture())
copyFileSync(join(ROOT, 'src', 'renderer', 'public', 'sample.pdf'), FILE_B)

// sample.pdf ships with annotations — the assertion is a DELTA, not a total
const beforeA = annotsOnDisk(FILE_A)
const beforeB = annotsOnDisk(FILE_B)
console.log(`baseline: A=${beforeA} annotation(s), B=${beforeB}\n`)

const app = launchApp({ root: ROOT, mainJs, args: [FILE_A], port: PORT })
const sockets = []

try {
  const [target] = await waitForPageTargets(PORT, 1)
  const ws = await openSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  const W = cdp(ws)
  await W('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    const r = await W('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page canvas')`,
      returnByValue: true
    })
    if (r.result?.value) break
    await sleep(500)
  }
  check('the window opened document A', true)

  // ---- 1. the same-file split is still instant on 's'
  await evalIn(W, `ui.key('s'); await ui.settle(700); return null`)
  let panes = await evalIn(W, `return ui.panes()`)
  check(
    "'s' opens the same-file split instantly",
    panes.length === 2 && panes[0].dockey === panes[1].dockey,
    JSON.stringify(panes)
  )
  await evalIn(W, `ui.key('s'); await ui.settle(500); return null`)
  panes = await evalIn(W, `return ui.panes()`)
  check("'s' closes it again", panes.length === 1)

  // ---- 2. a second launch lands document B as a tab in the SAME window
  const second = spawn(electronBinary(ROOT), [mainJs, FILE_B, `--user-data-dir=${app.profile}`], {
    cwd: ROOT,
    stdio: 'ignore'
  })
  second.unref()
  let tabs = []
  for (let i = 0; i < 40; i++) {
    tabs = await evalIn(W, `return ui.tabRects()`)
    if (tabs.length === 2) break
    await sleep(500)
  }
  check('document B opened as a second tab (single-instance route)', tabs.length === 2, JSON.stringify(tabs.map((t) => t.name)))

  // ---- 3. «Åpne i delt visning» on B's tab, with A active
  await clickAt(W, tabs[0].x, tabs[0].y) // activate tab A
  await sleep(600)
  await clickAt(W, tabs[1].x, tabs[1].y, 'right') // context menu on tab B
  await sleep(400)
  await evalIn(W, `ui.clickMenuItem('Åpne i delt visning'); return null`)
  let ok = false
  for (let i = 0; i < 30; i++) {
    panes = await evalIn(W, `return ui.panes()`)
    if (panes.length === 2 && panes[0].dockey !== panes[1].dockey) {
      ok = true
      break
    }
    await sleep(500)
  }
  check('the split shows TWO documents', ok, JSON.stringify(panes))
  check(
    'pane A holds document A, pane B holds document B',
    panes.find((p) => p.pane === 'a')?.dockey === FILE_A &&
      panes.find((p) => p.pane === 'b')?.dockey === FILE_B,
    JSON.stringify(panes)
  )
  // Both tabs still open — the source tab was not consumed
  tabs = await evalIn(W, `return ui.tabRects()`)
  check('the source tab stays open', tabs.length === 2)

  // The toolbar's page count follows the ACTIVE column's document (A=1, B=6)
  await evalIn(W, `ui.activatePaneBtn('b'); await ui.settle(300); return ui.pageCountText()`)
  const countB = await evalIn(W, `return ui.pageCountText()`)
  await evalIn(W, `ui.activatePaneBtn('a'); await ui.settle(300); return null`)
  const countA = await evalIn(W, `return ui.pageCountText()`)
  check("page count follows the active column ('/ 6' vs '/ 1')", /6/.test(countB) && /1/.test(countA), `${countB} vs ${countA}`)

  // ---- 4. «Bytt plass» trades sides (Shift+S), and back
  const beforeSwap = await evalIn(W, `return ui.panes()`)
  await evalIn(W, `ui.key('S', { shiftKey: true }); await ui.settle(400); return null`)
  const afterSwap = await evalIn(W, `return ui.panes()`)
  const a1 = beforeSwap.find((p) => p.pane === 'a')
  const b1 = beforeSwap.find((p) => p.pane === 'b')
  const a2 = afterSwap.find((p) => p.pane === 'a')
  const b2 = afterSwap.find((p) => p.pane === 'b')
  check(
    'Shift+S trades the columns’ sides',
    a1 && b1 && a2 && b2 && a1.left < b1.left && b2.left < a2.left,
    JSON.stringify({ beforeSwap, afterSwap })
  )
  await evalIn(W, `ui.key('S', { shiftKey: true }); await ui.settle(400); return null`)

  // ---- 5. a markup in the foreign column dirties B's draft, not A's
  await evalIn(W, `ui.armMarkup(); return null`)
  const markedText = await evalIn(W, `return await ui.markupInPane('b')`)
  check('a highlight was made in the foreign column', typeof markedText === 'string' && markedText.length > 0, markedText)
  await evalIn(W, `ui.armMarkup(); return null`) // disarm (toggle)
  await sleep(1200)
  const dirtyB = await evalIn(W, `return await window.api.docIsDirty(${JSON.stringify(FILE_B)})`)
  const dirtyA = await evalIn(W, `return await window.api.docIsDirty(${JSON.stringify(FILE_A)})`)
  check("the mark landed in document B's draft", dirtyB === true, String(dirtyB))
  check("…and document A's draft stays clean", dirtyA === false, String(dirtyA))

  // ---- 6. B's own tab converges and saves exactly one new annotation
  tabs = await evalIn(W, `return ui.tabRects()`)
  const tabB = tabs.find((t) => /annen/.test(t.name)) ?? tabs[1]
  await clickAt(W, tabB.x, tabB.y)
  await sleep(1500) // the bus reload is debounced; give the re-parse a beat
  await evalIn(W, `await ui.save(); return null`)
  const afterB = annotsOnDisk(FILE_B)
  check('saving from B’s own tab bakes exactly one new annotation', afterB === beforeB + 1, `${beforeB} -> ${afterB}`)
  check('document A’s bytes are untouched', annotsOnDisk(FILE_A) === beforeA)

  // ---- 7. 's' in the host tab closes the foreign document; next 's' is same-file
  const tabA = tabs.find((t) => /vert/.test(t.name)) ?? tabs[0]
  await clickAt(W, tabA.x, tabA.y)
  await sleep(600)
  await evalIn(W, `ui.key('s'); return null`)
  ok = false
  for (let i = 0; i < 20; i++) {
    panes = await evalIn(W, `return ui.panes()`)
    if (panes.length === 1) {
      ok = true
      break
    }
    await sleep(400)
  }
  check("'s' closes the two-document split", ok, JSON.stringify(panes))
  tabs = await evalIn(W, `return ui.tabRects()`)
  check('document B’s tab survives the close', tabs.length === 2)
  await evalIn(W, `ui.key('s'); await ui.settle(700); return null`)
  panes = await evalIn(W, `return ui.panes()`)
  check(
    "…and the next 's' is the instant same-file split again",
    panes.length === 2 && panes[0].dockey === panes[1].dockey && panes[0].dockey === FILE_A,
    JSON.stringify(panes)
  )
} catch (err) {
  failures++
  console.error('FAIL  unexpected error:', err)
  console.error('\n--- app log tail ---\n' + app.log().slice(-4000))
} finally {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* closing */
    }
  }
  await app.cleanup()
  for (const f of [FILE_A, FILE_B]) {
    try {
      unlinkSync(f)
    } catch {
      /* temp file */
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll split-docs checks passed.')

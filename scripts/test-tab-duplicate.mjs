// End-to-end test of «Dupliser fane» (issue #53) in the real app: a second tab
// on the same document, and what the two tabs share.
//
//   npm run test:tab-duplicate     (needs `npm run build` first)
//
// What it pins, in order:
//   1. The tab menu's «Dupliser fane» opens a second tab on the SAME path,
//      right after its source, active, on the page the source stood on — a
//      browser's duplicate, not a fresh open at page 1.
//   2. A markup made in the copy dirties the path's one draft: both tabs show
//      the dot, and the source converges on the mark over the local doc bus
//      (its annotation list grows by one without a save).
//   3. Closing the copy asks NOTHING — the draft lives on in the source — and
//      the source still holds the mark and still reads as dirty. (The August
//      2026 roadmap note that dropped tab copies feared exactly this close:
//      main's per-window Set would have lost the draft from the close-time
//      scan. docRegistry's count in front of it is what this proves.)
//   4. Saving from the source bakes exactly one new annotation, mupdf-verified.
//   5. Ctrl+Shift+K (Edge's chord) duplicates the active tab too, and a copy
//      of a PINNED tab is not pinned and lands after the pinned group.
import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9341
const FILE = join(tmpdir(), 'pdfx-tabdup-dokument.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
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
  key(k, opts) {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opts || {})));
  },
  tabs() {
    return [...document.querySelectorAll('.tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { name: (t.textContent || '').replace(/[•✕]/g, '').trim(),
               active: t.classList.contains('active'),
               pinned: t.classList.contains('pinned'),
               dirty: !!t.querySelector('.tab-dirty-dot'),
               x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  },
  clickMenuItem(label) {
    const item = [...document.querySelectorAll('.tab-menu .menu-item')]
      .find((b) => (b.textContent || '').trim() === label);
    if (!item) throw new Error('menu item not found: ' + label);
    click(item);
  },
  dockey() {
    return (this.activeView().querySelector('.pages') || {}).dataset?.dockey || null;
  },
  page() {
    return Number((this.activeView().querySelector('.page-indicator input') || {}).value || 0);
  },
  /** Type a page number into the toolbar's page field and commit it */
  async goToPage(n) {
    const input = this.activeView().querySelector('.page-indicator input');
    if (!input) throw new Error('no page field');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    set.call(input, String(n));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.blur();
    await settle(1500); // past the position save's debounce (600 ms)
  },
  /** Arm the text-markup tool from the toolbar (nb or en tooltip) */
  armMarkup() {
    const b = [...this.activeView().querySelectorAll('.tb-btn')].find((x) =>
      /^(Marker tekst|Mark up text)/.test(x.title || ''));
    if (!b) throw new Error('markup tool button not found');
    if (!b.classList.contains('is-active')) click(b);
  },
  /** Select a line of on-screen text and release the mouse over it — with
   *  the markup tool armed this commits a highlight into the draft. */
  async markup() {
    const pages = this.activeView().querySelector('.pages');
    const box = pages.getBoundingClientRect();
    const spans = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 12)
      .filter((s) => {
        const r = s.getBoundingClientRect();
        return r.top > box.top + 40 && r.bottom < box.bottom - 40 && r.width > 60;
      });
    if (spans.length === 0) throw new Error('no on-screen text');
    const span = spans[0];
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
  /** The sidebar's annotation list for the ACTIVE tab: open it (the 't' key
   *  toggles the panel, so only when it is closed), pick «Annoteringer» and
   *  count the cards. Session marks and file-painted ones both list here —
   *  which is the point: the source sees the copy's mark however it arrived. */
  async annotCount() {
    const view = this.activeView();
    if (!view.querySelector('.sidebar-tabs')) {
      this.key('t');
      await settle(400);
    }
    const tabs = [...view.querySelectorAll('.sidebar-tabs button')];
    if (tabs.length < 4) throw new Error('sidebar tabs not found');
    click(tabs[3]);
    await settle(400);
    return view.querySelectorAll('.annot-list > div').length;
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

/** A REAL click through CDP input (the tab strip ignores synthetic
 *  MouseEvents; trusted input behaves like the user's mouse). */
async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}

async function tabsEventually(W, want, tries = 30) {
  let tabs = []
  for (let i = 0; i < tries; i++) {
    tabs = await evalIn(W, `return ui.tabs()`)
    if (tabs.length === want) break
    await sleep(400)
  }
  return tabs
}

// ---------------------------------------------------------------------- main

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
// sample.pdf: six pages of real text to mark up. It ships with annotations —
// the assertion is a DELTA, not a total
copyFileSync(join(ROOT, 'src', 'renderer', 'public', 'sample.pdf'), FILE)
const before = annotsOnDisk(FILE)
console.log(`baseline: ${before} annotation(s) on disk\n`)

const app = launchApp({ root: ROOT, mainJs, args: [FILE], port: PORT })
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
  check('the window opened the document', true)

  // ---- 1. «Dupliser fane»: a second tab on the same path, where the first stands
  await evalIn(W, `await ui.goToPage(3); return null`)
  const pageBefore = await evalIn(W, `return ui.page()`)
  check('the source tab stands on page 3', pageBefore === 3, String(pageBefore))
  let tabs = await evalIn(W, `return ui.tabs()`)
  await clickAt(W, tabs[0].x, tabs[0].y, 'right')
  await sleep(400)
  await evalIn(W, `ui.clickMenuItem('Dupliser fane'); return null`)
  tabs = await tabsEventually(W, 2)
  check('a second tab appears', tabs.length === 2, JSON.stringify(tabs.map((t) => t.name)))
  check('…with the same name, after its source, and active', tabs.length === 2 && tabs[0].name === tabs[1].name && tabs[1].active)
  let ok = false
  for (let i = 0; i < 30; i++) {
    const key = await evalIn(W, `return ui.dockey()`)
    const canvas = await evalIn(W, `return !!ui.activeView().querySelector('.pdf-page canvas')`)
    if (key === FILE && canvas) {
      ok = true
      break
    }
    await sleep(400)
  }
  check('the copy shows the same document, rendered', ok)
  await sleep(800)
  const pageCopy = await evalIn(W, `return ui.page()`)
  check('…on the page the source stood on, not page 1', pageCopy === 3, String(pageCopy))

  // ---- 2. a markup in the copy dirties the one draft; the source converges
  const countSource0 = await evalIn(W, `return await ui.annotCount()`)
  await evalIn(W, `ui.key('t'); await ui.settle(300); return null`) // close the panel again
  await evalIn(W, `ui.armMarkup(); await ui.settle(200); return null`)
  const marked = await evalIn(W, `return await ui.markup()`)
  check('a highlight was made in the copy', typeof marked === 'string' && marked.length > 0, marked)
  await sleep(1200)
  const dirtyPath = await evalIn(W, `return await window.api.docIsDirty(${JSON.stringify(FILE)})`)
  check("the path's draft is dirty", dirtyPath === true, String(dirtyPath))
  tabs = await evalIn(W, `return ui.tabs()`)
  check('BOTH tabs show the dirty dot', tabs.length === 2 && tabs[0].dirty && tabs[1].dirty, JSON.stringify(tabs.map((t) => t.dirty)))
  await clickAt(W, tabs[0].x, tabs[0].y)
  await sleep(1800) // the bus reload is debounced; give the re-parse a beat
  const countSource1 = await evalIn(W, `return await ui.annotCount()`)
  check('the source lists the mark the copy made (no save in between)', countSource1 === countSource0 + 1, `${countSource0} -> ${countSource1}`)
  await evalIn(W, `ui.key('t'); await ui.settle(300); return null`)

  // ---- 3. closing the copy asks nothing; the draft and the mark stay with the source
  await clickAt(W, tabs[1].x, tabs[1].y)
  await sleep(400)
  // Through the tab menu — a middle-click is a real close too, but the menu's
  // «Lukk fane» is the same path and leaves no doubt which tab it hit
  await clickAt(W, tabs[1].x, tabs[1].y, 'right')
  await sleep(400)
  // If the close-time prompt (native dialog) opened here, the renderer would
  // hang on it and this evaluate would never return — a timeout IS the failure
  const closed = await Promise.race([
    (async () => {
      await evalIn(W, `ui.clickMenuItem('Lukk fane'); return null`)
      const t = await tabsEventually(W, 1)
      return t.length === 1
    })(),
    sleep(8000).then(() => 'timeout')
  ])
  check('the copy closes without the unsaved-changes prompt', closed === true, String(closed))
  const stillDirty = await evalIn(W, `return await window.api.docIsDirty(${JSON.stringify(FILE)})`)
  check('…and the draft is still there', stillDirty === true, String(stillDirty))
  tabs = await evalIn(W, `return ui.tabs()`)
  check('the source still reads as dirty', tabs.length === 1 && tabs[0].dirty)
  const countSource2 = await evalIn(W, `return await ui.annotCount()`)
  check('…and still lists the mark', countSource2 === countSource0 + 1, `${countSource2}`)
  await evalIn(W, `ui.key('t'); await ui.settle(300); return null`)

  // ---- 4. saving from the source bakes exactly one new annotation
  await evalIn(W, `await ui.save(); return null`)
  const after = annotsOnDisk(FILE)
  check('saving bakes exactly one new annotation (mupdf)', after === before + 1, `${before} -> ${after}`)

  // ---- 5. Ctrl+Shift+K duplicates the active tab; a pinned source's copy is unpinned, after the group
  await clickAt(W, tabs[0].x, tabs[0].y, 'right')
  await sleep(400)
  await evalIn(W, `ui.clickMenuItem('Fest fanen'); return null`)
  await sleep(400)
  tabs = await evalIn(W, `return ui.tabs()`)
  check('the source is pinned', tabs.length === 1 && tabs[0].pinned)
  await evalIn(W, `ui.key('K', { ctrlKey: true, shiftKey: true }); return null`)
  tabs = await tabsEventually(W, 2)
  check('Ctrl+Shift+K opens a copy', tabs.length === 2, JSON.stringify(tabs.map((t) => t.name)))
  check(
    '…unpinned, after the pinned group, and active',
    tabs.length === 2 && tabs[0].pinned && !tabs[1].pinned && tabs[1].active,
    JSON.stringify(tabs.map((t) => ({ pinned: t.pinned, active: t.active })))
  )
  // No draft now (saved): closing the copy is a plain close either way
  const clean = await evalIn(W, `return await window.api.docIsDirty(${JSON.stringify(FILE)})`)
  check('nothing is dirty after the save', clean === false, String(clean))
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
  try {
    unlinkSync(FILE)
  } catch {
    /* temp file */
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll tab-duplicate checks passed.')

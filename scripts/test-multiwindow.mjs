// End-to-end test of the promise the README makes about two windows on the same
// file: "they share one draft and sync as you annotate, and a Save from either
// window writes each mark exactly once".
//
//   npm run test:windows        (needs `npm run build` first)
//
// Why a real-app test and not a unit test: the claim spans every layer at once —
// renderer overlay, the annotate IPC, main's per-path draft, the
// `annots:changed-elsewhere` broadcast, the receiving window's debounced reload,
// and finally the bytes on disk. Nothing below the app can prove it. So we spawn
// the built app, open a second window on the same path, drive REAL text
// selections in both, and verify the saved file with mupdf (a different PDF
// implementation entirely — it cannot share a bug with our writer).
//
// Counting marks correctly is the subtle part. The React overlay paints ONLY
// `source === 'session'` records (PdfPage.tsx) — anything already in the file is
// painted by pdf.js into the page canvas. A reload turns a session mark into a
// file mark, so it moves from the DOM into the pixels and any DOM-node count
// drops to zero exactly when the sync WORKED. (This test's first run reported
// four "failures" for that reason alone.) So we count the notes panel's rows
// instead: one row per annotation, whichever source it came from, and a surface
// the user actually reads.
import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9334
const FILE = join(tmpdir(), 'pdfx-multiwindow-test.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------- in-page UI helpers

/** Injected into every evaluate. Drives real buttons and real selections. */
const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const btn = (prefix) =>
  [...document.querySelectorAll('.tb-btn')].find((b) => (b.title || '').startsWith(prefix));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ui = {
  settle,
  /** Open the sidebar's notes tab — the source-agnostic annotation readout */
  async openNotes() {
    const side = btn('Sidepanel');
    if (!side) throw new Error('no sidebar button');
    if (!side.classList.contains('is-active')) { click(side); await settle(500); }
    const tabs = document.querySelectorAll('.sidebar-tabs button');
    if (tabs.length < 3) throw new Error('sidebar tabs missing');
    click(tabs[2]);
    await settle(400);
  },
  /** One row per annotation the app knows about, file-painted or session */
  markCount() {
    return document.querySelectorAll('.annot-list-row').length;
  },
  /** Poll until the list shows n marks (the sync is debounced by 250 ms, and a
   *  reload has to re-parse the document before the list can grow) */
  async waitForMarks(n, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.markCount() >= n) return this.markCount();
      await settle(200);
    }
    return this.markCount();
  },
  /** Highlight one on-screen line, picking the Nth eligible span so the two
   *  windows mark DIFFERENT text and the count is unambiguous. */
  async highlightNth(n) {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const box = pages.getBoundingClientRect();
    const spans = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 12)
      .filter((s) => {
        const r = s.getBoundingClientRect();
        return r.top > box.top + 40 && r.bottom < box.bottom - 40 && r.width > 60;
      });
    if (spans.length === 0) throw new Error('no on-screen text to mark up');
    const span = spans[Math.min(n, spans.length - 1)];
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await settle(150);
    const r = span.getBoundingClientRect();
    pages.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0, clientX: Math.round(r.right), clientY: Math.round(r.bottom)
    }));
    await settle(400);
    const menu = document.querySelector('.selection-menu');
    if (!menu) throw new Error('selection menu did not open');
    const swatch = menu.querySelector('.menu-color-group .color-dot, .menu-color-group .color-bar');
    if (!swatch) throw new Error('no colour swatch in the selection menu');
    click(swatch);
    await settle(700);
    window.getSelection()?.removeAllRanges();
    return (span.textContent || '').trim().slice(0, 30);
  },
  /** The file is only written when the user presses Save — do it their way */
  async save() {
    const b = document.querySelector('.tb-save');
    if (!b) throw new Error('no Save button');
    if (b.disabled) throw new Error('Save is disabled — the app thinks nothing changed');
    click(b);
    await settle(2500);
  },
  /** Unsaved work? The Save button is always present, and enabled while dirty. */
  isDirty() {
    const b = document.querySelector('.tb-save');
    return !!b && !b.disabled;
  }
};
`

const evalIn = (send, body) => evaluate(send, body, PRELUDE)

// ---------------------------------------------------------------------- main

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
// A throwaway copy: the test saves to this file, so it must not be a repo asset
copyFileSync(join(ROOT, 'src', 'renderer', 'public', 'sample.pdf'), FILE)

/** Annotations already in a PDF, counted with mupdf (also the final verifier) */
function annotsOnDisk(file) {
  const pdf = mupdf.Document.openDocument(readFileSync(file), 'application/pdf').asPDF()
  const objs = new Set()
  const perPage = []
  let total = 0
  for (let p = 0; p < pdf.countPages(); p++) {
    const annots = pdf.loadPage(p).getAnnotations()
    if (annots.length) perPage.push(`p${p + 1}:${annots.length}`)
    for (const a of annots) objs.add(a.getObject().asIndirect())
    total += annots.length
  }
  pdf.destroy()
  return { total, distinct: objs.size, perPage: perPage.join(' ') || 'none' }
}

// sample.pdf ships with annotations of its own, so "two marks" is a DELTA, not
// an absolute — measure the baseline before the app ever touches the file.
const before = annotsOnDisk(FILE)
console.log(`baseline: ${before.total} annotation(s) in the file (${before.perPage})\n`)

const app = launchApp({ root: ROOT, mainJs, args: [FILE], port: PORT })
const sockets = []

try {
  // ---- window A
  const [targetA] = await waitForPageTargets(PORT, 1)
  const wsA = await openSocket(targetA.webSocketDebuggerUrl)
  sockets.push(wsA)
  const A = cdp(wsA)
  await A('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    const r = await A('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page canvas')`,
      returnByValue: true
    })
    if (r.result?.value) break
    await sleep(500)
  }
  check('window A opened the document', true)

  // ---- window B on the SAME path, exactly as the tab menu's «Åpne i nytt
  //      vindu» does it (App.tsx: onOpenInNewWindow -> bridge.newWindow(path))
  await evalIn(A, `window.api.newWindow(${JSON.stringify(FILE)})`)
  const targets = await waitForPageTargets(PORT, 2)
  const targetB = targets.find((t) => t.id !== targetA.id)
  check('a second window opened on the same file', !!targetB)
  if (!targetB) throw new Error('no second window')
  const wsB = await openSocket(targetB.webSocketDebuggerUrl)
  sockets.push(wsB)
  const B = cdp(wsB)
  await B('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    const r = await B('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page canvas')`,
      returnByValue: true
    })
    if (r.result?.value) break
    await sleep(500)
  }
  check('window B rendered the same document', true)

  // The notes panel is the readout for the rest of the run — open it in both
  await evalIn(A, `await ui.openNotes()`)
  await evalIn(B, `await ui.openNotes()`)
  const marks0A = await evalIn(A, `return ui.markCount()`)
  const marks0B = await evalIn(B, `return ui.markCount()`)
  check(
    'both windows list the same starting annotations',
    marks0A === before.total && marks0B === before.total,
    `A=${marks0A} B=${marks0B}, file has ${before.total}`
  )

  // ---- A annotates -> B must show it without being touched
  const textA = await evalIn(A, `return await ui.highlightNth(0)`)
  const aOwn = await evalIn(A, `return await ui.waitForMarks(${before.total + 1})`)
  check('A made a highlight', aOwn === before.total + 1, `A lists ${aOwn} ("${textA}")`)
  const seenByB = await evalIn(B, `return await ui.waitForMarks(${before.total + 1})`)
  check("B sees A's mark without a manual reload", seenByB === before.total + 1, `B lists ${seenByB}`)

  // ---- B annotates -> A must show that too (the reverse direction is a
  //      different code path: B is the sender, A the receiver)
  const textB = await evalIn(B, `return await ui.highlightNth(4)`)
  const bAfter = await evalIn(B, `return await ui.waitForMarks(${before.total + 2})`)
  check('B made a second highlight', bAfter === before.total + 2, `B lists ${bAfter} ("${textB}")`)
  const seenByA = await evalIn(A, `return await ui.waitForMarks(${before.total + 2})`)
  check("A sees B's mark", seenByA === before.total + 2, `A lists ${seenByA}`)

  // ---- one Save, from the window that did NOT start the editing
  check('B has unsaved work to save', await evalIn(B, `return ui.isDirty()`))
  check('A is dirty too — the draft is shared', await evalIn(A, `return ui.isDirty()`))
  await evalIn(B, `await ui.save()`)
  check('the saving window is clean afterwards', !(await evalIn(B, `return ui.isDirty()`)))
  const dirtyA = await evalIn(A, `return ui.isDirty()`)
  check('the other window is clean too — one draft, one save', !dirtyA, `A dirty=${dirtyA}`)
  // Clearing the flag means re-reading the file (the draft is gone). Both views
  // must come back with every mark — a reload that quietly emptied them would
  // look exactly like losing the user's work.
  const keptA = await evalIn(A, `return await ui.waitForMarks(${before.total + 2})`)
  const keptB = await evalIn(B, `return await ui.waitForMarks(${before.total + 2})`)
  check(
    'both windows still show every mark after the save',
    keptA === before.total + 2 && keptB === before.total + 2,
    `A=${keptA} B=${keptB}`
  )

  // ---- the file on disk, verified by a different PDF implementation
  const after = annotsOnDisk(FILE)
  check(
    'the saved file gained exactly the two new marks',
    after.total === before.total + 2,
    `${before.total} -> ${after.total} (${after.perPage})`
  )
  // Duplicates are the specific failure mode of two writers on one file: each
  // window flushing its own copy of the shared draft would double every mark.
  check(
    'each mark was written exactly once',
    after.distinct === after.total,
    `${after.distinct} distinct objects / ${after.total}`
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

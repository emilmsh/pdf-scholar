// Can a mark be CORRECTED after the fact, in the real app?
//
//   npm run test:annot-edit      (needs `npm run build` first)
//
// This test exists because the feature shipped broken. Dragging the end of a
// highlight was verified in the dev-web preview and by the screenshot run's
// assertions — the first says nothing about the real app, and the second only
// proved the knobs were DRAWN. Emil pressed one, dragged, and nothing moved. So
// the thing to test is the gesture itself, in Electron, on a document big enough
// to be realistic: the bug was a race against page-text extraction, which the
// six-page sample won by accident.
//
// It drives real pointer events at real handles and asserts the GEOMETRY changed
// — the annotation's own quads, read back out of the app — because "a handle
// appeared" and "the mark moved" turned out to be very different claims.
import { existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9336
const FILE = join(tmpdir(), 'pdfx-annot-edit-test.pdf')
/** The 15-page house paper when it is there (gitignored), the 6-page sample
 *  otherwise. The paper is the interesting case: extracting its text takes long
 *  enough that a drag can start before it is ready, which is the actual bug. */
const DEMO = join(ROOT, 'docs', 'screenshots', 'attention.pdf')
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
// No backticks and no interpolation anywhere below: PRELUDE is itself a template
// literal, so either one would be read by the OUTER file and break parsing.
const ui = {
  settle,
  page() {
    const el = document.querySelector('.pages[data-pane="a"] .pdf-page');
    if (!el) throw new Error('no page mounted');
    return el;
  },
  /** Every session mark on the page, as plain geometry we can compare */
  marks() {
    const page = this.page();
    const p = page.getBoundingClientRect();
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - p.left), y: Math.round(r.top - p.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      highlights: [...page.querySelectorAll('.annot-highlights > *')].map(box),
      shapes: [...page.querySelectorAll('.annot-marks svg')].map(box),
      knobs: page.querySelectorAll('.markup-end').length,
      grips: page.querySelectorAll('.annot-selection .grip').length
    };
  },
  /** Mark up one on-screen line and leave it unselected */
  async highlight() {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const box = pages.getBoundingClientRect();
    const span = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 24)
      .find((s) => {
        const r = s.getBoundingClientRect();
        return r.top > box.top + 120 && r.bottom < box.bottom - 120 && r.width > 120;
      });
    if (!span) throw new Error('no on-screen text to mark up');
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, Math.min(14, (span.textContent || '').length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await settle(200);
    const r = range.getBoundingClientRect();
    pages.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0, clientX: Math.round(r.right), clientY: Math.round(r.bottom)
    }));
    await settle(500);
    const menu = document.querySelector('.selection-menu');
    if (!menu) throw new Error('selection menu did not open');
    const swatch = menu.querySelector('.menu-color-group .color-dot');
    if (!swatch) throw new Error('no highlight colour in the selection menu');
    click(swatch);
    await settle(900);
    window.getSelection()?.removeAllRanges();
  },
  /** Draw a rectangle with the shape tool */
  async drawSquare() {
    const shapes = btn('Former');
    if (!shapes) throw new Error('no shapes button');
    click(shapes);
    await settle(350);
    const pick = [...document.querySelectorAll('.shape-pick')]
      .find((b) => /Rektangel|Rectangle/.test(b.title || ''));
    if (!pick) throw new Error('no rectangle in the shape menu');
    click(pick);
    await settle(400);
    const page = this.page();
    const layer = page.querySelector('.draw-layer');
    if (!layer) throw new Error('the shape tool did not arm');
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    const x = Math.round(host.left + host.width * 0.2);
    const y = Math.round(host.top + host.height * 0.55);
    const at = (t, dx, dy, buttons) => layer.dispatchEvent(new PointerEvent(t, {
      bubbles: true, pointerId: 41, isPrimary: true, button: 0, buttons,
      clientX: x + dx, clientY: y + dy
    }));
    at('pointerdown', 0, 0, 1);
    await settle(60);
    at('pointermove', 90, 60, 1);
    await settle(60);
    at('pointerup', 160, 110, 0);
    await settle(800);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(400);
  },
  /** Every text box on the page, with the shape the OVERLAY gave it */
  textBoxes() {
    const page = this.page();
    const p = page.getBoundingClientRect();
    return [...page.querySelectorAll('.annot-freetext')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left - p.left), y: Math.round(r.top - p.top),
        w: Math.round(r.width), h: Math.round(r.height),
        font: getComputedStyle(el).fontFamily,
        weight: getComputedStyle(el).fontWeight,
        style: getComputedStyle(el).fontStyle
      };
    });
  },
  /** Write a text box in a CHOSEN face: pick the family (and bold), click the
   *  page, type, commit. Returns what the EDITOR was showing while the text was
   *  typed — the thing that has to match the mark it commits. */
  async writeText(text) {
    const chev = [...document.querySelectorAll('.tb-chevron')]
      .find((b) => /Tekstfarge|Text colour/.test(b.title || ''));
    if (!chev) throw new Error('no text-options chevron');
    click(chev);
    await settle(400);
    const pick = [...document.querySelectorAll('.tool-menu .font-chip')]
      .find((b) => /Times/.test(b.textContent || ''));
    if (!pick) throw new Error('no Times chip in the text menu');
    click(pick);
    await settle(350);
    const bold = document.querySelector('.tool-menu .font-style-bold');
    if (!bold) throw new Error('no bold toggle in the text menu');
    click(bold);
    await settle(350);
    click(chev); // close the menu; the chevron leaves the tool armed
    await settle(300);
    const page = this.page();
    const layer = page.querySelector('.draw-layer');
    if (!layer) throw new Error('the text tool did not arm');
    const r = page.getBoundingClientRect();
    layer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 61, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(r.left + r.width * 0.60),
      clientY: Math.round(r.top + r.height * 0.24)
    }));
    await settle(600);
    const editor = document.querySelector('.freetext-editor');
    if (!editor) throw new Error('the text editor did not open');
    const cs = getComputedStyle(editor);
    const face = { font: cs.fontFamily, weight: cs.fontWeight };
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(150);
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true
    }));
    await settle(1600);
    return face;
  },
  /** Press a MARK (not a handle) and drag it somewhere else. Mouse arms the
   *  drag in onMouseDown; the move and the drop are pointer events on window. */
  async dragMark(selector, dx, dy) {
    const el = this.page().querySelector(selector);
    if (!el) throw new Error('no mark matching ' + selector);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const page = this.page();
    page.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y
    }));
    await settle(100);
    const move = (cx, cy, buttons) => ({
      bubbles: true, cancelable: true, pointerId: 62, isPrimary: true,
      button: 0, buttons, clientX: cx, clientY: cy
    });
    window.dispatchEvent(new PointerEvent('pointermove', move(x + dx / 3, y + dy / 3, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointermove', move(x + dx, y + dy, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointerup', move(x + dx, y + dy, 0)));
    await settle(1400);
  },
  /** Click a mark to select it (mouse down/up/click, as a hand does) */
  async selectAt(el, fx, fy) {
    const r = el.getBoundingClientRect();
    const page = this.page();
    const opt = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: Math.round(r.left + r.width * fx), clientY: Math.round(r.top + r.height * fy)
    };
    page.dispatchEvent(new MouseEvent('mousedown', opt));
    page.dispatchEvent(new MouseEvent('mouseup', opt));
    page.dispatchEvent(new MouseEvent('click', opt));
    await settle(400);
  },
  /** Press a handle and drag it, at human speed but without a human's patience.
   *  The pause before the first move is deliberately SHORT: waiting a second
   *  here is what hid the bug this test exists for. */
  async dragHandle(selector, dx, dy) {
    const grip = this.page().querySelector(selector);
    if (!grip) throw new Error('no handle matching ' + selector);
    const r = grip.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const opt = (cx, cy, buttons) => ({
      bubbles: true, cancelable: true, pointerId: 51, isPrimary: true,
      button: 0, buttons, clientX: cx, clientY: cy
    });
    grip.dispatchEvent(new PointerEvent('pointerdown', opt(x, y, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx / 3, y + dy / 3, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx, y + dy, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointerup', opt(x + dx, y + dy, 0)));
    await settle(1000);
  },
  /** Is the handle REACHABLE by a real pointer? A dispatched event goes straight
   *  to the element whether or not anything covers it, so a synthetic drag can
   *  pass while a hand cannot get near the thing. elementFromPoint answers the
   *  question a mouse actually asks. */
  hitTest(selector) {
    const grip = this.page().querySelector(selector);
    if (!grip) return { found: false };
    const r = grip.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return {
      found: true,
      reachable: top === grip || grip.contains(top) || top === grip.parentElement && false,
      covering: top ? (top.tagName.toLowerCase() + '.' + String(top.className || '')).slice(0, 70) : 'nothing'
    };
  },
  undo() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return settle(900);
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
const source = existsSync(DEMO) ? DEMO : SAMPLE
copyFileSync(source, FILE)
console.log(`document: ${source === DEMO ? 'the 15-page house paper' : 'sample.pdf (6 pages)'}\n`)

const app = launchApp({ root: ROOT, mainJs, args: [FILE], port: PORT })
const sockets = []

try {
  const [target] = await waitForPageTargets(PORT, 1)
  const ws = await openSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  const A = cdp(ws)
  await A('Runtime.enable')
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

  // ---- 1. the end of a highlight ----
  await evalIn(A, `await ui.highlight()`)
  const before = await evalIn(A, `return ui.marks()`)
  check('a highlight was made', before.highlights.length > 0, JSON.stringify(before.highlights[0]))

  await evalIn(A, `
    const m = ui.page().querySelector('.annot-highlights > *');
    await ui.selectAt(m, 0.5, 0.5);
  `)
  const selected = await evalIn(A, `return ui.marks()`)
  check('selecting it shows two end knobs', selected.knobs === 2, `${selected.knobs} knob(s)`)

  // The question Emil's hand asked: can a real pointer reach the knob at all?
  const knobHit = await evalIn(A, `return ui.hitTest('.markup-end-end')`)
  check('a real pointer reaches the end knob', knobHit.reachable === true,
    knobHit.found ? `topmost element there: ${knobHit.covering}` : 'no knob')

  // Drag the END knob to the right: the mark must cover MORE text.
  await evalIn(A, `await ui.dragHandle('.markup-end-end', 150, 0)`)
  const wider = await evalIn(A, `return ui.marks()`)
  const w0 = before.highlights[0]?.w ?? 0
  const w1 = wider.highlights[0]?.w ?? 0
  check('dragging the end grows the highlight', w1 > w0 + 10, `${w0} -> ${w1} px`)

  await evalIn(A, `await ui.undo()`)
  const undone = await evalIn(A, `return ui.marks()`)
  check('Ctrl+Z puts it back', Math.abs((undone.highlights[0]?.w ?? 0) - w0) <= 2,
    `${w1} -> ${undone.highlights[0]?.w ?? 0} px (was ${w0})`)

  // Dragging the same end LEFT must shrink it — the other direction has its own
  // clamping (the ends may not cross), so it is not the same code path twice.
  await evalIn(A, `
    const m = ui.page().querySelector('.annot-highlights > *');
    await ui.selectAt(m, 0.5, 0.5);
    await ui.dragHandle('.markup-end-start', 150, 0);
  `)
  const shorter = await evalIn(A, `return ui.marks()`)
  check('dragging the start shrinks it', (shorter.highlights[0]?.w ?? 0) < w0 - 5,
    `${w0} -> ${shorter.highlights[0]?.w ?? 0} px`)

  // The selection layer had to be raised above the text layer for the handles to
  // be reachable. Raising a full-page overlay is exactly how text selection has
  // been killed before (CLAUDE.md), so prove it still works WITH a mark selected.
  const stillSelectable = await evalIn(A, `
    const m = ui.page().querySelector('.annot-highlights > *');
    await ui.selectAt(m, 0.5, 0.5);
    const before = ui.page().querySelectorAll('.markup-end').length;
    await ui.highlight();
    return { knobsWereShowing: before, marks: ui.marks().highlights.length };
  `)
  check('text is still selectable with a mark selected (overlay is raised)',
    stillSelectable.knobsWereShowing === 2 && stillSelectable.marks >= 2,
    `${stillSelectable.marks} mark(s) after marking up a second passage`)

  // ---- 2. a shape's corner ----
  await evalIn(A, `await ui.drawSquare()`)
  const drawn = await evalIn(A, `return ui.marks()`)
  check('a rectangle was drawn', drawn.shapes.length > 0, `${drawn.shapes.length} shape(s)`)

  const shapeBox = await evalIn(A, `
    const svg = ui.page().querySelector('.annot-marks svg');
    const r = svg.querySelector('rect');
    if (!r) throw new Error('the shape svg has no rect');
    const b = r.getBoundingClientRect();
    // Select it by its OUTLINE: a hollow shape ignores clicks in its middle so
    // that text under it stays selectable.
    await ui.selectAt(r, 0.5, 0.02);
    return { w: Math.round(b.width), h: Math.round(b.height) };
  `)
  const framed = await evalIn(A, `return ui.marks()`)
  check('selecting the rectangle shows four grips', framed.grips === 4, `${framed.grips} grip(s)`)

  const gripHit = await evalIn(A, `return ui.hitTest('.annot-selection .br')`)
  check('a real pointer reaches the corner grip', gripHit.reachable === true,
    gripHit.found ? `topmost element there: ${gripHit.covering}` : 'no grip')

  // One handle size everywhere, and a box only where a box means something.
  // Emil asked for this by eye; it is cheap to keep by measurement.
  const look = await evalIn(A, `
    const page = ui.page();
    const grip = page.querySelector('.annot-selection .grip');
    const cs = getComputedStyle(grip);
    const frame = getComputedStyle(page.querySelector('.annot-selection'));
    return { grip: cs.width, frameBorder: frame.borderTopWidth, frameShadow: frame.boxShadow };
  `)
  check('a shape corner is the 7px dot', look.grip === '7px', look.grip)
  // A hairline, not an exact string: Chromium reports the USED width, and a 1px
  // border snaps to one device pixel — 0.8px on a 125% display.
  const border = Number.parseFloat(look.frameBorder)
  check('the box is a hairline with no halo',
    border > 0 && border <= 1.1 && (look.frameShadow === 'none' || look.frameShadow === ''),
    `${look.frameBorder} border, shadow: ${look.frameShadow}`)

  await evalIn(A, `await ui.dragHandle('.annot-selection .br', 120, 80)`)
  const resized = await evalIn(A, `
    const r = ui.page().querySelector('.annot-marks svg rect');
    const b = r.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  `)
  check('dragging the corner resizes the rectangle',
    resized.w > shapeBox.w + 20 && resized.h > shapeBox.h + 10,
    `${shapeBox.w}x${shapeBox.h} -> ${resized.w}x${resized.h} px`)

  await evalIn(A, `await ui.undo()`)
  const shapeUndone = await evalIn(A, `
    const r = ui.page().querySelector('.annot-marks svg rect');
    const b = r.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  `)
  check('Ctrl+Z puts the rectangle back',
    Math.abs(shapeUndone.w - shapeBox.w) <= 3 && Math.abs(shapeUndone.h - shapeBox.h) <= 3,
    `${resized.w}x${resized.h} -> ${shapeUndone.w}x${shapeUndone.h} px`)

  // ---- 3. the text box's TYPEFACE ----
  //
  // v0.36.0 offered "printed vs handwriting", which was never a font choice —
  // and its editor typed in the default sans until the mark was committed. The
  // typeface is now one of the PDF Standard 14, and the three things that have
  // to agree are checked separately: the menu, the EDITOR, and the mark.
  const editorFace = await evalIn(A, `return await ui.writeText('Tekst i valgt skrift')`)
  const wrote = await evalIn(A, `return ui.textBoxes()`)
  check('a text box was written', wrote.length === 1, `${wrote.length} box(es)`)
  // Typing in one face and committing in another is not a preview — and it is
  // not only cosmetic: the commit's minimum box is measured in the committed
  // face, so an editor set in another one wraps somewhere else than the mark.
  check('the editor typed in the chosen face',
    /Times/i.test(editorFace.font) && editorFace.weight === '700',
    `${editorFace.font} @ ${editorFace.weight}`)
  check('…and the mark kept it',
    /Times/i.test(wrote[0]?.font ?? '') && wrote[0]?.weight === '700',
    `${wrote[0]?.font} @ ${wrote[0]?.weight}`)

  await evalIn(A, `await ui.dragMark('.annot-freetext', -110, 70)`)
  const moved = await evalIn(A, `return ui.textBoxes()`)
  check('the box can be dragged',
    moved.length === 1 && Math.abs(moved[0].x - (wrote[0].x - 110)) <= 6 &&
      Math.abs(moved[0].y - (wrote[0].y + 70)) <= 6,
    `(${wrote[0]?.x}, ${wrote[0]?.y}) -> (${moved[0]?.x}, ${moved[0]?.y})`)

  const textFramed = await evalIn(A, `
    const el = ui.page().querySelector('.annot-freetext');
    await ui.selectAt(el, 0.5, 0.5);
    return ui.marks();
  `)
  check('selecting it shows four grips', textFramed.grips === 4, `${textFramed.grips} grip(s)`)

  await evalIn(A, `await ui.dragHandle('.annot-selection .br', 90, 40)`)
  const grown = await evalIn(A, `return ui.textBoxes()`)
  check('dragging the corner resizes it',
    grown[0] && grown[0].w > moved[0].w + 20,
    `${moved[0]?.w}px -> ${grown[0]?.w}px`)
  check('…and the face survives the resize', /Times/i.test(grown[0]?.font ?? ''), grown[0]?.font)

  await evalIn(A, `await ui.undo()`)
  const textUndone = await evalIn(A, `return ui.textBoxes()`)
  check('Ctrl+Z puts the box back',
    textUndone[0] && Math.abs(textUndone[0].w - moved[0].w) <= 4,
    `${grown[0]?.w}px -> ${textUndone[0]?.w}px`)
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
  const log = app.log()
  if (log.trim()) console.error('\n--- app output ---\n' + log.trim().slice(-1500))
} finally {
  for (const ws of sockets) {
    try { ws.close() } catch { /* already gone */ }
  }
  await app.cleanup()
  try { unlinkSync(FILE) } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

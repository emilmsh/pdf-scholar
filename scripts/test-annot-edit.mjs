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
import * as mupdf from 'mupdf'
import { standardFontCssProperties } from '@embedpdf/models'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'
import { wrapLines } from './lib/freetext-check.mjs'

/** PdfStandardFont 0–11, the twelve faces the text tool offers */
const FACE_NAMES = [
  'Courier', 'Courier-Bold', 'Courier-BoldOblique', 'Courier-Oblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Oblique',
  'Times-Roman', 'Times-Bold', 'Times-BoldItalic', 'Times-Italic'
]
/** The renderer's textFontCss (annotations.ts) — EmbedPDF's own mapping */
const textFontCss = (font) => standardFontCssProperties(font)

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
        style: getComputedStyle(el).fontStyle,
        size: parseFloat(getComputedStyle(el).fontSize)
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
  },
  /** Arm the text tool (a committed box disarms it) */
  async armText() {
    const b = btn('Tekst');
    if (!b) throw new Error('no text tool button');
    if (!b.classList.contains('is-active')) click(b);
    await settle(300);
    if (!this.page().querySelector('.draw-layer')) throw new Error('the text tool did not arm');
  },
  /** Press the page with the text tool at (fx, fy) of it; the click point */
  async placeDraft(fx, fy) {
    const page = this.page();
    const r = page.getBoundingClientRect();
    const x = Math.round(r.left + r.width * fx);
    const y = Math.round(r.top + r.height * fy);
    page.querySelector('.draw-layer').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 63, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y
    }));
    await settle(500);
    if (!document.querySelector('.freetext-editor')) throw new Error('the text editor did not open');
    return { x, y };
  },
  /** The open draft as the screen shows it */
  draft() {
    const ed = document.querySelector('.freetext-editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    const cs = getComputedStyle(ed);
    return {
      left: r.left, top: r.top, right: r.right, w: r.width, h: r.height,
      lineH: parseFloat(cs.lineHeight), sizePx: parseFloat(cs.fontSize),
      placeholder: ed.placeholder, value: ed.value,
      focused: document.activeElement === ed,
      padding: cs.paddingLeft + ' ' + cs.paddingTop, border: cs.borderLeftWidth
    };
  },
  /** Type into the draft as an input event delivers it */
  async type(text) {
    const ed = document.querySelector('.freetext-editor');
    ed.value = text;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
  },
  async commitDraft() {
    document.querySelector('.freetext-editor').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true
    }));
    await settle(1600);
  },
  /** A line's width in the draft's own face, measured as the app measures */
  measure(text) {
    const cs = getComputedStyle(document.querySelector('.freetext-editor'));
    const c = document.createElement('canvas').getContext('2d');
    c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    c.fontKerning = 'none';
    return c.measureText(text).width;
  },
  /** Drag something that is not on the page (the draft's grips) */
  async dragEl(selector, dx, dy) {
    const el = document.querySelector(selector);
    if (!el) throw new Error('nothing matching ' + selector);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const opt = (cx, cy, buttons) => ({
      bubbles: true, cancelable: true, pointerId: 64, isPrimary: true, pointerType: 'mouse',
      button: 0, buttons, clientX: cx, clientY: cy
    });
    const down = new PointerEvent('pointerdown', opt(x, y, 1));
    el.dispatchEvent(down);
    // The press must be TAKEN — that is what keeps the textarea focused
    const taken = down.defaultPrevented;
    await settle(80);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx / 2, y + dy / 2, 1)));
    await settle(80);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx, y + dy, 1)));
    await settle(80);
    window.dispatchEvent(new PointerEvent('pointerup', opt(x + dx, y + dy, 0)));
    await settle(300);
    return taken;
  },
  /** Is it the topmost thing under its own centre? (see hitTest) */
  reachable(selector) {
    const el = document.querySelector(selector);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      found: true, reachable: top === el || el.contains(top),
      covering: top ? (top.tagName.toLowerCase() + '.' + String(top.className || '')).slice(0, 70) : 'nothing'
    };
  },
  /** The lines a committed box shows, as the screen broke them */
  shownLines(el) {
    const node = el.firstChild;
    const lines = [];
    let top = null;
    let i = 0;
    for (const word of node.textContent.split(' ')) {
      if (word.length > 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + word.length);
        const r = range.getClientRects()[0];
        if (top === null || Math.abs(r.top - top) > 2) {
          lines.push([]);
          top = r.top;
        }
        lines[lines.length - 1].push(word);
      }
      i += word.length + 1;
    }
    return lines.map((l) => l.join(' '));
  },
  /** A committed box's first line, where the screen draws its first letter */
  firstLine(el) {
    const range = document.createRange();
    range.setStart(el.firstChild, 0);
    range.setEnd(el.firstChild, 1);
    const r = range.getBoundingClientRect();
    return { left: r.left, mid: (r.top + r.bottom) / 2 };
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

  // ---- 4. the text box's SIZE after writing (issue #53) ----
  //
  // The size used to be a choice for the NEXT box only: the box's own menu
  // had the face and the weight, but no slider. Now it has the one the text
  // tool's menu has, and a change re-sets THIS box — face kept, box grown to
  // fit the bigger letters.
  const sizeBefore = await evalIn(A, `
    const el = ui.page().querySelector('.annot-freetext');
    await ui.selectAt(el, 0.5, 0.5);
    const range = document.querySelector('.annot-popover .font-size-range');
    if (!range) throw new Error('no size slider in the text box menu');
    return { box: ui.textBoxes()[0], slider: Number(range.value) };
  `)
  check('the box menu has a size slider, at the box’s own size',
    sizeBefore.slider === 12, `slider at ${sizeBefore.slider}`)
  const sizeAfter = await evalIn(A, `
    const range = document.querySelector('.annot-popover .font-size-range');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(range, '36');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(1500);
    const out = document.querySelector('.annot-popover .slider-label output');
    return { box: ui.textBoxes()[0], label: out ? out.textContent : null };
  `)
  check('moving it to 36 pt triples the letters on the page',
    Math.abs(sizeAfter.box.size / sizeBefore.box.size - 3) < 0.1,
    `${sizeBefore.box.size}px -> ${sizeAfter.box.size}px`)
  check('…the menu says so', sizeAfter.label === '36 pt', String(sizeAfter.label))
  check('…the face survives the size change', /Times/i.test(sizeAfter.box.font), sizeAfter.box.font)
  // The words re-wrap inside the width the box has (the floor measures at
  // that width, like the corner handles) and the box grows DOWN to hold the
  // lines: at 36 pt the 48 pt default box cannot, so it must be taller now
  check('…and the box grew to fit the lines', sizeAfter.box.h > sizeBefore.box.h && sizeAfter.box.w === sizeBefore.box.w,
    `${sizeBefore.box.w}×${sizeBefore.box.h}px -> ${sizeAfter.box.w}×${sizeAfter.box.h}px`)

  // ---- 5. the box menu with the text tool ARMED (issue #53) ----
  //
  // Before: with the tool armed, a click on an existing box opened the editor
  // and nothing else; the menu came only from a click with no tool at all.
  const armed = await evalIn(A, `
    await ui.selectAt(ui.page(), 0.95, 0.95); // a blank spot: closes the menu
    if (document.querySelector('.annot-popover')) throw new Error('the menu did not close');
    const b = btn('Tekst');
    if (!b) throw new Error('no text tool button');
    if (!b.classList.contains('is-active')) click(b);
    await settle(300);
    const el = ui.page().querySelector('.annot-freetext');
    const r = el.getBoundingClientRect();
    const layer = ui.page().querySelector('.draw-layer');
    if (!layer) throw new Error('the text tool did not arm');
    layer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 62, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
    }));
    await settle(600);
    const editor = document.querySelector('.freetext-editor');
    const out = {
      editor: !!editor, text: editor ? editor.value : null,
      menu: !!document.querySelector('.annot-popover'),
      slider: !!document.querySelector('.annot-popover .font-size-range')
    };
    if (editor) editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    return out;
  `)
  check('with the text tool armed, a click on the box opens the editor on its text',
    armed.editor && armed.text === 'Tekst i valgt skrift', JSON.stringify(armed))
  check('…and the box menu beside it, size slider included', armed.menu && armed.slider, JSON.stringify(armed))

  // ---- 6. WRITING a text box (issue #66) ----
  //
  // The reporter's four wishes, each as the hand meets it: the text lands
  // where the pointer clicked, an empty box shows a placeholder and hugs it,
  // the box grows with its text and wraps at the page edge, a box sized by
  // hand keeps its width, and a grip moves the box before anything is typed.
  const boxesBefore = await evalIn(A, `return ui.textBoxes().length`)
  const fresh = await evalIn(A, `
    await ui.armText();
    const at = await ui.placeDraft(0.12, 0.62);
    return { at, d: ui.draft(), ph: ui.measure(ui.draft().placeholder) };
  `)
  check('an empty box shows a short placeholder', /^(Tekst|Text|文本)$/.test(fresh.d.placeholder),
    JSON.stringify(fresh.d.placeholder))
  check('…and hugs it: a few characters wide, not 200 pt',
    fresh.d.w >= fresh.ph && fresh.d.w <= fresh.ph + 6, `${Math.round(fresh.d.w)} px for a ${Math.round(fresh.ph)} px placeholder`)
  check('the text starts AT the click (no inset, no border)',
    Math.abs(fresh.d.left - fresh.at.x) <= 1 && fresh.d.padding === '0px 0px' && fresh.d.border === '0px',
    `editor left ${fresh.d.left.toFixed(1)} vs click ${fresh.at.x}; padding ${fresh.d.padding}, border ${fresh.d.border}`)
  check('…and its first line is centred on the click',
    Math.abs(fresh.d.top + fresh.d.lineH / 2 - fresh.at.y) <= 2,
    `line centre ${(fresh.d.top + fresh.d.lineH / 2).toFixed(1)} vs click ${fresh.at.y}`)
  const reach = await evalIn(A, `
    return { move: ui.reachable('.freetext-move'), size: ui.reachable('.freetext-resize') };
  `)
  check('a real pointer reaches the move grip', reach.move.reachable === true,
    reach.move.found ? `topmost element there: ${reach.move.covering}` : 'no grip')
  check('a real pointer reaches the resize corner', reach.size.reachable === true,
    reach.size.found ? `topmost element there: ${reach.size.covering}` : 'no handle')

  // Move it BEFORE typing — the misplaced click. The empty draft must survive
  // (an empty draft that loses focus is discarded) and keep the keyboard.
  const moved6 = await evalIn(A, `
    const taken = await ui.dragEl('.freetext-move', 40, 25);
    return { taken, d: ui.draft() };
  `)
  check('the grip moves the empty box', !!moved6.d &&
    Math.abs(moved6.d.left - (fresh.d.left + 40)) <= 2 && Math.abs(moved6.d.top - (fresh.d.top + 25)) <= 2,
    moved6.d ? `(${Math.round(fresh.d.left)}, ${Math.round(fresh.d.top)}) -> (${Math.round(moved6.d.left)}, ${Math.round(moved6.d.top)})` : 'the draft is gone')
  check('…without taking the focus from the text', moved6.taken === true && moved6.d?.focused === true,
    `press taken: ${moved6.taken}, focused: ${moved6.d?.focused}`)

  // Grows with what is typed, and shrinks back with it
  const grow = await evalIn(A, `
    await ui.type('Kort');
    const short = ui.draft();
    const shortText = ui.measure('Kort');
    await ui.type('Litt lengre tekst her');
    const longer = ui.draft();
    const longerText = ui.measure('Litt lengre tekst her');
    return { short, shortText, longer, longerText };
  `)
  check('the box hugs its text as it is typed',
    grow.short.w >= grow.shortText && grow.short.w <= grow.shortText + 6 &&
      grow.longer.w >= grow.longerText && grow.longer.w <= grow.longerText + 6 &&
      Math.abs(grow.longer.h - grow.short.h) < 1,
    `${Math.round(grow.short.w)} px for ${Math.round(grow.shortText)}, ${Math.round(grow.longer.w)} px for ${Math.round(grow.longerText)}, one line each`)

  // Commit: the mark lands exactly where the editor showed it
  const landed = await evalIn(A, `
    const before = ui.draft();
    const prior = new Set(ui.page().querySelectorAll('.annot-freetext'));
    await ui.commitDraft();
    const el = [...ui.page().querySelectorAll('.annot-freetext')].find((e) => !prior.has(e));
    if (!el) return { before, el: null };
    const r = el.getBoundingClientRect();
    return {
      before, el: { left: r.left, top: r.top, w: r.width, lineH: parseFloat(getComputedStyle(el).lineHeight) },
      first: ui.firstLine(el), text: el.textContent
    };
  `)
  check('the box commits', !!landed.el && landed.text === 'Litt lengre tekst her', JSON.stringify(landed.text ?? null))
  if (landed.el) {
    check('…exactly where and as wide as the editor showed it',
      Math.abs(landed.el.left - landed.before.left) <= 1 && Math.abs(landed.el.top - landed.before.top) <= 1 &&
        Math.abs(landed.el.w - landed.before.w) <= 1 && Math.abs(landed.el.lineH - landed.before.lineH) < 0.1,
      `editor (${landed.before.left.toFixed(1)}, ${landed.before.top.toFixed(1)}) ${landed.before.w.toFixed(1)} px, line ${landed.before.lineH.toFixed(2)} -> ` +
        `mark (${landed.el.left.toFixed(1)}, ${landed.el.top.toFixed(1)}) ${landed.el.w.toFixed(1)} px, line ${landed.el.lineH.toFixed(2)}`)
    check('…its first letter starts at the (moved) click and its line is centred there',
      Math.abs(landed.first.left - (fresh.at.x + 40)) <= 2 && Math.abs(landed.first.mid - (fresh.at.y + 25)) <= 2,
      `letter at (${landed.first.left.toFixed(1)}, ${landed.first.mid.toFixed(1)}) vs (${fresh.at.x + 40}, ${fresh.at.y + 25})`)
  }

  // An untouched placeholder never becomes a mark
  const untouched = await evalIn(A, `
    await ui.armText();
    const n = ui.textBoxes().length;
    await ui.placeDraft(0.12, 0.78);
    // A press elsewhere on the page closes the draft (the editor's blur)
    await ui.placeDraft(0.5, 0.9).catch(() => null);
    await settle(400);
    const open = !!document.querySelector('.freetext-editor');
    if (open) document.querySelector('.freetext-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    return { before: n, after: ui.textBoxes().length };
  `)
  check('an empty box, left alone, is never saved', untouched.after === untouched.before,
    `${untouched.before} -> ${untouched.after} box(es)`)

  // Near the right edge it stops widening and wraps
  const edge = await evalIn(A, `
    await ui.armText();
    await ui.placeDraft(0.62, 0.70);
    await ui.type('Denne setningen er altfor lang til å få plass på resten av linjen ut til sidekanten');
    const d = ui.draft();
    const page = ui.page().getBoundingClientRect();
    const out = { d, pageRight: page.right };
    document.querySelector('.freetext-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    return out;
  `)
  check('a long line wraps short of the page edge',
    edge.d.right <= edge.pageRight - 4 && edge.d.right >= edge.pageRight - 120 && edge.d.h >= 1.9 * edge.d.lineH,
    `box right ${Math.round(edge.d.right)} vs page right ${Math.round(edge.pageRight)}, ${(edge.d.h / edge.d.lineH).toFixed(1)} lines`)

  // A width set by hand is the reader's: more text adds lines, not width
  const pinned = await evalIn(A, `
    await ui.armText();
    await ui.placeDraft(0.12, 0.84);
    await ui.type('Noen ord');
    const start = ui.draft();
    const taken = await ui.dragEl('.freetext-resize', 70, 0);
    const sized = ui.draft();
    await ui.type('Noen ord, og så mange flere ord at de ikke lenger får plass på én linje');
    const typed = ui.draft();
    const prior = new Set(ui.page().querySelectorAll('.annot-freetext'));
    await ui.commitDraft();
    const el = [...ui.page().querySelectorAll('.annot-freetext')].find((e) => !prior.has(e));
    const cs = el ? getComputedStyle(el) : null;
    return {
      start, taken, sized, typed, committedW: el ? el.getBoundingClientRect().width : null,
      shown: el ? ui.shownLines(el) : [], text: el ? el.textContent : '',
      sizePx: cs ? parseFloat(cs.fontSize) : 0, face: cs ? cs.fontFamily + ' ' + cs.fontWeight + ' ' + cs.fontStyle : ''
    };
  `)
  check('the corner widens the box', pinned.taken === true && Math.abs(pinned.sized.w - (pinned.start.w + 70)) <= 2 &&
    pinned.sized.focused === true, `${Math.round(pinned.start.w)} -> ${Math.round(pinned.sized.w)} px, focused: ${pinned.sized.focused}`)
  check('…and from then on the width holds while the height grows',
    Math.abs(pinned.typed.w - pinned.sized.w) <= 1 && pinned.typed.h >= 1.9 * pinned.typed.lineH,
    `${Math.round(pinned.sized.w)} -> ${Math.round(pinned.typed.w)} px wide, ${(pinned.typed.h / pinned.typed.lineH).toFixed(1)} lines`)
  check('…and the committed box keeps that width',
    pinned.committedW !== null && Math.abs(pinned.committedW - pinned.typed.w) <= 1,
    `${pinned.committedW === null ? 'no box' : Math.round(pinned.committedW)} vs ${Math.round(pinned.typed.w)} px`)
  // The lines the screen shows are the lines the FILE will show: the same
  // words on the same lines as PDFium's rule (lib/freetext-check.mjs, which
  // test:engine holds against PDFium's own appearance streams) breaks them
  // at this box's width in the Standard-14 face. The box is set in the face
  // section 3 chose, Times bold, at the tool's 12 pt.
  if (pinned.committedW !== null) {
    const timesBold = new mupdf.Font('Times-Bold')
    const afm = (s) => {
      let w = 0
      for (const ch of s) w += timesBold.advanceGlyph(timesBold.encodeCharacter(ch.codePointAt(0)), false)
      return w * 12
    }
    const wPt = pinned.committedW / (pinned.sizePx / 12)
    const fileLines = wrapLines(pinned.text, wPt, afm)
    check('…and its lines break where the file\'s will',
      /Times/.test(pinned.face) && /700/.test(pinned.face) && JSON.stringify(pinned.shown) === JSON.stringify(fileLines),
      `screen ${JSON.stringify(pinned.shown)} vs file ${JSON.stringify(fileLines)} (${pinned.face})`)
  }
  const boxesAfter = await evalIn(A, `return ui.textBoxes().length`)
  check('two boxes written in this section, no more', boxesAfter === boxesBefore + 2, `${boxesBefore} -> ${boxesAfter}`)

  // ---- 7. the screen's faces are as wide as the file's ----
  //
  // A box that hugs its text is only its longest line plus 2 pt wide, so the
  // face the screen sets a line in must be as wide as the Standard-14 face the
  // file sets it in (PDFium wraps by those widths), or the file wraps the last
  // word where the screen did not. Measured as the app measures (canvas, no
  // kerning) in the CSS the app gives each face (textFontCss).
  const SAMPLE_LINE = 'Fri tekst – med ÆØÅ, æøå og «sitat»: 123,45 % (Q.E.D.)'
  const faces = FACE_NAMES.map((name, font) => ({ name, ...textFontCss(font) }))
  const screenWidths = await evalIn(A, `
    const faces = ${JSON.stringify(faces)};
    const c = document.createElement('canvas').getContext('2d');
    c.fontKerning = 'none';
    return faces.map((f) => {
      c.font = f.fontStyle + ' ' + f.fontWeight + ' 100px ' + f.fontFamily;
      return c.measureText(${JSON.stringify(SAMPLE_LINE)}).width;
    });
  `)
  const rows = FACE_NAMES.map((name, i) => {
    const f = new mupdf.Font(name)
    let w = 0
    for (const ch of SAMPLE_LINE) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)), false)
    return { name, file: w * 100, screen: screenWidths[i] }
  })
  // 0.1 %: a 500 pt line may differ by half a point, well inside the 2 pt the
  // box keeps past its longest line. (Courier New is 600.1 per mille, a
  // rounding in the font, where Courier is 600.)
  const off = rows.filter((r) => Math.abs(r.screen - r.file) > r.file * 0.001)
  const worst = Math.max(...rows.map((r) => Math.abs(r.screen - r.file) / r.file))
  check('every face measures on screen as wide as in the file (within 0.1 %)', off.length === 0,
    off.length
      ? off.map((r) => `${r.name} ${r.screen.toFixed(1)} vs ${r.file.toFixed(1)}`).join('; ')
      : `12 faces, worst ${(worst * 100).toFixed(3)} %`)

  // …and the screen breaks a line by the file's rule. PDFium moves a word
  // down once it WITH its following space overruns the box; CSS pre-wrap let
  // that space hang and kept the word up. In a box exactly wide enough for
  // «aaa aaa» but not «aaa aaa », the file reads «aaa» / «aaa» / «aaa aaa»
  // where pre-wrap showed two lines of «aaa aaa».
  const PROBE = 'aaa aaa aaa aaa'
  const PROBE_LINES = ['aaa', 'aaa', 'aaa aaa']
  const breaking = await evalIn(A, `
    const probe = (tag) => {
      const el = document.createElement(tag);
      el.className = tag === 'textarea' ? 'freetext-editor' : 'annot annot-freetext';
      Object.assign(el.style, { position: 'fixed', left: '10px', top: '10px', height: '120px', inset: 'auto',
        font: 'bold 100px "Times New Roman", Times, serif', lineHeight: '120px', padding: '0', border: '0' });
      const c = document.createElement('canvas').getContext('2d');
      c.font = el.style.font;
      c.fontKerning = 'none';
      el.style.width = (c.measureText('aaa aaa').width + 1) + 'px';
      document.body.append(el);
      let out;
      if (tag === 'textarea') {
        el.value = ${JSON.stringify(PROBE)};
        // a textarea's lines: the height of its content at this width
        out = Math.round(el.scrollHeight / 120);
      } else {
        el.textContent = ${JSON.stringify(PROBE)};
        out = ui.shownLines(el);
      }
      el.remove();
      return out;
    };
    return { overlay: probe('div'), editor: probe('textarea') };
  `)
  // (The rule's own verdict on the probe, at the Times-Bold widths)
  const tb = new mupdf.Font('Times-Bold')
  const tb100 = (s) => [...s].reduce((w, ch) => w + tb.advanceGlyph(tb.encodeCharacter(ch.codePointAt(0)), false), 0) * 100
  const ruled = wrapLines(PROBE, tb100('aaa aaa') + 1, tb100)
  check('the overlay breaks a line where the file does (the space goes down with its word)',
    JSON.stringify(breaking.overlay) === JSON.stringify(PROBE_LINES) && JSON.stringify(ruled) === JSON.stringify(PROBE_LINES),
    `screen ${JSON.stringify(breaking.overlay)}, file rule ${JSON.stringify(ruled)}`)
  check('…and so does the editor', breaking.editor === PROBE_LINES.length, `${breaking.editor} line(s)`)
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

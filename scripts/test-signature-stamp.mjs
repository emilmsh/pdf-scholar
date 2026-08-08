// The signature stamp, end to end in the REAL app.
//
//   npm run test:signature-stamp      (needs `npm run build` first)
//
// Same reason test:annot-edit exists: the dev-web preview says nothing about
// Electron, and "the button is there" is a different claim from "a signature
// drawn by hand ends up in the file". This drives the whole flow through the UI
// — open the pad, draw on it, save, place it on the page, drag it — and checks
// the things that would each ship a broken feature on their own:
//
//   - the pad opens from the toolbar when nothing is saved yet
//   - a stroke drawn on it survives as a TRIMMED png (not the whole empty pad)
//   - the saved signature is remembered and listed as a picture
//   - placing it puts a mark on the page at the image's own aspect ratio
//   - the placed stamp can be moved afterwards, like any other mark
//   - the document really carries a /Stamp with an image (checked with mupdf,
//     which has no stake in what PDFium believes it wrote)
import { copyFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9341
const FILE = join(tmpdir(), 'pdfx-signature-stamp-test.pdf')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const byTitle = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.title || ''));
const ui = {
  settle,
  page() {
    const el = document.querySelector('.pages[data-pane="a"] .pdf-page');
    if (!el) throw new Error('no page mounted');
    return el;
  },
  /** Toolbar signature button (the main half, not the chevron) */
  openPad() {
    localStorage.removeItem('pdfx-signatures');
    const b = byTitle(/^Signatur/);
    if (!b) throw new Error('no signature button in the toolbar');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return settle(600);
  },
  /** Draw a wave on the pad with pen pointer events, as a stylus would */
  async draw() {
    const c = document.querySelector('.signature-canvas');
    if (!c) throw new Error('the signature pad did not open');
    const r = c.getBoundingClientRect();
    const at = (fx, fy) => ({
      clientX: Math.round(r.left + r.width * fx),
      clientY: Math.round(r.top + r.height * fy)
    });
    const send = (type, p) => c.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 71, pointerType: 'pen', pressure: 0.65, isPrimary: true, button: 0, buttons: 1, ...p
    }));
    send('pointerdown', at(0.12, 0.62));
    for (let i = 1; i <= 20; i++) {
      const f = i / 20;
      send('pointermove', at(0.12 + f * 0.72, 0.62 - Math.sin(f * Math.PI * 2) * 0.3));
    }
    send('pointerup', at(0.84, 0.62));
    await settle(200);
  },
  save() {
    const b = [...document.querySelectorAll('.signature-actions button')]
      .find((x) => /lagre|save/i.test(x.textContent));
    if (!b || b.disabled) throw new Error('save is not available (nothing drawn?)');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return settle(700);
  },
  stored() {
    try { return JSON.parse(localStorage.getItem('pdfx-signatures') || '[]'); } catch { return []; }
  },
  armed() {
    return !!document.querySelector('.note-place-overlay');
  },
  /** Drop the armed signature onto the middle of the page */
  place() {
    const ov = document.querySelector('.note-place-overlay');
    if (!ov) throw new Error('no signature is armed');
    const p = this.page().getBoundingClientRect();
    ov.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 72, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(p.left + p.width * 0.5),
      clientY: Math.round(p.top + p.height * 0.5)
    }));
    return settle(1500);
  },
  stampBox() {
    const img = document.querySelector('img.annot-stamp');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const p = this.page().getBoundingClientRect();
    return {
      x: Math.round(r.left - p.left), y: Math.round(r.top - p.top),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  },
  /** Drag the stamp itself: mousedown arms the move, pointermove drives it */
  async dragStamp(dx, dy) {
    const img = document.querySelector('img.annot-stamp');
    if (!img) throw new Error('no stamp to drag');
    const r = img.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const opt = (cx, cy, buttons) => ({
      bubbles: true, cancelable: true, pointerId: 73, isPrimary: true, button: 0, buttons,
      clientX: cx, clientY: cy
    });
    this.page().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y }));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx / 3, y + dy / 3, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x + dx, y + dy, 1)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointerup', opt(x + dx, y + dy, 0)));
    await settle(1200);
  },
  save_() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    return settle(1600);
  }
};
`

const evalIn = (send, body) => evaluate(send, body, PRELUDE)

if (existsSync(FILE)) unlinkSync(FILE)
copyFileSync(SAMPLE, FILE)

const mainJs = join(ROOT, 'out', 'main', 'index.js')
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

  // 1. The pad opens straight from the toolbar when nothing is saved yet
  const padOpen = await evalIn(A, `
    await ui.openPad();
    return !!document.querySelector('.signature-canvas');
  `)
  check('the toolbar button opens the pad when nothing is saved', padOpen === true)

  // 2. Draw, save — and the PNG must be cropped to the ink, not the whole pad
  const stored = await evalIn(A, `
    await ui.draw();
    await ui.save();
    const s = ui.stored();
    return { count: s.length, w: s[0] && s[0].width, h: s[0] && s[0].height,
             png: !!(s[0] && s[0].dataUrl.startsWith('data:image/png;base64,')),
             padClosed: !document.querySelector('.signature-canvas'), armed: ui.armed() };
  `)
  check('the drawn signature was saved', stored.count === 1, JSON.stringify(stored))
  check('it is a PNG data URL', stored.png === true)
  check('the pad closed after saving', stored.padClosed === true)
  check('it was trimmed to the ink (narrower than the 1000px pad)',
    stored.w > 0 && stored.w < 1000, `${stored.w}x${stored.h}px`)
  check('saving arms it for placement (drawing one means using one)', stored.armed === true)

  // 3. Place it — the mark must appear at the image's own aspect ratio
  const placed = await evalIn(A, `
    await ui.place();
    const s = ui.stored()[0];
    return { box: ui.stampBox(), stillArmed: ui.armed(), srcW: s.width, srcH: s.height };
  `)
  check('a stamp appeared on the page', !!placed.box, JSON.stringify(placed.box))
  check('placing disarms the tool', placed.stillArmed === false)
  if (placed.box) {
    const shown = placed.box.w / placed.box.h
    const source = placed.srcW / placed.srcH
    check('it keeps the signature\'s aspect ratio', Math.abs(shown - source) < 0.06,
      `${shown.toFixed(2)} vs ${source.toFixed(2)}`)
  }

  // 4. It can be corrected afterwards, like every other mark
  const moved = await evalIn(A, `
    const before = ui.stampBox();
    await ui.dragStamp(70, 40);
    return { before, after: ui.stampBox() };
  `)
  check('the stamp can be dragged',
    moved.after && (Math.abs(moved.after.x - moved.before.x) > 40),
    `x ${moved.before?.x} -> ${moved.after?.x}, y ${moved.before?.y} -> ${moved.after?.y}`)
  check('dragging moves it without resizing it',
    moved.after && Math.abs(moved.after.w - moved.before.w) <= 1 &&
      Math.abs(moved.after.h - moved.before.h) <= 1,
    `${moved.before?.w}x${moved.before?.h} -> ${moved.after?.w}x${moved.after?.h}`)

  // 5. And it is really IN the document — verified by a library that did not
  // write it. This is the check the whole feature stands on.
  await evalIn(A, `await ui.save_();`)
  await sleep(1800)
  const doc = mupdf.Document.openDocument(readFileSync(FILE), 'application/pdf').asPDF()
  let stamps = 0
  let withAp = 0
  for (let p = 0; p < doc.countPages(); p++) {
    for (const a of doc.loadPage(p).getAnnotations()) {
      if (a.getType() !== 'Stamp') continue
      stamps++
      const ap = a.getObject().get('AP')
      if (ap && !ap.isNull()) withAp++
    }
  }
  check('mupdf finds the stamp in the saved file', stamps === 1, `${stamps} stamp(s)`)
  check('the stamp has an appearance stream', withAp === 1, `${withAp}/${stamps}`)
  const bytes = readFileSync(FILE).toString('latin1')
  check('the file carries the image itself', /\/Subtype\s*\/Image/.test(bytes))
  doc.destroy()
  const log = app.log()
  if (log.trim()) console.error('\n--- app output ---\n' + log.trim().slice(-1200))
} finally {
  for (const s of sockets) { try { s.close() } catch { /* already gone */ } }
  await app.cleanup()
  if (existsSync(FILE)) { try { unlinkSync(FILE) } catch { /* held by the app */ } }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

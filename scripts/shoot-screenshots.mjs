// Re-shoot every README screenshot, automatically.
//
//   npm run shoot            all shots
//   npm run shoot -- dual-pane reading      just these
//   npm run shoot -- --list                 show the shot names
//
// Why it drives the REAL desktop app rather than the dev-web preview: the
// screenshots are of the Windows app, so they should be the Windows app —
// real IPC, real file opening, real tab strip. Electron ships Chromium's
// DevTools protocol, so no browser-automation dependency is needed: we spawn
// `electron out/main/index.js <pdf> --remote-debugging-port`, talk CDP over the
// WebSocket that Node has had built in since v22, drive the UI with
// Runtime.evaluate, and capture with Page.captureScreenshot.
//
// Two deliberate choices that make the output reproducible:
//   * `--user-data-dir` points at a THROWAWAY profile, so the shoot never
//     touches the real recents/reading positions/theme, and every run starts
//     from factory defaults. (It also gives the run its own single-instance
//     lock, so it works while the real app is open.)
//   * device metrics are pinned (size + deviceScaleFactor 2), so the PNGs are
//     the same dimensions every time and crisp on a HiDPI README.
//
// The two assistant screenshots are NOT here: a useful one needs a real answer
// from a real API key, which is neither reproducible nor something to bake into
// a script. Shoot those two by hand when the assistant UI changes.
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
/** The house demo doc (arXiv 1706.03762). Gitignored — see .gitignore. */
const DEMO_PDF = join(OUT_DIR, 'attention.pdf')
const FALLBACK_PDF = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const PORT = 9333
const WIDTH = 1440
const HEIGHT = 900
const DPR = 2

// ---------------------------------------------------------------- shot list

/**
 * Each shot: a name (→ docs/screenshots/<name>.png) and a `setup` body run in
 * the page. `setup` is async and gets a `ui` helper (defined in PRELUDE below);
 * it must leave the app in the state to be photographed.
 *
 * Keep these in the order a reader meets them in the README.
 */
const SHOTS = [
  {
    name: 'reading',
    caption: 'Plain reading view, fit-width, chrome at rest',
    setup: `
      await ui.closePanels()
      await ui.goToPage(1)
      await ui.fitWidth()
    `
  },
  {
    // Historical name, kept so the file path stays stable for anything linking
    // it; the shot is the outline sidebar (nothing references it in the README
    // today — it is used in the store listings).
    name: 'reading_tabs',
    caption: 'Outline sidebar open beside the page',
    setup: `
      await ui.closePanels()
      await ui.toggle('Sidepanel')
      await ui.settle(600)
      await ui.goToPage(3)
      await ui.fitWidth()
      ui.expectPage(0, 3)
    `
  },
  {
    name: 'dual-pane',
    caption: 'Split view: two columns, own page and zoom, one set of tools',
    setup: `
      await ui.closePanels()
      // Open the split FIRST, then navigate: opening it re-fits both columns,
      // which re-anchors the scroll — so a jump made before the toggle does not
      // survive it. Layout, then position, then capture.
      await ui.toggle('Delt visning')
      await ui.settle(900)
      await ui.paneGoToPage(0, 3)
      // Right column onto the figure page: the shot should show the actual
      // point of the split — argument on the left, the figure it refers to on
      // the right.
      await ui.paneGoToPage(1, 6)
      await ui.settle(900)
      ui.expectPage(0, 3)
      ui.expectPage(1, 6)
      // Both columns must be the SAME width and land on the SAME zoom — the
      // split is symmetric by construction, and this is where that is checked.
      ui.expectSymmetric()
    `
  },
  {
    name: 'annotations',
    caption: 'Annotation tools with a tool-options popover open',
    setup: `
      await ui.closePanels()
      await ui.fitWidth()
      await ui.goToPage(2)
      ui.expectPage(0, 2)
      await ui.highlightSomeText()
      await ui.openToolOptions(1)   // the tusj (highlighter) chevron
      await ui.settle(400)
    `
  },
  {
    name: 'parchment',
    caption: 'Sepia reading mode',
    setup: `
      await ui.closePanels()
      await ui.goToPage(1)
      await ui.fitWidth()
      await ui.setTheme('sepia')
    `
  },
  {
    name: 'night',
    caption: 'Night reading mode',
    setup: `
      await ui.closePanels()
      await ui.goToPage(1)
      await ui.fitWidth()
      await ui.setTheme('night')
    `
  },
  {
    name: 'night+',
    caption: 'Night+ — the higher-contrast dark mode',
    setup: `
      await ui.closePanels()
      await ui.goToPage(1)
      await ui.fitWidth()
      await ui.setTheme('nightHc')
    `
  }
]

// ------------------------------------------------------- in-page UI helpers

/**
 * Injected before every shot. These drive the app the way a user would — real
 * clicks on real buttons found by their tooltips — so a renamed tooltip fails
 * loudly here instead of silently producing a wrong screenshot.
 */
const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const btn = (prefix, root = document) =>
  [...root.querySelectorAll('.tb-btn')].find((b) => (b.title || '').startsWith(prefix));
const click = (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
const ui = {
  settle,
  /** The page actually UNDER THE READER in a column (0 = left, 1 = right),
   *  read from geometry rather than from the toolbar's readout: the readout is
   *  app state, and the whole point of asserting is to catch the case where the
   *  state says one thing and the pixels show another. */
  visiblePage(paneIndex = 0) {
    const host = document.querySelectorAll('.pages')[paneIndex];
    if (!host) throw new Error('no pages column ' + paneIndex);
    const box = host.getBoundingClientRect();
    const probe = box.top + box.height * 0.35;
    let best = null;
    for (const el of host.querySelectorAll('.pdf-page')) {
      const r = el.getBoundingClientRect();
      if (r.top <= probe) best = el;
    }
    return best ? Number(best.dataset.page) : null;
  },
  /** The two columns must be equal in width and therefore in fit-zoom */
  expectSymmetric() {
    const w = [...document.querySelectorAll('.viewer-body > .pages-host')]
      .map((h) => Math.round(h.getBoundingClientRect().width));
    if (w.length !== 2) throw new Error('expected two columns, saw ' + w.length);
    if (Math.abs(w[0] - w[1]) > 2) throw new Error('columns not symmetric: ' + w.join(' vs '));
    const z = [...document.querySelectorAll('.center-cluster .zoom-label')].map((e) => e.textContent);
    if (z.length === 2 && z[0] !== z[1]) throw new Error('zooms differ: ' + z.join(' vs '));
  },
  /** Fail the shot rather than save a screenshot of the wrong thing */
  expectPage(paneIndex, page) {
    const got = this.visiblePage(paneIndex);
    if (got !== page) {
      throw new Error('column ' + paneIndex + ' shows page ' + got + ', expected ' + page);
    }
  },
  /** Click a toolbar button by the start of its tooltip; throws if it is gone */
  async toggle(prefix) {
    const b = btn(prefix);
    if (!b) throw new Error('no toolbar button starting with: ' + prefix);
    click(b);
    await settle(450);
  },
  /** Leave only the pages visible (idempotent) */
  async closePanels() {
    for (const p of ['Sidepanel', 'Assistent']) {
      const b = btn(p);
      if (b && b.classList.contains('is-active')) { click(b); await settle(400); }
    }
    const split = btn('Delt visning');
    if (split && split.classList.contains('is-active')) { click(split); await settle(500); }
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle(200);
  },
  /** Page for a column via its own toolbar cluster (0 = left, 1 = right).
   *  The app commits the typed page on BLUR, so the field must genuinely be
   *  focused first — blur() on an unfocused input fires nothing, which silently
   *  did nothing at all until ui.expectPage caught it. */
  async paneGoToPage(clusterIndex, n) {
    const cluster = document.querySelectorAll('.center-cluster')[clusterIndex];
    if (!cluster) throw new Error('no centre cluster ' + clusterIndex + ' (is the split open?)');
    const input = cluster.querySelector('.page-indicator input');
    input.focus();
    await settle(60);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(n));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(60);
    input.blur();
    await settle(800);
  },
  goToPage(n) {
    return this.paneGoToPage(0, n);
  },
  async fitWidth() {
    // The fit control offers the mode you are NOT in, so click only if needed
    const fit = [...document.querySelectorAll('.toolbar-center .tb-btn')]
      .find((b) => (b.title || '').includes('veksler'));
    if (fit && (fit.title || '').startsWith('Tilpass bredde')) { click(fit); await settle(600); }
  },
  async setTheme(id) {
    await this.toggle('Lesemodus');
    const opt = document.querySelector('.theme-menu .theme-option.theme-' + id);
    if (!opt) throw new Error('no theme option: ' + id);
    click(opt);
    await settle(500);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await settle(400);
  },
  /** Open the Nth annotation tool's options popover (0 = pen, 1 = tusj, …) */
  async openToolOptions(n) {
    const chev = [...document.querySelectorAll('.tb-chevron')][n];
    if (!chev) throw new Error('no tool chevron ' + n);
    click(chev);
    await settle(400);
  },
  /** A couple of real marks on the page, so the tools shot has something to
   *  show. Restricted to text that is ACTUALLY ON SCREEN — marking a span on a
   *  scrolled-away page produced a screenshot with no visible marks at all. */
  async highlightSomeText() {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const box = pages.getBoundingClientRect();
    const spans = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 25)
      .filter((s) => {
        const r = s.getBoundingClientRect();
        // Comfortably inside the column, and below the tool popovers up top
        return r.top > box.top + 260 && r.bottom < box.bottom - 40 && r.width > 80;
      });
    if (spans.length === 0) throw new Error('no on-screen text to mark up');
    for (const [i, idx] of [0, 6].entries()) {
      const span = spans[Math.min(idx, spans.length - 1)];
      if (!span) continue;
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
      if (!menu) continue;
      // First shot yellow highlight, second an underline, for variety
      const group = menu.querySelectorAll('.menu-color-group')[i === 0 ? 0 : 1];
      const swatch = group?.querySelector('.color-dot, .color-bar');
      if (swatch) click(swatch);
      await settle(600);
    }
    window.getSelection()?.removeAllRanges();
    await settle(200);
    const marks = document.querySelectorAll('.annot-highlight, .annot-underline').length;
    if (marks === 0) throw new Error('markup produced nothing visible');
  }
};
`

// ------------------------------------------------------------------- CDP glue

/** Run an async setup body in the page, with the UI helpers in scope */
const runSetup = (send, body) => evaluate(send, `${body}\nreturn 'ok'`, PRELUDE)

// ---------------------------------------------------------------------- main

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(14)} ${s.caption}`)
  process.exit(0)
}
const wanted = args.filter((a) => !a.startsWith('-'))
const shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS
if (shots.length === 0) {
  console.error(`No shot matched. Known: ${SHOTS.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

const mainJs = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(mainJs)) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}
const pdf = existsSync(DEMO_PDF) ? DEMO_PDF : FALLBACK_PDF
if (pdf === FALLBACK_PDF) {
  console.warn(
    `! ${DEMO_PDF} not found — shooting sample.pdf instead.\n` +
      '  The README uses "Attention Is All You Need" (arXiv 1706.03762); drop it there.'
  )
}

console.log(`Shooting ${shots.length} screenshot(s) at ${WIDTH}×${HEIGHT} @${DPR}x`)
const app = launchApp({ root: ROOT, mainJs, args: [pdf], port: PORT })

let failed = 0
try {
  const [target] = await waitForPageTargets(PORT, 1)
  const ws = await openSocket(target.webSocketDebuggerUrl)
  const send = cdp(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  // Pin the viewport so every run yields identically sized, HiDPI-crisp PNGs
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DPR,
    mobile: false
  })

  // Wait for the document to actually be rendered before the first shot
  for (let i = 0; i < 60; i++) {
    const ready = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.pdf-page canvas')`,
      returnByValue: true
    })
    if (ready.result?.value) break
    await sleep(500)
  }

  for (const shot of shots) {
    process.stdout.write(`  ${shot.name} … `)
    try {
      await runSetup(send, shot.setup)
      await sleep(500)
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      })
      const file = join(OUT_DIR, `${shot.name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`ok (${Math.round(Buffer.from(data, 'base64').length / 1024)} kB)`)
    } catch (err) {
      failed++
      console.log(`FAILED: ${err.message}`)
    }
    // Every shot starts from a clean slate, so one failure cannot cascade
    await runSetup(send, `await ui.closePanels(); await ui.setTheme('day')`).catch(() => {})
  }
  ws.close()
} catch (err) {
  console.error(`\nShoot aborted: ${err.message}`)
  const log = app.log().trim()
  if (log) console.error(`--- app output ---\n${log}`)
  failed = 1
} finally {
  await app.cleanup()
}

if (failed) {
  console.error(`\n${failed} shot(s) failed.`)
  process.exit(1)
}
console.log('\nDone. Check the PNGs, then commit them.')

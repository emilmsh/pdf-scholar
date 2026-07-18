// Capture README screenshots by driving the renderer in an offscreen
// Electron window against the dev-web server. Run with the dev server up:
//   npm run dev:web   (separate terminal)   then   npx electron scripts/capture-screenshots.cjs
// Point at another server (e.g. a worktree of the released tag) with
//   CAPTURE_URL=http://localhost:5399 npx electron scripts/capture-screenshots.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = (process.env.CAPTURE_URL || 'http://localhost:5199') + '/#open=sample.pdf'
const OUT = path.join(__dirname, '..', 'docs', 'screenshots')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

async function capture(win, name) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, name), image.toPNG())
  console.log('wrote', name)
}

function run(win, script) {
  return win.webContents.executeJavaScript(`(async () => { ${script} })()`, true)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Injected once: helpers shared by every step. Hidden-window gotchas: pdf.js
// renders on rAF (dev shim maps it to setTimeout) but scroll events must be
// dispatched manually, and CSS transitions freeze at their start value — so
// they are disabled outright.
const HELPERS = `
  window.__wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__btn = (t) => Array.from(document.querySelectorAll('button')).find((b) => (b.title || '').startsWith(t));
  window.__scrollTo = async (top) => {
    const host = document.querySelector('.pages');
    host.scrollTop = top;
    host.dispatchEvent(new Event('scroll'));
    await window.__wait(1200);
  };
  window.__canvasOn = async (page) => {
    for (let i = 0; i < 80; i++) {
      if (document.querySelector('.pdf-page[data-page="' + page + '"] canvas')) return true;
      await window.__wait(250);
    }
    return false;
  };
  if (!document.getElementById('__noTransitions')) {
    const s = document.createElement('style');
    s.id = '__noTransitions';
    s.textContent = '* { transition: none !important; animation-duration: 0s !important; }';
    document.head.append(s);
  }
`

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: true }
  })
  win.webContents.setFrameRate(10)
  await win.loadURL(URL)
  await wait(1000)
  // A previous run's theme/reading position persists in localStorage — start clean
  await run(win, `localStorage.clear(); location.reload();`)
  await wait(2000)

  // ---- 1. reading.png — document open at the top, day theme ----
  const open = await run(
    win,
    `${HELPERS}
     const ok = await window.__canvasOn(1);
     await window.__wait(1500);
     return { ok, pages: document.querySelectorAll('.pdf-page').length };`
  )
  console.log('open:', JSON.stringify(open))
  await capture(win, 'reading.png')

  // ---- 2. annotations.png — highlight + pen stroke on a body page ----
  const annot = await run(
    win,
    `${HELPERS}
     // bring a body page (2) into view
     const page2 = document.querySelector('.pdf-page[data-page="2"]');
     await window.__scrollTo(page2.offsetTop - 40);
     await window.__canvasOn(2);
     await window.__wait(800);

     // a) text highlight: arm the marker tool, select some text, pointerup applies it
     window.__btn('Marker tekst')?.click();
     await window.__wait(300);
     const spans = Array.from(page2.querySelectorAll('.text-host span'))
       .filter((s) => s.firstChild?.nodeType === 3 && s.textContent.trim().length > 3);
     let highlighted = false;
     if (spans.length >= 6) {
       const first = spans[1], last = spans[3];
       const range = document.createRange();
       range.setStart(first.firstChild, 0);
       range.setEnd(last.firstChild, last.firstChild.length);
       const sel = window.getSelection();
       sel.removeAllRanges();
       sel.addRange(range);
       const r = last.getBoundingClientRect();
       // the viewer applies an armed markup tool on MOUSEUP (not pointerup)
       last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right, clientY: r.y + 3, button: 0 }));
       await window.__wait(600);
       window.getSelection().removeAllRanges();
       highlighted = true;
     }
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     await window.__wait(200);

     // b) pen stroke: arm the pen, draw a wavy line on the draw layer
     window.__btn('Penn')?.click();
     await window.__wait(300);
     const layer = page2.querySelector('.draw-layer');
     let drew = false;
     if (layer && spans.length > 6) {
       // underline a separate sentence further down, just below the glyphs
       const under = spans[Math.min(7, spans.length - 1)].getBoundingClientRect();
       const y0 = under.bottom + 2;
       const len = Math.min(under.width, 240);
       const fire = (type, x, y, buttons) =>
         layer.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 7, isPrimary: true }));
       fire('pointerdown', under.x, y0, 1);
       for (let i = 1; i <= 24; i++) {
         const x = under.x + (i / 24) * len;
         const y = y0 + Math.sin(i / 2.4) * 1.5;
         fire('pointermove', x, y, 1);
         await window.__wait(16);
       }
       fire('pointerup', under.x + len, y0, 0);
       await window.__wait(600);
       drew = true;
     }
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
     await window.__wait(500);
     return { highlighted, drew, marks: document.querySelectorAll('.annot-marks *').length };`
  )
  console.log('annotations:', JSON.stringify(annot))
  await capture(win, 'annotations.png')

  // ---- 3. assistant.png — AI panel with the mock conversation ----
  const ai = await run(
    win,
    `${HELPERS}
     window.__btn('Assistent')?.click();
     await window.__wait(500);
     const sugg = Array.from(document.querySelectorAll('.ai-suggestions button, .ai-landing button'))
       .find((b) => b.textContent.includes('Oppsummer dokumentet'))
       || document.querySelector('.ai-suggestions button');
     sugg?.click();
     for (let i = 0; i < 60; i++) { await window.__wait(250); if (document.querySelector('.ai-chip')) break; }
     await window.__wait(400);
     return { chips: document.querySelectorAll('.ai-chip').length };`
  )
  console.log('assistant:', JSON.stringify(ai))
  await capture(win, 'assistant.png')

  // ---- 4. parchment.png — sepia theme with the sidebar open ----
  const sepia = await run(
    win,
    `${HELPERS}
     const closeBtn = Array.from(document.querySelectorAll('.ai-header button'))
       .find((b) => b.textContent.trim() === '✕' || (b.title || '').includes('Lukk'));
     closeBtn?.click();
     await window.__wait(300);
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
     await window.__wait(300);
     window.__btn('Visningsinnstillinger')?.click();
     await window.__wait(300);
     document.querySelector('.theme-option.theme-sepia')?.click();
     await window.__wait(300);
     document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
     await window.__wait(200);
     window.__btn('Sidepanel')?.click();
     await window.__wait(1500);
     document.querySelector('.pages')?.dispatchEvent(new Event('scroll'));
     await window.__wait(1000);
     return { theme: document.documentElement.dataset.theme };`
  )
  console.log('sepia:', JSON.stringify(sepia))
  await capture(win, 'parchment.png')

  // ---- 5. night.png — night theme, sidebar closed again ----
  const night = await run(
    win,
    `${HELPERS}
     window.__btn('Sidepanel')?.click();
     await window.__wait(400);
     window.__btn('Visningsinnstillinger')?.click();
     await window.__wait(300);
     document.querySelector('.theme-option.theme-night')?.click();
     await window.__wait(300);
     document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
     await window.__wait(1200);
     document.querySelector('.pages')?.dispatchEvent(new Event('scroll'));
     await window.__wait(800);
     return { theme: document.documentElement.dataset.theme };`
  )
  console.log('night:', JSON.stringify(night))
  await capture(win, 'night.png')

  app.quit()
})

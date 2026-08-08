// Drive the real app into each documented state and photograph it.
//
//   npm run shoot                           all shots except the AI ones
//   npm run shoot -- dual-pane reading      just these
//   npm run shoot -- --list                 show the shot names
//   npm run shoot -- --with-ai              call the real model for the AI shots
//   npm run shoot -- --with-ai --record     …and save those answers for replay
//   npm run shoot -- --out docs/screenshots overwrite the shipped set (rare)
//
// WHERE THE OUTPUT GOES, AND WHY: docs/screenshots/_auto/ (gitignored), NOT the
// screenshots the README and the stores use. Those are taken BY HAND — framing,
// what is on screen and which answer is worth showing are judgement calls this
// script kept getting slightly wrong, and a slightly-wrong marketing image is
// worse than no new image. See docs/RELEASE.md: re-shooting them is a step Emil
// does before a release. This script cannot overwrite them without --out.
//
// It is still worth running: every shot ASSERTS the state before capturing, so
// it doubles as a UI smoke test (it is what caught the lopsided split, the page
// field that silently did nothing, and the markup that landed off-screen), and
// the images are a fast way to eyeball a change across themes.
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
// The two assistant shots show the same feature on the same paper every time,
// so their answers are RECORDED once into docs/ai-fixtures/ and replayed after
// that: an ordinary keyless run refreshes them like any other shot, and only
// `--with-ai --record` spends anything. Everything the shots are evidence for
// still runs live — the chips, the jump to the cited sentence, the highlight,
// the snipped region in the chat — since only the provider call comes from
// disk. Recording does not ask anyone for an
// API key: keys already live in the real profile's pdfx-state.json, encrypted
// with Electron safeStorage, which on Windows is DPAPI — scoped to the Windows
// USER, not to the profile directory. So the encrypted blob can be copied into
// the throwaway profile and the app there decrypts it itself. The key is never
// decrypted by this script, never printed, and dies with the temp profile.
//
// Re-record when the answer itself should change; a UI change to the assistant
// needs nothing. Either way the assertions are what keep a run honest — a real
// answer with at least one citation chip, the cited passage highlighted on
// screen — or it would happily photograph a spinner or an error toast and save
// it as marketing.
//
// Every shot is taken with the app in ENGLISH (seeded into the throwaway
// profile), because the README is in English. Tooltips are therefore matched
// against both languages; see the L map in the PRELUDE.
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHOT_DIR = join(ROOT, 'docs', 'screenshots')
/** The house demo doc (arXiv 1706.03762). Gitignored — see .gitignore. */
const DEMO_PDF = join(SHOT_DIR, 'attention.pdf')
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
      await ui.cover()
    `
  },
  {
    // Historical name, kept so the shot name stays stable; the shot is the
    // outline sidebar. It ships nowhere today (scripts/lib/shots.json) and is
    // kept as a smoke test of the sidebar.
    name: 'reading_tabs',
    caption: 'Outline sidebar open beside the page',
    setup: `
      await ui.closePanels()
      await ui.toggle(L.sidebar)
      await ui.settle(600)
      await ui.goToPage(3)
      await ui.fitWidth()
      ui.expectPage(0, 3)
      await ui.settle(3400)   // let the nav pills fade, as in the cover shots
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
      await ui.toggle(L.split)
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
      await ui.expectSymmetric()
      // Photograph it with the toolbar pointing at the right-hand column, so
      // the switcher in the shot reads "3 | 6" with the figure's column live —
      // the state the split exists for. The long settle outlasts the nav pills'
      // 2.6 s idle fade: jumping pages leaves a "back to p. 1" pill in the
      // corner, and it has no business in a marketing frame.
      await ui.activatePane(1)
      await ui.settle(3400)
    `
  },
  {
    // The shot carries the claim the annotation tools are sold on: they are
    // within reach without getting in the way. So it needs BOTH halves — marks
    // of several kinds already sitting on the page, and the menu that appears
    // where you selected text, which is how they got there. One version let the
    // menu cover the marks; the next overcorrected and parked it in the far
    // margin, where it no longer looked like it belonged to the selection.
    // openSelectionMenu now nudges it just far enough aside that the marks stay
    // mostly visible, keeps it beside the selection, and fails rather than
    // shoot a frame where the tools hide their own output.
    name: 'annotations',
    caption: 'Marks of several kinds on the page, and the menu that makes the next one',
    setup: `
      await ui.closePanels()
      await ui.showAnnots(true)
      await ui.fitWidth()
      await ui.goToPage(2)
      ui.expectPage(0, 2)
      await ui.highlightSomeText()
      await ui.drawRectangleAround('Attention mechanisms have become')
      // Note bubble in the LEFT margin: the menu parks on the right, and the
      // two of them in the same margin would stack.
      await ui.placeNote('Same claim as Bahdanau (2015) — check the setup', 0.08, 0.3)
      await ui.openSelectionMenu()
      await ui.settle(400)
    `
  },
  {
    // The same page as `annotations`, framed on the other half of the story: a
    // mark already made, selected, with the knobs that drag its ends. The two
    // states are mutually exclusive on screen — selecting text to open the menu
    // drops the selected mark. `annotations` (the menu) is the frame that ships;
    // this one ships nowhere and stays as a smoke test of mark selection.
    name: 'annotations_edit',
    caption: 'A mark selected, with the knobs that drag its ends',
    setup: `
      await ui.closePanels()
      await ui.showAnnots(true)
      await ui.fitWidth()
      await ui.goToPage(2)
      ui.expectPage(0, 2)
      // Usually the marks from the shot before are still there — the shots share
      // one session and one draft. Run this one on its own (\`shoot annotations_edit\`)
      // and there is nothing to select, so make something first.
      if (ui.markRectsA().length === 0) await ui.highlightSomeText()
      await ui.selectMark()
      // Outlast the nav pills' 2.6 s idle fade — this setup is short enough that
      // jumping to page 2 leaves a "back to p. 2" bubble in the corner of the
      // frame. (The sibling shot spends longer making its marks and never sees it.)
      await ui.settle(3400)
    `
  },
  {
    // Marking up a draft the way a supervisor or an examiner does: red pen
    // gestures ON the text (a bracket down the margin, a wavy underline) and
    // handwritten comments BESIDE it. Both are real marks — the pen strokes
    // carry pressure, and the handwriting is a note in the embedded
    // handwriting font (src/shared/hand-note.ts), not a caption pasted on top.
    //
    // Placement is measured from the document's own text geometry rather than
    // hard-coded, so nothing lands on a word: the bracket takes the strip just
    // left of the column and the writing gets what is left of the margin. Four
    // placements were photographed before this one was picked (left margin,
    // line-end gaps, right margin, mixed); the left margin reads most like a
    // marked-up paper.
    name: 'feedback',
    caption: 'A marked-up draft: red pen on the text, handwritten notes in the margin',
    setup: `
      await ui.closePanels()
      await ui.showAnnots(true)
      await ui.fitWidth()
      await ui.goToPage(3)
      ui.expectPage(0, 3)
      await ui.penScrawl()
      const w = ui.whitespace()
      const marks = ui.markRectsA()
      const top = marks.length ? Math.min(...marks.map((m) => m.top)) : 0
      const bottom = marks.length ? Math.max(...marks.map((m) => m.bottom)) : 0
      // colorIndex 1 is the red pen in the text tool's palette — the same red
      // the strokes are in, so the marks read as one hand's work
      await ui.writeNote('Can you connect this to any contemporary phenomenon?',
        w.leftMargin.x, top - 6, { width: w.leftMargin.w, colorIndex: 1 })
      // Beside the underlined line rather than below it: below the last mark
      // falls out of the window on a short page.
      await ui.writeNote('Just a summary — what is YOUR reading?',
        w.leftMargin.x, bottom - 40, { width: w.leftMargin.w, colorIndex: 1 })
      await ui.settle(3400)   // outlast the nav pills' idle fade
    `
  },
  {
    // Sign without leaving the app: the signature drawn once and stamped where
    // it is needed. Shot on the last page, because that is where a document
    // gets signed — and the claim is "stamp it anywhere", not "fill a form".
    //
    // The signature this draws is SYNTHETIC and looks it. Three shapes were
    // tried (one big wave, pointed minims, rounded loops) and all three read as
    // a drawn curve rather than a name — the same uncanny problem as
    // hand-authored handwriting, and no amount of extra harmonics fixes it.
    // So this frame earns its keep as a smoke test of the whole chain — pad,
    // pen strokes, save, arm, place, stamp on the page — and NOT as the
    // picture that ships. The shipped one wants Emil's own signature on the
    // pad with a real pen; it is his app and his name.
    name: 'signature',
    caption: 'A signature drawn once and stamped onto the page (synthetic — reshoot by hand)',
    setup: `
      await ui.closePanels()
      await ui.showAnnots(true)
      await ui.fitWidth()
      // The LAST page: a signature belongs where a document ends, and the
      // whitespace under the final paragraph is where a hand would put it —
      // not across a body paragraph in the middle.
      await ui.goToLastPage()
      await ui.signHere(0.24, 0.62)
      await ui.settle(3400)   // outlast the nav pills' idle fade
    `
  },
  {
    // The release's headline, shot as its own frame: the comments stand in the
    // margin as visible text — the way a corrected draft reads on paper. Notes
    // carry their text into cards on the tinted strip; the highlight from the
    // annotations scene stays on the page as the thing being commented on.
    // Leader lines are hover-only, so a static frame stays calm by design.
    name: 'margin',
    caption: 'Comments in the margin: notes as visible text beside the page',
    setup: `
      await ui.closePanels()
      await ui.showAnnots(true)
      await ui.goToPage(2)
      ui.expectPage(0, 2)
      // Standalone run (\`shoot margin\`) starts from a bare page — make the
      // mark the comments belong with. In a full run the annotations scene
      // already left its marks here.
      if (ui.markRectsA().length === 0) await ui.highlightSomeText()
      await ui.placeNote('Tie this back to the RNN baseline in §2', 0.08, 0.24)
      await ui.placeNote('Strong claim — soften it, or cite the ablation', 0.06, 0.52)
      await ui.toggle(L.margin)
      await ui.fitWidth()
      await ui.settle(3400)
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
      await ui.cover()
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
      await ui.cover()
    `
  },
  {
    name: 'assistant',
    caption: 'Assistant answering from the document, with citation chips',
    needsAi: true,
    setup: `
      await ui.closePanels()
      await ui.fitWidth()
      await ui.goToPage(1)
      await ui.openAssistant()
      // The house question (docs/agent-notes): its answer cites p. 6, so the
      // chips in the shot point somewhere a reader can verify.
      await ui.ask('How does positional encoding work in this paper?')
      ui.expectAnswer()
      // Give the formulas room to sit unbroken — see widenUntilMathFits
      await ui.widenUntilMathFits()
      // Then TAKE the chip's word for it. A picture of an answer proves the
      // assistant can write; a picture of the cited sentence highlighted on the
      // page, next to the answer that claimed it, proves the part that matters.
      await ui.followFirstCitation()
      ui.expectCitationVisible()
    `
  },
  {
    name: 'assistant_snip',
    caption: 'Dragging a box around a figure to send it to the assistant',
    needsAi: true,
    setup: `
      await ui.closePanels()
      await ui.fitWidth()
      await ui.goToPage(3)
      await ui.openAssistant()
      await ui.newConversation()
      await ui.centreOn('Figure 1')
      // Caught mid-drag, before the mouse comes up: the crop tool is only
      // visible while you are using it.
      await ui.holdSnipBox('Figure 1')
      await ui.settle(300)
    `
  },
  {
    name: 'assistant_figure',
    caption: 'Explain a figure: a snipped region and the answer about it',
    needsAi: true,
    setup: `
      // The CHAT flow, not the floating bubble: it puts the region you marked
      // directly above the answer about it, so one frame carries the whole
      // story — drag a box, it lands in the conversation, you get a real
      // description back. (The bubble is the same request with less to show.)
      await ui.closePanels()
      await ui.fitWidth()
      await ui.goToPage(3)
      await ui.openAssistant()
      // Default panel width here, unlike the citation shot: there is no maths in
      // a figure answer to make room for, and this is what the assistant looks
      // like out of the box.
      await ui.resetAssistantWidth()
      await ui.newConversation()
      // Bring the whole figure and its caption into view first: the marked
      // region shows up as a thumbnail in the chat, and a thumbnail of
      // something half off-screen is no evidence of anything.
      await ui.centreOn('Figure 1')
      await ui.snipIntoChat()
      await ui.send('What does this figure show?')
      ui.expectAnswer({ image: true, chips: false })
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
      await ui.cover()
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
/** Tooltips are UI strings, and the shots are taken in English while the app's
 *  own language is Norwegian — so every control is addressed by BOTH labels.
 *  A selector that silently stops matching would not fail the run, it would
 *  photograph the wrong state, so this stays exhaustive. */
const L = {
  sidebar: ['Sidepanel', 'Sidebar'],
  split: ['Delt visning', 'Split view'],
  assistant: ['Assistent', 'Assistant'],
  snip: ['Forklar område', 'Explain area'],
  fitWidth: ['Tilpass bredde', 'Fit width'],
  fitToggle: ['veksler', 'toggles'],
  newChat: ['Ny samtale', 'New conversation'],
  theme: ['Lesemodus', 'Reading mode'],
  shapes: ['Former', 'Shapes'],
  rectangle: ['Rektangel', 'Rectangle'],
  pen: ['Penn', 'Pen'],
  note: ['Notat', 'Note'],
  text: ['Tekst på siden', 'Text on the page'],
  signature: ['Signatur', 'Signature'],
  margin: ['Vis kommentarer i margen', 'Show comments in the margin']
};
const titleOf = (el) => el.title || '';
const startsAny = (el, names) => names.some((n) => titleOf(el).startsWith(n));
const btn = (names, root = document) =>
  [...root.querySelectorAll('.tb-btn')].find((b) => startsAny(b, names));
const click = (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
const ui = {
  settle,
  /** The page element under the reader in column A. NOT the first .pdf-page in
   *  the DOM — three pages are mounted around the viewport, and the first of
   *  them is the one ABOVE, so marks placed there land off-screen (which is
   *  exactly what happened: a rectangle and a note drawn onto page 1 while the
   *  shot framed page 2). */
  pageElA() {
    const n = this.visiblePage(0);
    const el = document.querySelector('.pages[data-pane="a"] .pdf-page[data-page="' + n + '"]');
    if (!el) throw new Error('page ' + n + ' is not mounted');
    return el;
  },
  /** The part of that page which is ACTUALLY IN FRAME, in client coords. At the
   *  fit-width zoom of a screenshot only the top third of an A4 page is on
   *  screen, so anything placed by a fraction of the PAGE lands below the fold —
   *  which is how a rectangle and a note ended up in a shot that showed
   *  neither. Fractions are of this box. */
  visibleBoxA() {
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    const page = this.pageElA().getBoundingClientRect();
    const top = Math.max(host.top, page.top);
    const bottom = Math.min(host.bottom, page.bottom);
    if (bottom - top < 80) throw new Error('almost none of the page is in frame');
    return { left: page.left, width: page.width, top, height: bottom - top };
  },
  /** Fail if a mark is off-screen: "it exists in the DOM" is not the same as
   *  "it is in the picture", and only the second one matters here. */
  expectInFrame(el, what) {
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const inside = r.bottom > host.top + 8 && r.top < host.bottom - 8 &&
      r.right > host.left + 8 && r.left < host.right - 8 && r.width > 2 && r.height > 2;
    if (!inside) throw new Error(what + ' is outside the frame');
  },
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
  /** The two columns must be equal in width and therefore in fit-zoom. The
   *  zooms are read one at a time through the switcher, since the toolbar now
   *  shows the ACTIVE column's — which is also a check that switching works. */
  async expectSymmetric() {
    const w = [...document.querySelectorAll('.viewer-body > .pages-host')]
      .map((h) => Math.round(h.getBoundingClientRect().width));
    if (w.length !== 2) throw new Error('expected two columns, saw ' + w.length);
    if (Math.abs(w[0] - w[1]) > 2) throw new Error('columns not symmetric: ' + w.join(' vs '));
    const z = [];
    for (const i of [0, 1]) {
      await this.activatePane(i);
      z.push(document.querySelector('.center-cluster .zoom-label').textContent);
    }
    if (z[0] !== z[1]) throw new Error('zooms differ: ' + z.join(' vs '));
  },
  /** Fail the shot rather than save a screenshot of the wrong thing */
  expectPage(paneIndex, page) {
    const got = this.visiblePage(paneIndex);
    if (got !== page) {
      throw new Error('column ' + paneIndex + ' shows page ' + got + ', expected ' + page);
    }
  },
  /** Click a toolbar button by the start of its tooltip; throws if it is gone */
  async toggle(names) {
    const b = btn(names);
    if (!b) throw new Error('no toolbar button starting with: ' + names.join(' / '));
    click(b);
    await settle(450);
  },
  /** Leave only the pages visible (idempotent) */
  async closePanels() {
    for (const p of [L.sidebar, L.assistant]) {
      const b = btn(p);
      if (b && b.classList.contains('is-active')) { click(b); await settle(400); }
    }
    const split = btn(L.split);
    if (split && split.classList.contains('is-active')) { click(split); await settle(500); }
    // The margin view persists in localStorage — a scene that turned it on
    // must not leak its strip into every frame that follows.
    const margin = btn(L.margin);
    if (margin && margin.classList.contains('is-active')) { click(margin); await settle(500); }
    // Disarm any tool a previous shot armed — the shots share one app session,
    // so the annotations shot's highlighter was still lit (and its button
    // outlined) in every theme shot that followed it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // The house demo PDF carries the owner's own old marks — a stray highlight,
    // a note icon, a red box. They belong in the annotation shot and nowhere
    // else, so every shot starts with them hidden and the ones that are ABOUT
    // annotating turn them back on.
    await this.showAnnots(false);
    await settle(200);
  },
  /** H toggles annotation visibility. Nothing in the DOM reports the state — the
   *  toggle is a checkbox inside the reading-mode menu, and an unannotated page
   *  looks the same either way — so the flag is tracked here. Safe because the
   *  shots share one page context and nothing else presses H. */
  async showAnnots(visible) {
    if (!!window.__pdfxAnnotsHidden === !visible) return;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    window.__pdfxAnnotsHidden = !visible;
    await settle(350);
  },
  /** Frame a cover shot and prove it: what a reader should meet is the paper's
   *  title, its authors and the first lines of the abstract — not page 1's
   *  opening act, which on an arXiv paper is a reproduction notice ("Provided
   *  proper attribution is provided, Google hereby grants…"). Legal boilerplate
   *  is the worst possible first impression of a reading app.
   *
   *  Scrolls by the TITLE's own position rather than by a fraction of the page:
   *  a fraction depends on the zoom the shot happens to be at, and got this
   *  wrong by 400 px on the very first shot of a run. Ends by outlasting the nav
   *  pills' 2.6 s idle fade, which otherwise leaves a "back to p. 1" bubble in
   *  the corner of a marketing image. */
  async cover() {
    const host = document.querySelector('.pages');
    const title = [...host.querySelectorAll('.textLayer span')]
      .find((s) => (s.textContent || '').includes('Attention Is All You Need'));
    if (!title) throw new Error('title not rendered — is this the house demo paper?');
    const box = host.getBoundingClientRect();
    host.scrollTop += title.getBoundingClientRect().top - box.top - 90;
    host.dispatchEvent(new Event('scroll'));
    await settle(400);
    // The notice is three lines and only the first names itself, so clearing
    // "Provided proper attribution" can still leave a red sliver of the last
    // one under the toolbar. Push past whatever of it is left.
    const overlap = this.noticeOverlap();
    if (overlap > 0) {
      host.scrollTop += overlap + 6;
      host.dispatchEvent(new Event('scroll'));
      await settle(400);
    }
    this.expectCoverFraming();
    await settle(3400);
  },
  /** How far the reproduction notice still reaches into the frame, in px */
  noticeOverlap() {
    const host = document.querySelector('.pages');
    const box = host.getBoundingClientRect();
    const parts = ['Provided proper attribution', 'reproduce the tables', 'scholarly works'];
    let worst = 0;
    for (const s of host.querySelectorAll('.textLayer span')) {
      const txt = s.textContent || '';
      if (!parts.some((p) => txt.includes(p))) continue;
      worst = Math.max(worst, s.getBoundingClientRect().bottom - box.top);
    }
    return worst;
  },
  /** The cover framing, asserted rather than hoped for: the title near the top
   *  of the viewport, and the notice above it out of frame. */
  expectCoverFraming() {
    const host = document.querySelector('.pages');
    const box = host.getBoundingClientRect();
    const spans = [...host.querySelectorAll('.textLayer span')];
    const hit = (needle) => spans.find((s) => (s.textContent || '').includes(needle));
    const title = hit('Attention Is All You Need');
    if (!title) throw new Error('title not rendered — is this the house demo paper?');
    const t = title.getBoundingClientRect();
    if (t.top < box.top || t.top > box.top + box.height * 0.35) {
      throw new Error('title is not in the top third of the frame (' + Math.round(t.top - box.top) + 'px)');
    }
    if (this.noticeOverlap() > 0) throw new Error('the reproduction notice is still in frame');
    const abstract = hit('The dominant sequence transduction models');
    if (!abstract || abstract.getBoundingClientRect().top > box.bottom) {
      throw new Error('the abstract does not start inside the frame');
    }
  },
  /** Point the toolbar at a column (0 = left, 1 = right) through the switcher.
   *  A no-op with one column, so callers can stay pane-agnostic. */
  async activatePane(paneIndex) {
    const seg = document.querySelectorAll('.pane-switch button')[paneIndex];
    if (!seg) {
      if (paneIndex === 0) return;
      throw new Error('no column switcher segment ' + paneIndex + ' (is the split open?)');
    }
    if (!seg.classList.contains('is-active')) { click(seg); await settle(350); }
  },
  /** Page for a column (0 = left, 1 = right). The toolbar has ONE cluster and
   *  it drives the active column, so this points the switcher first.
   *  The app commits the typed page on BLUR, so the field must genuinely be
   *  focused first — blur() on an unfocused input fires nothing, which silently
   *  did nothing at all until ui.expectPage caught it. */
  async paneGoToPage(paneIndex, n) {
    await this.activatePane(paneIndex);
    const cluster = document.querySelector('.center-cluster');
    if (!cluster) throw new Error('no centre cluster');
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
  /** The document's last page — counted from the mounted layout, so it works
   *  on the six-page sample and the fifteen-page house paper alike.
   *  (No regex: PRELUDE is itself a template literal, and its escapes would be
   *  eaten before the page ever sees them.) */
  goToLastPage() {
    const pages = [...document.querySelectorAll('.pages[data-pane="a"] .pdf-page')]
      .map((p) => Number(p.dataset.page))
      .filter((n) => Number.isFinite(n));
    const total = pages.length ? Math.max(...pages) : 0;
    if (!total) throw new Error('cannot tell how many pages this document has');
    return this.paneGoToPage(0, total);
  },
  async fitWidth() {
    // The fit control offers the mode you are NOT in, so click only if needed
    const fit = [...document.querySelectorAll('.toolbar-center .tb-btn')]
      .find((b) => L.fitToggle.some((w) => titleOf(b).includes(w)));
    if (fit && startsAny(fit, L.fitWidth)) { click(fit); await settle(600); }
  },
  async setTheme(id) {
    await this.toggle(L.theme);
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
  /** Open the assistant panel (idempotent) */
  async openAssistant() {
    const b = btn(L.assistant);
    if (!b) throw new Error('no assistant button');
    if (!b.classList.contains('is-active')) { click(b); await settle(700); }
    if (!document.querySelector('.ai-panel')) throw new Error('assistant panel did not open');
    // With no usable key the panel opens on its key-settings form instead of the
    // chat, and every later selector misses for a reason that has nothing to do
    // with the shot. Name that here.
    if (document.querySelector('.ai-settings') && !document.querySelector('.ai-composer')) {
      throw new Error('assistant opened its API-key settings — the carried AI config did not decrypt');
    }
  },
  /** Type into the composer without faking React's value plumbing */
  async compose(text) {
    const ta = document.querySelector('.ai-composer textarea');
    if (!ta) throw new Error('no composer textarea');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(150);
  },
  /** Send whatever is composed and wait for the answer to finish streaming */
  async send(text) {
    if (text) await this.compose(text);
    const send = document.querySelector('.ai-send');
    if (!send) throw new Error('no send button');
    click(send);
    await settle(500);
    // Done = no thinking indicator AND the answer stopped growing. A generated
    // answer has no fixed length, so settle on stability rather than a timeout.
    const deadline = Date.now() + 180000;
    let lastLen = -1, stableFor = 0;
    while (Date.now() < deadline) {
      if (document.querySelector('.ai-error')) return;   // expectAnswer reports it
      const msgs = document.querySelectorAll('.ai-msg.ai-assistant');
      const len = msgs.length ? (msgs[msgs.length - 1].textContent || '').length : 0;
      const busy = !!document.querySelector('.ai-thinking');
      if (!busy && len > 0 && len === lastLen) {
        stableFor += 1;
        if (stableFor >= 3) return;   // ~1.5 s unchanged
      } else {
        stableFor = 0;
      }
      lastLen = len;
      await settle(500);
    }
    throw new Error('the assistant did not finish within 180 s');
  },
  ask(text) { return this.send(text); },
  /** Fail rather than photograph a spinner, an error, or an uncited answer */
  expectAnswer(opts) {
    const err = document.querySelector('.ai-error');
    if (err) throw new Error('assistant errored: ' + (err.textContent || '').trim().slice(0, 200));
    if (document.querySelector('.ai-thinking')) throw new Error('still thinking');
    const msgs = document.querySelectorAll('.ai-msg.ai-assistant');
    if (msgs.length === 0) throw new Error('no assistant message');
    const last = msgs[msgs.length - 1];
    const text = (last.textContent || '').trim();
    if (text.length < 120) throw new Error('answer suspiciously short: ' + JSON.stringify(text.slice(0, 80)));
    // Document chips, not web chips: the claim is that answers link back to the
    // PDF, and that is exactly what the screenshot is evidence for.
    if (!opts || opts.chips !== false) {
      const chips = last.querySelectorAll('.ai-chip:not(.ai-chip-web)');
      if (chips.length === 0) throw new Error('answer has no document citation chips');
    }
    if (opts && opts.image) {
      const shown = document.querySelectorAll('.ai-msg.ai-user .ai-msg-images img, .ai-msg-images img');
      if (shown.length === 0) throw new Error('no snipped image in the conversation');
    }
  },
  /** Click the answer's first document citation and land on the passage.
   *
   *  This is the claim the shot exists to prove — a chip is not a footnote, it
   *  is a jump — so the picture has to be taken with the cited sentence
   *  highlighted on the page, not with the panel alone. The highlight releases
   *  itself after 7 s (it is a pointer, not a selection), so whatever follows
   *  this must be quick. */
  async followFirstCitation() {
    const msgs = document.querySelectorAll('.ai-msg.ai-assistant');
    const last = msgs[msgs.length - 1];
    const chip = last && last.querySelector('.ai-chip:not(.ai-chip-web)');
    if (!chip) throw new Error('no document citation chip to click');
    const label = (chip.textContent || '').trim();
    click(chip);
    // Resolving the passage means scrolling, waiting for a text layer and
    // measuring rects — poll for the highlight rather than guess a delay
    for (let i = 0; i < 25; i++) {
      await settle(200);
      if (document.querySelector('.search-hit.cite-flash')) return label;
    }
    throw new Error('citation ' + label + ' did not highlight anything');
  },
  /** The highlight must be ON SCREEN, not merely in the DOM: the jump aims for
   *  a third of the way down the viewport, and a shot of the right page with
   *  the passage scrolled out of frame proves nothing. */
  expectCitationVisible() {
    const host = document.querySelector('.pages[data-pane="a"]');
    const box = host.getBoundingClientRect();
    const hits = [...document.querySelectorAll('.search-hit.cite-flash')];
    if (hits.length === 0) throw new Error('the citation highlight is gone (it fades after 7 s)');
    const seen = hits.filter((h) => {
      const r = h.getBoundingClientRect();
      return r.bottom > box.top + 20 && r.top < box.bottom - 20 && r.width > 4;
    });
    if (seen.length === 0) throw new Error('the cited passage is highlighted off-screen');
  },
  /** Give the assistant panel a little more width for the shot. Answers about a
   *  paper contain display maths, and a formula wider than the panel gets its
   *  own sideways scrollbar — correct behaviour, and a poor advertisement. The
   *  panel is drag-resizable precisely so a reader can do this. */
  async widenAssistant(px = 110) {
    const panel = document.querySelector('.right-panel');
    if (!panel) throw new Error('no assistant panel to widen');
    const edge = panel.getBoundingClientRect().left;
    const grip = [...document.querySelectorAll('.panel-resizer')]
      .find((r) => Math.abs(r.getBoundingClientRect().right - edge) < 12);
    if (!grip) throw new Error('no resizer beside the assistant panel');
    const y = 400;
    const x = grip.getBoundingClientRect().left + 3;
    const opt = (cx) => ({ bubbles: true, clientX: cx, clientY: y, button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isPrimary: true });
    grip.dispatchEvent(new PointerEvent('pointerdown', opt(x)));
    await settle(60);
    window.dispatchEvent(new PointerEvent('pointermove', opt(x - px)));
    await settle(120);
    window.dispatchEvent(new PointerEvent('pointerup', opt(x - px)));
    await settle(400);
  },
  /** Put the assistant panel back to the width a new user gets. Double-clicking
   *  the divider is the app's own "reset this" gesture. */
  async resetAssistantWidth() {
    const panel = document.querySelector('.right-panel');
    if (!panel) throw new Error('no assistant panel');
    const edge = panel.getBoundingClientRect().left;
    const grip = [...document.querySelectorAll('.panel-resizer')]
      .find((r) => Math.abs(r.getBoundingClientRect().right - edge) < 12);
    if (!grip) throw new Error('no resizer beside the assistant panel');
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle(400);
  },
  /** Every mark currently drawn on the visible page, as client rects. Used to
   *  keep popovers off them.
   *
   *  Ink, squiggly and shapes are drawn into an SVG that spans the WHOLE PAGE
   *  (viewBox 0 0 pageW pageH), so a rect measured off the <svg> reports the
   *  page itself as one big mark — which made every sentence on it look
   *  occupied. Measure the geometry inside those instead. The note marker is
   *  also an <svg>, but a positioned, mark-sized one, so it is left alone. */
  markRectsA() {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const out = [];
    for (const el of pages.querySelectorAll('.annot, .annot-ink-svg')) {
      const spansPage = el.tagName.toLowerCase() === 'svg' &&
        !el.classList.contains('annot-note-mark');
      const parts = spansPage
        ? [...el.querySelectorAll('path, rect, line, polyline, polygon, ellipse, circle')]
        : [el];
      for (const p of parts) out.push(p.getBoundingClientRect());
    }
    return out.filter((r) => r.width > 1 && r.height > 1);
  },
  /** Select a sentence and leave the markup menu open over it. This is the
   *  gesture the annotation tools are actually reached by — the toolbar is the
   *  second way, not the first — so the annotations shot carries both halves:
   *  the marks a reader has already made, and the menu that makes the next one.
   *
   *  The catch that sank the first attempt at this shot: the menu is tall
   *  (247x537 in a 900px window on the house document) and lands on the marks
   *  wherever it opens, hiding the very thing it produced. No choice of
   *  sentence fixes that — the marks span y 333-786 and nothing that size fits
   *  between them.
   *
   *  So the shot uses the menu's own drag handle, which is what a reader would
   *  do: open it, then nudge it aside. Aside, not away: fully clear of every
   *  mark means the far margin, where the menu stops looking like it belongs
   *  to the selection. The parking search instead keeps it at the selection's
   *  right end and accepts covering a sliver of a mark, as long as every mark
   *  stays mostly visible. Searched, not hard-coded — a fixed offset would go
   *  stale the moment the zoom, the document or the menu's height changed —
   *  and asserted: if a mark ends up mostly hidden, no picture. */
  async openSelectionMenu() {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const box = pages.getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    const marks = this.markRectsA();
    if (marks.length === 0) throw new Error('no marks on the page to frame the menu against');
    const hits = (a, b, pad = 0) =>
      a.left < b.right + pad && a.right > b.left - pad &&
      a.top < b.bottom + pad && a.bottom > b.top - pad;

    // Candidates: full lines of body text, on screen, not themselves sitting on
    // a mark — selecting text that is already highlighted reads as a muddle.
    const candidates = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((x) => (x.textContent || '').trim().length > 40)
      .filter((x) => {
        const r = x.getBoundingClientRect();
        return r.width > 200 && r.top > box.top + 40 && r.bottom < box.bottom - 40 &&
          !marks.some((m) => hits(r, m, 6));
      });
    if (candidates.length === 0) throw new Error('no sentence clear of the marks to select');

    // The lowest sentence clear of the marks: selecting near the bottom of the
    // column leaves the marks above it untouched by the selection highlight,
    // and the menu is going to be dragged anyway.
    const span = candidates.sort((a, b) =>
      b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    const r = span.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await settle(200);
    // Release at the END of the selection — where a left-to-right drag ends,
    // and the point the parked menu should visibly hang from.
    const anchor = { x: Math.round(r.right - 4), y: Math.round(r.bottom) };
    pages.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0, clientX: anchor.x, clientY: anchor.y
    }));
    await settle(500);
    const menu = document.querySelector('.selection-menu');
    if (!menu) throw new Error('the selection menu did not open');
    await this.parkMenuBySelection(menu, marks, toolbar, r, anchor);
  },
  /** Drag the menu aside by its own grip — the gesture a reader uses, so the
   *  frame stays a picture of the real app. Two masters, weighed rather than
   *  one obeyed: the menu must stay where it plausibly opened (hanging off the
   *  end of the selection), and the marks must stay legible. Demanding zero
   *  coverage serves the second master only — the search then teleports the
   *  menu to the far margin, orphaned from its selection. So partial cover is
   *  allowed, bounded: every mark keeps at least ~two thirds of itself. */
  async parkMenuBySelection(menu, marks, toolbar, selRect, anchor) {
    const grip = menu.querySelector('.menu-grip');
    if (!grip) throw new Error('the selection menu has no drag grip');
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const area = (k) => Math.max(1, (k.right - k.left) * (k.bottom - k.top));
    // The worst-covered mark's covered share, 0..1. The limit is per mark, not
    // summed: hiding one mark entirely is not redeemed by leaving three alone.
    const worstCover = (rect) => Math.max(...marks.map((k) => overlap(rect, k) / area(k)));
    // The selection itself stays fully visible — a menu on top of the text it
    // acts on is the muddle this whole dance exists to avoid.
    const okay = (rect) => worstCover(rect) <= 0.34 && overlap(rect, selRect) === 0;

    const m = menu.getBoundingClientRect();
    const minX = 8, maxX = window.innerWidth - m.width - 8;
    const minY = Math.max(8, toolbar.bottom + 8), maxY = window.innerHeight - m.height - 8;
    if (maxX < minX || maxY < minY) {
      throw new Error('the menu (' + Math.round(m.width) + 'x' + Math.round(m.height) +
        ') does not fit the window below the toolbar');
    }
    // Nearest acceptable spot to the anchor: distance to the selection's end
    // dominates, residual coverage breaks ties. dist/40 vs cover*10 means a
    // fully clear spot is worth at most ~140px of extra distance — enough to
    // step off a sliver, not enough to flee to the margin.
    const distTo = (rect) => Math.hypot(
      Math.max(rect.left - anchor.x, anchor.x - rect.right, 0),
      Math.max(rect.top - anchor.y, anchor.y - rect.bottom, 0)
    );
    let target = null, bestScore = -Infinity;
    for (let x = minX; x <= maxX; x += 6) {
      for (let y = minY; y <= maxY; y += 6) {
        const rect = { left: x, top: y, right: x + m.width, bottom: y + m.height };
        if (!okay(rect)) continue;
        const score = -distTo(rect) / 40 - worstCover(rect) * 10;
        if (score > bestScore) { bestScore = score; target = { x, y }; }
      }
    }
    if (!target) {
      throw new Error('nowhere to park the menu near the selection. Menu ' +
        Math.round(m.width) + 'x' + Math.round(m.height) + ', window ' +
        window.innerWidth + 'x' + window.innerHeight + ', marks at ' +
        marks.map((k) => Math.round(k.top) + '-' + Math.round(k.bottom) + '/' +
          Math.round(k.left) + '-' + Math.round(k.right)).join(' '));
    }

    const g = grip.getBoundingClientRect();
    const from = { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
    // A dispatched pointerdown reaches a handle no real finger could — v0.31.0
    // shipped mark handles that were drawn but covered, and events aimed at them
    // "worked" the whole time. Prove the grip is the topmost thing at its centre
    // before trusting the drag below.
    const top = document.elementFromPoint(from.x, from.y);
    if (top !== grip && !grip.contains(top)) {
      throw new Error('the menu grip is not reachable by a pointer at its centre — ' +
        (top ? top.className || top.tagName : 'nothing') + ' is on top of it');
    }
    const to = { x: from.x + Math.round(target.x - m.left), y: from.y + Math.round(target.y - m.top) };
    const at = (type, x, y, buttons) => grip.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 37, isPrimary: true, button: 0, buttons,
      clientX: x, clientY: y
    }));
    at('pointerdown', from.x, from.y, 1);
    await settle(80);
    // A couple of intermediate moves: one jump would work, but this is also the
    // only exercise the drag handler gets outside a real hand.
    at('pointermove', Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2), 1);
    await settle(60);
    at('pointermove', to.x, to.y, 1);
    await settle(60);
    at('pointerup', to.x, to.y, 0);
    await settle(350);

    const after = menu.getBoundingClientRect();
    if (!okay(after)) {
      throw new Error('a mark is mostly hidden after the drag: the menu sits at ' +
        Math.round(after.left) + ',' + Math.round(after.top) + ' and was aimed at ' +
        target.x + ',' + target.y + ' (worst cover ' +
        Math.round(worstCover(after) * 100) + '%)');
    }
    if (window.getSelection()?.isCollapsed !== false) {
      throw new Error('dragging the menu dropped the text selection');
    }
  },
  /** Widest overflow of any maths block in the answer, in px (0 = all fit) */
  mathOverflow() {
    let worst = 0;
    for (const b of document.querySelectorAll('.ai-math-block')) {
      worst = Math.max(worst, b.scrollWidth - b.clientWidth);
    }
    return worst;
  },
  /** Widen until the formulas fit outright. A sideways scrollbar under an
   *  equation is the app working as designed, but as an advertisement it says
   *  "your maths will not fit here" — and the panel is resizable precisely so a
   *  reader would do this themselves. Give up rather than eat the page. */
  async widenUntilMathFits() {
    for (let i = 0; i < 6 && this.mathOverflow() > 0; i++) {
      await this.widenAssistant(Math.max(40, Math.min(140, this.mathOverflow() + 24)));
    }
    if (this.mathOverflow() > 0) {
      throw new Error('maths still overflows by ' + Math.round(this.mathOverflow()) + 'px at the widest tried');
    }
  },
  /** Start a fresh conversation, so a shot is not framed around the tail of the
   *  previous shot's chat — every shot shares one app session. */
  async newConversation() {
    const b = [...document.querySelectorAll('.ai-panel .tb-btn')]
      .find((x) => startsAny(x, L.newChat));
    if (!b) throw new Error('no new-conversation button');
    click(b);
    await settle(500);
  },
  /** Centre a page's figure in the viewport before snipping it, so the shot
   *  shows the thing that was marked at a size a reader can recognise. */
  async centreOn(captionStart) {
    const host = document.querySelector('.pages[data-pane="a"]');
    const box = host.getBoundingClientRect();
    const cap = [...host.querySelectorAll('.pdf-page .textLayer span')]
      .find((x) => (x.textContent || '').trim().startsWith(captionStart));
    if (!cap) throw new Error('no caption starting with ' + captionStart);
    const r = cap.getBoundingClientRect();
    host.scrollTop += r.bottom - box.bottom + 40;
    host.dispatchEvent(new Event('scroll'));
    await settle(700);
  },
  /** Snip a region straight into the CHAT (the composer's own snip button)
   *  rather than into the floating bubble. Two reasons: it stages the region as
   *  an attachment you can still add a question to — the app never fires a
   *  request off a single click — and the finished conversation then shows the
   *  region you marked directly above the answer about it, which is the whole
   *  story in one frame. */
  async snipIntoChat() {
    const b = [...document.querySelectorAll('.ai-composer .ai-attach-add')]
      .find((x) => startsAny(x, L.snip));
    if (!b) throw new Error('no snip button in the composer');
    click(b);
    await settle(500);
    await this.dragSnipBox('Figure 1');
    for (let i = 0; i < 20; i++) {
      await settle(400);
      const img = document.querySelector('.ai-attach img');
      if (img) {
        if (!img.complete || img.naturalWidth < 100) continue;
        return;
      }
    }
    throw new Error('the snipped region never reached the composer');
  },
  /** Drag a box over the visible part of the page.
   *
   *  Coordinates come from the INTERSECTION of the page and its scroll
   *  container, not from the page alone: a page taller than the viewport starts
   *  above it (negative top), so a box measured off the page rect lands partly
   *  off-screen and the snip comes back empty. */
  async snipRegion() {
    const b = btn(L.snip);
    if (!b) throw new Error('no snip button');
    click(b);
    await settle(500);
    await this.dragSnipBox();
    // The TOOLBAR snip arms target 'quick' (PdfViewer: setSnip({target:'quick'})),
    // so the result is the floating bubble, not the side panel's composer -
    // asserting on .ai-attach here was asserting the panel's flow instead.
    // Rasterising is async, so poll rather than guess a delay.
    for (let i = 0; i < 20; i++) {
      await settle(400);
      if (document.querySelector('.ai-quick')) return;
    }
    throw new Error('snip produced no quick bubble');
  },
  /** The drag itself, shared by both snip entry points. Pass the start of a
   *  caption ("Figure 1") to end the box just under it, so the frame is the
   *  figure and its caption rather than an arbitrary slice of the page. */
  async dragSnipBox(captionStart, hold) {
    const overlay = document.querySelector('.snip-overlay');
    if (!overlay) throw new Error('snip overlay did not appear');
    const host = document.querySelector('.pages[data-pane="a"]');
    if (!host) throw new Error('no pages column');
    const h = host.getBoundingClientRect();
    // The page under the READER, not the first one in the DOM: after scrolling
    // to page 6 the first .pdf-page is thousands of pixels above the viewport.
    let page = null, bestOverlap = 0;
    for (const el of host.querySelectorAll('.pdf-page')) {
      const r = el.getBoundingClientRect();
      const overlap = Math.min(r.bottom, h.bottom) - Math.max(r.top, h.top);
      if (overlap > bestOverlap) { bestOverlap = overlap; page = el; }
    }
    if (!page) throw new Error('no page overlaps the viewport');
    const p = page.getBoundingClientRect();
    const box = {
      left: Math.max(p.left, h.left),
      right: Math.min(p.right, h.right),
      top: Math.max(p.top, h.top),
      bottom: Math.min(p.bottom, h.bottom)
    };
    const w = box.right - box.left, ht = box.bottom - box.top;
    if (w < 200 || ht < 150) throw new Error('too little of the page is visible to snip: ' + Math.round(w) + 'x' + Math.round(ht));
    const x1 = Math.round(box.left + w * 0.10);
    const y1 = Math.round(box.top + ht * 0.06);
    const x2 = Math.round(box.left + w * 0.90);
    let y2 = Math.round(box.top + ht * 0.62);
    if (captionStart) {
      const cap = [...page.querySelectorAll('.textLayer span')]
        .find((s) => (s.textContent || '').trim().startsWith(captionStart));
      const r = cap && cap.getBoundingClientRect();
      if (r && r.bottom > y1 + 120 && r.bottom < box.bottom - 6) y2 = Math.round(r.bottom + 6);
    }
    const opts = (x, y) => ({
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
    });
    overlay.dispatchEvent(new PointerEvent('pointerdown', opts(x1, y1)));
    await settle(120);
    overlay.dispatchEvent(new PointerEvent('pointermove', opts(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2))));
    await settle(120);
    overlay.dispatchEvent(new PointerEvent('pointermove', opts(x2, y2)));
    await settle(150);
    if (!document.querySelector('.snip-marquee')) throw new Error('the drag drew no marquee');
    // A held drag stops here, marquee on screen: that is the only moment the
    // crop tool itself is visible, and it is worth a frame.
    if (hold) return;
    overlay.dispatchEvent(new PointerEvent('pointerup', opts(x2, y2)));
  },
  /** Arm the composer's snip and draw the box, but do not release it */
  async holdSnipBox(captionStart) {
    const b = [...document.querySelectorAll('.ai-composer .ai-attach-add')]
      .find((x) => startsAny(x, L.snip));
    if (!b) throw new Error('no snip button in the composer');
    click(b);
    await settle(500);
    await this.dragSnipBox(captionStart, true);
    const m = document.querySelector('.snip-marquee');
    const r = m && m.getBoundingClientRect();
    if (!r || r.width < 200 || r.height < 150) throw new Error('the marquee is too small to read');
  },
  /** The bubble must actually show the snipped region, not an empty frame */
  expectSnippedFigure() {
    const img = document.querySelector('.ai-quick img.ai-quick-figure');
    if (!img) throw new Error('no snipped figure in the bubble');
    if (!img.complete || img.naturalWidth < 100) {
      throw new Error('snipped figure is empty or tiny: ' + img.naturalWidth + 'x' + img.naturalHeight);
    }
  },
  /** Wait for the bubble's answer to finish.
   *
   *  Figure mode has no question field: AiPanel computes active as
   *  "not ask-mode, or already asked", so only the free-form «Spør …» mode
   *  stages a prompt - there, drawing a box is not itself the question. For a
   *  figure the drag IS the deliberate act, so the request runs on open.
   *  (No backticks in this PRELUDE: it is a template literal.) */
  async waitForQuick() {
    const deadline = Date.now() + 180000;
    let lastLen = -1, stable = 0;
    while (Date.now() < deadline) {
      if (document.querySelector('.ai-quick .ai-error')) return;
      const body = document.querySelector('.ai-quick-body');
      const len = body ? (body.textContent || '').length : 0;
      const busy = !!document.querySelector('.ai-quick .ai-thinking');
      if (!busy && len > 0 && len === lastLen) { stable += 1; if (stable >= 3) return; }
      else stable = 0;
      lastLen = len;
      await settle(500);
    }
    throw new Error('the bubble did not finish within 180 s');
  },
  /** A figure answer need not cite the text, so chips are not required here -
   *  but an error, a spinner or an empty body still fails the shot. */
  expectQuickAnswer() {
    const err = document.querySelector('.ai-quick .ai-error');
    if (err) throw new Error('assistant errored: ' + (err.textContent || '').trim().slice(0, 200));
    if (document.querySelector('.ai-quick .ai-thinking')) throw new Error('still thinking');
    const body = document.querySelector('.ai-quick-body');
    const text = body ? (body.textContent || '').trim() : '';
    if (text.length < 120) throw new Error('figure answer suspiciously short: ' + JSON.stringify(text.slice(0, 80)));
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
  },
  /** Draw a rectangle around a passage, low on the page so it does not land on
   *  the marks the text markup just made. Arms the shape tool through its own
   *  popover — the same two clicks a reader makes. */
  /** Client-space box around the paragraph starting with the given phrase, found by
   *  walking the text layer line by line until the vertical gap says the
   *  paragraph ended. A rectangle drawn to arbitrary fractions slices through
   *  body text and looks like a mistake; one that hugs a paragraph looks like a
   *  reader's decision, which is what the shot is for. */
  paragraphBox(phrase, pad = 10) {
    const page = this.pageElA();
    const lines = [...page.querySelectorAll('.text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 0)
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    const first = lines.findIndex((l) => (l.s.textContent || '').trim().startsWith(phrase));
    if (first === -1) throw new Error('no paragraph starting with "' + phrase + '"');
    const picked = [lines[first]];
    for (let i = first + 1; i < lines.length; i++) {
      const gap = lines[i].r.top - picked[picked.length - 1].r.bottom;
      // Lines inside a paragraph very nearly touch; the gap to the NEXT
      // paragraph is a fair fraction of a line. 0.9 was too generous and the box
      // swallowed two paragraphs.
      if (gap > lines[i].r.height * 0.35) break;
      picked.push(lines[i]);
    }
    const left = Math.min(...picked.map((l) => l.r.left));
    const right = Math.max(...picked.map((l) => l.r.right));
    const top = Math.min(...picked.map((l) => l.r.top));
    const bottom = Math.max(...picked.map((l) => l.r.bottom));
    return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
  },
  /** Draw a rectangle around a paragraph. */
  async drawRectangleAround(phrase) {
    const shapes = btn(L.shapes);
    if (!shapes) throw new Error('no shapes button in the toolbar');
    click(shapes);
    await settle(300);
    const pick = [...document.querySelectorAll('.shape-pick')]
      .find((b) => startsAny(b, L.rectangle));
    if (!pick) throw new Error('no rectangle in the shape menu');
    click(pick);
    await settle(400);
    const pageEl = this.pageElA();
    const layer = pageEl.querySelector('.draw-layer');
    if (!layer) throw new Error('the shape tool did not arm (no draw layer)');
    const box = this.paragraphBox(phrase);
    const at = (t, x, y, buttons) => layer.dispatchEvent(new PointerEvent(t, {
      bubbles: true, pointerId: 31, isPrimary: true, button: 0, buttons,
      clientX: Math.round(x), clientY: Math.round(y)
    }));
    at('pointerdown', box.left, box.top, 1);
    await settle(60);
    at('pointermove', (box.left + box.right) / 2, (box.top + box.bottom) / 2, 1);
    await settle(60);
    at('pointermove', box.right, box.bottom, 1);
    await settle(60);
    at('pointerup', box.right, box.bottom, 0);
    await settle(700);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    const shape = pageEl.querySelector('.annot-marks svg');
    if (!shape) throw new Error('the rectangle produced nothing on this page');
    // WHOLLY inside, not merely overlapping: a box with its bottom edge cut off
    // by the window looks like a rendering fault in a marketing image.
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    if (box.top < host.top + 4 || box.bottom > host.bottom - 4) {
      throw new Error('the rectangle would be clipped by the window — frame it elsewhere');
    }
  },
  /** Freehand pen gestures with pressure, the way a hand actually marks a
   *  paper: a ring around a phrase, a wavy underline under another, and an
   *  exclamation mark in the margin. Hand-authored paths with a little wobble
   *  and a pressure curve — honest about being *marks*, not fake handwriting
   *  (words are where synthetic strokes start to look uncanny). */
  async penScrawl(colorIndex = 0) {
    const pen = btn(L.pen);
    if (!pen) throw new Error('no pen button in the toolbar');
    if (!pen.classList.contains('is-active')) { click(pen); await settle(400); }
    // Swatch 0 of the pen's (saturated) palette is red — the marking-up colour
    const chev = pen.parentElement.querySelector('.tb-chevron');
    if (chev) {
      click(chev); await settle(300);
      const dots = [...document.querySelectorAll('.tool-menu .color-dot')];
      if (dots[colorIndex]) { click(dots[colorIndex]); await settle(200); }
      click(chev); await settle(250);
    }
    const pageEl = this.pageElA();
    const layer = pageEl.querySelector('.draw-layer');
    if (!layer) throw new Error('the pen tool did not arm (no draw layer)');
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    const spans = [...pageEl.querySelectorAll('.text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 25)
      .filter((s) => {
        const r = s.getBoundingClientRect();
        return r.top > host.top + 260 && r.bottom < host.bottom - 120 && r.width > 160;
      });
    if (spans.length < 2) throw new Error('no on-screen text to scrawl at');
    const stroke = async (pts, pid) => {
      const at = (t, [x, y, p], buttons) => layer.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: 'pen',
        button: 0, buttons, clientX: x, clientY: y, pressure: p
      }));
      at('pointerdown', pts[0], 1);
      for (let i = 1; i < pts.length; i++) {
        at('pointermove', pts[i], 1);
        if (i % 5 === 0) await settle(16);
      }
      at('pointerup', [pts[pts.length - 1][0], pts[pts.length - 1][1], 0], 0);
      await settle(450);
    };
    // 1. Ring around the first words of one span — slight overshoot past the
    // start, like a hand actually circling something.
    const r1 = spans[0].getBoundingClientRect();
    const cx = r1.left + 80;
    const cy = (r1.top + r1.bottom) / 2;
    const rx = 96;
    const ry = Math.max(17, r1.height * 1.35);
    const ring = [];
    for (let i = 0; i <= 46; i++) {
      const t = -0.6 + (i / 46) * (2 * Math.PI + 1.0);
      ring.push([
        cx + rx * Math.cos(t) + 2 * Math.sin(7 * t),
        cy + ry * Math.sin(t) + 1.5 * Math.sin(5 * t + 1),
        Math.min(0.85, Math.max(0.25, 0.5 + 0.28 * Math.sin(t * 1.3 + 1)))
      ]);
    }
    await stroke(ring, 71);
    // 2. Wavy underline under a span further down, pressing harder mid-stroke
    const r2 = spans[Math.min(7, spans.length - 1)].getBoundingClientRect();
    const w = Math.min(250, r2.width);
    const wave = [];
    for (let i = 0; i <= 36; i++) {
      const f = i / 36;
      wave.push([
        r2.left + w * f,
        r2.bottom + 3.5 + 1.8 * Math.sin(f * 26),
        Math.min(0.85, 0.35 + 0.45 * Math.sin(f * Math.PI))
      ]);
    }
    await stroke(wave, 72);
    // 3. An exclamation mark in the margin beside the ring: a tapering
    // downstroke (pressure easing off) and a firm dot.
    const ex = cx - rx - 26;
    if (ex > host.left + 12) {
      const bar = [];
      for (let i = 0; i <= 14; i++) {
        const f = i / 14;
        bar.push([ex + 2.2 * Math.sin(f * 2.6), cy - 24 + 30 * f, 0.8 - 0.5 * f]);
      }
      await stroke(bar, 73);
      const dot = [];
      for (let i = 0; i <= 8; i++) {
        const t = (i / 8) * 2 * Math.PI;
        dot.push([ex + 1.6 * Math.cos(t), cy + 14 + 1.6 * Math.sin(t), 0.7]);
      }
      await stroke(dot, 74);
    }
    const marks = pageEl.querySelectorAll('.annot-marks path');
    if (marks.length < 2) throw new Error('the pen produced ' + marks.length + ' mark(s) on this page');
  },
  /** The document's own white space, measured from the text layer — so a mark
   *  can be put in the margin without landing on a word, whatever the paper. */
  whitespace() {
    const page = this.pageElA();
    const pr = page.getBoundingClientRect();
    const spans = [...page.querySelectorAll('.text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 1);
    if (spans.length === 0) throw new Error('no text layer to measure margins from');
    const rects = spans.map((s) => s.getBoundingClientRect());
    const textLeft = Math.min(...rects.map((r) => r.left));
    const textRight = Math.max(...rects.map((r) => r.right));
    // The pen's bracket sits just left of the column; the handwriting must
    // stop short of it or the two overprint each other.
    const bracketX = textLeft - 14;
    return {
      textLeft, textRight, bracketX,
      leftMargin: { x: pr.left + 10, w: Math.max(60, bracketX - (pr.left + 10) - 12) }
    };
  },
  /** Set the text tool's typeface and colour, then write a note at (x, y).
   *  font: 'hand' gives the red-pen-in-the-margin look. */
  async writeNote(text, x, y, { font = 'hand', colorIndex = 0, width = 0 } = {}) {
    const tool = btn(L.text);
    if (!tool) throw new Error('no text button in the toolbar');
    if (!tool.classList.contains('is-active')) { click(tool); await settle(350); }
    const chev = tool.parentElement.querySelector('.tb-chevron');
    if (chev) {
      click(chev); await settle(300);
      const dots = [...document.querySelectorAll('.tool-menu .color-dot')];
      if (dots[colorIndex]) { click(dots[colorIndex]); await settle(200); }
      const pick = [...document.querySelectorAll('.tool-menu .scope-option')].find((b) =>
        /Håndskrift|Handwriting/.test(b.querySelector('strong')?.textContent || '') === (font === 'hand') &&
        /Håndskrift|Handwriting|Trykt|Printed/.test(b.querySelector('strong')?.textContent || ''));
      if (pick) { click(pick); await settle(250); }
      click(chev); await settle(250);
    }
    const layer = this.pageElA().querySelector('.draw-layer');
    if (!layer) throw new Error('the text tool did not arm');
    layer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 47, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(x), clientY: Math.round(y)
    }));
    await settle(450);
    const ta = document.querySelector('.freetext-editor');
    if (!ta) throw new Error('the text editor did not open');
    // The committed box is the EDITOR's box (saveFreeText reads offsetWidth),
    // so narrowing it here is how the note is told to wrap inside the margin
    // rather than run across the page.
    if (width > 0) ta.style.width = Math.round(width) + 'px';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await settle(800);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
  },
  /** Draw a signature on the pad and stamp it onto the page.
   *
   *  Hand-authored as a single continuous ribbon rather than letterforms: a
   *  signature is a gesture, and synthetic letters are where this stops
   *  looking like a hand (the same reason the pen frame draws marks, not
   *  words). Pen pointer events with a pressure ramp, because that is what the
   *  pad is built for. */
  async signHere(fx = 0.2, fy = 0.78) {
    const sig = btn(L.signature);
    if (!sig) throw new Error('no signature button in the toolbar');
    // A leftover signature would skip the pad and arm the old one
    try { localStorage.removeItem('pdfx-signatures') } catch { /* fine */ }
    click(sig);
    await settle(700);
    const pad = document.querySelector('.signature-canvas');
    if (!pad) throw new Error('the signature pad did not open');
    const r = pad.getBoundingClientRect();
    const P = (type, x, y, pressure, extra = {}) => pad.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 51, isPrimary: true, pointerType: 'pen',
      button: 0, buttons: 1, clientX: x, clientY: y, pressure, ...extra
    }));
    const baseY = r.top + r.height * 0.60;
    const x0 = r.left + r.width * 0.14;
    const span = r.width * 0.60;
    const H = r.height;
    // A capital's opening loop, then connected minims of decreasing height,
    // then a long trailing flourish back under the whole thing. Slanted
    // forward the way a hand writes, and never a pure sine — the giveaway of
    // the first attempt was one huge regular wave.
    const slant = (f) => -f * H * 0.06;
    P('pointerdown', x0, baseY, 0.25);
    // 1. the opening capital loop
    for (let i = 1; i <= 26; i++) {
      const t = (i / 26) * Math.PI * 2;
      P('pointermove',
        x0 + span * 0.10 * (1 - Math.cos(t)) + span * 0.02 * (i / 26),
        baseY - H * 0.30 * Math.sin(t) - H * 0.06 * (1 - Math.cos(t)) + slant(i / 26),
        0.35 + 0.3 * Math.sin(t));
      if (i % 10 === 0) await settle(16);
    }
    // 2. the body: rounded loops (a plain sine, not |sin| — the cusps of an
    // absolute value are what read as a drawn zigzag rather than a hand), each
    // a little smaller and a little faster than the last
    for (let i = 1; i <= 80; i++) {
      const f = i / 80;
      const x = x0 + span * (0.22 + 0.60 * f) + Math.sin(f * 5.3) * span * 0.012;
      const amp = H * 0.17 * (1 - 0.45 * f);
      const y = baseY
        - Math.sin(f * Math.PI * 3.1 + 0.5) * amp
        - Math.sin(f * Math.PI * 6.4) * amp * 0.28
        + slant(0.22 + 0.60 * f);
      P('pointermove', x, y, 0.35 + 0.35 * Math.sin(f * Math.PI));
      if (i % 14 === 0) await settle(16);
    }
    // 3. the trailing flourish: a shallow sweep back under the name that stops
    // short of the start, so the signature never closes into a shape
    for (let i = 1; i <= 34; i++) {
      const f = i / 34;
      P('pointermove',
        x0 + span * (0.82 - 0.62 * f),
        baseY + H * 0.12 + Math.sin(f * Math.PI) * H * 0.09 + slant(1),
        0.45 * (1 - f * 0.8));
    }
    P('pointerup', x0 + span * 0.20, baseY + H * 0.12 + slant(1), 0, { buttons: 0 });
    await settle(500);
    const save = [...document.querySelectorAll('.signature-actions button')]
      .find((b) => !b.disabled && /Lagre|Save|Bruk|Use/.test(b.textContent || ''));
    if (!save) throw new Error('the signature pad has nothing to save');
    click(save);
    await settle(900);
    const overlay = document.querySelector('.note-place-overlay');
    if (!overlay) throw new Error('saving the signature did not arm it');
    const host = document.querySelector('.pages[data-pane="a"]').getBoundingClientRect();
    overlay.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 53, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(host.left + host.width * fx),
      clientY: Math.round(host.top + host.height * fy)
    }));
    await settle(1100);
    const stamp = document.querySelector('.annot-stamp');
    if (!stamp) throw new Error('the signature produced no stamp on the page');
    this.expectInFrame(stamp, 'the signature stamp');
  },
  /** Place a sticky note in the margin and write in it. */
  async placeNote(text, fx = 0.92, fy = 0.3) {
    const note = btn(L.note);
    if (!note) throw new Error('no note button in the toolbar');
    click(note);
    await settle(300);
    const pageEl = this.pageElA();
    const r = this.visibleBoxA();
    // The armed note tool listens on its own full-window overlay, for
    // pointerdown — not for a click on the page underneath it.
    const overlay = document.querySelector('.note-place-overlay');
    if (!overlay) throw new Error('the note tool did not arm');
    overlay.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 33, isPrimary: true, button: 0, buttons: 1,
      clientX: Math.round(r.left + r.width * fx), clientY: Math.round(r.top + r.height * fy)
    }));
    await settle(500);
    const ta = document.querySelector('.note-popover textarea');
    if (!ta) throw new Error('the note draft did not open');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    const save = [...document.querySelectorAll('.note-popover .note-actions button')].pop();
    if (!save || save.disabled) throw new Error('the note has nothing to save');
    click(save);
    await settle(700);
    const bubble = pageEl.querySelector('.annot-note-mark');
    if (!bubble) throw new Error('the note produced no bubble on this page');
    this.expectInFrame(bubble, 'the note bubble');
  },
  /** Select a highlight so the shot shows a mark in BOTH states — the knobs on
   *  its ends beside marks that are merely there.
   *
   *  Escape once closes the properties popover and leaves the selection intact
   *  (it clears the selection only on a second press), which is what keeps the
   *  page visible behind the knobs. */
  async selectMark() {
    const host = document.querySelector('.pages[data-pane="a"]');
    const mark = host.querySelector('.annot-highlights div, .annot-highlights rect');
    if (!mark) throw new Error('no highlight to select');
    const b = mark.getBoundingClientRect();
    const page = mark.closest('.pdf-page');
    const opt = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2) };
    page.dispatchEvent(new MouseEvent('mousedown', opt));
    page.dispatchEvent(new MouseEvent('mouseup', opt));
    page.dispatchEvent(new MouseEvent('click', opt));
    await settle(500);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(400);
    if (document.querySelectorAll('.markup-end').length !== 2) {
      throw new Error('the selected mark has no end knobs');
    }
    if (document.querySelector('.annot-popover')) {
      throw new Error('the properties popover is still covering the page');
    }
  }
};
`

// ------------------------------------------------------------------- CDP glue

/** Run an async setup body in the page, with the UI helpers in scope */
const runSetup = (send, body) => evaluate(send, `${body}\nreturn 'ok'`, PRELUDE)

// ---------------------------------------------------------------------- main

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const s of SHOTS) {
    console.log(`${s.name.padEnd(16)}${s.needsAi ? '[--with-ai] ' : ''}${s.caption}`)
  }
  process.exit(0)
}
const withAi = args.includes('--with-ai')
const record = args.includes('--record')
/** Recorded answers for the two assistant shots. With these present the shots
 *  run in an ordinary keyless run; --with-ai calls the real provider instead,
 *  and --with-ai --record refreshes what is replayed. */
const FIXTURE_DIR = join(ROOT, 'docs', 'ai-fixtures')
const haveFixtures =
  existsSync(join(FIXTURE_DIR, 'answer.json')) && existsSync(join(FIXTURE_DIR, 'figure.json'))
// Default output is the gitignored _auto/ folder, so a run can never clobber the
// hand-taken set the README and the stores ship. --out is the explicit override.
const outFlag = args.indexOf('--out')
const OUT_DIR = outFlag !== -1 && args[outFlag + 1] ? resolve(ROOT, args[outFlag + 1]) : join(SHOT_DIR, '_auto')
// Guard the -1 case: without --out, `outFlag + 1` is 0 and would swallow the
// first shot name, silently running the whole set instead of the one asked for.
const outValueAt = outFlag === -1 ? -1 : outFlag + 1
const wanted = args.filter((a, i) => !a.startsWith('-') && i !== outValueAt)
let shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS
// A real model call costs the user's own key, so it never happens by accident.
// A RECORDED answer costs nothing, so the AI shots are ordinary shots whenever
// docs/ai-fixtures/ is populated — the whole set refreshes with one keyless
// command, and only a deliberate --with-ai spends anything.
const gated = shots.filter((s) => s.needsAi && !withAi && !haveFixtures)
shots = shots.filter((s) => !s.needsAi || withAi || haveFixtures)
if (gated.length) {
  console.log(`Skipping ${gated.map((s) => s.name).join(', ')} — no recorded answer yet; pass --with-ai --record (uses your own API key).`)
}
if (shots.length === 0) {
  console.error(`No shot matched. Known: ${SHOTS.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

/**
 * Carry the app's own AI configuration into the throwaway profile, so the AI
 * shots can ask a real question without anyone typing a key.
 *
 * TWO files are needed, and the reason is worth writing down. Electron's
 * safeStorage on Windows is Chromium's os_crypt, which does NOT DPAPI-encrypt
 * each string: it encrypts them with a random AES key, and only THAT key is
 * DPAPI-protected — stored as os_crypt.encrypted_key in <userData>/Local State.
 * A fresh profile generates a fresh AES key, so the copied blob decrypts to ''
 * and the app opens the assistant in its key-settings state instead of the chat
 * (which is exactly how the first run of this failed). The encrypted keys and
 * the wrapped AES key have to travel together.
 *
 * What this does NOT do: decrypt anything, print anything, or persist anything
 * outside the temp profile, which is deleted when the run ends. DPAPI still
 * binds the copy to this Windows user, so it is useless anywhere else.
 *
 * Nothing else is copied: no recents, no reading positions, no theme. The shots
 * still start from factory defaults in every other respect.
 */
/** Every shot is taken with the app in ENGLISH. The README is in English, and a
 *  Norwegian toolbar in it asks the reader to decode the interface before they
 *  can see the feature. The app's own default is unchanged; this is one line in
 *  the throwaway profile, which main/storage.ts merges over its defaults. */
function seedProfile(profileDir, withAi, replaying) {
  const state = { settings: { language: 'en' } }
  if (withAi) state.ai = carryAiConfig(profileDir)
  else if (replaying) state.ai = replayAiConfig()
  writeFileSync(join(profileDir, 'pdfx-state.json'), JSON.stringify(state), 'utf8')
}

/** The assistant panel opens on its key form when no provider has a key, so a
 *  replay run still needs the app to believe one is configured. The placeholder
 *  below is never sent anywhere: the fixture short-circuits the request before
 *  any provider client is built. The model NAME is read back out of the
 *  recording, so the header in the screenshot names the model that actually
 *  produced the answer underneath it. */
function replayAiConfig() {
  const recorded = JSON.parse(readFileSync(join(FIXTURE_DIR, 'answer.json'), 'utf8'))
  const model = recorded.model || ''
  const provider = /^claude|opus|sonnet|haiku|fable/i.test(model) ? 'anthropic' : 'openai'
  return {
    provider,
    models: { [provider]: model },
    // storage.ts decrypts 'plain:'-prefixed values without safeStorage, which is
    // how the app reports "a key exists" here without a key existing.
    keys: { [provider]: 'plain:' + Buffer.from('screenshot-replay', 'utf8').toString('base64') }
  }
}

function carryAiConfig(profileDir) {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const realDir = join(appData, 'PDF Scholar')
  const realState = join(realDir, 'pdfx-state.json')
  const realCrypt = join(realDir, 'Local State')
  if (!existsSync(realState)) {
    throw new Error(
      `--with-ai needs the app's own settings, but ${realState} does not exist.\n` +
        '  Open PDF Scholar normally once and add an API key in the assistant settings.'
    )
  }
  const ai = JSON.parse(readFileSync(realState, 'utf8')).ai
  const providers = Object.entries(ai?.keys ?? {})
    .filter(([id, v]) => v && id !== 'mock')
    .map(([id]) => id)
  if (providers.length === 0) {
    throw new Error('--with-ai found no API key in the app settings. Add one in the assistant settings.')
  }
  if (!existsSync(realCrypt)) {
    throw new Error(
      `--with-ai found keys but no ${realCrypt}, which holds the wrapped key that decrypts them.`
    )
  }
  const osCrypt = JSON.parse(readFileSync(realCrypt, 'utf8')).os_crypt
  if (!osCrypt?.encrypted_key) {
    throw new Error('--with-ai: Local State has no os_crypt.encrypted_key — cannot decrypt the stored keys.')
  }
  // Only os_crypt, not the rest of Chromium's Local State.
  writeFileSync(join(profileDir, 'Local State'), JSON.stringify({ os_crypt: osCrypt }), 'utf8')
  console.log(`  AI config carried into the temp profile (provider: ${ai.provider}, keys for: ${providers.join(', ')})`)
  return ai
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

mkdirSync(OUT_DIR, { recursive: true })
console.log(`Shooting ${shots.length} screenshot(s) at ${WIDTH}×${HEIGHT} @${DPR}x`)
console.log(`  → ${OUT_DIR}`)
if (OUT_DIR === SHOT_DIR) {
  console.log('  ! writing over the SHIPPED screenshots (docs/RELEASE.md: these are taken by hand)')
}
const hasAiShot = shots.some((s) => s.needsAi)
/** Real provider calls only when asked for; otherwise replay */
const needsAi = hasAiShot && withAi
const aiEnv = {}
if (hasAiShot && !withAi) aiEnv.PDFX_AI_FIXTURE = FIXTURE_DIR
if (hasAiShot && withAi && record) aiEnv.PDFX_AI_RECORD = FIXTURE_DIR
if (aiEnv.PDFX_AI_FIXTURE) console.log('  Assistant answers replayed from docs/ai-fixtures/ (no API call)')
if (aiEnv.PDFX_AI_RECORD) console.log('  Recording the assistant answers into docs/ai-fixtures/')
const app = launchApp({
  root: ROOT,
  mainJs,
  args: [pdf],
  port: PORT,
  prepareProfile: (dir) => seedProfile(dir, needsAi, !!aiEnv.PDFX_AI_FIXTURE),
  env: aiEnv
})

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
console.log(`\nDone — ${OUT_DIR}`)
if (OUT_DIR !== SHOT_DIR) {
  console.log('These are for eyeballing, not for shipping. The README/store set is shot by hand.')
}

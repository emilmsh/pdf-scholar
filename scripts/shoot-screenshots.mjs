// Drive the real app into each documented state and photograph it.
//
//   npm run shoot                           all shots except the AI ones
//   npm run shoot -- dual-pane reading      just these
//   npm run shoot -- --list                 show the shot names
//   npm run shoot -- --with-ai              also the two assistant shots
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
// The two assistant shots need a real answer from a real model, so they are
// OPT-IN behind --with-ai and skipped otherwise. They do not ask anyone for an
// API key: keys already live in the real profile's pdfx-state.json, encrypted
// with Electron safeStorage, which on Windows is DPAPI — scoped to the Windows
// USER, not to the profile directory. So the encrypted blob can be copied into
// the throwaway profile and the app there decrypts it itself. The key is never
// decrypted by this script, never printed, and dies with the temp profile.
//
// Consequence worth knowing: those two shots are NOT byte-reproducible, since
// the answer is generated. That makes their assertions the important part — a
// real answer with at least one citation chip and no error — or the run would
// happily photograph a spinner or an error toast and save it as marketing.
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
      await ui.ask('Hvordan fungerer positional encoding i denne artikkelen?')
      ui.expectAnswer()
      // Then TAKE the chip's word for it. A picture of an answer proves the
      // assistant can write; a picture of the cited sentence highlighted on the
      // page, next to the answer that claimed it, proves the part that matters.
      await ui.followFirstCitation()
      ui.expectCitationVisible()
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
      await ui.newConversation()
      // Bring the whole figure and its caption into view first: the marked
      // region shows up as a thumbnail in the chat, and a thumbnail of
      // something half off-screen is no evidence of anything.
      await ui.centreOn('Figure 1')
      await ui.snipIntoChat()
      await ui.send('Hva viser denne figuren?')
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
    // Disarm any tool a previous shot armed — the shots share one app session,
    // so the annotations shot's highlighter was still lit (and its button
    // outlined) in every theme shot that followed it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle(200);
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
  /** Open the assistant panel (idempotent) */
  async openAssistant() {
    const b = btn('Assistent');
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
  /** Start a fresh conversation, so a shot is not framed around the tail of the
   *  previous shot's chat — every shot shares one app session. */
  async newConversation() {
    const b = [...document.querySelectorAll('.ai-panel .tb-btn')]
      .find((x) => /ny samtale|new conversation/i.test(x.title || ''));
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
      .find((x) => /område/i.test(x.title || ''));
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
    const b = btn('Forklar område');
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
  async dragSnipBox(captionStart) {
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
    overlay.dispatchEvent(new PointerEvent('pointerup', opts(x2, y2)));
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
// Default output is the gitignored _auto/ folder, so a run can never clobber the
// hand-taken set the README and the stores ship. --out is the explicit override.
const outFlag = args.indexOf('--out')
const OUT_DIR = outFlag !== -1 && args[outFlag + 1] ? resolve(ROOT, args[outFlag + 1]) : join(SHOT_DIR, '_auto')
// Guard the -1 case: without --out, `outFlag + 1` is 0 and would swallow the
// first shot name, silently running the whole set instead of the one asked for.
const outValueAt = outFlag === -1 ? -1 : outFlag + 1
const wanted = args.filter((a, i) => !a.startsWith('-') && i !== outValueAt)
let shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS
// AI shots cost a real model call on the user's own key, so they never run by
// accident — not even when named explicitly.
const gated = shots.filter((s) => s.needsAi && !withAi)
shots = shots.filter((s) => !s.needsAi || withAi)
if (gated.length) {
  console.log(`Skipping ${gated.map((s) => s.name).join(', ')} — pass --with-ai (uses your own API key).`)
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
  // Only the ai block. main/storage.ts merges a partial state over its defaults.
  writeFileSync(join(profileDir, 'pdfx-state.json'), JSON.stringify({ ai }), 'utf8')
  // Only os_crypt, not the rest of Chromium's Local State.
  writeFileSync(join(profileDir, 'Local State'), JSON.stringify({ os_crypt: osCrypt }), 'utf8')
  console.log(`  AI config carried into the temp profile (provider: ${ai.provider}, keys for: ${providers.join(', ')})`)
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
const needsAi = shots.some((s) => s.needsAi)
const app = launchApp({
  root: ROOT,
  mainJs,
  args: [pdf],
  port: PORT,
  prepareProfile: needsAi ? carryAiConfig : undefined
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

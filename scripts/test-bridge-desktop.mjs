// «Les sammen» in the REAL app (Emil, 2026-11-24): the shipped MCP script,
// started the way a tool starts it, asking the running app to show a passage,
// read a document and say what is open — and the app's own side of it: the
// passage marked on its page (and staying marked), the reference kept in the assistant panel's
// list and pressable again after the reader has gone elsewhere, a document no
// tab holds read WITHOUT a tab opening, and the switch that turns it all off.
//
// What only a real app can show: that main listens exactly while the switch
// is on (the token file comes and goes with it), that a request reaches the
// window holding the document and the viewer resolves the quote in the text
// it really extracted, that the panel opens on the list, and that the server
// script bundled into out/ speaks to the pipe main opened.
//
// NOT covered here, and a hand check before a release: that the window comes
// up ABOVE another app without taking the keyboard (measured by hand on
// Windows 11, 2026-11-24 — CDP cannot see the desktop's z-order), and the
// server starting an app that is not running (it starts the INSTALLED app's
// executable, which a developer run is not).
// Run: npm run build && node scripts/test-bridge-desktop.mjs
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, evaluate, launchApp, openSocket, sleep, waitForPageTargets } from './lib/cdp.mjs'

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE_DIR, '..')
const PORT = 9367
const MAIN = join(ROOT, 'out', 'main', 'index.js')
const SCRIPT = join(ROOT, 'out', 'mcp', 'pdf-scholar-mcp.cjs')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

async function waitFor(fn, ready, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (ready(last)) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

/** The server script as ONE running session of a tool: every call goes to the
 *  same process, as a tool's calls in one conversation do */
function startServer(dataDir) {
  const child = spawn(process.execPath, [SCRIPT, '--data', dataDir, '--client', 'other'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let id = 1
  const waiting = new Map()
  child.stdout.on('data', (d) => {
    out += d
    for (let nl = out.indexOf('\n'); nl !== -1; nl = out.indexOf('\n')) {
      const line = out.slice(0, nl)
      out = out.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  const rpc = (method, params) =>
    new Promise((done, fail) => {
      const mine = ++id
      const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 90_000)
      waiting.set(mine, (msg) => {
        clearTimeout(timer)
        done(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`)
    })
  return {
    init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    call: async (name, args = {}) => {
      const res = await rpc('tools/call', { name, arguments: args })
      return { text: res.result?.content?.[0]?.text ?? '', isError: res.result?.isError === true }
    },
    close: () => child.stdin.end()
  }
}

const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const page = () => document.querySelector('.page-indicator input')?.value ?? null;
// A <select> React controls: its value is set past React's own setter, then told
const pick = async (key, value) => {
  const el = document.querySelector('.tool-session select[data-pick="' + key + '"]');
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(400);
  return true;
};
`

async function main() {
  if (!existsSync(MAIN) || !existsSync(SCRIPT)) throw new Error('out/ is missing the app or the MCP script — run npm run build first')
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-bridge-'))
  const DOC = join(dir, 'Open paper.pdf')
  const OTHER = join(dir, 'Unopened paper.pdf')
  copyFileSync(SAMPLE, DOC)
  copyFileSync(SAMPLE, OTHER)

  const app = launchApp({
    root: ROOT,
    mainJs: MAIN,
    args: [DOC],
    port: PORT,
    prepareProfile: (p) => {
      // A tool set up by hand is on (the one switch that writes into no
      // tool's config) — and «Les sammen» is NOT: it starts off
      writeFileSync(join(p, 'pdfx-state.json'), JSON.stringify({ mcp: { clients: { claude: false, codex: false, other: true } } }))
    }
  })
  const tokenFile = join(app.profile, 'tool-bridge.json')
  const run = (send, body) => evaluate(send, body, PRELUDE)
  let server = null
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')
    await waitFor(() => run(send, `return document.querySelectorAll('.pdf-page').length`), (n) => n > 0, 'the document')

    server = startServer(app.profile)
    await server.init()

    console.log('\n1. off until the reader turns it on')
    await sleep(800)
    check('a fresh profile does not listen: no token beside the state file', !existsSync(tokenFile))
    const refused = await server.call('show_passage', { path: DOC, page: 4, quote: 'Navigasjonshistorikk med en tydelig tilbake-knapp' })
    check('show_passage is refused, naming the switch', refused.isError && /«Read together» is off/.test(refused.text), refused.text)
    check('…and the notes tools still answer', !(await server.call('list_documents')).isError)

    console.log('\n2. the switch in the AI-tools dialog')
    const dialog = await run(
      send,
      `window.dispatchEvent(new CustomEvent('pdfx:ai-tools', { detail: {} }));
       // The dialog first looks for the tools on this machine (it asks the
       // claude CLI, which takes seconds to start) — the rows come after
       const find = () => [...document.querySelectorAll('.ai-tools-dialog .ai-tools-row')]
         .find((r) => /PDF Scholar/.test(r.querySelector('.ai-tools-name')?.textContent || ''));
       for (let waited = 0; waited < 40000 && !find(); waited += 250) await settle(250);
       const row = find();
       const box = row?.querySelector('input');
       const before = { found: !!row, checked: box?.checked, disabled: box?.disabled };
       if (box) click(box);
       await settle(900);
       const after = { checked: row?.querySelector('input')?.checked,
                       note: [...document.querySelectorAll('.ai-tools-dialog .ai-tools-note')].some((n) => /KI-leverandør|AI provider/.test(n.textContent)) };
       document.querySelector('.ai-tools-dialog .shortcuts-close')?.click();
       await settle(300);
       return { before, after };`
    )
    check('the dialog has the switch, off, and usable because a tool is on', dialog.before.found && dialog.before.checked === false && dialog.before.disabled === false, JSON.stringify(dialog.before))
    check('…and says in full what is then shared', dialog.after.note)
    check('turned on in the dialog', dialog.after.checked === true)
    await waitFor(() => existsSync(tokenFile), Boolean, 'main to start listening')
    check('main listens now: the token is beside the state file', JSON.parse(readFileSync(tokenFile, 'utf-8')).token.length >= 32)

    console.log('\n3. what the reader has open')
    const ctx = await server.call('get_reading_context')
    check('the document in front, its path and page', !ctx.isError && ctx.text.includes('«Open paper.pdf»') && ctx.text.includes(`Path: ${DOC}`) && /page 1 of 6/.test(ctx.text), ctx.text)
    check('nothing selected is said so', /no text selected/.test(ctx.text))
    await run(
      send,
      `const span = [...document.querySelectorAll('.textLayer span')].find((s) => (s.textContent || '').includes('Eksempeldokument'));
       const range = document.createRange(); range.selectNodeContents(span);
       const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
       return true;`
    )
    const withSel = await server.call('get_reading_context')
    check('text the reader selected is given', withSel.text.includes('«Eksempeldokument»'), withSel.text)

    console.log('\n4. the text as the app reads it')
    const text = await server.call('read_document', { path: DOC })
    check('every page, under its own heading', !text.isError && /pages 1–6 of 6/.test(text.text) && ['## Page 1', '## Page 4', '## Page 6'].every((h) => text.text.includes(h)))
    check('…with the document’s own words', text.text.includes('Navigasjonshistorikk') && text.text.includes('Eksempeldokument'))

    console.log('\n5. a passage shown, and kept')
    const QUOTE = 'Navigasjonshistorikk med en tydelig tilbake-knapp er derfor en sentral del av planen.'
    const shown = await server.call('show_passage', { path: DOC, page: 4, quote: QUOTE, claim: 'Dokumentet lover en tilbake-knapp', topic: 'Navigasjon i appen' })
    check('found word for word on its page, as reference 1', !shown.isError && /^\[1\] Found word for word on page 4/.test(shown.text), shown.text)
    const view = await waitFor(
      () => run(send, `return { page: page(), mark: !!document.querySelector('.search-hit:not(.cite-flash)'), panel: !!document.querySelector('.tool-session'),
                              refs: [...document.querySelectorAll('.tool-ref')].map((r) => ({ n: r.querySelector('.tool-ref-n')?.textContent, claim: r.querySelector('.tool-ref-claim')?.textContent, chip: r.querySelector('.ai-chip')?.textContent, missing: r.classList.contains('is-missing') })),
                              title: document.querySelector('.tool-session-title')?.textContent,
                              picks: [...document.querySelectorAll('.tool-session select')].map((s) => s.dataset.pick + '=' + s.value) }`),
      (v) => v.page === '4' && v.mark && v.refs.length === 1,
      'the passage to be shown'
    )
    check('the viewer went to the page and the passage is marked', view.page === '4' && view.mark)
    // The assistant's own citation chips flash for 7 s and fade. A passage a
    // tool pointed at does not: the reader comes to it from another program
    const later = await run(send, `await settle(7600); return { mark: !!document.querySelector('.search-hit:not(.cite-flash)') }`)
    check('…and stays marked past the seven seconds a flash lasts', later.mark)
    // ONE list of references across sessions (Emil, 2026-11-25): it opens on
    // this document's, newest first, with what is shown, how it is grouped
    // and how it is sorted to choose
    check('the assistant panel opened on the one list of references', view.panel && view.title === 'Henvisninger fra KI-verktøy' && view.picks.join() === 'show=here,group=none,sort=newest', `${view.title} · ${view.picks.join()}`)
    check('the reference: the claim and the page as a chip — and no number, which is a session’s own', view.refs[0].n === undefined && view.refs[0].claim === 'Dokumentet lover en tilbake-knapp' && /4/.test(view.refs[0].chip) && !view.refs[0].missing, JSON.stringify(view.refs[0]))
    const bySession = await run(
      send,
      `await pick('group', 'session');
       const out = { headings: [...document.querySelectorAll('.tool-refs-heading-name')].map((h) => h.textContent),
                     n: document.querySelector('.tool-ref .tool-ref-n')?.textContent,
                     canDelete: !!document.querySelector('.tool-refs-heading .ai-history-delete') };
       await pick('group', 'none');
       return out;`
    )
    check('grouped by session: under the topic the tool gave, with the number it wrote and a way to delete the session', bySession.headings.length === 1 && /^Navigasjon i appen · [^·]+ · /.test(bySession.headings[0]) && / \(1\)$/.test(bySession.headings[0]) && bySession.n === '[1]' && bySession.canDelete, JSON.stringify(bySession))

    const wrong = await server.call('show_passage', { path: DOC, page: 2, quote: 'Appen ble lansert i 1987 og har ti millioner brukere.', claim: 'En påstand uten dekning' })
    check('words that are not in the document: NOT FOUND, as reference 2', /^\[2\] NOT FOUND/.test(wrong.text) && /unverified/.test(wrong.text), wrong.text)
    const missing = await waitFor(
      () => run(send, `return { page: page(), refs: [...document.querySelectorAll('.tool-ref')].map((r) => ({ missing: r.classList.contains('is-missing'), flag: r.querySelector('.tool-ref-flag')?.textContent ?? '' })) }`),
      (v) => v.refs.length === 2,
      'the second reference'
    )
    check('…listed first, as the newest, and marked as not found', missing.refs[0].missing && missing.refs[0].flag.length > 0 && !missing.refs[1].missing, JSON.stringify(missing.refs))
    const lost = await run(
      send,
      `await pick('show', 'missing');
       const only = [...document.querySelectorAll('.tool-ref')].map((r) => r.classList.contains('is-missing'));
       await pick('show', 'here');
       return only;`
    )
    check('«Ikke funnet» shows that one alone', lost.length === 1 && lost[0] === true, JSON.stringify(lost))
    check('…with the viewer on the cited page', missing.page === '2')

    console.log('\n6. a reference is come back to')
    const back = await run(
      send,
      `const field = document.querySelector('.page-indicator input');
       const first = [...document.querySelectorAll('.tool-ref:not(.is-missing) .ai-chip')][0];
       click(first);
       let waited = 0;
       while (waited < 8000 && !(page() === '4' && document.querySelector('.search-hit:not(.cite-flash)'))) { await settle(200); waited += 200; }
       return { page: page(), mark: !!document.querySelector('.search-hit:not(.cite-flash)'), had: !!field };`
    )
    check('pressing the first reference’s chip goes back to its passage', back.page === '4' && back.mark, JSON.stringify(back))

    const again = await server.call('show_passage', { path: DOC, page: 4, quote: QUOTE })
    const count = await run(send, `await settle(500); return document.querySelectorAll('.tool-ref').length`)
    check('the same passage shown again keeps its number and adds no card', /^\[1\] /.test(again.text) && count === 2, `${again.text.slice(0, 40)} · ${count} cards`)

    console.log('\n7. a document no tab holds')
    const tabsBefore = await run(send, `return document.querySelectorAll('.tab').length`)
    const quiet = await server.call('read_document', { path: OTHER, from: 2, to: 2 })
    check('its text is read', !quiet.isError && quiet.text.includes('## Page 2') && quiet.text.includes('Innledning'), quiet.text.slice(0, 120))
    const listed = await server.call('show_passage', { path: OTHER, page: 4, quote: QUOTE, claim: 'Det samme i den andre', show: false })
    check('a passage in it is found and only listed', /Found word for word on page 4/.test(listed.text) && /list of references/.test(listed.text), listed.text)
    await sleep(600)
    const after = await run(send, `return { tabs: document.querySelectorAll('.tab').length, page: page() }`)
    check('…without a tab opening or the reader being moved', after.tabs === tabsBefore && after.page === '4', JSON.stringify(after))
    const recents = JSON.parse(readFileSync(join(app.profile, 'pdfx-state.json'), 'utf-8')).recents ?? []
    check('…and without filing it as just opened', !recents.some((r) => r.path === OTHER))
    const all = await run(
      send,
      `const onlyHere = document.querySelectorAll('.tool-ref').length;
       const hadPick = await pick('show', 'all');
       const out = { hadPick, onlyHere, all: document.querySelectorAll('.tool-ref').length,
                     docs: [...document.querySelectorAll('.tool-ref .ai-history-doc')].map((d) => d.textContent) };
       await pick('group', 'doc');
       out.headings = [...document.querySelectorAll('.tool-refs-heading-name')].map((h) => h.textContent);
       out.docsUnderHeadings = document.querySelectorAll('.tool-ref .ai-history-doc').length;
       await pick('sort', 'page');
       out.byPage = [...document.querySelectorAll('.tool-ref .ai-chip')].map((c) => c.textContent.replace(/\\D+/g, ''));
       await pick('group', 'none'); await pick('sort', 'newest');
       return out;`
    )
    check('the list shows this document’s references, and every document’s on «Alle dokumenter»', all.hadPick && all.onlyHere === 2 && all.all === 3 && all.docs.includes('Unopened paper.pdf'), JSON.stringify(all))
    check('grouped by document: a heading per document with its count, and no file name on the cards', all.headings.length === 2 && all.headings.some((h) => /^Unopened paper\.pdf \(1\)$/.test(h)) && all.docsUnderHeadings === 0, JSON.stringify(all.headings))
    check('sorted by page within each document', all.byPage.length === 3, all.byPage.join())
    const sessions = readdirSync(join(app.profile, 'tool-sessions')).filter((n) => n.endsWith('.json'))
    const stored = JSON.parse(readFileSync(join(app.profile, 'tool-sessions', sessions[0]), 'utf-8'))
    check('one session on disk, holding what was shown AND what was read', sessions.length === 1 && stored.entries.filter((e) => e.kind === 'reference').length === 3 && stored.entries.some((e) => e.kind === 'read') && stored.entries.some((e) => e.kind === 'context' && e.selection === true))

    console.log('\n8. kept out, and switched off')
    await run(send, `await window.api.mcpSetPolicy({ excludedDocs: [${JSON.stringify(DOC)}] }); return true;`)
    const kept = await server.call('show_passage', { path: DOC, page: 4, quote: QUOTE })
    check('a document kept out is refused', kept.isError && /keeps this document out/.test(kept.text), kept.text)
    const hidden = await server.call('get_reading_context')
    check('…and when it is the one in front, the tool is told nothing about it', !hidden.isError && /does not share/.test(hidden.text) && !hidden.text.includes('Open paper'), hidden.text)
    await run(send, `await window.api.mcpSetPolicy({ excludedDocs: [], live: false }); return true;`)
    await waitFor(() => !existsSync(tokenFile), Boolean, 'main to stop listening')
    check('switched off: the token is gone', !existsSync(tokenFile))
    const off = await server.call('get_reading_context')
    check('…and the running session is refused at once', off.isError && /«Read together» is off/.test(off.text), off.text)
  } finally {
    server?.close()
    await app.cleanup()
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

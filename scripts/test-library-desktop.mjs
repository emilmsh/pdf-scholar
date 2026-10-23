// The library's «Samtaler» in the REAL app (issue #46): what dev:web cannot
// show — a recents list to badge, files that are really gone, the search
// answered by main, and a source chip clicked outside its document opening
// that document ON the cited passage, in a fresh tab and in one already open.
//
// The profile holds two recents with conversations: HERE (a copy of
// sample.pdf, one conversation whose answer cites a sentence on page 3) and
// GONE (a path with no file, two conversations).
// Needs `npm run build` first. Run: node scripts/test-library-desktop.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE_DIR, '..')
const PORT = 9357
const MAIN = join(ROOT, 'out', 'main', 'index.js')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
/** A sentence sample.pdf prints on its third page */
const QUOTE = 'God typografi og rolige farger gjør lange lesestunder behagelige.'

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

async function waitFor(fn, ready, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (ready(last)) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const DAY = 86_400_000
const now = Date.now()
const conv = (id, title, answer, age, citation) => ({
  id, title, createdAt: now - age * DAY - 1000, updatedAt: now - age * DAY,
  messages: [{ role: 'user', text: title }, { role: 'assistant', parts: [{ text: answer, citations: citation ? [citation] : [] }] }]
})

// In-page helpers: setting a React-controlled field needs the native setter
const PRELUDE = `
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const setValue = (el, v) => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const groups = () => [...document.querySelectorAll('.convs-group')].map((g) => ({
  name: g.querySelector('.convs-doc-name')?.childNodes[0]?.textContent ?? '',
  gone: !!g.querySelector('.conv-gone-tag'),
  rows: g.querySelectorAll('.convs-item').length
}));
const page = () => Number([...document.querySelectorAll('input')].find((i) => /^\\d+$/.test(i.value))?.value ?? 0);
`
const run = (send, body) => evaluate(send, body, PRELUDE)

async function main() {
  if (!existsSync(MAIN)) throw new Error('out/main/index.js missing — run npm run build first')
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-library-'))
  const HERE = join(dir, 'present.pdf')
  const GONE = join(dir, 'deleted.pdf')
  copyFileSync(SAMPLE, HERE)

  const app = launchApp({
    root: ROOT, mainJs: MAIN, args: [], port: PORT,
    prepareProfile: (p) => {
      writeFileSync(join(p, 'pdfx-state.json'), JSON.stringify({
        recents: [
          { path: HERE, name: 'present.pdf', lastOpened: now - 1000 },
          { path: GONE, name: 'deleted.pdf', lastOpened: now - 2000 }
        ]
      }))
      mkdirSync(join(p, 'chats'))
      writeFileSync(join(p, 'chats', `${sha1(HERE)}.json`), JSON.stringify({
        path: HERE, name: 'present.pdf',
        conversations: [conv('h1', 'Hva sier den om typografi?', 'Rolige farger hjelper.', 1, { kind: 'quote', pageNumber: 3, quote: QUOTE })]
      }))
      writeFileSync(join(p, 'chats', `${sha1(GONE)}.json`), JSON.stringify({
        path: GONE, name: 'deleted.pdf',
        conversations: [conv('g1', 'Metode', 'Differanse-i-differanser med paneldata.', 400), conv('g2', 'Data', 'Registerdata.', 5)]
      }))
    }
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    console.log('\n1. the recents carry a quiet mark')
    const badges = await waitFor(
      () => run(send, `return [...document.querySelectorAll('.recent-item')].map((li) => ({
        name: li.querySelector('.recent-name')?.textContent, badge: li.querySelector('.recent-convs')?.textContent ?? null }))`),
      (v) => v.length === 2 && v.every((r) => r.badge !== null),
      'the recents with their marks'
    )
    const by = Object.fromEntries(badges.map((r) => [r.name, r.badge]))
    check('each entry shows its number of conversations', by['present.pdf'] === '1' && by['deleted.pdf'] === '2', JSON.stringify(by))

    console.log('\n2. «Vis samtaler» opens the tab on that document')
    await run(send, `click([...document.querySelectorAll('.recent-item')].find((li) => li.textContent.includes('present.pdf')).querySelector('[aria-label="Vis samtaler"]')); await settle(600)`)
    const filtered = await waitFor(() => run(send, `return groups()`), (g) => g.length >= 1, 'the filtered tab')
    check('only that document’s conversations show', filtered.length === 1 && filtered[0].name === 'present.pdf', JSON.stringify(filtered))
    check('the filter shows as a chip that clears it', await run(send, `return !!document.querySelector('.convs-chip.is-on')`))
    await run(send, `click(document.querySelector('.convs-chip.is-on')); await settle(300)`)

    console.log('\n3. a document whose file is gone says so')
    const all = await waitFor(() => run(send, `return groups()`), (g) => g.length === 2 && g.some((x) => x.gone), 'both documents with the tag')
    const goneGroup = all.find((g) => g.name === 'deleted.pdf')
    const hereGroup = all.find((g) => g.name === 'present.pdf')
    check('the gone document carries «Filen finnes ikke»', !!goneGroup?.gone)
    check('the present one does not', hereGroup && !hereGroup.gone)
    await run(send, `click([...document.querySelectorAll('.convs-chip')].find((b) => b.textContent === 'Filen mangler')); await settle(300)`)
    const missing = await run(send, `return groups()`)
    check('«Filen mangler» keeps only the gone document', missing.length === 1 && missing[0].name === 'deleted.pdf', JSON.stringify(missing))
    await run(send, `click([...document.querySelectorAll('.convs-chip')].find((b) => b.textContent === 'Filen mangler')); await settle(300)`)

    console.log('\n4. sorting')
    await run(send, `setValue(document.querySelector('.convs-sort select'), 'name'); await settle(300)`)
    const byName = (await run(send, `return groups()`)).map((g) => g.name).join(',')
    check('by name: A–Å', byName === 'deleted.pdf,present.pdf', byName)
    await run(send, `setValue(document.querySelector('.convs-sort select'), 'updated'); await settle(300)`)
    const byUpdated = (await run(send, `return groups()`)).map((g) => g.name).join(',')
    check('by last change: the one changed yesterday first', byUpdated === 'present.pdf,deleted.pdf', byUpdated)

    console.log('\n5. the search is answered by main')
    const listed = await run(send, `return await window.api.listConversations()`)
    check('the list a window receives carries no conversation text', listed.length === 3 && listed.every((c) => !('text' in c)), String(listed.length))
    await run(send, `setValue(document.querySelector('.convs-search'), 'paneldata'); await settle(700)`)
    const searched = await run(send, `return { g: groups(), snippet: document.querySelector('.convs-snippet')?.textContent ?? null }`)
    check('a word in one answer finds that conversation only', searched.g.length === 1 && searched.g[0].name === 'deleted.pdf' && searched.g[0].rows === 1, JSON.stringify(searched.g))
    check('…with a snippet around it', !!searched.snippet && /paneldata/i.test(searched.snippet), String(searched.snippet))
    await run(send, `setValue(document.querySelector('.convs-search'), ''); await settle(500)`)

    console.log('\n6. «Egendefinert» counts what it would take')
    await run(send, `click(document.querySelector('.library-tidy-btn')); await settle(400)`)
    const custom = await run(send, `
      const row = [...document.querySelectorAll('.convs-tidy-row')][1];
      setValue(row.querySelector('select'), '-1'); await settle(200);
      setValue(row.querySelector('.convs-custom'), '3'); await settle(300);
      const three = row.querySelector('.convs-tidy-count').textContent;
      setValue(row.querySelector('.convs-custom'), 'x'); await settle(300);
      return { three, junk: row.querySelector('.convs-tidy-count').textContent, disabled: row.querySelector('button').disabled }`)
    check('older than 3 months: the 400-day-old one', custom.three === '1 samtaler om 1 dokumenter', custom.three)
    check('a field that is not a number takes nothing', custom.junk === 'Ingen' && custom.disabled, JSON.stringify(custom))
    await run(send, `click(document.querySelector('.convs-tidy-close')); await settle(200)`)

    console.log('\n7. a source chip opens its document on the passage')
    await run(send, `click([...document.querySelectorAll('.convs-row')].find((b) => b.textContent.includes('typografi'))); await settle(600)`)
    await run(send, `click(document.querySelector('.convs-reader-body button')); await settle(200)`)
    const landed = await waitFor(
      () => run(send, `return { flash: !!document.querySelector('.search-hit.cite-flash'), page: page(),
        panel: [...document.querySelectorAll('.right-pane .ai-messages')].map((e) => e.innerText).join(' | '),
        panelOpen: (document.querySelector('.tab-view.active .right-pane') ?? document.querySelector('.right-pane'))?.innerText?.slice(0, 160), panes: document.querySelectorAll('.right-pane').length, msgs: [...document.querySelectorAll('.ai-messages')].map((e) => (e.closest('.convs') ? 'library: ' : 'panel: ') + e.innerText.slice(0, 40)) }`),
      (v) => v.flash,
      'the cited passage to flash',
      25_000
    )
    check('the document opened on the cited page', landed.page === 3, `page ${landed.page}`)
    check('the passage is highlighted', landed.flash)
    check('the assistant shows that conversation', landed.panel.includes('typografi'), JSON.stringify({ panel: landed.panel.slice(0, 80), pane: landed.panelOpen, panes: landed.panes, msgs: landed.msgs }))

    console.log('\n8. …also when the document is already open in a tab')
    await run(send, `document.querySelector('.pages')?.scrollTo?.(0, 0); click(document.querySelector('button[title="Tilbake til biblioteket"]')); await settle(800)`)
    await waitFor(() => run(send, `return !!document.querySelector('.library-tabs')`), (v) => v, 'the library again')
    await run(send, `if (!document.querySelector('.convs')) click([...document.querySelectorAll('.library-tabs button')].find((b) => b.textContent === 'Samtaler')); await settle(500)`)
    await run(send, `click([...document.querySelectorAll('.convs-row')].find((b) => b.textContent.includes('typografi'))); await settle(600)`)
    await run(send, `click(document.querySelector('.convs-reader-body button')); await settle(200)`)
    const again = await waitFor(
      () => run(send, `return { flash: !!document.querySelector('.search-hit.cite-flash'), page: page(), tabs: document.querySelectorAll('.tab').length }`),
      (v) => v.flash && v.page === 3,
      'the passage again in the open tab',
      25_000
    )
    check('the open tab is reused, not a second one', again.tabs === 1, `tabs=${again.tabs}`)
    check('and lands on the passage again', again.page === 3 && again.flash)
  } finally {
    await app.cleanup()
  }
}

main()
  .catch((err) => {
    console.error(err)
    failures++
  })
  .finally(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall passed')
    process.exit(failures ? 1 : 0)
  })

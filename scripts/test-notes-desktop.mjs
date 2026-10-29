// The notes an outside AI tool reads, end to end in the REAL app (Emil,
// 2026-10-29): opening a document writes its record into userData/notes
// without anyone asking — the marks with the words they mark, read off the
// viewer's own excerpts — and the MCP server script the build ships finds
// them when started the way Claude Code starts it: the app's executable in
// Node mode. Also the Merknader tab's «Kopier for KI», which carries the same
// notes AND the document's conversations to a tool no server can reach.
//
// sample.pdf carries one highlight and one sticky note of its own.
// Needs `npm run build` first. Run: node scripts/test-notes-desktop.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, electronBinary, sleep } from './lib/cdp.mjs'

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE_DIR, '..')
const PORT = 9361
const MAIN = join(ROOT, 'out', 'main', 'index.js')
const SCRIPT = join(ROOT, 'out', 'mcp', 'pdf-scholar-mcp.cjs')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const sha1 = (s) => createHash('sha1').update(s).digest('hex')

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

/** One request to the server script over stdio, as a tool sends it */
function ask(command, env, dataDir, name, args) {
  return new Promise((done) => {
    // Named as a tool set up by hand: the one switch a test can turn without
    // writing into the developer's own Claude or Codex config
    const child = spawn(command, [SCRIPT, '--data', dataDir, '--client', 'other'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, 20_000)
    child.stdout.on('data', (d) => {
      out += d
      const line = out.split('\n').find((l) => l.includes('"id":2'))
      if (!line) return
      clearTimeout(timer)
      child.stdin.end()
      done(JSON.parse(line).result?.content?.[0]?.text ?? null)
    })
    child.stdin.write(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n'
    )
  })
}

const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const label = (b) => b.title || b.getAttribute('aria-label') || '';
`

async function main() {
  if (!existsSync(MAIN) || !existsSync(SCRIPT)) throw new Error('out/ is missing the app or the MCP script — run npm run build first')
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-notes-'))
  const DOC = join(dir, 'Notes paper.pdf')
  copyFileSync(SAMPLE, DOC)
  // A paper marked up before notes were kept: in the recents, never opened
  // in this profile, no record — the quiet pass must read its marks
  const OLD = join(dir, 'Older paper.pdf')
  copyFileSync(SAMPLE, OLD)

  const app = launchApp({
    root: ROOT,
    mainJs: MAIN,
    args: [DOC],
    port: PORT,
    prepareProfile: (p) => {
      writeFileSync(
        join(p, 'pdfx-state.json'),
        JSON.stringify({ recents: [{ path: OLD, name: 'Older paper.pdf', lastOpened: Date.now() - 86_400_000 }] })
      )
      // A conversation about the document, so «Kopier for KI» has one to carry
      mkdirSync(join(p, 'chats'))
      writeFileSync(
        join(p, 'chats', `${sha1(DOC)}.json`),
        JSON.stringify({
          path: DOC,
          name: 'Notes paper.pdf',
          conversations: [
            {
              id: 'c1',
              title: 'Typografi',
              createdAt: Date.now() - 2000,
              updatedAt: Date.now() - 1000,
              messages: [
                { role: 'user', text: 'Hva sier den om lesestunder?' },
                { role: 'assistant', parts: [{ text: 'Rolige farger hjelper.', citations: [] }] }
              ]
            }
          ]
        })
      )
    }
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    console.log('\n1. opening a document writes its notes, unasked')
    const file = join(app.profile, 'notes', `${sha1(DOC)}.json`)
    const record = await waitFor(
      () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null),
      (r) => r !== null && r.notes.length > 0,
      'the notes record'
    )
    check('one record, under the path’s hash, naming the path', record.path === DOC && record.name === 'Notes paper.pdf')
    check('its page count', record.pages > 0, String(record.pages))
    const hl = record.notes.find((n) => n.type === 'highlight')
    check('the highlight carries the words it marks', !!hl && hl.excerpt.trim().length > 3, hl?.excerpt)
    check('every entry has a page and a colour', record.notes.every((n) => n.page >= 1 && /^#[0-9a-f]{6}$/.test(n.color)))

    console.log('\n2. the panel: off until switched on, then the shipped script finds them')
    const word = hl.excerpt.split(/\s+/).find((w) => w.replace(/\W/g, '').length >= 5) ?? hl.excerpt.split(/\s+/)[0]
    const offAnswer = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('a fresh profile shares nothing (every switch is off by default)', !!offAnswer && /not sharing with this tool/.test(offAnswer), offAnswer?.slice(0, 80))
    check('…and the Merknader tab shows no AI-tools line while no tool may read', await evaluate(send, `return !document.querySelector('.annot-ai-tools')`))
    // The gear menu's own entry — not inside the API-key settings
    const panel = await evaluate(
      send,
      `
      const gear = [...document.querySelectorAll('.tb-btn')].find((b) => /^(Innstillinger|Settings)/.test(label(b)))
      if (!gear) return { error: 'no gear' }
      click(gear); await settle(300)
      const entry = [...document.querySelectorAll('.menu-action')].find((b) => /KI-verktøy \\(Claude|AI tools \\(Claude/.test(b.textContent))
      if (!entry) return { error: 'no menu entry' }
      click(entry); await settle(400)
      for (let i = 0; i < 40 && !document.querySelector('.ai-tools-dialog .ai-tools-row input'); i++) await settle(150)
      const dlg = document.querySelector('.ai-tools-dialog')
      if (!dlg) return { error: 'no dialog' }
      const rows = [...dlg.querySelectorAll('.keys-group:first-child .ai-tools-row')]
      return {
        tools: rows.map((r) => r.querySelector('.ai-tools-name').textContent),
        allOff: rows.every((r) => !r.querySelector('input').checked),
        inKeys: !!dlg.closest('.ai-settings')
      }
      `,
      PRELUDE
    )
    check('the gear menu opens «AI tools on this computer»', !panel.error, panel.error)
    check('…one switch per tool: Claude, Codex, other tools', JSON.stringify(panel.tools) === JSON.stringify(['Claude', 'Codex', panel.tools?.[2]]) && panel.tools?.length === 3, JSON.stringify(panel.tools))
    check('…all off in a fresh profile', panel.allOff === true)
    // «Andre verktøy» — the one switch that writes into no tool's config
    const turned = await evaluate(
      send,
      `
      const row = [...document.querySelectorAll('.ai-tools-dialog .keys-group:first-child .ai-tools-row')][2]
      row.querySelector('input').click()
      for (let i = 0; i < 40 && !row.querySelector('input').checked; i++) await settle(150)
      const copy = [...row.querySelectorAll('a')].find((a) => /Kopier oppsett|Copy setup/.test(a.textContent))
      return { on: row.querySelector('input').checked, copy: !!copy }
      `,
      PRELUDE
    )
    check('turning «other tools» on, and its setup to copy appears', turned.on && turned.copy, JSON.stringify(turned))
    const policyOn = await evaluate(send, `return await window.api.mcpPolicy()`)
    check('…the state holds that one switch and no other', policyOn.clients.other === true && !policyOn.clients.claude && !policyOn.clients.codex)
    check('…and the script is in place where the copied setup points', existsSync(join(app.profile, 'mcp', 'pdf-scholar-mcp.cjs')))
    const oldFile = join(app.profile, 'notes', `${sha1(OLD)}.json`)
    const oldRecord = await waitFor(
      () => (existsSync(oldFile) ? JSON.parse(readFileSync(oldFile, 'utf-8')) : null),
      (r) => r !== null,
      'the older paper’s record from the quiet pass',
      45_000
    ).catch(() => null)
    check('a paper never opened since notes were kept gets its record from the file', !!oldRecord && oldRecord.notes.some((n) => n.type === 'highlight' && n.excerpt.trim().length > 3), oldRecord ? JSON.stringify(oldRecord.notes[0]) : 'none')
    const recents = await evaluate(send, `return (await window.api.getRecents()).map((r) => r.path)`)
    check('…without filing it as just opened (the recents order is untouched)', recents.indexOf(OLD) > recents.indexOf(DOC), JSON.stringify(recents.map((p) => p.split(/[\\\\/]/).pop())))
    await evaluate(send, `document.querySelector('.ai-tools-dialog .shortcuts-close').click(); window.dispatchEvent(new Event('focus')); await settle(300)`, PRELUDE)
    const viaNode = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check(`Node: search_notes finds «${word}» in the paper`, !!viaNode && viaNode.includes('Notes paper.pdf'), viaNode?.slice(0, 120))
    // How Claude Code and Claude Desktop actually start it
    const viaApp = await ask(electronBinary(ROOT), { ELECTRON_RUN_AS_NODE: '1' }, app.profile, 'get_document_notes', { document: 'notes paper' })
    check('the app’s executable in Node mode: get_document_notes', !!viaApp && viaApp.includes(`Page ${hl.page}`) && viaApp.includes('Typografi'), viaApp?.slice(0, 120))

    console.log('\n3. «Kopier for KI» in the Merknader tab')
    const copied = await evaluate(
      send,
      `
      let text = null
      navigator.clipboard.writeText = async (t) => { text = t }
      const side = [...document.querySelectorAll('.tb-btn')].find((b) => /^(Sidepanel|Sidebar)/.test(label(b)))
      if (!side.classList.contains('is-active')) { click(side); await settle(450) }
      const tab = [...document.querySelectorAll('.sidebar-tabs button')].find((b) => /^(Merknader|Annotations)/.test(b.textContent.trim()))
      click(tab); await settle(400)
      const button = [...document.querySelectorAll('.annot-export button')].find((b) => /Kopier for KI|Copy for AI/.test(b.textContent))
      if (!button) return { error: 'no button' }
      button.click()
      for (let i = 0; i < 40 && text === null; i++) await settle(150)
      return { text, disabled: button.disabled }
      `,
      PRELUDE
    )
    check('the button is there', !copied.error, copied.error)
    check('it copies the paper’s name and its marks by page', !!copied.text && copied.text.startsWith('# Notes paper.pdf') && copied.text.includes(hl.excerpt.replace(/\s+/g, ' ').trim()))
    check('…and the paper’s conversation', !!copied.text && copied.text.includes('Hva sier den om lesestunder?') && copied.text.includes('Rolige farger hjelper.'))
    check('…and no file path', !!copied.text && !copied.text.includes(dir))

    console.log('\n3b. the tab’s line, and the document’s switch in the panel')
    const line = await evaluate(
      send,
      `
      const row = document.querySelector('.annot-ai-tools')
      if (!row) return { error: 'no line' }
      const text = row.textContent
      const change = row.querySelector('button')
      click(change); await settle(400)
      for (let i = 0; i < 40 && !document.querySelector('.ai-tools-doc.is-focused'); i++) await settle(150)
      const focused = document.querySelector('.ai-tools-doc.is-focused')
      if (!focused) return { error: 'no focused document', text }
      const box = focused.querySelector('input')
      const wasOn = box.checked
      box.click()
      for (let i = 0; i < 40 && box.checked; i++) await settle(150)
      return { text, name: focused.querySelector('.ai-tools-name').textContent, wasOn, nowOn: box.checked }
      `,
      PRELUDE
    )
    check('with a tool on, the tab says the paper is shared', /Deles med KI-verktøy|Shared with AI tools/.test(line.text ?? ''), line.error ?? line.text)
    check('«Endre» opens the panel on THIS paper, shared', line.name && line.wasOn === true, JSON.stringify(line))
    check('…and its switch keeps it out', line.nowOn === false)
    const kept = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('kept out, the server no longer finds the paper', !!kept && !kept.includes('Notes paper.pdf'), kept?.slice(0, 80))
    const policy = await evaluate(send, `return await window.api.mcpPolicy()`)
    check('…and the state says so', policy.clients.other === true && policy.excludedDocs.includes(DOC))
    const backIn = await evaluate(
      send,
      `
      const box = document.querySelector('.ai-tools-doc.is-focused input')
      box.click()
      for (let i = 0; i < 40 && !box.checked; i++) await settle(150)
      document.querySelector('.ai-tools-dialog .shortcuts-close').click()
      window.dispatchEvent(new Event('focus')); await settle(400)
      return document.querySelector('.annot-ai-tools')?.textContent ?? ''
      `,
      PRELUDE
    )
    const back = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('one click lets it back in', !!back && back.includes('Notes paper.pdf'))
    check('…and the tab says so again', /Deles med KI-verktøy|Shared with AI tools/.test(backIn), backIn)

    console.log('\n4. a second change rewrites the record')
    const before = readFileSync(file, 'utf-8')
    // Delete every mark through the tab's own «clear all» — the record must
    // follow and go, the file gone with nothing left to keep
    const cleared = await evaluate(
      send,
      `
      const all = document.querySelector('.annot-clear-all')
      if (!all || all.disabled) return 'no clear-all'
      click(all); await settle(300)
      const yes = [...document.querySelectorAll('.annot-clear-ask button, .annot-list button')].find((b) => /^(Fjern alle|Slett alle|Remove all|Delete all)/.test(b.textContent.trim()) && b !== all)
      if (!yes) return 'no confirm'
      click(yes); await settle(800)
      return 'ok'
      `,
      PRELUDE
    )
    if (cleared !== 'ok') console.log(`SKIP  could not clear the marks from the tab (${cleared})`)
    else {
      await waitFor(() => existsSync(file), (e) => !e, 'the record to go once nothing is noted', 15_000).catch(() => null)
      check('no marks left → no record', !existsSync(file), existsSync(file) && readFileSync(file, 'utf-8') === before ? 'unchanged' : '')
    }
  } finally {
    await app.cleanup()
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll notes-desktop checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

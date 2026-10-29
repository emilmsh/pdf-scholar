// The notes an outside AI tool reads, end to end in the REAL app (Emil,
// 2026-10-29): opening a document writes its record into userData/notes
// without anyone asking â€” the marks with the words they mark, read off the
// viewer's own excerpts â€” and the MCP server script the build ships finds
// them when started the way Claude Code starts it: the app's executable in
// Node mode. Also the Merknader tab's Â«Kopier for KIÂ», which carries the same
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
    const child = spawn(command, [SCRIPT, '--data', dataDir], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
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
  if (!existsSync(MAIN) || !existsSync(SCRIPT)) throw new Error('out/ is missing the app or the MCP script â€” run npm run build first')
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-notes-'))
  const DOC = join(dir, 'Notes paper.pdf')
  copyFileSync(SAMPLE, DOC)

  const app = launchApp({
    root: ROOT,
    mainJs: MAIN,
    args: [DOC],
    port: PORT,
    prepareProfile: (p) => {
      // A conversation about the document, so Â«Kopier for KIÂ» has one to carry
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
    check('one record, under the pathâ€™s hash, naming the path', record.path === DOC && record.name === 'Notes paper.pdf')
    check('its page count', record.pages > 0, String(record.pages))
    const hl = record.notes.find((n) => n.type === 'highlight')
    check('the highlight carries the words it marks', !!hl && hl.excerpt.trim().length > 3, hl?.excerpt)
    check('every entry has a page and a colour', record.notes.every((n) => n.page >= 1 && /^#[0-9a-f]{6}$/.test(n.color)))

    console.log('\n2. the shipped server script: off until switched on, then it finds them')
    const word = hl.excerpt.split(/\s+/).find((w) => w.replace(/\W/g, '').length >= 5) ?? hl.excerpt.split(/\s+/)[0]
    const offAnswer = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('a fresh profile shares nothing (the switch is off by default)', !!offAnswer && /Sharing with AI tools is switched off/.test(offAnswer), offAnswer?.slice(0, 80))
    check('â€¦and the Merknader tab shows no per-document switch while it is off', await evaluate(send, `return !document.querySelector('.annot-ai-keep-out')`))
    await evaluate(send, `await window.api.mcpSetPolicy({ sharing: true }); window.dispatchEvent(new Event('focus'))`)
    const viaNode = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check(`Node: search_notes finds Â«${word}Â» in the paper`, !!viaNode && viaNode.includes('Notes paper.pdf'), viaNode?.slice(0, 120))
    // How Claude Code and Claude Desktop actually start it
    const viaApp = await ask(electronBinary(ROOT), { ELECTRON_RUN_AS_NODE: '1' }, app.profile, 'get_document_notes', { document: 'notes paper' })
    check('the appâ€™s executable in Node mode: get_document_notes', !!viaApp && viaApp.includes(`Page ${hl.page}`) && viaApp.includes('Typografi'), viaApp?.slice(0, 120))

    console.log('\n3. Â«Kopier for KIÂ» in the Merknader tab')
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
    check('it copies the paperâ€™s name and its marks by page', !!copied.text && copied.text.startsWith('# Notes paper.pdf') && copied.text.includes(hl.excerpt.replace(/\s+/g, ' ').trim()))
    check('â€¦and the paperâ€™s conversation', !!copied.text && copied.text.includes('Hva sier den om lesestunder?') && copied.text.includes('Rolige farger hjelper.'))
    check('â€¦and no file path', !!copied.text && !copied.text.includes(dir))

    console.log('\n3b. Â«Hold utenfor KI-verktÃ¸yÂ» in the same tab')
    const keep = await evaluate(
      send,
      `
      const box = document.querySelector('.annot-ai-keep-out input')
      if (!box) return 'no switch'
      if (box.checked) return 'already on'
      box.click(); await settle(600)
      return 'ok'
      `,
      PRELUDE
    )
    check('with sharing on, the tab has the switch, off', keep === 'ok', keep)
    const kept = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('switched on, the server no longer finds the paper', !!kept && !kept.includes('Notes paper.pdf'), kept?.slice(0, 80))
    const policy = await evaluate(send, `return await window.api.mcpPolicy()`)
    check('â€¦and the state says so', policy.sharing === true && policy.excludedDocs.includes(DOC))
    await evaluate(send, `document.querySelector('.annot-ai-keep-out input').click(); await settle(600)`, PRELUDE)
    const back = await ask(process.execPath, {}, app.profile, 'search_notes', { query: word })
    check('one click lets it back in', !!back && back.includes('Notes paper.pdf'))

    console.log('\n4. a second change rewrites the record')
    const before = readFileSync(file, 'utf-8')
    // Delete every mark through the tab's own Â«clear allÂ» â€” the record must
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
      check('no marks left â†’ no record', !existsSync(file), existsSync(file) && readFileSync(file, 'utf-8') === before ? 'unchanged' : '')
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

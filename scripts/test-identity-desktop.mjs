// A moved/renamed PDF in the REAL app (issue #46; the rule is
// src/shared/doc-identity.ts, its unit test scripts/test-doc-identity.mjs).
//
// The profile is seeded with what a reader leaves behind under the OLD path
// — a reading position on page 3, a bookmark, a conversation, a pinned
// recents entry, the fingerprint — then the file is renamed into another
// folder and the app launched on the NEW path. What only the real app shows:
// the fingerprint is read from the bytes and reported BEFORE the position is
// looked up (the viewer opens on page 3, not page 1), main moves every record
// in its own stores (state file + userData/chats), the notice names the old
// name, and the assistant's history lists the conversation under the new
// document.
//
// Then the guard: a COPY of a file whose original is still on disk opens as
// a document of its own and takes nothing.
// Needs `npm run build` first. Run: node scripts/test-identity-desktop.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9355
const MAIN = join(ROOT, 'out', 'main', 'index.js')
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const ID0 = 'feedfacecafebeef0123456789abcdef'

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

/** sample.pdf with a trailer /ID (the sample carries none) */
function fixtureBytes() {
  const s = readFileSync(SAMPLE, 'latin1')
  const out = s.replace('<</Size 37/Info 3 0 R/Root 2 0 R>>', `<</Size 37/Info 3 0 R/Root 2 0 R/ID[<${ID0}><${ID0}>]>>`)
  if (out === s) throw new Error('sample.pdf trailer changed — update the fixture')
  return Buffer.from(out, 'latin1')
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const conv = { id: 'moved-1', title: 'Hva er positional encoding?', createdAt: 1, updatedAt: 2,
  messages: [{ role: 'user', text: 'Hva er positional encoding?' }, { role: 'assistant', parts: [{ text: 'Rekkefølgen.', citations: [] }] }] }

const PAGE_STATE = `
  const pageField = [...document.querySelectorAll('input')].find((i) => i.closest('.toolbar, header') && /^\\d+$/.test(i.value));
  const toast = document.querySelector('.app-toast');
  return {
    pages: document.querySelectorAll('.pdf-page').length,
    page: pageField ? Number(pageField.value) : null,
    toast: toast ? toast.textContent : null
  };
`

async function withApp({ args, seed }, body) {
  const app = launchApp({ root: ROOT, mainJs: MAIN, args, port: PORT, prepareProfile: seed })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')
    await body(send, app.profile)
  } finally {
    await app.cleanup()
  }
}

async function run() {
  if (!existsSync(MAIN)) throw new Error('out/main/index.js missing — run npm run build first')
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-identity-'))
  mkdirSync(join(dir, 'inbox'))
  mkdirSync(join(dir, 'papers'))
  const OLD = join(dir, 'inbox', 'paper.pdf')
  const NEW = join(dir, 'papers', 'Vaswani 2017.pdf')
  writeFileSync(OLD, fixtureBytes())

  const seed = (profile) => {
    writeFileSync(join(profile, 'pdfx-state.json'), JSON.stringify({
      recents: [{ path: OLD, name: 'paper.pdf', lastOpened: 1000, pinnedAt: 1000 }],
      positions: { [OLD]: { page: 3, offset: 0, zoom: 1 } },
      bookmarks: { [OLD]: [{ page: 3, title: 'Metode' }] },
      fingerprints: { [OLD]: ID0 }
    }))
    mkdirSync(join(profile, 'chats'))
    writeFileSync(join(profile, 'chats', `${sha1(OLD)}.json`), JSON.stringify({ path: OLD, name: 'paper.pdf', conversations: [conv] }))
  }

  // The move: another folder AND another name
  renameSync(OLD, NEW)

  console.log('\n1. a moved and renamed file opens with its records')
  await withApp({ args: [NEW], seed }, async (send, profile) => {
    const s = await waitFor(() => evaluate(send, PAGE_STATE), (v) => v.pages > 0 && v.page !== null, 'the document to open')
    const shown = await waitFor(() => evaluate(send, PAGE_STATE), (v) => v.page === 3 || v.toast, 'the position or the notice', 8000)
    check('the viewer opened on the page the reader left, not page 1', (await evaluate(send, PAGE_STATE)).page === 3, `page ${s.page}→${shown.page}`)
    const toast = await waitFor(() => evaluate(send, PAGE_STATE), (v) => !!v.toast, 'the notice', 6000).catch(() => ({ toast: null }))
    check('the notice names the old file name', !!toast.toast && toast.toast.includes('paper.pdf'), String(toast.toast))
    const api = await evaluate(send, `
      return {
        pos: await window.api.getPosition(${JSON.stringify(NEW)}),
        oldPos: await window.api.getPosition(${JSON.stringify(OLD)}),
        bookmarks: await window.api.getBookmarks(${JSON.stringify(NEW)}),
        chats: (await window.api.getConversations(${JSON.stringify(NEW)})).map((c) => c.id),
        oldChats: (await window.api.getConversations(${JSON.stringify(OLD)})).length,
        recents: (await window.api.getRecents()).map((r) => ({ path: r.path, pinned: r.pinnedAt !== undefined }))
      }`)
    check('the position is under the new path, gone from the old', api.pos?.page === 3 && api.oldPos === null, JSON.stringify([api.pos, api.oldPos]))
    check('the bookmark followed', api.bookmarks.length === 1 && api.bookmarks[0].title === 'Metode')
    check('the conversation followed', api.chats.join(',') === 'moved-1' && api.oldChats === 0, JSON.stringify(api.chats))
    const oldEntry = api.recents.find((r) => r.path === OLD)
    const newEntry = api.recents.find((r) => r.path === NEW)
    check('the dead recents entry is gone, the pin came along', !oldEntry && !!newEntry?.pinned, JSON.stringify(api.recents))
    check('the old conversation file is gone from userData/chats', !existsSync(join(profile, 'chats', `${sha1(OLD)}.json`)))
    check('a conversation file exists for the new path', existsSync(join(profile, 'chats', `${sha1(NEW)}.json`)))
    const state = JSON.parse(readFileSync(join(profile, 'pdfx-state.json'), 'utf-8'))
    check('the fingerprint map holds the new path only', state.fingerprints?.[NEW] === ID0 && !(OLD in (state.fingerprints ?? {})), JSON.stringify(state.fingerprints))
  })

  console.log('\n2. a copy of a file that is still there takes nothing')
  const ORIG = join(dir, 'papers', 'original.pdf')
  const COPY = join(dir, 'papers', 'original - Copy.pdf')
  writeFileSync(ORIG, fixtureBytes())
  copyFileSync(ORIG, COPY)
  await withApp({
    args: [COPY],
    seed: (profile) => {
      writeFileSync(join(profile, 'pdfx-state.json'), JSON.stringify({
        recents: [{ path: ORIG, name: 'original.pdf', lastOpened: 1000 }],
        positions: { [ORIG]: { page: 4, offset: 0, zoom: 1 } },
        fingerprints: { [ORIG]: ID0 }
      }))
    }
  }, async (send) => {
    await waitFor(() => evaluate(send, PAGE_STATE), (v) => v.pages > 0 && v.page !== null, 'the copy to open')
    await sleep(1500)
    const s = await evaluate(send, PAGE_STATE)
    check('the copy opens at page 1 with no notice', s.page === 1 && !s.toast, JSON.stringify(s))
    const pos = await evaluate(send, `return await window.api.getPosition(${JSON.stringify(ORIG)})`)
    check('the original keeps its position', pos?.page === 4, JSON.stringify(pos))
  })
}

run()
  .catch((err) => {
    console.error(err)
    failures++
  })
  .finally(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall passed')
    process.exit(failures ? 1 : 0)
  })

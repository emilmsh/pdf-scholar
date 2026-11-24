// «Les sammen» (Emil, 2026-11-24): an AI tool outside the app pointing at a
// passage in the RUNNING app, reading a document's text as the app reads it,
// and asking what the reader has open — the contract (src/shared/
// tool-bridge.ts), the rules and the pipe (src/main/tool-bridge-core.ts), the
// store of what was pointed at (src/main/tool-sessions.ts) and the MCP
// server's three tools over them (src/main/mcp-server.ts), end to end over a
// REAL pipe with a fake window behind it.
//
// What would go wrong silently without these: a document the reader keeps
// out — or a password-protected one — shown or read on a tool's word; the
// path and selection of such a document told to a tool that asks what is
// open; a tool whose switch is off, or any program that guesses the pipe's
// name, answered; the switch turned off and a running session still served;
// a reference lost because two arrived at once; a claim reported as found
// when only its first words were; a stored list with junk in it crashing the
// panel; and a page of text cut in two by the answer's cap, so that the quote
// taken from it can never be found.
// Run: node scripts/test-tool-bridge.mjs
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const src = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url))
const buildDir = mkdtempSync(join(tmpdir(), 'tool-bridge-build-'))
const bundle = async (entry, name) => {
  const outfile = join(buildDir, name)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const T = await bundle(src('shared/tool-bridge.ts'), 'tool-bridge.mjs')
const M = await bundle(src('shared/mcp.ts'), 'mcp.mjs')
const C = await bundle(src('main/tool-bridge-core.ts'), 'core.mjs')
const { createToolSessionStore } = await bundle(src('main/tool-sessions.ts'), 'sessions.mjs')
const { createMcpServer } = await bundle(src('main/mcp-server.ts'), 'server.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** A path as this platform spells an absolute one: the rules ask the
 *  platform's own `isAbsolute`, so «C:/papers/a.pdf» is a path on Windows
 *  and «/papers/a.pdf» everywhere else. Backslashes only where they are
 *  separators. */
const WIN = process.platform === 'win32'
const W = (path) => (WIN ? path : path.replace(/^[cC]:/, '').replace(/\\/g, '/'))

const TOKEN = 'a'.repeat(64)
const SESSION = { id: 'abcdef0123456789', client: 'claude', startedAt: 1_700_000_000_000 }
const envelope = (request, over = {}) => ({ token: TOKEN, session: SESSION, request, ...over })

console.log('\n1. the pipe’s name')
{
  // The platform is passed in here, so these stay Windows paths on every OS
  const a = T.bridgePipePath('C:\\Users\\x\\AppData\\Roaming\\PDF Scholar', 'win32')
  check('a named pipe on Windows — no file, no port', a.startsWith('\\\\.\\pipe\\pdf-scholar-bridge-'))
  check('the same folder with the other slash and case is the same pipe', a === T.bridgePipePath('c:/users/x/appdata/roaming/pdf scholar/', 'win32'))
  check('another userData folder is another pipe', a !== T.bridgePipePath('C:\\portable\\data', 'win32'))
  const deep = `/home/${'x'.repeat(90)}/.config/PDF Scholar`
  check('a profile folder too deep for a socket path gets one in /tmp, under its own name', /^\/tmp\/pdf-scholar-bridge-[0-9a-f]{16}\.sock$/.test(T.bridgePipePath(deep, 'linux')) && T.bridgePipePath(deep, 'linux') === T.bridgePipePath(deep, 'darwin') && T.bridgePipePath(deep, 'linux') !== T.bridgePipePath(deep + '2', 'linux'))
  check('a socket file inside userData elsewhere', T.bridgePipePath('/home/x/.config/PDF Scholar/', 'linux') === '/home/x/.config/PDF Scholar/tool-bridge.sock')
}

console.log('\n2. a request off the pipe is untrusted input')
{
  const ok = T.sanitizeBridgeEnvelope(envelope({ op: 'cite', path: ' C:\\p\\a.pdf ', page: 6.9, quote: '  some words  ', claim: 'x', topic: 't', show: 'yes' }))
  check('a citation: path trimmed, page whole, show on unless exactly false', ok?.request.path === 'C:\\p\\a.pdf' && ok.request.page === 6 && ok.request.quote === 'some words' && ok.request.show === true)
  check('show: false is only listed', T.sanitizeBridgeRequest({ op: 'cite', path: '/a.pdf', page: 1, quote: 'q', show: false }).show === false)
  check('no quote, no page, no path → not a request', [{ op: 'cite', path: '/a.pdf', page: 1, quote: ' ' }, { op: 'cite', path: '/a.pdf', page: 0, quote: 'q' }, { op: 'cite', path: '', page: 1, quote: 'q' }, { op: 'cite', path: 7, page: 1, quote: 'q' }].every((r) => T.sanitizeBridgeRequest(r) === null))
  const long = T.sanitizeBridgeRequest({ op: 'cite', path: '/a.pdf', page: 1, quote: 'q'.repeat(9000), claim: 'c'.repeat(9000), topic: 't'.repeat(900) })
  check('a runaway quote, claim and topic are cut to their caps', long.quote.length === T.MAX_QUOTE && long.claim.length === T.MAX_CLAIM && long.topic.length === T.MAX_TOPIC)
  const dirty = T.sanitizeBridgeRequest({ op: 'cite', path: '/a.pdf', page: 1, quote: 'a\u0000b\u202ec\u0007d' })
  check('control and bidi characters are dropped from what is kept and shown', dirty.quote === 'abcd')
  check('a path with a NUL, or a runaway one, is refused', T.sanitizeBridgeRequest({ op: 'read', path: '/a\u0000.pdf' }) === null && T.sanitizeBridgeRequest({ op: 'read', path: 'x'.repeat(5000) }) === null)
  const read = T.sanitizeBridgeRequest({ op: 'read', path: '/a.pdf', from: 3, to: 99999 })
  check('a read spans at most MAX_READ_PAGES', read.from === 3 && read.to === 3 + T.MAX_READ_PAGES - 1)
  check('a read with no range is the first page on', T.sanitizeBridgeRequest({ op: 'read', path: '/a.pdf' }).from === 1)
  check('an unknown op is nothing', T.sanitizeBridgeRequest({ op: 'quit' }) === null && T.sanitizeBridgeRequest('quit') === null)
  check('no token, a short one, no session, an odd client → nothing', [envelope({ op: 'ping' }, { token: undefined }), envelope({ op: 'ping' }, { token: 'short' }), envelope({ op: 'ping' }, { session: null }), envelope({ op: 'ping' }, { session: { ...SESSION, client: 'cursor' } }), envelope({ op: 'ping' }, { session: { ...SESSION, id: '../../x' } })].every((e) => T.sanitizeBridgeEnvelope(e) === null))
}

console.log('\n3. a stored session is untrusted input')
{
  const ref = (id, over = {}) => ({ kind: 'reference', id, at: 10, docPath: '/p/a.pdf', docName: 'a.pdf', page: 2, quote: 'words', found: true, whole: true, ...over })
  const s = T.sanitizeToolSession({
    ...SESSION,
    title: '  Minimum wages  ',
    updatedAt: 3,
    entries: [
      ref('ent1'),
      ref('ent1', { quote: 'a second with the same id' }),
      ref('ent2', { found: false, whole: true }),
      { kind: 'read', id: 'ent3', at: 11, docPath: '/p/a.pdf', docName: 'a.pdf', from: 1, to: 15 },
      { kind: 'read', id: 'ent4', at: 11, docPath: '/p/a.pdf', docName: 'a.pdf', from: 9, to: 2 },
      { kind: 'context', id: 'ent5', at: 12, selection: true },
      { kind: 'context', id: 'ent6', at: 13, docPath: '/p/a.pdf', docName: 'a.pdf', selection: 'yes' },
      { kind: 'delete-everything', id: 'ent7', at: 14 },
      ref('ent8', { page: 'six' }),
      'junk',
      null
    ]
  })
  check('an id twice keeps its first; junk, an unknown kind, a backwards range and a non-page are dropped', s.entries.map((e) => e.id).join() === 'ent1,ent2,ent3,ent5,ent6')
  check('«whole» cannot be true of a quote that was not found', s.entries[1].found === false && s.entries[1].whole === false)
  check('a context entry with no document keeps none; selection only when exactly true', s.entries[3].docPath === undefined && s.entries[3].selection === true && s.entries[4].selection === false)
  check('the title is tidied, and updatedAt is never before the last entry', s.title === 'Minimum wages' && s.updatedAt === 13)
  check('a session with nothing readable in it is nothing', T.sanitizeToolSession({ ...SESSION, entries: ['x'] }) === null && T.sanitizeToolSession('x') === null && T.sanitizeToolSession({ entries: [ref('ent1')] }) === null)
  const many = T.sanitizeToolSession({ ...SESSION, entries: Array.from({ length: T.MAX_SESSION_ENTRIES + 50 }, (_, i) => ref(`e${i}xx`, { at: i + 1 })) })
  check('a list past the cap keeps the newest', many.entries.length === T.MAX_SESSION_ENTRIES && many.entries[0].id === 'e50xx')
  let grown = T.withToolEntry(null, SESSION, ref('new1'), 'First topic')
  grown = T.withToolEntry(grown, SESSION, ref('new2', { at: 20 }), 'A later topic')
  check('the first topic names the session; a later one does not rename it', grown.title === 'First topic' && grown.entries.length === 2 && grown.updatedAt === 20)
  check('no topic at first, one later: the later one names it', T.withToolEntry(T.withToolEntry(null, SESSION, ref('new1')), SESSION, ref('new2'), 'Named late').title === 'Named late')
  const meta = T.toolSessionMeta(T.sanitizeToolSession({ ...SESSION, entries: [ref('ent1'), ref('ent2', { docPath: '/p/b.pdf', docName: 'b.pdf' }), { kind: 'read', id: 'ent3', at: 11, docPath: '/p/c.pdf', docName: 'c.pdf', from: 1, to: 2 }] }))
  check('a row counts references, and the documents they point into (a read is not one)', meta.references === 2 && meta.documents.join() === '/p/a.pdf,/p/b.pdf' && !('entries' in meta))
}

console.log('\n4. the store: one file per session')
const dataDir = mkdtempSync(join(tmpdir(), 'tool-bridge-data-'))
{
  const dir = join(dataDir, 'tool-sessions')
  const store = createToolSessionStore(dir)
  const ref = (id, at) => ({ kind: 'reference', id, at, docPath: '/p/a.pdf', docName: 'a.pdf', page: 1, quote: 'q', found: true, whole: true })
  check('an empty store lists nothing', (await store.all()).length === 0 && (await store.get(SESSION.id)) === null)
  // Two at once: the second must not be written over the first
  await Promise.all([store.append(SESSION, ref('ref1', 1), 'Topic'), store.append(SESSION, ref('ref2', 2)), store.append(SESSION, ref('ref3', 3))])
  const got = await store.get(SESSION.id)
  check('three appended at once are all kept, in order', got.entries.map((e) => e.id).join() === 'ref1,ref2,ref3' && got.title === 'Topic')
  check('…in one file named by the session, and no temp file left', readdirSync(dir).join() === `${SESSION.id}.json`)
  const other = { ...SESSION, id: '00ff00ff00ff00ff' }
  await store.append(other, ref('oth1', 99))
  check('sessions list with the one last added to first', (await store.all()).map((s) => s.id).join() === `${other.id},${SESSION.id}`)
  writeFileSync(join(dir, 'deadbeefdeadbeef.json'), '{ not json')
  check('a file that no longer parses reads as nothing, and is left', (await store.all()).length === 2 && existsSync(join(dir, 'deadbeefdeadbeef.json')))
  writeFileSync(join(dir, 'cafecafecafecafe.json'), JSON.stringify({ ...SESSION, entries: [ref('xxx1', 5)] }))
  check('a file naming another session is not that session', (await store.get('cafecafecafecafe')) === null)
  check('an id that is not one touches no file', (await store.get('../pdfx-state')) === null)
  await store.remove(other.id)
  check('removing deletes exactly that session', !existsSync(join(dir, `${other.id}.json`)) && (await store.get(SESSION.id)) !== null)
}

// ---------- the rules, with a fake window behind them ----------

const POLICY_ON = () => M.sanitizeMcpPolicy({ clients: { claude: true, codex: false, other: false }, live: true, excludedDocs: [W('C:/kept/secret.pdf')], excludedFolders: [W('C:/clients')] })
const PAGES = [
  'Minimum wages and employment. We study the effect of a rise in the minimum wage.',
  'The dominant view holds that employment falls. We find no such effect in fast food.',
  'Robustness. The result survives every specification we tried.'
]

function world(over = {}) {
  const calls = []
  const changes = []
  const store = createToolSessionStore(join(mkdtempSync(join(tmpdir(), 'tool-bridge-world-')), 'tool-sessions'))
  let policy = POLICY_ON()
  let seq = 0
  let raised = 0
  const w = {
    calls,
    changes,
    store,
    setPolicy: (p) => (policy = p),
    raised: () => raised,
    open: { path: W('C:/papers/card.pdf'), name: 'card.pdf', page: 2, pageCount: 3, selection: 'employment falls', locked: false },
    held: new Set([W('c:/papers/card.pdf')]),
    locked: new Set(),
    files: new Map([[W('C:/papers/unopened.pdf'), new Uint8Array([37, 80, 68, 70])]])
  }
  const deps = {
    token: TOKEN,
    version: '9.9.9',
    foldCase: true,
    policy: () => policy,
    store,
    canonical: (p) => p.replace(/\\/g, '/'),
    isLocked: (p) => w.locked.has(p),
    holds: async (p) => w.held.has(p.toLowerCase()),
    readBytes: async (p) => w.files.get(p) ?? 'unreadable',
    isPdf: async (p) => w.files.has(p),
    view: async (req) => {
      calls.push(req)
      if (req.op === 'context') return { ok: true, op: 'context', open: w.open }
      if (req.op === 'read') {
        return { ok: true, op: 'read', pageCount: PAGES.length, hasText: true, pages: PAGES.slice(req.from - 1, req.to).map((text, i) => ({ page: req.from + i, text })) }
      }
      // The window's own rule is the renderer's (resolveQuote); here: a quote
      // is found where a page holds it, whole only when all of it is there
      const at = PAGES.findIndex((p) => p.includes(req.quote))
      const part = PAGES.findIndex((p) => p.includes(req.quote.slice(0, 20)))
      return { ok: true, op: 'cite', found: at > -1 || part > -1, whole: at > -1, page: (at > -1 ? at : part > -1 ? part : req.page - 1) + 1, pageCount: PAGES.length, hasText: true }
    },
    raise: () => raised++,
    changed: (session, entry, shown) => changes.push({ session: session.id, kind: entry.kind, shown }),
    now: () => 1_700_000_000_000 + ++seq,
    newId: () => `id${String(++seq).padStart(6, '0')}`,
    ...over
  }
  w.handle = C.createBridgeHandler(deps)
  w.ask = (request, env = {}) => w.handle(JSON.stringify(envelope(request, env)))
  return w
}

console.log('\n5. who is answered at all')
{
  const w = world()
  check('a line that is not JSON, and one that is not a request', (await w.handle('{ nope')).error === 'bad-request' && (await w.handle(JSON.stringify({ op: 'ping' }))).error === 'bad-request')
  check('the wrong token is refused — also one of the wrong length', (await w.ask({ op: 'ping' }, { token: 'b'.repeat(64) })).error === 'bad-token' && (await w.ask({ op: 'ping' }, { token: 'a'.repeat(63) })).error === 'bad-token')
  check('the right one is answered', (await w.ask({ op: 'ping' })).version === '9.9.9')
  check('a tool whose own switch is off is refused, whatever «Les sammen» says', (await w.ask({ op: 'ping' }, { session: { ...SESSION, client: 'codex' } })).error === 'client-off')
  w.setPolicy({ ...POLICY_ON(), live: false })
  check('«Les sammen» off: refused — even a ping', (await w.ask({ op: 'ping' })).error === 'bridge-off' && (await w.ask({ op: 'context' })).error === 'bridge-off')
  check('…and no window was asked anything', w.calls.length === 0)
  check('a stored policy with no `live` is off; only exactly true is on', M.sanitizeMcpPolicy({ clients: { claude: true } }).live === false && M.sanitizeMcpPolicy({ live: 1 }).live === false && M.sanitizeMcpPolicy({ live: true }).live === true && M.DEFAULT_MCP_POLICY.live === false)
}

console.log('\n6. a passage: shown, kept, and told whether it is there')
{
  const w = world()
  const r = await w.ask({ op: 'cite', path: W('C:\\papers\\card.pdf'), page: 2, quote: 'We find no such effect in fast food.', claim: 'The paper finds no employment effect', topic: 'Minimum wages', show: true })
  check('found word for word, on its page, and shown', r.ok && r.found && r.whole && r.page === 2 && r.citedPage === 2 && r.shown === true)
  check('the window was asked with the path the app knows the document by', w.calls[0].op === 'cite' && w.calls[0].path === W('C:/papers/card.pdf') && w.calls[0].bytes === undefined)
  check('…and brought up once', w.raised() === 1)
  const kept = await w.store.get(SESSION.id)
  check('the reference is kept: claim, quote, page, document, found', kept.title === 'Minimum wages' && kept.entries.length === 1 && kept.entries[0].claim === 'The paper finds no employment effect' && kept.entries[0].docName === 'card.pdf' && kept.entries[0].page === 2 && kept.entries[0].found)
  check('…and the windows are told, with «shown»', w.changes.length === 1 && w.changes[0].kind === 'reference' && w.changes[0].shown === true)

  const wrongPage = await w.ask({ op: 'cite', path: W('C:/papers/card.pdf'), page: 1, quote: 'The result survives every specification we tried.', show: false })
  check('cited on the wrong page: found where it is, and both pages told', wrongPage.found && wrongPage.page === 3 && wrongPage.citedPage === 1)
  check('show: false keeps the reference and leaves the window where it is', wrongPage.shown === false && w.raised() === 1 && (await w.store.get(SESSION.id)).entries.length === 2)

  const part = await w.ask({ op: 'cite', path: W('C:/papers/card.pdf'), page: 2, quote: 'The dominant view holds that wages are too low.', show: false })
  check('only its first words are there: found, but NOT whole', part.found && !part.whole)
  const none = await w.ask({ op: 'cite', path: W('C:/papers/card.pdf'), page: 2, quote: 'Unemployment tripled within a year.', show: true })
  check('not in the document: not found — and still shown (the page) and kept, marked', none.ok && !none.found && !none.whole && none.shown && (await w.store.get(SESSION.id)).entries.at(-1).found === false)
}

console.log('\n7. a document no tab holds')
{
  const w = world()
  const listed = await w.ask({ op: 'cite', path: W('C:/papers/unopened.pdf'), page: 1, quote: 'Minimum wages and employment.', show: false })
  check('only listed: resolved from the file’s bytes, no tab', listed.ok && w.calls[0].bytes instanceof Uint8Array && w.raised() === 0)
  const shown = await w.ask({ op: 'cite', path: W('C:/papers/unopened.pdf'), page: 1, quote: 'Minimum wages and employment.', show: true })
  check('shown: the window opens it itself — no bytes are read for it', shown.ok && w.calls[1].bytes === undefined && w.raised() === 1)
  check('a file that is not there, or not a PDF', (await w.ask({ op: 'cite', path: W('C:/papers/gone.pdf'), page: 1, quote: 'q', show: false })).error === 'unreadable')
  check('one that does not begin as a PDF is not opened on a tool’s word: answered, no window asked', (await w.ask({ op: 'cite', path: W('C:/papers/notes.txt'), page: 1, quote: 'q', show: true })).error === 'unreadable' && w.calls.length === 2)
  const big = world({ readBytes: async () => 'too-large' })
  check('one too large to read unopened says so', (await big.ask({ op: 'read', path: W('C:/papers/huge.pdf'), from: 1, to: 2 })).error === 'too-large' && big.calls.length === 0)
  const gone = world({ view: async () => ({ ok: false, error: 'no-window' }) })
  check('no window answers: named, nothing kept', (await gone.ask({ op: 'cite', path: W('C:/papers/card.pdf'), page: 1, quote: 'q', show: true })).error === 'no-window' && (await gone.store.all()).length === 0 && gone.raised() === 0)
}

console.log('\n7b. which paths a tool may name')
{
  const w = world()
  check('a relative path is refused — relative to what?', (await w.ask({ op: 'read', path: 'papers/card.pdf', from: 1, to: 1 })).error === 'unreadable' && (await w.ask({ op: 'cite', path: '..\\card.pdf', page: 1, quote: 'q', show: true })).error === 'unreadable')
  const unc = '//fileserver/share/paper.pdf'
  w.files.set(unc, new Uint8Array([37, 80, 68, 70]))
  check('a path on another machine is not followed on a tool’s word — shown, listed or read', (!WIN || (await w.ask({ op: 'cite', path: '\\\\fileserver\\share\\paper.pdf', page: 1, quote: 'q', show: true })).error === 'not-local') && (await w.ask({ op: 'cite', path: unc, page: 1, quote: 'q', show: true })).error === 'not-local' && (await w.ask({ op: 'cite', path: unc, page: 1, quote: 'q', show: false })).error === 'not-local' && (await w.ask({ op: 'read', path: unc, from: 1, to: 1 })).error === 'not-local')
  check('…and nothing was asked of a window or read from it', w.calls.length === 0 && (await w.store.all()).length === 0)
  w.held.add(unc)
  check('one the reader has OPEN themselves is answered', (await w.ask({ op: 'read', path: unc, from: 1, to: 1 })).ok === true)
  check('the long-path spelling of a local file is local', C.isRemotePath('\\\\?\\C:\\papers\\a.pdf') === false && C.isRemotePath('\\\\server\\share\\a.pdf') === true && C.isRemotePath(W('C:\\papers\\a.pdf')) === false && C.isRemotePath('/home/x/a.pdf') === false)
}

console.log('\n8. what is kept out, and what is locked')
{
  const w = world()
  check('a document kept out is neither shown nor read', (await w.ask({ op: 'cite', path: W('C:\\kept\\secret.pdf'), page: 1, quote: 'q', show: true })).error === 'kept-out' && (await w.ask({ op: 'read', path: W('c:/KEPT/SECRET.pdf'), from: 1, to: 1 })).error === 'kept-out')
  check('…nor one under a folder kept out — and «C:/clientsOld» is not under «C:/clients»', (await w.ask({ op: 'read', path: W('C:/clients/acme/offer.pdf'), from: 1, to: 1 })).error === 'kept-out' && (await w.ask({ op: 'read', path: W('C:/clientsOld/x.pdf'), from: 1, to: 1 })).error === 'unreadable')
  w.locked.add(W('C:/papers/locked.pdf'))
  check('a document the app holds a password for is refused', (await w.ask({ op: 'cite', path: W('C:/papers/locked.pdf'), page: 1, quote: 'q', show: true })).error === 'locked')
  check('…and for none of these was a window asked, a file read or a list written', w.calls.length === 0 && (await w.store.all()).length === 0 && w.raised() === 0)
  const prompt = world({ view: async () => ({ ok: false, error: 'locked' }) })
  check('one the WINDOW finds locked (not unlocked here yet) is refused the same', (await prompt.ask({ op: 'read', path: W('C:/papers/card.pdf'), from: 1, to: 1 })).error === 'locked' && (await prompt.store.all()).length === 0)
}

console.log('\n9. reading, and what the reader has open')
{
  const w = world()
  const r = await w.ask({ op: 'read', path: W('C:/papers/card.pdf'), from: 2, to: 3 })
  check('the pages asked for, as the window gave them', r.ok && r.pageCount === 3 && r.pages.map((p) => p.page).join() === '2,3' && r.pages[0].text === PAGES[1])
  const kept = await w.store.get(SESSION.id)
  check('a read is listed too — what left, not only what was shown', kept.entries[0].kind === 'read' && kept.entries[0].from === 2 && kept.entries[0].to === 3 && w.raised() === 0)
  const c = await w.ask({ op: 'context' })
  check('what is open: path, page, selection', c.ok && c.open.path === W('C:/papers/card.pdf') && c.open.page === 2 && c.open.selection === 'employment falls' && !('locked' in c.open))
  check('…listed as «read your selection»', (await w.store.get(SESSION.id)).entries.at(-1).kind === 'context' && (await w.store.get(SESSION.id)).entries.at(-1).selection === true)
  w.open = { ...w.open, selection: 's'.repeat(20000) }
  check('a runaway selection is cut', (await w.ask({ op: 'context' })).open.selection.length === T.MAX_SELECTION)
  w.open = { path: W('C:/kept/secret.pdf'), name: 'secret.pdf', page: 4, pageCount: 9, selection: 'the secret', locked: false }
  const withheld = await w.ask({ op: 'context' })
  check('a document kept out is open: the tool learns that much and nothing else', withheld.ok && withheld.open.withheld === true && !JSON.stringify(withheld).includes('secret'))
  const entry = (await w.store.get(SESSION.id)).entries.at(-1)
  check('…and the list does not name it either', entry.kind === 'context' && entry.docPath === undefined && entry.selection === false)
  w.open = { path: W('C:/papers/pw.pdf'), name: 'pw.pdf', page: 1, pageCount: 2, selection: 'x', locked: true }
  check('a locked one the same', (await w.ask({ op: 'context' })).open.withheld === true)
  w.open = null
  check('nothing in front', (await w.ask({ op: 'context' })).open === null)
  const none = world({ view: async () => ({ ok: false, error: 'no-window' }) })
  check('no window at all is «nothing in front», not an error', (await none.ask({ op: 'context' })).open === null)
}

// ---------- the MCP server's three tools, over a REAL pipe ----------

console.log('\n10. the server’s tools, over the pipe')
{
  const serverData = mkdtempSync(join(tmpdir(), 'tool-bridge-server-'))
  mkdirSync(serverData, { recursive: true })
  const setState = (mcp) => writeFileSync(join(serverData, 'pdfx-state.json'), JSON.stringify({ mcp }))
  const ON = { clients: { claude: true, codex: false, other: false }, live: true, excludedDocs: [W('C:/kept/secret.pdf')] }
  setState(ON)
  const w = world({ policy: () => M.sanitizeMcpPolicy(JSON.parse(readFileSync(join(serverData, 'pdfx-state.json'), 'utf-8')).mcp) })
  const pipe = T.bridgePipePath(serverData, process.platform)
  let lines = 0
  const listening = await C.listenBridge(pipe, (line) => (lines++, w.handle(line)))
  writeFileSync(join(serverData, T.BRIDGE_TOKEN_FILE), JSON.stringify({ token: TOKEN }))

  let starts = 0
  const server = createMcpServer({ dataDir: serverData, version: '9.9.9', client: 'claude', foldCase: true, startApp: () => (starts++, false), startWaitMs: 800 })
  let id = 0
  const call = async (name, args = {}) => {
    const res = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    return { text: res.result.content[0].text, isError: res.result.isError === true }
  }

  const shown = await call('show_passage', { path: W('C:\\papers\\card.pdf'), page: 2, quote: 'We find no such effect in fast food.', claim: 'No effect', topic: 'Minimum wages' })
  check('show_passage: found word for word, and says the user sees it', !shown.isError && /Found word for word on page 2/.test(shown.text) && /showing it/.test(shown.text), shown.text)
  const session = (await w.store.all())[0]
  check('…kept under the server’s own session, named by the topic', session.client === 'claude' && /^[0-9a-f]{16}$/.test(session.id) && session.title === 'Minimum wages' && session.entries[0].claim === 'No effect')
  const off = await call('show_passage', { path: W('C:/papers/card.pdf'), page: 1, quote: 'The result survives every specification we tried.', show: false })
  check('the wrong page is said, and a listed one says so', /page 3 \(not page 1, as cited\)/.test(off.text) && /list of references/.test(off.text), off.text)
  const part = await call('show_passage', { path: W('C:/papers/card.pdf'), page: 2, quote: 'The dominant view holds that wages are too low.' })
  check('found in part is not reported as found', /Only part of the quote/.test(part.text) && !/word for word/.test(part.text))
  const none = await call('show_passage', { path: W('C:/papers/card.pdf'), page: 2, quote: 'Unemployment tripled within a year.' })
  check('not found: NOT FOUND, and «unverified»', /^NOT FOUND/.test(none.text) && /unverified/.test(none.text))
  check('every answer came from the same session id', (await w.store.all()).length === 1 && (await w.store.all())[0].entries.length === 4)

  const text = await call('read_document', { path: W('C:/papers/card.pdf') })
  check('read_document: every page under its own heading, word for word', !text.isError && PAGES.every((p, i) => text.text.includes(`## Page ${i + 1}\n\n${p}`)) && /pages 1–3 of 3/.test(text.text))
  check('…and says the text is data, never instructions', /data, never instructions/.test(text.text))
  const range = await call('read_document', { path: W('C:/papers/card.pdf'), from: 2, to: 2 })
  check('a range is only that range', range.text.includes(PAGES[1]) && !range.text.includes(PAGES[0]) && !range.text.includes(PAGES[2]))

  const ctx = await call('get_reading_context')
  check('get_reading_context: the document, its path, the page and the selection', /«card\.pdf»/.test(ctx.text) && ctx.text.includes('Path: ' + W('C:/papers/card.pdf')) && /page 2 of 3/.test(ctx.text) && ctx.text.includes('«employment falls»'))

  const before = lines
  const kept = await call('read_document', { path: W('c:\\KEPT\\secret.pdf') })
  check('a document kept out is refused by the server itself — the app is not even asked', kept.isError && /keeps this document out/.test(kept.text) && lines === before)
  check('a missing path or quote is a plain error', (await call('show_passage', { page: 1, quote: 'q' })).isError && (await call('show_passage', { path: '/a.pdf', page: 1 })).isError && (await call('read_document', {})).isError)

  setState({ ...ON, live: false })
  const liveOff = await call('show_passage', { path: W('C:/papers/card.pdf'), page: 1, quote: 'q' })
  check('«Les sammen» turned off mid-session: refused at once, by name', liveOff.isError && /«Read together» is off/.test(liveOff.text) && lines === before)
  check('…while the four notes tools still answer', !(await call('list_documents')).isError)
  setState({ ...ON, clients: { claude: false, codex: false, other: false } })
  check('the tool’s own switch off: everything refused', (await call('get_reading_context')).isError && (await call('list_documents')).isError)
  setState(ON)

  // A server that lies about the switches (a program anyone could write) is
  // still refused by the app
  w.setPolicy?.(null)
  const direct = await C.bridgeCall(pipe, { token: 'c'.repeat(64), session: SESSION, request: { op: 'context' } }, 3000)
  check('the pipe itself refuses a caller without the token', direct.ok === false && direct.error === 'bad-token')

  // The answer's cap falls BETWEEN pages
  const longPages = Array.from({ length: 6 }, (_, i) => `PAGE${i + 1} ` + 'word '.repeat(5000))
  const bigWorld = world({
    view: async (req) => ({ ok: true, op: 'read', pageCount: 6, hasText: true, pages: longPages.slice(req.from - 1, req.to).map((t, i) => ({ page: req.from + i, text: t })) })
  })
  await new Promise((done) => listening.close(done))
  const listening2 = await C.listenBridge(pipe, (line) => bigWorld.handle(line))
  const first = await call('read_document', { path: W('C:/papers/card.pdf') })
  const lastWhole = Number(/pages 1–(\d+) of 6/.exec(first.text)?.[1])
  check('a long document comes in whole pages, and says where to go on', lastWhole >= 1 && lastWhole < 6 && first.text.includes(`from: ${lastWhole + 1}`) && first.text.trimEnd().endsWith('word') && !first.text.includes(`PAGE${lastWhole + 1}`), `stopped after page ${lastWhole}`)
  const rest = await call('read_document', { path: W('C:/papers/card.pdf'), from: lastWhole + 1 })
  check('…and the next call starts there', rest.text.includes(`## Page ${lastWhole + 1}\n\nPAGE${lastWhole + 1}`))

  // No app at all
  await new Promise((done) => listening2.close(done))
  const t0 = Date.now()
  const dead = await call('get_reading_context')
  check('no app listening: the server tries to start it once, then says so by name', dead.isError && /not running and could not be started/.test(dead.text) && starts === 1, `${Date.now() - t0} ms`)
  await call('get_reading_context')
  check('…and does not try again in the same session', starts === 1)

  // An app that comes up after being started
  let listening3 = null
  const server2 = createMcpServer({
    dataDir: serverData,
    version: '9.9.9',
    client: 'claude',
    foldCase: true,
    startWaitMs: 8000,
    startApp: () => {
      setTimeout(() => void C.listenBridge(pipe, (line) => w.handle(line)).then((s) => (listening3 = s)), 600)
      return true
    }
  })
  const res = await server2.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_reading_context', arguments: {} } })
  check('an app that was not running is started, waited for, and then asked', res.result.isError !== true && /card\.pdf/.test(res.result.content[0].text))
  if (listening3) await new Promise((done) => listening3.close(done))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

// The AI conversation history (issue #46): the rules in
// src/shared/chat-history.ts and desktop's file store,
// src/main/chat-history.ts, against a temp folder.
//
// What would go wrong silently without these: a hand-edited or version-skewed
// file throwing the whole history away (or the panel); two windows writing
// one document and one losing the other's conversation (the merge, and the
// write queue on Windows, where a rename onto a file mid-rename fails with
// EPERM); a search that misses «Økonomi» for «økonomi» or reads a typed «(5)»
// as a regex; a snippet cut mid-word or without the hit in it; an empty list
// leaving a file behind; and a corrupt file being overwritten with nothing
// instead of left for the next write to replace.
// Run: node scripts/test-chat-history.mjs
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SHARED = fileURLToPath(new URL('../src/shared/chat-history.ts', import.meta.url))
const STORE = fileURLToPath(new URL('../src/main/chat-history.ts', import.meta.url))
const buildDir = mkdtempSync(join(tmpdir(), 'chat-history-build-'))
const bundle = async (entry, name) => {
  const outfile = join(buildDir, name)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const H = await bundle(SHARED, 'shared.mjs')
const { createChatHistoryStore } = await bundle(STORE, 'store.mjs')
const L = await bundle(fileURLToPath(new URL('../src/shared/chat-library.ts', import.meta.url)), 'library.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const user = (text, extra = {}) => ({ role: 'user', text, ...extra })
const answer = (text) => ({ role: 'assistant', parts: [{ text, citations: [] }] })
const conv = (id, updatedAt, messages = [user('q'), answer('a')], extra = {}) => ({
  id,
  title: `Title ${id}`,
  createdAt: updatedAt - 10,
  updatedAt,
  messages,
  ...extra
})

console.log('\n1. a stored list is untrusted input')
{
  const list = H.sanitizeConversations([
    conv('a', 100),
    null,
    'junk',
    { id: 'b', title: 'no updatedAt', messages: [] },
    { id: 'c', title: 'no createdAt', updatedAt: 300, messages: [user('x'), { role: 'robot' }, 7, answer('y')] },
    { id: '', title: 'empty id', updatedAt: 50, messages: [] },
    { id: 'a', title: 'older twin', updatedAt: 90, messages: [] },
    { id: 'd', title: 5, updatedAt: 20, messages: [] },
    { id: 'e', title: 'messages not a list', updatedAt: 20, messages: 'no' }
  ])
  check('junk dropped, newest first', list.map((c) => c.id).join(',') === 'c,a', list.map((c) => c.id).join(','))
  check('a missing createdAt reads as updatedAt', list[0].createdAt === 300)
  check('junk messages dropped, the readable ones kept', list[0].messages.length === 2)
  check('an id twice keeps the newest record', list[1].updatedAt === 100 && list[1].title === 'Title a')
  check('not a list → []', H.sanitizeConversations({ a: 1 }).length === 0 && H.sanitizeConversations(null).length === 0)
  const many = H.sanitizeConversations(Array.from({ length: 3000 }, (_, i) => conv(`c${i}`, i)))
  check('a garbage-sized list is bounded', many.length === H.MAX_CONVERSATIONS_PER_DOC, String(many.length))
}

console.log('\n2. the document name a store entry gets')
{
  check('a Windows path → its file name', H.docNameFromPath('C:\\Users\\e\\paper (1).pdf') === 'paper (1).pdf')
  check('a URL → its last segment, decoded', H.docNameFromPath('https://x.org/a/My%20paper.pdf?dl=1#p=3') === 'My paper.pdf')
  check('an fsa: pseudo-path → the name', H.docNameFromPath('fsa:notes.pdf') === 'notes.pdf')
  check('a bare % is shown as it is', H.docNameFromPath('/x/100%.pdf') === '100%.pdf')
  const doc = H.sanitizeConversationDoc({ path: 'C:\\a\\b.pdf', name: '  ', conversations: [conv('a', 1)] })
  check('a blank name reads as the file name', doc.name === 'b.pdf')
  check('no path → null', H.sanitizeConversationDoc({ name: 'x', conversations: [] }) === null)
}

console.log('\n3. merging two windows’ lists')
{
  const merged = H.mergeConversations(
    [conv('a', 100, [user('old')]), conv('b', 50)],
    [conv('a', 120, [user('new')]), conv('c', 70)]
  )
  check('union by id, newest first', merged.map((c) => c.id).join(',') === 'a,c,b', merged.map((c) => c.id).join(','))
  check('the newer record of a shared id wins', merged[0].messages[0].text === 'new')
}

console.log('\n4. the searchable text')
{
  const c = conv('a', 1, [
    user('raw text', { display: 'Shown text', images: [{ mime: 'image/jpeg', data: 'AAAA' }] }),
    { role: 'assistant', parts: [{ text: 'First ', citations: [] }, { text: 'part.', citations: [] }], error: 'boom' },
    { role: 'assistant', parts: [], error: 'only an error' }
  ])
  const text = H.conversationText(c)
  check('what was shown, then what was answered', text === 'Shown text\nFirst part.', JSON.stringify(text))
  check('no image data, no error prose', !text.includes('AAAA') && !text.includes('boom'))
  const s = H.summarizeConversations({ path: 'p', name: 'n', conversations: [c] })[0]
  check('a summary carries counts and names, no messages', s.messageCount === 3 && s.docName === 'n' && !('messages' in s))
}

console.log('\n5. the search')
{
  const docs = [
    { path: 'C:\\a.pdf', name: 'Alpha.pdf', conversations: [
      conv('a1', 300, [user('Hva betyr positional encoding?'), answer('Positional encoding gir modellen rekkefølgen. Økonomi er ikke nevnt.')]),
      conv('a2', 100, [user('Regn ut (5) for meg'), answer('Likning (5) gir c++ som svar.')])
    ] },
    { path: 'C:\\b.pdf', name: 'Beta økonomi.pdf', conversations: [
      conv('b1', 200, [user('Oppsummer'), answer('Dette er en lang tekst '.repeat(30) + 'med ordet nøkkelord midt inni ' + 'og mer tekst etterpå '.repeat(30))])
    ] }
  ]
  const all = docs.flatMap(H.summarizeConversations)
  const ids = (hits) => hits.map((h) => h.id).join(',')
  check('an empty query lists everything, newest first', ids(H.searchConversations(all, '  ')) === 'a1,b1,a2')
  check('every word must occur', ids(H.searchConversations(all, 'positional rekkefølgen')) === 'a1')
  check('a word missing kills the hit', ids(H.searchConversations(all, 'positional kvantemekanikk')) === '')
  check('case-folded, Norwegian letters included', ids(H.searchConversations(all, 'ØKONOMI')) === 'a1,b1')
  check('a hit in the document name counts', ids(H.searchConversations(all, 'beta')) === 'b1')
  check('a hit in the title counts', ids(H.searchConversations(all, 'title a2')) === 'a2')
  check('regex characters are literal', ids(H.searchConversations(all, '(5)')) === 'a2' && ids(H.searchConversations(all, 'c++')) === 'a2')
  const [nameHit] = H.searchConversations(all, 'beta')
  check('a hit in the name alone gives no snippet', nameHit.snippet === null)
  const [textHit] = H.searchConversations(all, 'nøkkelord')
  const words = ['Dette', 'er', 'en', 'lang', 'tekst', 'med', 'ordet', 'midt', 'inni', 'og', 'mer', 'etterpå']
  const body = textHit.snippet.replace(/^…|…$/g, '').split(' ')
  check(
    'a snippet holds the hit with text either side, cut at whole words, with ellipses',
    /^….* nøkkelord .*…$/.test(textHit.snippet) && words.includes(body[0]) && words.includes(body[body.length - 1]) &&
      textHit.snippet.length > 100 && textHit.snippet.length < 200,
    textHit.snippet
  )
  const [startHit] = H.searchConversations(all, 'hva betyr')
  check('a hit at the start has no leading ellipsis', startHit.snippet.startsWith('Hva betyr'), startHit.snippet)
  check('newlines read as spaces in a snippet', !startHit.snippet.includes('\n'))
}

console.log('\n6. the desktop store, against a temp folder')
{
  const dir = join(mkdtempSync(join(tmpdir(), 'chat-history-')), 'chats')
  const store = createChatHistoryStore(dir)
  const A = 'C:\\docs\\alpha.pdf'
  const B = 'https://x.org/beta.pdf'
  const keyOf = (p) => createHash('sha1').update(p).digest('hex')

  check('nothing stored → [] (and no folder made)', (await store.get(A)).length === 0 && !existsSync(dir))
  await store.set(A, 'alpha.pdf', [conv('a1', 100), conv('a2', 300)])
  const got = await store.get(A)
  check('round trip, newest first', got.map((c) => c.id).join(',') === 'a2,a1', got.map((c) => c.id).join(','))
  check('one file per document, named by the path’s hash', existsSync(join(dir, `${keyOf(A)}.json`)))
  check('no temp file left behind', readdirSync(dir).every((n) => !n.endsWith('.tmp')), readdirSync(dir).join(','))

  await store.set(B, '', [conv('b1', 200)])
  const list = await store.list()
  check('list spans documents, newest first, no messages', list.map((s) => s.id).join(',') === 'a2,b1,a1' && list.every((s) => !('messages' in s)), list.map((s) => s.id).join(','))
  check('a blank name reads as the file name', list.find((s) => s.id === 'b1').docName === 'beta.pdf')
  check('all() hands the documents whole', (await store.all()).length === 2)

  // Two writes of one document in flight at once: the second must wait for
  // the first (on Windows a rename onto a file mid-rename fails), and the
  // last one must be what is on disk afterwards.
  const w1 = store.set(A, 'alpha.pdf', [conv('a1', 100)])
  const w2 = store.set(A, 'alpha.pdf', [conv('a1', 100), conv('a3', 400)])
  const w3 = store.set(A, 'alpha.pdf', [conv('a3', 400)])
  await Promise.all([w1, w2, w3])
  check('queued writes of one document land in order', (await store.get(A)).map((c) => c.id).join(',') === 'a3')

  await store.set(A, 'alpha.pdf', [])
  check('an empty list removes the file', !existsSync(join(dir, `${keyOf(A)}.json`)) && (await store.get(A)).length === 0)

  // A file that no longer parses reads as empty and stays where it is
  const bFile = join(dir, `${keyOf(B)}.json`)
  writeFileSync(bFile, '{ not json')
  check('a corrupt file reads as empty', (await store.get(B)).length === 0)
  check('…and is left in place for the next write to replace', readFileSync(bFile, 'utf-8') === '{ not json')
  check('…and does not take the list down with it', (await store.list()).length === 0)

  // A file whose path inside disagrees with its name is not this document's
  writeFileSync(bFile, JSON.stringify({ path: 'C:\\other.pdf', name: 'o', conversations: [conv('x', 1)] }))
  check('a file naming another path is not read as this document', (await store.get(B)).length === 0)

  // Garbage in a file is sanitized on the way out
  writeFileSync(bFile, JSON.stringify({ path: B, name: 'b', conversations: [conv('ok', 5), 'junk', { id: 'no' }] }))
  check('garbage inside a file is dropped', (await store.get(B)).map((c) => c.id).join(',') === 'ok')
}

console.log('\n7. a password-protected document is stored without images')
{
  const img = { mediaType: 'image/jpeg', dataBase64: 'SECRETPAGEPIXELS' }
  const list = [
    conv('a', 2, [user('Hva viser figuren?', { images: [img, img] }), answer('En graf.'), user('Og denne?', { images: [img] })]),
    conv('b', 1, [user('Ingen bilder her'), answer('ok')])
  ]
  const out = H.withoutImages(list)
  const json = JSON.stringify(out)
  check('no image data survives', !json.includes('SECRETPAGEPIXELS'))
  check('each turn counts what it carried', out[0].messages[0].imagesWithheld === 2 && out[0].messages[2].imagesWithheld === 1)
  check('the questions and answers stay', out[0].messages[0].text === 'Hva viser figuren?' && out[0].messages[1].parts[0].text === 'En graf.')
  check('a conversation without images is the same object', out[1] === list[1])
  check('stripping twice changes nothing', JSON.stringify(H.withoutImages(out)) === json)
  check('the count survives the store’s shape check', H.sanitizeConversations(out)[0].messages[0].imagesWithheld === 2)
}

console.log('\n8. the cross-document list does not re-read what has not changed')
{
  const dir = join(mkdtempSync(join(tmpdir(), 'chat-history-cache-')), 'chats')
  // Count the files the store reads and parses: the proof of a cache hit is
  // a listing that parses NOTHING, which no amount of output can show
  let parsed = []
  const store = createChatHistoryStore(dir, { onParse: (f) => parsed.push(f) })
  const P = 'C:\\docs\\cache.pdf'
  const Q = 'C:\\docs\\other.pdf'
  const qFile = join(dir, `${createHash('sha1').update(Q).digest('hex')}.json`)

  await store.set(P, 'cache.pdf', [conv('p1', 10, [user('first'), answer('x')])])
  // A file written by ANOTHER process: no cache entry from a set of ours
  writeFileSync(qFile, JSON.stringify({ path: Q, name: 'other.pdf', conversations: [conv('q1', 20, [user('AAAA'), answer('y')])] }))
  parsed = []
  const first = await store.list()
  check('both documents listed', first.map((s) => s.id).join(',') === 'q1,p1', first.map((s) => s.id).join(','))
  check('the first listing parses only the file this store did not write', parsed.length === 1 && parsed[0] === qFile, String(parsed.length))

  parsed = []
  const second = await store.list()
  check('a second listing parses nothing', parsed.length === 0 && second.map((s) => s.id).join(',') === 'q1,p1', String(parsed.length))

  // A real change from outside — new content, new stamp — is read again
  utimesSync(qFile, new Date(), new Date(statSync(qFile).mtimeMs + 5000))
  writeFileSync(qFile, JSON.stringify({ path: Q, name: 'other.pdf', conversations: [conv('q1', 20, [user('BBBBBB'), answer('y')])] }))
  parsed = []
  const third = await store.list()
  check('a changed file is re-read, and only that one', parsed.length === 1 && third.find((s) => s.id === 'q1').text.startsWith('BBBBBB'), String(parsed.length))

  // Our own write fills the cache from the list it wrote
  await store.set(P, 'cache.pdf', [conv('p1', 30, [user('written'), answer('x')])])
  parsed = []
  const fourth = await store.list()
  check('our own write needs no re-read', parsed.length === 0 && fourth.find((s) => s.id === 'p1').text.startsWith('written'), String(parsed.length))

  // A file that goes leaves the list and the cache
  await store.set(Q, 'other.pdf', [])
  parsed = []
  check('a removed document leaves the list', (await store.list()).map((s) => s.id).join(',') === 'p1' && parsed.length === 0)
}

console.log('\n9. the library view: groups, and what each tidying takes')
{
  const img = (n) => ({ mediaType: 'image/jpeg', dataBase64: 'A'.repeat(n) })
  const DAY = 86_400_000
  const NOW = Date.UTC(2026, 9, 23, 12)
  const docs = [
    { path: 'A', name: 'a.pdf', conversations: [
      conv('a1', NOW - 1 * DAY, [user('q', { images: [img(4000), img(400)] }), answer('x')]),
      conv('a2', NOW - 400 * DAY)
    ] },
    { path: 'B', name: 'b.pdf', conversations: [conv('b1', NOW - 2 * DAY), conv('b2', NOW - 800 * DAY)] },
    { path: 'C', name: 'c.pdf', conversations: [conv('c1', NOW - 30 * DAY)] }
  ]
  const all = docs.flatMap(H.summarizeConversations)
  const a1 = all.find((s) => s.id === 'a1')
  check('a summary counts its images and their decoded size', a1.images === 2 && a1.imageBytes === 3300, `${a1.images} / ${a1.imageBytes}`)
  check('a summary without images counts none', all.find((s) => s.id === 'b1').images === 0)

  const groups = L.groupByDocument(all)
  check('groups list newest document first, conversations newest first',
    groups.map((g) => `${g.docPath}:${g.items.map((i) => i.id).join('+')}`).join(' ') === 'A:a1+a2 B:b1+b2 C:c1',
    groups.map((g) => `${g.docPath}:${g.items.map((i) => i.id).join('+')}`).join(' '))

  const ids = (sel) => [...sel].map(([p, s]) => `${p}:${[...s].sort().join('+')}`).sort().join(' ')
  const older = L.selectOlderThan(all, L.monthsBefore(NOW, 12))
  check('older than a year: exactly those', ids(older) === 'A:a2 B:b2', ids(older))
  check('…counted as conversations about documents', JSON.stringify(L.selectionSize(older)) === '{"conversations":2,"documents":2}')
  check('nothing older than 24 months but one', ids(L.selectOlderThan(all, L.monthsBefore(NOW, 24))) === 'B:b2')

  const beyond = L.selectBeyondNewest(all, 3)
  check('keep the 3 newest: the other two go', ids(beyond) === 'A:a2 B:b2', ids(beyond))
  check('keeping more than there are takes nothing', L.selectBeyondNewest(all, 100).size === 0)
  const tied = [
    { ...all[0], docPath: 'Z', id: 'z', updatedAt: 5 },
    { ...all[0], docPath: 'Y', id: 'y', updatedAt: 5 }
  ]
  check('a tie on the time is broken the same way every time',
    ids(L.selectBeyondNewest(tied, 1)) === ids(L.selectBeyondNewest([...tied].reverse(), 1)) && ids(L.selectBeyondNewest(tied, 1)) === 'Z:z')

  const withImages = L.selectWithImages(all)
  check('«Fjern bilder» takes only conversations with images', ids(withImages) === 'A:a1')
  check('…and says what it frees', JSON.stringify(L.selectionImages(all, withImages)) === '{"images":2,"bytes":3300}')
  const totals = L.storageTotals(all)
  check('the store at a glance', totals.conversations === 5 && totals.documents === 3 && totals.images === 2 && totals.imageBytes === 3300)

  check('sizes read as kB below a megabyte', L.formatBytes(3300, 'en') === '3 kB' && L.formatBytes(10, 'en') === '1 kB')
  check('…and as MB with one decimal above', L.formatBytes(5.25 * 1024 * 1024, 'en') === '5.3 MB', L.formatBytes(5.25 * 1024 * 1024, 'en'))
}

console.log('\n10. the view: no text crosses, sort, filters, custom values, badge counts')
{
  const DAY = 86_400_000
  const mk = (path, name, id, created, updated, n, images = 0) => ({
    docPath: path, docName: name, id, title: id, createdAt: created, updatedAt: updated,
    messageCount: n, text: `secret text of ${id}`, images, imageBytes: images * 1000
  })
  const list = [
    mk('/z.pdf', 'zeta.pdf', 'z1', 1 * DAY, 50 * DAY, 2),
    mk('/z.pdf', 'zeta.pdf', 'z2', 40 * DAY, 41 * DAY, 9),
    mk('/a.pdf', 'Alfa.pdf', 'a1', 10 * DAY, 30 * DAY, 4, 2),
    mk('/m.pdf', 'mu 10.pdf', 'm1', 45 * DAY, 46 * DAY, 1),
    mk('/m2.pdf', 'mu 9.pdf', 'm2', 2 * DAY, 3 * DAY, 3)
  ]
  const meta = H.toMeta(list[0])
  check('a listed summary carries no text', !('text' in meta) && meta.title === 'z1' && meta.images === 0)
  const hits = H.searchConversations(list, 'secret')
  check('search hits carry no text either, only the snippet', hits.length === 5 && hits.every((h) => !('text' in h) && h.snippet?.includes('secret')))

  const order = (sort) => L.sortGroups(list, sort).map((g) => `${g.docName}:${g.items.map((i) => i.id).join('+')}`).join(' | ')
  check('by last change: the document changed last first', order('updated') === 'zeta.pdf:z1+z2 | mu 10.pdf:m1 | Alfa.pdf:a1 | mu 9.pdf:m2', order('updated'))
  check('by creation: the newest conversation leads, inside a group too', order('created') === 'mu 10.pdf:m1 | zeta.pdf:z2+z1 | Alfa.pdf:a1 | mu 9.pdf:m2', order('created'))
  check('by name: A–Å, case-folded, numbers in number order', order('name') === 'Alfa.pdf:a1 | mu 9.pdf:m2 | mu 10.pdf:m1 | zeta.pdf:z1+z2', order('name'))
  check('by messages: the longest conversation first', order('messages') === 'zeta.pdf:z2+z1 | Alfa.pdf:a1 | mu 9.pdf:m2 | mu 10.pdf:m1', order('messages'))
  check('a stored sort that is not one falls back to last change', L.sortOrDefault('bogus') === 'updated' && L.sortOrDefault('name') === 'name')

  const gone = new Set(['/a.pdf', '/m.pdf'])
  const ids = (arr) => arr.map((c) => c.id).join(',')
  check('no filter keeps everything', L.applyFilter(list, L.NO_FILTER, gone).length === 5)
  check('«Filen mangler» keeps the gone documents', ids(L.applyFilter(list, { ...L.NO_FILTER, missing: true }, gone)) === 'a1,m1')
  check('«Med bilder» keeps conversations with images', ids(L.applyFilter(list, { ...L.NO_FILTER, images: true }, gone)) === 'a1')
  check('a document filter keeps that document', ids(L.applyFilter(list, { ...L.NO_FILTER, doc: '/z.pdf' }, gone)) === 'z1,z2')
  check('filters combine', L.applyFilter(list, { doc: '/z.pdf', missing: true, images: false }, gone).length === 0)

  check('a custom number: whole, in bounds', L.customNumber('18', 1, 600) === 18 && L.customNumber(' 7 ', 1, 600) === 7)
  check('…anything else is no number (the action offers nothing)',
    [L.customNumber('', 1, 600), L.customNumber('0', 1, 600), L.customNumber('2.5', 1, 600), L.customNumber('-3', 1, 600), L.customNumber('601', 1, 600), L.customNumber('12 mnd', 1, 600)].every((v) => v === null))
  check('keeping zero is a number for «behold de nyeste»', L.customNumber('0', 0, 1_000_000) === 0)

  const counts = L.countByDocument(list)
  check('the badge counts per document', counts.get('/z.pdf') === 2 && counts.get('/a.pdf') === 1 && !counts.has('/none.pdf'))
}

{
  // The Markdown export lists the passages an answer cites under it: a
  // «[s. 6]» alone is unreadable without the PDF, and the export is read
  // without it. The real renderer module, in the master language.
  const E = await bundle(fileURLToPath(new URL('../src/renderer/src/chat-export.ts', import.meta.url)), 'export.mjs')
  const long = 'ord '.repeat(400)
  const cited = {
    role: 'assistant',
    parts: [
      {
        text: 'Kodingen er sinusformet. ',
        citations: [
          { kind: 'quote', pageNumber: 6, quote: 'we use sine and\n  cosine functions' },
          { kind: 'quote', pageNumber: 6, quote: 'we use sine and cosine functions' },
          { kind: 'web', url: 'https://example.org/a', title: 'A' }
        ]
      },
      { text: 'Den er fast.', citations: [{ kind: 'char', start: 10, end: 40, citedText: 'fixed, not learned' }] },
      { text: ' Lang.', citations: [{ kind: 'quote', pageNumber: 2, quote: long }] },
      { text: ' Tom.', citations: [{ kind: 'quote', pageNumber: 3, quote: '   ' }] },
      {
        text: ' Fra før.',
        citations: [{ kind: 'conversation', docPath: '/b.pdf', id: 'c1', docName: 'b.pdf', title: 'Tidligere' }]
      }
    ]
  }
  const md = E.libraryMarkdown(
    [{ path: '/a.pdf', name: 'a.pdf', conversations: [{ id: 'x', title: 'Koding', createdAt: 1, updatedAt: 2, messages: [user('Hva?'), cited, answer('Uten kilder.')] }] }],
    Date.UTC(2026, 9, 24)
  )
  const block = md.slice(md.indexOf('*Siterte passasjer:*'))
  check('cited passages follow the answer that cites them', md.includes('[s. 6]') && md.indexOf('Kodingen er') < md.indexOf('*Siterte passasjer:*') && md.indexOf('*Siterte passasjer:*') < md.indexOf('Uten kilder.'))
  check('a passage opens with the marker the text carries, whitespace folded', block.includes('- [s. 6] «we use sine and cosine functions»'))
  check('…the same passage twice is listed once', block.split('we use sine').length === 2)
  check('a character-offset citation with no document reads as [kilde]', block.includes('- [kilde] «fixed, not learned»'))
  check('a long passage is cut with an ellipsis', block.includes('- [s. 2] «ord') && block.includes(' …»') && !block.includes(long.trim()))
  check('web sources, conversations and empty quotes list no passage', !block.includes('example.org/a)»') && !block.includes('Tidligere»') && !block.includes('[s. 3]'))
  check('an answer without citations gets no passage list', md.split('*Siterte passasjer:*').length === 2)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

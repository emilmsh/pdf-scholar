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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

// Earlier conversations attached as context (issue #46): the rules in
// src/shared/conversation-context.ts, and where they meet the citation
// contract (src/shared/ai-stream.ts).
//
// What would go wrong silently without these: a [SAMTALE n] tag read by the
// quote contract's tolerant parser as a SOURCE in the document (its source
// token is any short bracket-safe word, and a chip would then search the
// document for a quote that is not in it); the stream holding a tag back to
// the end of the answer; a tag numbered for an attachment that was deleted,
// pointing at the wrong conversation; five long conversations crowding the
// document out of a tight request; images or failure prose riding along; a
// stored attachment list that throws or attaches a conversation twice.
// Run: node scripts/test-conversation-context.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const buildDir = mkdtempSync(join(tmpdir(), 'conv-context-build-'))
const bundle = async (rel, name) => {
  const outfile = join(buildDir, name)
  await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const C = await bundle('../src/shared/conversation-context.ts', 'context.mjs')
const S = await bundle('../src/shared/ai-stream.ts', 'stream.mjs')
const H = await bundle('../src/shared/chat-history.ts', 'history.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const meta = (n) => ({ docPath: `/d/${n}.pdf`, docName: `Doc ${n}.pdf`, id: `c${n}`, title: `Title ${n}` })
const conv = (n, messages, updatedAt = Date.UTC(2026, 9, 20)) => ({ id: `c${n}`, title: `Title ${n}`, createdAt: updatedAt, updatedAt, messages })
const q = (text, extra = {}) => ({ role: 'user', text, ...extra })
const a = (text, extra = {}) => ({ role: 'assistant', parts: [{ text, citations: [] }], ...extra })

console.log('\n1. a stored attachment list is untrusted input')
{
  const list = C.sanitizeAttached([meta(1), null, { docPath: '', id: 'x' }, { docPath: '/d/1.pdf', id: 'c1' }, { docPath: '/d/2.pdf', id: 'c2', docName: 7 }, meta(3), meta(4), meta(5), meta(6), meta(7)])
  check('junk dropped, a conversation once, at most five', list.length === 5 && list.map((x) => x.id).join(',') === 'c1,c2,c3,c4,c5', list.map((x) => x.id).join(','))
  check('a missing name reads as empty, not as garbage', list[1].docName === '')
  check('not a list → []', C.sanitizeAttached({}).length === 0)
  const stored = H.sanitizeConversations([{ ...conv(9, [q('x')]), attached: [meta(1), meta(1), 'junk'] }])
  check('the store keeps a conversation’s attachments, sanitised', stored[0].attached?.length === 1 && stored[0].attached[0].id === 'c1')
  check('…and adds none to a conversation without them', !('attached' in H.sanitizeConversations([conv(8, [q('x')])])[0]))
}

console.log('\n2. what the model reads of a conversation')
{
  const t = C.transcript(conv(1, [
    q('raw sent text', { display: 'What does it say?', images: [{ mediaType: 'image/png', dataBase64: 'PIXELS' }] }),
    a('It says X.'),
    q('And Y?'),
    { role: 'assistant', parts: [], error: 'HTTP 500 boom' }
  ]))
  check('who said what, in order, as the reader saw it', t === 'Reader: What does it say?\nAssistant: It says X.\nReader: And Y?', JSON.stringify(t))
  check('no image data and no failure prose', !t.includes('PIXELS') && !t.includes('boom'))
  const long = 'x'.repeat(5000) + 'MIDDLE' + 'y'.repeat(5000)
  const capped = C.capTranscript(long, 1000)
  check('a long transcript is cut to its cap', capped.cut && capped.text.length <= 1000, String(capped.text.length))
  check('…keeping the opening and the end, with a marker between', capped.text.startsWith('xxx') && capped.text.endsWith('yyy') && capped.text.includes('left out') && !capped.text.includes('MIDDLE'))
  check('a short one is untouched', C.capTranscript('short', 1000).text === 'short' && !C.capTranscript('short', 1000).cut)
}

console.log('\n3. the block in the system prompt')
{
  const items = [
    { meta: meta(1), conversation: conv(1, [q('Q1'), a('A1')]) },
    { meta: meta(2), conversation: null },
    { meta: meta(3), conversation: conv(3, [q('Q3'), a('A3')]) }
  ]
  const b = C.attachedBlock(items)
  check('tags number only what is in the block — a deleted one leaves no gap', b.tagged.map((x) => x.id).join(',') === 'c1,c3' && b.text.includes('[SAMTALE 1] About "Doc 1.pdf"') && b.text.includes('[SAMTALE 2] About "Doc 3.pdf"') && !b.text.includes('[SAMTALE 3]'))
  check('the deleted one is reported as missing', b.missing.map((x) => x.id).join(',') === 'c2')
  check('the rules say the document is the only source and how to tag', /only thing you cite as a source/.test(b.text) && /\[SAMTALE 2\]/.test(b.text) && /the document wins/.test(b.text))
  check('nothing attached → no block at all', C.attachedBlock([]).text === '' && C.attachedBlock([{ meta: meta(2), conversation: null }]).text === '')
  const huge = Array.from({ length: 5 }, (_, i) => ({ meta: meta(i + 1), conversation: conv(i + 1, [q('Q'), a('z'.repeat(20_000))]) }))
  const big = C.attachedBlock(huge)
  const transcripts = big.text.length - C.attachedBlock([]).text.length
  check('five long conversations stay within the total cap', big.text.length < C.MAX_CHARS_TOTAL + 3000, String(big.text.length))
  check('…each cut to its own cap, and reported as cut', big.cut.length >= 3 && transcripts > 0)
  check('a sixth is never attached', C.attachedBlock([...huge, { meta: meta(6), conversation: conv(6, [q('Q6'), a('A6')]) }]).tagged.length <= 5)
}

console.log('\n4. a tag becomes a chip — and never a source')
{
  const tagged = [meta(1), meta(3)]
  const parts = C.splitConversationTags([{ text: 'The method is DiD [SAMTALE 2]. The data are new.', citations: [{ kind: 'quote', pageNumber: 2, quote: 'new data' }] }], tagged)
  check('the text before a tag carries its chip', parts[0].text === 'The method is DiD' && parts[0].citations[0]?.kind === 'conversation' && parts[0].citations[0].id === 'c3', JSON.stringify(parts[0]))
  check('the part’s own source stays at its end', parts.at(-1).citations[0]?.kind === 'quote' && parts.at(-1).text === '. The data are new.')
  check('no raw tag is left in the text', parts.every((p) => !/SAMTALE/.test(p.text)))
  const unknown = C.splitConversationTags([{ text: 'Odd [SAMTALE 9] claim.', citations: [] }], tagged)
  check('a tag naming no attachment is dropped, not shown', unknown.map((p) => p.text).join('') === 'Odd claim.' && unknown.every((p) => p.citations.length === 0))
  check('casing and the English word are understood', C.splitConversationTags([{ text: 'x [Conversation 1]', citations: [] }], tagged)[0].citations[0]?.id === 'c1')
  check('splitting twice changes nothing', JSON.stringify(C.splitConversationTags(parts, tagged)) === JSON.stringify(parts))
  const plain = [{ text: 'No tags here.', citations: [] }]
  check('an answer without tags is the same parts', C.splitConversationTags(plain, tagged)[0] === plain[0])

  // The quote contract's parser takes ANY short word as the source token; a
  // tag must never come out of it as a document quote
  const contract = S.parseQuoteContract('Per the earlier talk [SAMTALE 2]. The paper says [KILDE s.3: "verbatim text here"].')
  const quotes = contract.flatMap((p) => p.citations)
  check('the quote contract sees the KILDE marker and only it', quotes.length === 1 && quotes[0].kind === 'quote' && quotes[0].pageNumber === 3, JSON.stringify(quotes))
  check('…and leaves the tag in the text for the split', contract.map((p) => p.text).join('').includes('[SAMTALE 2]'))
  // While streaming, a tag that has closed is not held back as a marker prefix
  const streamed = 'Earlier [SAMTALE 1] and more words after it'
  check('the stream does not hold a closed tag back', S.pendingMarkerStart(streamed) === streamed.length, String(S.pendingMarkerStart(streamed)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

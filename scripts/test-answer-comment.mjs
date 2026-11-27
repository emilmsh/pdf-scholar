// An AI answer kept as a comment (src/shared/answer-comment.ts, issue #137).
//
// A comment is plain text in the file, an answer is Markdown: the marks go,
// the words stay, and what the rule does not recognise is left as written.
// Run: node scripts/test-answer-comment.mjs
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/answer-comment.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'answer-comment-'))
const out = join(dir, 'answer-comment.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { plainAnswer, answerComment, answerCommentWithSources, commentSources } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
  }
}

console.log('plainAnswer')
eq(plainAnswer('Plain words stay.'), 'Plain words stay.', 'plain text untouched')
eq(plainAnswer('A **bold** and *soft* and __loud__ and _quiet_ word'), 'A bold and soft and loud and quiet word', 'emphasis marks go')
eq(plainAnswer('## Heading\n\nBody'), 'Heading\n\nBody', 'a heading keeps its words')
eq(plainAnswer('* one\n+ two\n  - three'), '- one\n- two\n  - three', 'bullets read as dashes, indent kept')
eq(plainAnswer('1. first\n2. second'), '1. first\n2. second', 'a numbered list stays')
eq(plainAnswer('Use `attention` here'), 'Use attention here', 'inline code')
eq(plainAnswer('before\n```js\nconst a = b * c * d\n```\nafter'), 'before\nconst a = b * c * d\nafter', 'a fence goes, its content is untouched')
eq(plainAnswer('See [the paper](https://example.org/p) now'), 'See the paper (https://example.org/p) now', 'a link keeps its address')
eq(plainAnswer('[https://example.org](https://example.org)'), 'https://example.org', 'a bare link is not doubled')
eq(plainAnswer('> quoted line'), 'quoted line', 'a quote mark goes')
eq(plainAnswer('above\n\n---\n\nbelow'), 'above\n\nbelow', 'a rule carries nothing')
eq(plainAnswer('a\n\n\n\nb\n'), 'a\n\nb', 'blank runs collapse, ends trimmed')
eq(plainAnswer('a\r\nb'), 'a\nb', 'CRLF')

console.log('what it must leave alone')
eq(plainAnswer('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24', 'arithmetic asterisks')
eq(plainAnswer('the file snake_case_name here'), 'the file snake_case_name here', 'underscores inside a word')
eq(plainAnswer('$PE_{(pos,2i)} = \\sin(pos)$'), '$PE_{(pos,2i)} = \\sin(pos)$', 'math')
eq(plainAnswer('| a | b |\n|---|---|\n| 1 | 2 |'), '| a | b |\n|---|---|\n| 1 | 2 |', 'a table')
eq(plainAnswer('æøå «sitat» – 中文'), 'æøå «sitat» – 中文', 'non-ASCII')
eq(plainAnswer(''), '', 'empty')

console.log('answerComment')
eq(answerComment('**Yes.**'), 'Yes.', 'a chip: the answer alone')
eq(answerComment('**Yes.**', null), 'Yes.', 'null question')
eq(answerComment('**Yes.**', '   '), 'Yes.', 'blank question')
eq(answerComment('It adds *position*.', ' Why\n sinusoids? '), 'Why sinusoids?\n\nIt adds position.', 'a typed question leads, on one line')
eq(answerComment('', 'Why?'), 'Why?', 'no answer text')

// ---------- The sources an answer stood on (issue #168) ----------
// A comment is plain text in every reader, so a source chip is WRITTEN as a
// «[s. 4]» with its passage listed under the answer, and read back out of it.

const NB = { pageAbbrev: 's.', heading: 'Siterte passasjer:' }
const quote = (pageNumber, text) => ({ kind: 'quote', pageNumber, quote: text })
const pageOf = (c) => (c.kind === 'quote' ? c.pageNumber : c.kind === 'char' ? (c.start < 100 ? 1 : 2) : null)

console.log('answerCommentWithSources')
eq(
  answerCommentWithSources([{ text: '**Yes.** It *does*.\n', citations: [] }], ' Why? ', NB, pageOf),
  answerComment('**Yes.** It *does*.\n', ' Why? '),
  'an answer that cites nothing is answerComment, byte for byte'
)
const two = [
  { text: 'Tissue was **collected** for histology. ', citations: [quote(4, 'Tumours were\ncollected  for histology')] },
  { text: 'The markers are listed.\n\n', citations: [quote(4, 'CD3E, CD20, CD138'), quote(7, 'based on H&E')] },
  { text: 'No source for this.', citations: [] }
]
const saved = answerCommentWithSources(two, null, NB, pageOf)
eq(
  saved,
  'Tissue was collected for histology. [s. 4] The markers are listed. [s. 4] [s. 7]\n\nNo source for this.\n\n' +
    'Siterte passasjer:\n[s. 4] «Tumours were collected for histology»\n[s. 4] «CD3E, CD20, CD138»\n[s. 7] «based on H&E»',
  'a marker where each chip stood, the passages under the answer in the same order'
)
eq(
  answerCommentWithSources(two, 'How?', NB, pageOf).startsWith('How?\n\nTissue was collected'),
  true,
  'a typed question still leads'
)
eq(
  answerCommentWithSources([{ text: 'A.', citations: [quote(3, 'x y'), quote(3, 'x  y'), quote(3, 'z')] }], null, NB, pageOf),
  'A. [s. 3] [s. 3]\n\nSiterte passasjer:\n[s. 3] «x y»\n[s. 3] «z»',
  'the same passage twice under one sentence is one marker'
)
eq(
  answerCommentWithSources(
    [{ text: 'A.', citations: [{ kind: 'char', start: 150, end: 160, citedText: 'native words' }] }],
    null,
    { pageAbbrev: 'p.', heading: 'Cited passages:' },
    pageOf
  ),
  'A. [p. 2]\n\nCited passages:\n[p. 2] «native words»',
  'a character citation: the page from pageOf, the cited text as the passage'
)
eq(
  answerCommentWithSources([{ text: 'A.', citations: [{ kind: 'char', start: 1, end: 2, citedText: 'x' }] }], null, NB, () => null),
  'A.',
  'a citation whose page cannot be told is left out'
)
eq(
  answerCommentWithSources(
    [
      {
        text: 'Checked online.',
        citations: [
          { kind: 'web', url: 'https://example.org/a', title: 'A' },
          { kind: 'web', url: 'https://example.org/a', title: 'A' },
          { kind: 'conversation', docPath: 'x', id: '1', docName: 'd', title: 't' }
        ]
      }
    ],
    null,
    NB,
    pageOf
  ),
  'Checked online. (https://example.org/a)',
  'a web source is its address, once; a conversation chip is nothing in a comment'
)
{
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const text = answerCommentWithSources([{ text: 'A.', citations: [quote(2, long)] }], null, NB, pageOf)
  const line = text.split('\n').at(-1)
  eq(line.endsWith(' …»'), true, 'a long passage is cut with an ellipsis')
  eq(line.length <= 320, true, 'cut near 300 characters')
  eq(/word\d+ …»$/.test(line), true, 'cut at a whole word')
}
eq(
  answerCommentWithSources([{ text: 'See [1](x) here.', citations: [quote(9, 'q')] }], null, NB, pageOf),
  'See 1 (x) here. [s. 9]\n\nSiterte passasjer:\n[s. 9] «q»',
  'the marker is never read as Markdown'
)

console.log('commentSources')
{
  const read = commentSources(saved)
  eq(read.body, 'Tissue was collected for histology. [s. 4] The markers are listed. [s. 4] [s. 7]\n\nNo source for this.', 'the list is not part of the body')
  eq(JSON.stringify(read.sources.map((s) => [s.page, s.quote])), JSON.stringify([[4, 'Tumours were collected for histology'], [4, 'CD3E, CD20, CD138'], [7, 'based on H&E']]), 'each marker gets its own passage, by order')
  eq(read.sources.every((s) => read.body.slice(s.start, s.end) === `[s. ${s.page}]`), true, 'start/end address the marker in the body')
}
eq(commentSources('Just a thought about method.'), null, 'a comment the reader typed names no source')
eq(commentSources(''), null, 'empty')
eq(commentSources('array[3] and [see p. 4] and [p. x]'), null, 'brackets that are not a marker')
eq(commentSources('Siterte passasjer:\n[s. 4] «only a list»'), null, 'a list with no marker in the text is the reader’s own lines')
{
  const r = commentSources('See [p. 4] and [s. 12] and [第 7] and [P.4].')
  eq(JSON.stringify(r.sources.map((s) => [s.page, s.quote])), JSON.stringify([[4, null], [12, null], [7, null], [4, null]]), 'all three languages’ markers, a typed one too: a page and nothing more')
  eq(r.body, 'See [p. 4] and [s. 12] and [第 7] and [P.4].', 'nothing folded')
}
eq(commentSources('On [s. 4] and [s. 40].', 12).sources.length, 1, 'a page the document does not have is not a source')
eq(commentSources('On [s. 0].'), null, 'page 0')
{
  // Edited by hand elsewhere: a line gone, Acrobat's bare CR line ends
  const r = commentSources('A [s. 4] B [s. 4] C [s. 7]\r\rCited passages:\r[p. 4] «first»\r[p. 7] «seven»\r')
  eq(JSON.stringify(r.sources.map((s) => s.quote)), JSON.stringify(['first', null, 'seven']), 'a marker with no line left is a page alone; languages mix')
  eq(r.body, 'A [s. 4] B [s. 4] C [s. 7]', 'CR line ends, heading folded')
}
{
  const r = commentSources('A [s. 4]\n[s. 4] «no heading»')
  eq(r.body, 'A [s. 4]', 'a list straight under the text')
  eq(r.sources[0].quote, 'no heading', '… is still the list')
}
{
  const r = commentSources('A [s. 4]\n\nA long closing paragraph of the reader’s own that only happens to stand over the list of passages here\n[s. 4] «q»')
  eq(r.body.includes('closing paragraph'), true, 'a long line over the list is body, not a heading')
}
{
  const r = commentSources('A [s. 4]\n\nKilder:\n[s. 4] «a » inside» and more»')
  eq(r.sources[0].quote, 'a » inside» and more', 'a » inside the passage')
}
{
  // The abbreviations the dictionaries actually use must be ones the parser reads
  const dicts = readFileSync(new URL('../src/renderer/src/i18n.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../src/renderer/src/i18n-zh.ts', import.meta.url), 'utf8')
  const abbrevs = [...dicts.matchAll(/'app\.pageAbbrev': '([^']+)'/g)].map((m) => m[1])
  eq(abbrevs.length, 3, 'three dictionaries, three abbreviations')
  for (const pageAbbrev of abbrevs) {
    const text = answerCommentWithSources([{ text: 'A.', citations: [quote(5, 'q')] }], null, { pageAbbrev, heading: 'H' }, pageOf)
    const r = commentSources(text)
    eq(JSON.stringify(r?.sources.map((s) => [s.page, s.quote])), JSON.stringify([[5, 'q']]), `«${pageAbbrev}» written is «${pageAbbrev}» read`)
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nanswer-comment: all passed')

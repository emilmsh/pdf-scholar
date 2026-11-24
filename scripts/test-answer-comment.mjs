// An AI answer kept as a comment (src/shared/answer-comment.ts, issue #137).
//
// A comment is plain text in the file, an answer is Markdown: the marks go,
// the words stay, and what the rule does not recognise is left as written.
// Run: node scripts/test-answer-comment.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/answer-comment.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'answer-comment-'))
const out = join(dir, 'answer-comment.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { plainAnswer, answerComment } = await import(pathToFileURL(out).href)

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

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nanswer-comment: all passed')

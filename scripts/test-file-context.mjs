// Local files attached to a question as context (src/shared/file-context.ts,
// the paperclip's «Fil …», 2026-10-24).
//
// What would go wrong silently without these: a long report crowding the
// document out of a tight request (the per-file and whole-block caps); a
// file with nothing in it taking a slot and a number; the rules telling the
// model to cite the attached file with a [KILDE …] marker, which the quote
// contract would then try to find in the document; a sixth file quietly
// going along. Run: node scripts/test-file-context.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const buildDir = mkdtempSync(join(tmpdir(), 'file-context-build-'))
const outfile = join(buildDir, 'files.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/file-context.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const F = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const file = (name, text) => ({ name, text })
const lorem = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} of the attached file.`).join(' ')

// ---- 1. nothing attached, nothing in the prompt
{
  const b = F.attachedFilesBlock([])
  check('no files: an empty block', b.text === '' && b.included.length === 0)
  const e = F.attachedFilesBlock([file('empty.txt', '   \n')])
  check('a file with no text is left out, and takes no number', e.text === '' && e.included.length === 0)
}

// ---- 2. one file: the rules, the name, the text
{
  const b = F.attachedFilesBlock([file('notes.md', 'The sample was 120 firms.')])
  check('the block opens with the rules', /ATTACHED FILES/.test(b.text))
  check('the file is numbered and named', /\[FILE 1\] "notes\.md"/.test(b.text))
  check('…and its text is there', b.text.includes('The sample was 120 firms.'))
  check('the rules forbid a document citation on file content', /Never put a document citation/.test(b.text))
  check('the rules ask for the file to be named in words', /say which file/.test(b.text))
  check('included lists it, nothing cut, nothing left', b.included.join() === 'notes.md' && b.cut.length === 0 && b.left.length === 0)
}

// ---- 3. a long file is cut, head and tail kept, and says so
{
  const long = lorem(3000)
  const b = F.attachedFilesBlock([file('report.pdf', long)])
  check('a long file is cut', b.cut.join() === 'report.pdf')
  // The block carries the rules and the name line on top of the capped text
  const section = b.text.slice(b.text.indexOf('[FILE 1]'))
  check('…to the per-file cap', section.length <= F.MAX_FILE_CHARS_EACH + 40, String(section.length))
  check('…keeping its opening', b.text.includes('Sentence number 1 of'))
  check('…and its end', b.text.includes('Sentence number 3000 of'))
  check('…with a gap marker between', /left out/.test(b.text))
}

// ---- 4. the block as a whole is capped; the sixth file never goes
{
  const files = Array.from({ length: 6 }, (_, i) => file(`f${i + 1}.txt`, lorem(1200)))
  const b = F.attachedFilesBlock(files)
  check('at most MAX_FILES go along', b.included.length <= F.MAX_FILES && !b.included.includes('f6.txt'), b.included.join())
  check('the whole block stays under its cap, about', b.text.length < F.MAX_FILE_CHARS_TOTAL + 1500, String(b.text.length))
  check('what did not fit is named as left out or cut', b.left.length + b.cut.length > 0, `left ${b.left.join()} cut ${b.cut.join()}`)
  const numbers = [...b.text.matchAll(/\[FILE (\d+)\]/g)].map((m) => Number(m[1]))
  check('numbers run 1..n over what is in the block', numbers.join() === b.included.map((_, i) => i + 1).join(), numbers.join())
}

// ---- 5. the chip's cost
{
  check('fileTokens is about a quarter of the characters', F.fileTokens(file('a', 'x'.repeat(4000))) === 1000)
  check('…and never counts past the cap', F.fileTokens(file('a', 'x'.repeat(400000))) === F.MAX_FILE_CHARS_EACH / 4)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\ntest:file-context — ok')

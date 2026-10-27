// Proof for src/renderer/src/reading-font.ts — the reading font chosen by
// name from the machine's installed faces (docs/TYPOGRAPHY.md § 5–6). What
// matters here:
//   1) The default (empty) produces NO override — null vars — so the shipped
//      CSS renders bit-identically; the same rule test-theme-tune proves.
//   2) The stored value is untrusted input: a non-string, junk, quotes,
//      semicolons, braces, backslashes, control characters and a runaway
//      length all come out as a clean family name or as the default, never
//      as something that could reshape the custom property it lands in.
//   3) The stack quotes the family and keeps the interface stack behind it,
//      and the x-height adjustment rides along as a second property.
//   4) The installed rule: any measured pair that differs means installed;
//      all-equal means the generic was drawn every time.
// Run: node scripts/test-reading-font.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/reading-font.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'reading-font-'))
const out = join(dir, 'reading-font.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const F = await import(pathToFileURL(out).href)

let failures = 0
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

// 1) default = no override
console.log('1) the default produces no override')
eq(F.READING_FONT_DEFAULT, '', 'the default is the empty name')
eq(F.readingFontVars(''), null, 'empty name → null vars')
eq(F.readingFontVars('   '), null, 'blank name → null vars')
eq(F.readingFontVars(undefined), null, 'undefined → null vars')

// 2) untrusted input
console.log('2) the stored value is untrusted input')
const n = F.normalizeReadingFont
eq(n('Libertinus Serif'), 'Libertinus Serif', 'a plain name is kept')
eq(n('  Libertinus   Serif  '), 'Libertinus Serif', 'blanks trimmed and collapsed')
eq(n('"Libertinus Serif"'), 'Libertinus Serif', 'double quotes dropped')
eq(n("'Libertinus Serif'"), 'Libertinus Serif', 'single quotes dropped')
eq(n('Libertinus Serif; color: red'), 'Libertinus Serif color red', 'semicolon and colon dropped')
eq(n('Libertinus } body { font: x'), 'Libertinus body font x', 'braces dropped')
eq(n('Liber\\tinus'), 'Libertinus', 'backslash dropped')
eq(n('Liber\u0000tinus\u001f'), 'Libertinus', 'control characters dropped')
eq(n('Libertinus\nSerif'), 'Libertinus Serif', 'a newline is a blank')
eq(n('Libertinus /* x */ Serif'), 'Libertinus x Serif', 'slashes and stars dropped')
eq(n('var(--font-ui)'), 'var--font-ui', 'parentheses dropped — no function call survives')
eq(n('Søk Ærlig Åpent'), 'Søk Ærlig Åpent', 'æøå are letters and stay')
eq(n('思源宋体'), '思源宋体', 'CJK letters stay')
eq(n('Noto Sans CJK JP Light-2.0'), 'Noto Sans CJK JP Light-2.0', 'hyphen, digits and full stop stay')
eq(n('My_Font'), 'My_Font', 'underscore stays')
eq(n(';;;'), '', 'nothing but junk → default')
eq(n(null), '', 'null → default')
eq(n(123), '', 'a number → default')
eq(n({ name: 'x' }), '', 'an object → default')
eq(n(['Libertinus']), '', 'an array → default')
const long = 'A'.repeat(200)
eq(n(long).length, F.READING_FONT_MAX_LEN, 'a runaway name is capped')
eq(n('A'.repeat(63) + ' B'), 'A'.repeat(63), 'the cap does not leave a trailing blank')
eq(n(n('"  Libertinus;  Serif "')), n('"  Libertinus;  Serif "'), 'normalising is idempotent')

// 3) stack and vars
console.log('3) the stack and the vars')
eq(F.readingFontStack('Libertinus Serif'), '"Libertinus Serif", var(--font-ui)', 'quoted, interface stack behind')
const vars = F.readingFontVars(' "Libertinus Serif" ')
ok(vars !== null, 'a chosen face produces vars')
eq(vars && vars['--font-reading'], '"Libertinus Serif", var(--font-ui)', 'vars carry the normalised stack')
eq(vars && vars['--font-reading-adjust'], '0.5', 'vars carry the x-height adjustment')
eq(F.READING_FONT_X_HEIGHT, 0.5, 'the adjustment is Segoe\'s measured ratio')
eq(vars && Object.keys(vars).length, 2, 'exactly two properties, nothing else reaches the root')

// 4) the installed rule
console.log('4) the installed rule')
eq(F.installedFromWidths([[100, 100], [120, 120], [110, 110]]), false, 'every pair equal → not installed')
eq(F.installedFromWidths([[100, 100], [121, 120], [110, 110]]), true, 'one pair differing → installed')
eq(F.installedFromWidths([]), false, 'no measurements → not installed')

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nreading-font: all good')

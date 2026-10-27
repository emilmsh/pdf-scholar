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

// 5) the machine's faces as a list — a queryLocalFonts() listing is untrusted
//    input like the typed name, and the menu derived from it is what the
//    picker shows
console.log('5) the listing behind the picker')
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg)
const listing = [
  { family: 'Segoe UI', fullName: 'Segoe UI Bold', postscriptName: 'SegoeUI-Bold', style: 'Bold' },
  { family: 'Segoe UI', fullName: 'Segoe UI', postscriptName: 'SegoeUI', style: 'Regular' },
  { family: 'Libertinus Serif', fullName: 'Libertinus Serif Italic', style: 'Italic' },
  { family: 'libertinus serif', fullName: 'Libertinus Serif Semibold', style: 'Semibold' },
  { family: 'Cambria', fullName: 'Cambria' },
  { fullName: 'Georgia Bold' },
  { family: '', fullName: 'Georgia' },
  { family: 'Noto Sans 10', fullName: 'Noto Sans 10' },
  { family: 'Noto Sans 2', fullName: 'Noto Sans 2' },
  { family: 'Évora', fullName: 'Évora' },
  { family: 'Bad; One }', fullName: 'Bad; One }' },
  { family: ';;;' },
  { family: 42, fullName: 42 },
  null,
  'Arial',
  7,
  {},
]
const fam = F.familiesFromListing(listing)
same(
  fam,
  ['Bad One', 'Cambria', 'Évora', 'Georgia', 'Georgia Bold', 'Libertinus Serif', 'Noto Sans 2', 'Noto Sans 10', 'Segoe UI'],
  'families: one per family (cuts folded, case-insensitively), family over fullName, fullName when family is missing or blank, junk normalised, non-objects and junk-only names dropped, sorted with base letters and numbers in number order'
)
same(F.familiesFromListing(null), [], 'a non-array listing → nothing')
same(F.familiesFromListing('Segoe UI'), [], 'a string → nothing')
same(F.familiesFromListing({ length: 2, 0: { family: 'A' } }), [], 'an array-like object → nothing')
same(F.familiesFromListing([]), [], 'an empty listing → nothing')
const runaway = Array.from({ length: F.READING_FONT_LIST_MAX + 500 }, (_, i) => ({ family: 'F' + i }))
eq(F.familiesFromListing(runaway).length, F.READING_FONT_LIST_MAX, 'a runaway listing is capped')
ok(
  F.familiesFromListing(fam.map((family) => ({ family }))).every((n, i) => n === fam[i]),
  'listing the result again gives the same list (idempotent)'
)

// the order the menu shows: the current face first
same(F.orderFamilies(fam, 'Libertinus Serif'), ['Libertinus Serif', 'Bad One', 'Cambria', 'Évora', 'Georgia', 'Georgia Bold', 'Noto Sans 2', 'Noto Sans 10', 'Segoe UI'], 'the current face first, the rest in order')
same(F.orderFamilies(fam, ' "libertinus serif" '), F.orderFamilies(fam, 'Libertinus Serif'), 'the current name is normalised and case-folded before it is looked up')
same(F.orderFamilies(fam, 'Palatino'), fam, 'a current face the machine lacks changes nothing')
same(F.orderFamilies(fam, ''), fam, 'the default changes nothing')
same(F.orderFamilies([], 'Georgia'), [], 'an empty list stays empty')
ok(F.orderFamilies(fam, 'Georgia') !== fam, 'ordering returns a new array, the listing is not mutated')

// the typed filter — the chips' rule (section 6) with no cap, and the exact
// name kept at the top: the current face must stay in the list it opened
same(F.filterFamilies(fam, ''), fam, 'an empty query keeps everything')
same(F.filterFamilies(fam, '   '), fam, 'a blank query keeps everything')
same(F.filterFamilies(fam, 'geo'), ['Georgia', 'Georgia Bold'], 'a prefix, case-folded')
same(F.filterFamilies(fam, 'Georgia'), ['Georgia', 'Georgia Bold'], 'the exact name stays, first')
same(F.filterFamilies(fam, 'serif'), ['Libertinus Serif'], 'a word inside the name')
same(F.filterFamilies(fam, 'sans'), ['Noto Sans 2', 'Noto Sans 10'], 'inner matches keep the list order')
same(F.filterFamilies(fam, 'se'), ['Segoe UI', 'Libertinus Serif'], 'names that start with the query come before names that merely contain it')
same(F.filterFamilies(fam, 'Zapf'), [], 'no match → empty, never the whole list')
same(F.filterFamilies(fam, 'geo;{'), ['Georgia', 'Georgia Bold'], 'the query is normalised like a name before it is matched')
eq(F.filterFamilies(fam, 'o').length, fam.filter((f) => f.toLowerCase().includes('o')).length, 'the open list has no cap')

// 6) suggestions as the name is typed
console.log('6) the suggestions')
const NAMES = ['Georgia', 'Libertinus Serif', 'Libertinus Sans', 'Source Serif 4', 'Noto Serif', 'Segoe UI', 'Gill Sans']
const m = (q, limit) => F.matchFontNames(q, NAMES, limit)
eq(JSON.stringify(m('')), '[]', 'an empty query offers nothing')
eq(JSON.stringify(m('   ')), '[]', 'blanks offer nothing')
eq(JSON.stringify(m('lib')), '["Libertinus Serif","Libertinus Sans"]', 'a prefix, in list order')
eq(JSON.stringify(m('LIB')), '["Libertinus Serif","Libertinus Sans"]', 'case-folded')
eq(
  JSON.stringify(m('serif')),
  '["Libertinus Serif","Source Serif 4","Noto Serif"]',
  'a word the query opens, after no whole name does'
)
eq(JSON.stringify(m('eorg')), '["Georgia"]', 'an occurrence anywhere, last')
eq(JSON.stringify(m('Georgia')), '[]', 'the exact name is not offered back')
eq(JSON.stringify(m('georgia')), '[]', 'nor the exact name in another case')
eq(
  JSON.stringify(F.matchFontNames('s', ['Segoe UI', 'Source Serif 4', 'Gill Sans', 'Noto Serif'])),
  '["Segoe UI","Source Serif 4","Gill Sans","Noto Serif"]',
  'whole-name openers before word openers, each tier in list order'
)
eq(m('s', 2).length, 2, 'the limit cuts the list')
eq(JSON.stringify(m('s', 0)), '[]', 'a limit of zero offers nothing')
eq(JSON.stringify(F.matchFontNames('g', ['Georgia', 'georgia', 'Gill Sans'])), '["Georgia","Gill Sans"]', 'a name twice is offered once')
eq(JSON.stringify(m('"lib;')), '["Libertinus Serif","Libertinus Sans"]', 'the query is normalised like the name')
eq(JSON.stringify(m('xyz')), '[]', 'nothing matches → nothing')
ok(Array.isArray(F.COMMON_FONT_FAMILIES) && F.COMMON_FONT_FAMILIES.length > 50, 'the common list is a real list')
eq(new Set(F.COMMON_FONT_FAMILIES.map((s) => s.toLowerCase())).size, F.COMMON_FONT_FAMILIES.length, 'no family twice')
ok(
  F.COMMON_FONT_FAMILIES.every((s) => n(s) === s),
  'every common family survives normalising unchanged (it goes straight into the stack)'
)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nreading-font: all good')

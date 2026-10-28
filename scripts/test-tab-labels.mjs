// What a tab shows when its name does not tell it apart (src/shared/tab-labels.ts,
// Emil 2026-10-28: a full strip read «Hortacs…», «Hortacs…», «Handb…»).
//
// Names that begin alike are split where they part, so the strip can give way
// at the head and keep what differs; head + tail is always the whole name. The
// same name on two paths carries the fewest trailing folders that tell them
// apart. And the «Alle faner» search: every word, name or path, case-folded.
// Run: node scripts/test-tab-labels.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/tab-labels.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'tab-labels-'))
const out = join(dir, 'tab-labels.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const L = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

const tab = (path) => ({ name: path.split(/[\\/]/).pop(), path })
const labels = (...paths) => L.tabLabels(paths.map(tab))

// --- Nothing shared: names stand whole ----------------------------------------
eq(
  labels('C:\\a\\Davis and Hall.pdf', 'C:\\a\\Einav et al.pdf'),
  [
    { head: 'Davis and Hall.pdf', tail: '', dir: null },
    { head: 'Einav et al.pdf', tail: '', dir: null }
  ],
  'unrelated names are left whole'
)
eq(labels('C:\\a\\only.pdf'), [{ head: 'only.pdf', tail: '', dir: null }], 'a single tab is left whole')
eq(L.tabLabels([]), [], 'no tabs, no labels')

// --- Names that begin alike ----------------------------------------------------
{
  const [a, b] = labels('C:\\p\\Hortacsu Syverson 2015.pdf', 'C:\\p\\Hortacsu Puller 2008.pdf')
  eq([a.head, a.tail], ['Hortacsu ', 'Syverson 2015.pdf'], 'split at the word where they part')
  eq([b.head, b.tail], ['Hortacsu ', 'Puller 2008.pdf'], 'both sides are split')
  eq(a.head + a.tail, 'Hortacsu Syverson 2015.pdf', 'head + tail is the whole name')
}
{
  // Parting mid-word goes back to that word's start
  const [a, b] = labels('C:\\p\\Handbook of IO vol3.pdf', 'C:\\p\\Handbook of IO vol4.pdf')
  eq([a.head, a.tail], ['Handbook of IO ', 'vol3.pdf'], 'mid-word parting backs up to the word start')
  eq([b.head, b.tail], ['Handbook of IO ', 'vol4.pdf'], 'and the same for the other')
}
{
  // Parting AT a break cuts there
  const [a, b] = labels('C:\\p\\Handbook of IO.pdf', 'C:\\p\\Handbook of IO vol 2.pdf')
  eq([a.head, a.tail], ['Handbook of IO', '.pdf'], 'parting at a full stop cuts there')
  eq([b.head, b.tail], ['Handbook of IO', ' vol 2.pdf'], 'parting at a space cuts there (space kept)')
}
{
  // Underscores and hyphens are word breaks, as file names use them
  const [a] = labels('C:\\p\\Aguirre_Reguant_2024.pdf', 'C:\\p\\Aguirre_Reguant_2019.pdf')
  eq([a.head, a.tail], ['Aguirre_Reguant_', '2024.pdf'], 'underscores break words')
}
{
  // A long word parting deep inside keeps a few characters before the difference
  const [a] = labels('C:\\p\\Supercalifragilisticexpialidocious-A.pdf', 'C:\\p\\Supercalifragilisticexpialidocious-B.pdf')
  eq(a.tail.startsWith('-A') || a.tail.length <= 6, true, 'a long shared word is not backed up to its start')
  eq(a.head + a.tail, 'Supercalifragilisticexpialidocious-A.pdf', 'still the whole name')
}
{
  // A short shared beginning survives an end ellipsis by itself
  const [a] = labels('C:\\p\\Hort a.pdf', 'C:\\p\\Hort b.pdf')
  eq(a.tail, '', 'under MIN_SHARED nothing is split')
}
{
  // Case does not hide a shared beginning
  const [a] = labels('C:\\p\\hortacsu syverson.pdf', 'C:\\p\\Hortacsu Puller.pdf')
  eq(a.tail, 'syverson.pdf', 'prefix compared case-folded')
}
{
  // The closest neighbour decides: three names, one shares more with one of them
  const [a, b, c] = labels('C:\\p\\Report_2024_final.pdf', 'C:\\p\\Report_2024_draft.pdf', 'C:\\p\\Report_2019.pdf')
  eq(a.tail, 'final.pdf', 'the longest shared beginning wins')
  eq(b.tail, 'draft.pdf', 'for both sharers')
  eq(c.tail, '2019.pdf', 'the third parts earlier')
}

// --- The same name on different paths: folders --------------------------------
{
  const [a, b] = labels('C:\\x\\Downloads\\main.pdf', 'C:\\x\\Papers\\main.pdf')
  eq([a.head, a.tail, a.dir], ['main.pdf', '', 'Downloads'], 'identical names carry their folder')
  eq(b.dir, 'Papers', 'both of them')
}
{
  // The parent folders are alike too: as many as it takes
  const [a, b] = labels('C:\\one\\proj\\main.pdf', 'C:\\two\\proj\\main.pdf')
  eq([a.dir, b.dir], ['one\\proj', 'two\\proj'], 'two folders when one is not enough, in the path\'s own separator')
}
{
  const [a, b] = labels('/home/e/a/x.pdf', '/home/e/b/x.pdf')
  eq([a.dir, b.dir], ['a', 'b'], 'forward slashes')
}
{
  // A tab duplicated on ONE path is the same document — nothing to add
  const [a, b] = L.tabLabels([tab('C:\\p\\paper.pdf'), tab('C:\\p\\paper.pdf')])
  eq([a.dir, b.dir, a.tail], [null, null, ''], 'a duplicate on the same path gets no folder and no split')
}
{
  // Identical names in different case are still identical names
  const [a, b] = L.tabLabels([
    { name: 'Paper.pdf', path: 'C:\\a\\Paper.pdf' },
    { name: 'paper.pdf', path: 'C:\\b\\paper.pdf' }
  ])
  eq([a.dir, b.dir, a.tail, b.tail], ['a', 'b', '', ''], 'case-folded identity, and no prefix split between them')
}
{
  // An identical pair beside a third that only begins alike
  const [a, b, c] = labels('C:\\a\\Smith 2020.pdf', 'C:\\b\\Smith 2020.pdf', 'C:\\a\\Smith 2021.pdf')
  eq([a.dir, b.dir], ['a', 'b'], 'the twins get folders')
  eq([a.tail, c.tail], ['2020.pdf', '2021.pdf'], 'and the near-twin still splits against them')
}
{
  // URLs: the host is the outermost folder, query and fragment are not folders
  const [a, b] = L.tabLabels([
    { name: 'paper.pdf', path: 'https://one.org/files/paper.pdf?x=1' },
    { name: 'paper.pdf', path: 'https://two.org/files/paper.pdf#p=2' }
  ])
  eq([a.dir, b.dir], ['one.org/files', 'two.org/files'], 'URLs walk up to the host')
}

// --- folderOf / folderSegments --------------------------------------------------
eq(L.folderOf('C:\\Users\\e\\Zotero\\storage\\ABCD1234\\x.pdf'), 'ABCD1234', 'the folder a file lies in')
eq(L.folderOf('/tmp/x.pdf'), 'tmp', 'posix')
eq(L.folderOf('x.pdf'), '', 'no folder')
eq(L.folderOf('https://pubs.aeaweb.org/doi/pdfplus/10.1257/jep.29.4.89'), '10.1257', 'a URL\'s last folder')
eq(L.folderSegments('\\\\server\\share\\dir\\x.pdf'), ['server', 'share', 'dir'], 'UNC paths')

// --- The list's search ------------------------------------------------------------
const t1 = { name: 'Hortacsu Syverson 2015.pdf', path: 'C:\\Papers\\IO\\Hortacsu Syverson 2015.pdf' }
eq(L.matchesTabQuery(t1, ''), true, 'an empty query keeps every tab')
eq(L.matchesTabQuery(t1, '   '), true, 'blanks are an empty query')
eq(L.matchesTabQuery(t1, 'syv'), true, 'a fragment of the name')
eq(L.matchesTabQuery(t1, 'SYV 2015'), true, 'every word, case-folded')
eq(L.matchesTabQuery(t1, 'syv 2016'), false, 'every word must occur')
eq(L.matchesTabQuery(t1, 'io'), true, 'the folder counts')
eq(L.matchesTabQuery({ name: 'Økonomi.pdf', path: 'C:\\Økonomi.pdf' }, 'øko'), true, 'æøå fold')
eq(L.matchesTabQuery(t1, '.*'), false, 'regex characters are literal')

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('tab-labels: all checks passed')

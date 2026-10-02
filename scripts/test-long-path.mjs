// Windows 8.3 aliases never become a document's identity (src/main/long-path.ts).
//
// The failure is silent and lands on someone's own file: a launcher hands us
// "EFFECT~1.pdf", Save renames a temp file onto that name, and the paper comes
// back called EFFECT~1.pdf with its real name gone (issue #24). Nothing in a
// build or a unit test of the save path notices — the save "worked".
//
// Part 1 is the logic, run everywhere with the resolver injected. Part 2 is the
// real thing on a Windows volume that has aliases: it first proves the OLD
// behaviour really destroys the name (so the fixture cannot pass by accident),
// then that the fix keeps it.
// Run: node scripts/test-long-path.mjs
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/main/long-path.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'long-path-build-'))
const out = join(dir, 'long-path.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { toLongPath } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
  }
}

/** A resolver that answers from a table and throws like the real one for the rest */
function resolver(table, calls = []) {
  return (p) => {
    calls.push(p)
    const hit = table[p]
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return hit
  }
}

const LONG =
  'Effect of Steam, Carbonation, and Autoclave Curing on the Mechanical, Durability, and Microstructure Properties of UHPC A Compreh.pdf'

// --- logic, everywhere --------------------------------------------------------
console.log('toLongPath (injected resolver)')
{
  const calls = []
  const real = resolver({ 'C:\\p\\EFFECT~1.pdf': `C:\\p\\${LONG}` }, calls)
  eq(toLongPath('C:\\p\\EFFECT~1.pdf', real, 'linux'), 'C:\\p\\EFFECT~1.pdf', 'not Windows: ~1 is just a name')
  eq(toLongPath('/home/e/EFFECT~1.pdf', real, 'darwin'), '/home/e/EFFECT~1.pdf', 'not Windows (mac)')
  eq(calls.length, 0, 'not Windows: the resolver is never asked')
}
{
  const calls = []
  const real = resolver({}, calls)
  eq(toLongPath(`C:\\p\\${LONG}`, real, 'win32'), `C:\\p\\${LONG}`, 'a long name is left alone')
  eq(calls.length, 0, 'no tilde+digit: the resolver is never asked (the fast path)')
}
{
  const real = resolver({ 'C:\\p\\EFFECT~1.pdf': `C:\\p\\${LONG}` })
  eq(toLongPath('C:\\p\\EFFECT~1.pdf', real, 'win32'), `C:\\p\\${LONG}`, 'a file alias becomes the long name')
}
{
  const real = resolver({
    'C:\\USERS\\EMILMA~1\\DOCUME~1\\EFFECT~1.PDF': `C:\\Users\\Emil\\Documents\\${LONG}`,
    [`C:\\USERS\\Emil\\Documents\\${LONG}`]: `C:\\Users\\Emil\\Documents\\${LONG}`
  })
  // The user directories are aliases too — all three components expand, and the
  // casing the caller gave for the parts that were NOT aliases is kept
  eq(
    toLongPath('C:\\USERS\\EMILMA~1\\DOCUME~1\\EFFECT~1.PDF', real, 'win32'),
    `C:\\USERS\\Emil\\Documents\\${LONG}`,
    'directory aliases expand too; non-alias casing kept'
  )
}
{
  // A mapped drive resolves to its UNC form. The path is the key for drafts and
  // reading positions, so the drive letter must survive: only the alias changes.
  const real = resolver({
    'Z:\\Papers\\EFFECT~1.pdf': `\\\\srv\\share\\Papers\\${LONG}`,
    [`Z:\\Papers\\${LONG}`]: `\\\\srv\\share\\Papers\\${LONG}`
  })
  eq(toLongPath('Z:\\Papers\\EFFECT~1.pdf', real, 'win32'), `Z:\\Papers\\${LONG}`, 'a mapped drive stays a mapped drive')
}
{
  // A link in the middle shifts the positions: the tail swap would put "x" where
  // A~1 was and lead nowhere. The merged path is verified against the resolver's
  // own answer, and when it does not match the answer wins.
  const real = resolver({ 'C:\\A~1\\link\\f.pdf': 'D:\\x\\y\\f.pdf' })
  eq(toLongPath('C:\\A~1\\link\\f.pdf', real, 'win32'), 'D:\\x\\y\\f.pdf', 'a link mid-path: the resolver is the truth')
}
{
  const real = resolver({})
  eq(toLongPath('C:\\p\\EFFECT~1.pdf', real, 'win32'), 'C:\\p\\EFFECT~1.pdf', 'a path that does not exist comes back unchanged')
}
{
  // "draft~1.pdf" is a perfectly good real name; resolving it changes nothing
  const real = resolver({ 'C:\\p\\draft~1.pdf': 'C:\\p\\draft~1.pdf' })
  eq(toLongPath('C:\\p\\draft~1.pdf', real, 'win32'), 'C:\\p\\draft~1.pdf', 'a real name that merely contains ~1 is untouched')
}
{
  // Same name, different case from the resolver's: not an alias being expanded,
  // so the caller's spelling stands (no churn in the draft key)
  const real = resolver({ 'C:\\p\\Draft~1.pdf': 'C:\\p\\DRAFT~1.PDF' })
  eq(toLongPath('C:\\p\\Draft~1.pdf', real, 'win32'), 'C:\\p\\Draft~1.pdf', 'a case-only difference is not an expansion')
}

// --- the real thing, Windows with 8.3 enabled ---------------------------------
console.log('toLongPath (real filesystem)')
if (process.platform !== 'win32') {
  console.log('  skipped: aliases are a Windows filesystem feature')
} else {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'long-path-')))
  try {
    const original = join(base, LONG)
    const draft = join(base, 'draft.bin')
    writeFileSync(original, 'original bytes')
    writeFileSync(draft, 'edited bytes')

    // %~s is the shell's own short form of the whole path
    const alias = execFileSync('cmd', ['/c', 'for', '%I', 'in', `("${original}")`, 'do', '@echo', '%~sI'], {
      encoding: 'utf8',
      windowsVerbatimArguments: true
    }).trim()

    if (!/~\d/.test(alias)) {
      console.log('  skipped: this volume has no 8.3 aliases (fsutil 8dot3name), nothing to test against')
    } else {
      eq(toLongPath(alias).toLowerCase(), original.toLowerCase(), 'the real alias expands to the real path')
      eq(toLongPath(alias).split('\\').pop(), LONG, 'the file name comes back exactly, commas and all')
      eq(readFileSync(toLongPath(alias), 'utf8'), 'original bytes', 'and the expanded path opens the same file')
      eq(toLongPath(original), original, 'a path that is already long is returned as it is')

      // The fixture must really reproduce the bug, or the next check proves nothing:
      // the OLD save (rename a temp file onto the alias) has to lose the long name.
      const oldTmp = `${alias}.pdfx-tmp`
      copyFileSync(draft, oldTmp)
      renameSync(oldTmp, alias)
      const afterOld = readdirSync(base).filter((n) => n !== 'draft.bin')
      eq(afterOld.includes(LONG), false, 'fixture: renaming onto the alias DOES destroy the long name (the bug)')
      eq(afterOld.length, 1, 'fixture: and leaves exactly one file behind, named for the alias')
      rmSync(join(base, afterOld[0]), { force: true })

      // The fix: the same save, destination expanded first (what saveDraft does)
      writeFileSync(original, 'original bytes')
      const target = toLongPath(alias)
      const tmp = `${target}.pdfx-tmp`
      copyFileSync(draft, tmp)
      renameSync(tmp, target)
      const afterFix = readdirSync(base).filter((n) => n !== 'draft.bin')
      eq(JSON.stringify(afterFix), JSON.stringify([LONG]), 'saving through the alias keeps the long name, and only it')
      eq(readFileSync(original, 'utf8'), 'edited bytes', 'and the edit landed in that file')
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

rmSync(dir, { recursive: true, force: true })
if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nOK')

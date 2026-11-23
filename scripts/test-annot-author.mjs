// «Navn på merknader» filled in from the system once (src/shared/annot-author.ts,
// Simen's wish 2026-11-23). The system's name is outside input — a registry
// value, a GECOS field — so it is cleaned before it can be stored; the seed
// fills an EMPTY field ONCE and never re-signs a reader who cleared it. Then,
// on this machine, the real lookup (src/main/system-user-name.ts) answers with
// a clean name and does not hang. Run: node scripts/test-annot-author.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'annot-author-'))
async function load(rel, name) {
  const out = join(dir, name)
  await build({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    outfile: out,
    format: 'esm',
    platform: 'node',
    bundle: true,
    logLevel: 'silent'
  })
  return import(pathToFileURL(out).href)
}
const A = await load('../src/shared/annot-author.ts', 'annot-author.mjs')
const S = await load('../src/main/system-user-name.ts', 'system-user-name.mjs')

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// --- cleanAuthorName: the system's name is untrusted -------------------------
eq(A.cleanAuthorName('Emil Mathias Strøm Halseth'), 'Emil Mathias Strøm Halseth', 'a plain name, æøå kept')
eq(A.cleanAuthorName('  Simen   Hansen \r\n'), 'Simen Hansen', 'whitespace runs and the line end go')
eq(A.cleanAuthorName('Ada\u0000Love\u001blace'), 'Ada Love lace', 'control characters become spaces')
eq(A.cleanAuthorName('evil‮exe.pdf'), 'evil exe.pdf', 'a bidi override cannot reorder the name')
eq(A.cleanAuthorName(''), '', 'empty')
eq(A.cleanAuthorName('   '), '', 'blank')
eq(A.cleanAuthorName(null), '', 'null')
eq(A.cleanAuthorName(42), '', 'a number')
eq(A.cleanAuthorName({ name: 'x' }), '', 'an object')
eq(A.cleanAuthorName('x'.repeat(500)).length, A.AUTHOR_NAME_MAX, 'a runaway value is capped')
eq(Array.from(A.cleanAuthorName('😀'.repeat(100))).length, A.AUTHOR_NAME_MAX, 'the cap counts characters, never splits a surrogate pair')
eq(A.cleanAuthorName('a'.repeat(63) + ' b'), 'a'.repeat(63), 'a cap landing on a space leaves no trailing blank')

// --- pickAuthorName: the first usable candidate -------------------------------
eq(A.pickAuthorName(['', '  ', 'Full Name', 'login']), 'Full Name', 'blank candidates are passed over')
eq(A.pickAuthorName(['', 'login']), 'login', 'the login name when no full name answers')
eq(A.pickAuthorName([undefined, null, '\r\n']), '', 'nothing usable at all')
eq(A.pickAuthorName([]), '', 'no candidates')

// --- seedAuthor: once, empty only ---------------------------------------------
eq(A.seedAuthor('', false, 'Simen Hansen'), 'Simen Hansen', 'an empty field on a first start is filled')
eq(A.seedAuthor('Typed Name', false, 'Simen Hansen'), 'Typed Name', 'a name already typed is kept')
eq(A.seedAuthor('', true, 'Simen Hansen'), '', 'a field cleared after the seed stays cleared')
eq(A.seedAuthor('Typed', true, 'Simen Hansen'), 'Typed', 'a seeded profile is never touched')
eq(A.seedAuthor('', false, ''), '', 'the system saying nothing leaves the field empty')
eq(A.seedAuthor('', false, ' Bad\u0007Name '), 'Bad Name', 'the seeded name is cleaned')

// --- parseRegString: a `reg export` file ---------------------------------------
const REG = '﻿Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Office\\Common\\UserInfo]\r\n"Company"=""\r\n"UserName"="Emil Mathias Strøm Halseth"\r\n"UserInitials"="EH"\r\n'
eq(A.parseRegString(REG, 'UserName'), 'Emil Mathias Strøm Halseth', 'the value, æøå intact')
eq(A.parseRegString(REG, 'username'), 'Emil Mathias Strøm Halseth', 'value names are case-insensitive, as in the registry')
eq(A.parseRegString(REG, 'Company'), '', 'an empty value')
eq(A.parseRegString(REG, 'Missing'), '', 'an absent value')
eq(A.parseRegString('"UserName"="A \\"B\\" C\\\\D"\r\n', 'UserName'), 'A "B" C\\D', 'escaped quotes and backslashes undone')
eq(A.parseRegString('"UserName"=dword:00000001\r\n', 'UserName'), '', 'a non-string value is not a name')
eq(A.parseRegString('', 'UserName'), '', 'an empty file')

// --- the real lookup on this machine -------------------------------------------
const t0 = Date.now()
const name = await S.systemUserName()
const ms = Date.now() - t0
eq(typeof name, 'string', 'the lookup answers with a string')
eq(A.cleanAuthorName(name), name, 'what it answers is already clean')
eq(name.length > 0, true, 'this machine has a user to name')
eq(ms < 6000, true, `the lookup returns within its timeout (took ${ms} ms)`)
console.log(`  system name: ${JSON.stringify(name)} (${ms} ms)`)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('annot-author: all good')

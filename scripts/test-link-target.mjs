// Proof for src/shared/link-target.ts — what the point menu over a link offers
// to copy: the bare address of a mailto: link (never «mailto:», never the
// ?subject=… tail), the URL of a web link, and nothing for anything else.
// Run: node scripts/test-link-target.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/link-target.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'link-target-'))
const out = join(dir, 'link-target.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const { copyableLink } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

console.log('mailto')
eq(copyableLink('mailto:fredrik.sorensen@compass-group.no'), { kind: 'email', text: 'fredrik.sorensen@compass-group.no' }, 'plain address')
eq(copyableLink('MAILTO:a@b.no'), { kind: 'email', text: 'a@b.no' }, 'scheme is case-insensitive')
eq(copyableLink('mailto:a@b.no?subject=Hi%20there&body=x'), { kind: 'email', text: 'a@b.no' }, 'query dropped')
eq(copyableLink('mailto:a%2Bb@b.no'), { kind: 'email', text: 'a+b@b.no' }, 'percent escapes decoded')
eq(copyableLink('mailto:a@b.no,c@d.no'), { kind: 'email', text: 'a@b.no,c@d.no' }, 'several recipients stay together')
eq(copyableLink('mailto:100%@b.no'), { kind: 'email', text: '100%@b.no' }, 'a broken escape keeps the raw text')
eq(copyableLink('  mailto:a@b.no  '), { kind: 'email', text: 'a@b.no' }, 'surrounding space trimmed')
eq(copyableLink('mailto:'), null, 'empty mailto')
eq(copyableLink('mailto:?subject=Hi'), null, 'mailto with no recipient')

console.log('web')
eq(copyableLink('https://github.com/emilmsh/pdf-scholar'), { kind: 'web', text: 'https://github.com/emilmsh/pdf-scholar' }, 'https')
eq(copyableLink('http://example.com/a?b=c#d'), { kind: 'web', text: 'http://example.com/a?b=c#d' }, 'http keeps query and fragment')

console.log('nothing to copy')
eq(copyableLink('javascript:alert(1)'), null, 'javascript:')
eq(copyableLink('file:///C:/secret.pdf'), null, 'file:')
eq(copyableLink(''), null, 'empty')
eq(copyableLink(undefined), null, 'undefined')
eq(copyableLink(null), null, 'null')

if (failures) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nlink-target: all good')

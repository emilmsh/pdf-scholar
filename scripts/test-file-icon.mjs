// Proof for the .pdf file icon (issue #26) — the parts that can be checked
// without a Windows install:
//   1) The ProgId the app rewrites (src/shared/file-icon.ts) is the ProgId the
//      installer registers (fileAssociations[].name in electron-builder.yml).
//      A rename on either side would have the app writing a key nothing reads.
//   2) The DefaultIcon value per choice: the installer's own path for the
//      document icon, `exe,0` for the app logo, the reader's file for custom —
//      and null when no file was chosen.
//   3) Only .ico names pass the picker's guard.
//   4) The shipped icon files exist and are what their containers claim:
//      build/pdf.ico holds PNG entries at the sizes Explorer draws, build/pdf.icns
//      is a well-formed ICNS. electron-builder picks both up BY NAME
//      (`<ext>.ico` / `<ext>.icns`), so a missing or misnamed file silently
//      falls back to the app logo — which is the regression this guards.
// Run: node scripts/test-file-icon.mjs
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(root, 'src', 'shared', 'file-icon.ts')
const dir = mkdtempSync(join(tmpdir(), 'file-icon-'))
const out = join(dir, 'file-icon.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)

let failures = 0
const ok = (cond, msg) => {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

console.log('1) the ProgId matches the installer config')
const yml = readFileSync(join(root, 'config', 'electron-builder.yml'), 'utf-8')
const assoc = /fileAssociations:\s*\n\s*- ext: pdf\s*\n\s*name: (.+)$/m.exec(yml)
ok(!!assoc, 'electron-builder.yml has a pdf fileAssociations entry with a name')
if (assoc) eq(M.PDF_PROGID, assoc[1].trim(), 'PDF_PROGID equals fileAssociations[].name')

console.log('2) the DefaultIcon value per choice')
const paths = { resourcesPath: 'C:\\App\\resources', execPath: 'C:\\App\\PDF Scholar.exe', customPath: 'C:\\Users\\me\\AppData\\Roaming\\pdfx\\file-icons\\mine.ico' }
eq(M.fileIconRegistryValue('document', paths), 'C:\\App\\resources\\pdf.ico', 'document → the installed pdf.ico')
eq(M.fileIconRegistryValue('app', paths), 'C:\\App\\PDF Scholar.exe,0', 'app → exe,0')
eq(M.fileIconRegistryValue('document-lines', paths), 'C:\\App\\resources\\file-icons\\document-lines.ico', 'document-lines → the extraResources copy')
eq(M.fileIconRegistryValue('document-quiet', paths), 'C:\\App\\resources\\file-icons\\document-quiet.ico', 'document-quiet → the extraResources copy')
eq(M.fileIconRegistryValue('custom', paths), paths.customPath, 'custom → the kept copy')
eq(M.fileIconRegistryValue('custom', { ...paths, customPath: '' }), null, 'custom without a file → null')
eq(M.fileIconRegistryValue('custom', { ...paths, customPath: '   ' }), null, 'custom with a blank path → null')
eq(M.fileIconRegistryValue('plaid', paths), 'C:\\App\\resources\\pdf.ico', 'an unknown stored choice → the document icon')
eq(M.FILE_ICON_CHOICES.join(), 'document,document-lines,document-quiet,app,custom', 'the five choices, the default first')
// The renderer script's variant ids are the shared list, in order — a variant
// added on one side only would ship an .ico nothing can choose, or a choice
// pointing at an .ico that was never rendered
const renderSrc = readFileSync(join(root, 'scripts', 'render-file-icon.cjs'), 'utf-8')
const renderedIds = [...renderSrc.matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1])
eq(renderedIds.join(), M.FILE_ICON_VARIANTS.join(), 'render-file-icon.cjs renders exactly the shared variants')
// extraResources must carry the non-default variants
ok(/extraResources:\s*\n\s*- from: build\/file-icons\s*\n\s*to: file-icons/.test(yml), 'electron-builder.yml ships build/file-icons as resources/file-icons')

console.log('3) only .ico passes the picker guard')
for (const good of ['mine.ico', 'C:\\x\\y\\Z.ICO', ' a.ico ']) ok(M.isIcoName(good), `${JSON.stringify(good)} is an .ico`)
for (const bad of ['mine.exe', 'icon.png', 'mine.ico.exe', 'ico', '']) ok(!M.isIcoName(bad), `${JSON.stringify(bad)} is refused`)
for (const code of ['file-icon-unavailable', 'file-icon-not-ico', 'file-icon-registry']) ok(M.isFileIconErrorCode(code), `${code} is a named failure`)
ok(!M.isFileIconErrorCode('attach-blocked'), 'a code from another family is not')

console.log('4) the shipped icon files are real containers at the right sizes')
const ico = join(root, 'build', 'pdf.ico')
const icns = join(root, 'build', 'pdf.icns')
ok(existsSync(ico), 'build/pdf.ico exists (electron-builder picks it up by name)')
ok(existsSync(icns), 'build/pdf.icns exists (same rule, macOS)')
for (const v of M.FILE_ICON_VARIANTS) {
  if (v !== 'document') ok(existsSync(join(root, 'build', 'file-icons', `${v}.ico`)), `build/file-icons/${v}.ico exists`)
  ok(existsSync(join(root, 'src', 'renderer', 'src', 'assets', 'file-icons', `${v}.png`)), `picker preview for ${v} exists`)
}
ok(existsSync(join(root, 'src', 'renderer', 'src', 'assets', 'file-icons', 'app.png')), 'picker preview for the app logo exists')
if (existsSync(ico)) {
  const b = readFileSync(ico)
  eq(b.readUInt16LE(2), 1, 'ICO type is 1 (icon)')
  const n = b.readUInt16LE(4)
  const sizes = []
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    sizes.push(b[o] || 256)
    const off = b.readUInt32LE(o + 12)
    eq(b.slice(off, off + 8).toString('hex'), '89504e470d0a1a0a', `entry ${i} is a PNG`)
  }
  for (const want of [16, 32, 48, 256]) ok(sizes.includes(want), `ICO carries ${want} px (has ${sizes.join(', ')})`)
}
if (existsSync(icns)) {
  const c = readFileSync(icns)
  eq(c.slice(0, 4).toString('ascii'), 'icns', 'ICNS magic')
  eq(c.readUInt32BE(4), c.length, 'ICNS length field equals the file length')
  const types = []
  for (let p = 8; p < c.length; ) {
    types.push(c.slice(p, p + 4).toString('ascii'))
    p += c.readUInt32BE(p + 4)
  }
  for (const want of ['icp4', 'icp5', 'ic08', 'ic09']) ok(types.includes(want), `ICNS carries ${want} (has ${types.join(', ')})`)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll file-icon checks passed.')

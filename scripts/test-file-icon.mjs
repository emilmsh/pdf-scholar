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
for (const v of M.FILE_ICON_VARIANTS) {
  if (v === 'document') continue
  eq(M.fileIconRegistryValue(v, paths), `C:\\App\\resources\\file-icons\\${v}.ico`, `${v} → the extraResources copy`)
}
eq(M.FILE_ICON_VARIANTS.join(), 'document,document-plain,document-lines,document-lines-plain,document-quiet,document-quiet-plain', 'six variants: three colourings, badge and plain')
eq(M.splitVariant('document-lines-plain').colouring, 'document-lines', 'splitVariant: colouring')
eq(M.splitVariant('document-lines-plain').badge, false, 'splitVariant: plain has no badge')
eq(M.splitVariant('document').badge, true, 'splitVariant: the bare id has the badge')
eq(M.variantFor('document-quiet', false), 'document-quiet-plain', 'variantFor: plain')
eq(M.variantFor('document-quiet', true), 'document-quiet', 'variantFor: badged')
ok(M.isFileIconVariant('document-plain') && !M.isFileIconVariant('app') && !M.isFileIconVariant('custom'), 'isFileIconVariant')
eq(M.fileIconRegistryValue('custom', paths), paths.customPath, 'custom → the kept copy')
eq(M.fileIconRegistryValue('custom', { ...paths, customPath: '' }), null, 'custom without a file → null')
eq(M.fileIconRegistryValue('custom', { ...paths, customPath: '   ' }), null, 'custom with a blank path → null')
eq(M.fileIconRegistryValue('plaid', paths), 'C:\\App\\resources\\pdf.ico', 'an unknown stored choice → the document icon')
eq(M.FILE_ICON_CHOICES.join(), 'document,document-lines,document-quiet,app,custom', "the picker's five chips, the default first")
// The renderer script's variant ids are the shared list, in order — a variant
// added on one side only would ship an .ico nothing can choose, or a choice
// pointing at an .ico that was never rendered
const renderSrc = readFileSync(join(root, 'scripts', 'render-file-icon.cjs'), 'utf-8')
const renderedColourings = [...renderSrc.matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1])
eq(renderedColourings.join(), M.FILE_ICON_COLOURINGS.join(), 'render-file-icon.cjs renders exactly the shared colourings')
ok(/id: `\$\{c\.id\}-plain`/.test(renderSrc), 'render-file-icon.cjs renders a -plain twin of each colouring')
// extraResources must carry the non-default variants
ok(/extraResources:\s*\n\s*- from: build\/file-icons\s*\n\s*to: file-icons/.test(yml), 'electron-builder.yml ships build/file-icons as resources/file-icons')

console.log('3) the picker guard: .ico and .png in, programs out — and the ICO packer')
for (const good of ['mine.ico', 'C:\\x\\y\\Z.ICO', ' a.ico ']) eq(M.iconSourceKind(good), 'ico', `${JSON.stringify(good)} is an .ico`)
for (const good of ['logo.png', 'C:\\x\\LOGO.PNG']) eq(M.iconSourceKind(good), 'png', `${JSON.stringify(good)} is a .png`)
for (const bad of ['mine.exe', 'icon.jpg', 'mine.ico.exe', 'mine.png.exe', 'ico', '']) eq(M.iconSourceKind(bad), null, `${JSON.stringify(bad)} is refused`)
ok(M.isIcoName('a.ico') && !M.isIcoName('a.png'), 'isIcoName still answers for .ico alone')
eq(M.ICO_SIZES.join(), '16,32,48,256', "Explorer's sizes")
eq(M.MIN_ICON_SOURCE_PX, 48, 'a PNG must at least fill the tile view')
// packIco: a header and a table in front of the payloads, verbatim
const fakePng = (n) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array(n).fill(7)])
const ico2 = M.packIco([{ size: 256, png: fakePng(10) }, { size: 16, png: fakePng(4) }, { size: 512, png: fakePng(3) }])
const dv = new DataView(ico2.buffer)
eq(dv.getUint16(2, true), 1, 'packIco: type 1')
eq(dv.getUint16(4, true), 2, 'packIco: the 512 entry is dropped (not legal ICO)')
eq(ico2[6], 0, 'packIco: 256 is written as 0')
eq(ico2[22], 16, 'packIco: 16 is written as 16')
eq(dv.getUint32(6 + 12, true), 6 + 32, 'packIco: first payload right after the table')
eq(dv.getUint32(22 + 12, true), 6 + 32 + 14, 'packIco: second payload after the first')
eq(ico2.length, 6 + 32 + 14 + 8, 'packIco: total length')
eq(Array.from(ico2.slice(38, 42)).map((b) => b.toString(16)).join(''), '89504e47', 'packIco: payload bytes intact')
for (const code of ['file-icon-unavailable', 'file-icon-bad-file', 'file-icon-not-square', 'file-icon-too-small', 'file-icon-registry']) ok(M.isFileIconErrorCode(code), `${code} is a named failure`)
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

// Pack dist-extension/ into a zip. Two shapes, because the two consumers want
// opposite things:
//
//   (default)  release/pdf-scholar-extension.zip
//              ONE top-level folder, so "unzip anywhere" leaves exactly one
//              directory to point Load unpacked at (bare files at the zip root
//              spilled assets/, icons/ etc. into whatever folder the user
//              extracted to). This is the README download button's asset.
//
//   --store    release/pdf-scholar-extension-store.zip
//              manifest.json at the zip ROOT, as the Chrome Web Store and Edge
//              Add-ons uploaders require. A folder-wrapped zip is REJECTED
//              there ("manifest not found").
//
// Entry names always use forward slashes (see scripts/lib/zip.mjs — the Windows
// built-ins write backslashes, which store uploaders mis-parse). This script is
// the ONLY implementation of those two zip shapes: release.yml calls it rather
// than rebuilding the layout in shell, so the contract cannot drift.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { writeZip } from './lib/zip.mjs'

const store = process.argv.includes('--store')
const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist-extension')
const out = join(root, 'release', store ? 'pdf-scholar-extension-store.zip' : 'pdf-scholar-extension.zip')

if (!existsSync(dist)) {
  console.error('dist-extension/ not found — run `npm run build:ext` first')
  process.exit(1)
}

/** Every file under `dir`, as zip entries rooted at `prefix`. */
function collect(dir, prefix) {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    const zipName = prefix ? `${prefix}/${relative(dir, full).replace(/\\/g, '/')}` : name
    if (stat.isDirectory()) entries.push(...collect(full, zipName))
    else entries.push({ name: zipName, data: readFileSync(full), mtime: stat.mtime })
  }
  return entries
}

const entries = collect(dist, store ? '' : 'pdf-scholar-extension')

// Edge Add-ons rejects the WHOLE package when one file inside it is itself
// compressed («PackageValidationError | The uploaded package consists of a
// compressed file») — v0.73.0's OCR models went up as .traineddata.gz and the
// submission failed after the release was already out. Judged by the bytes,
// not the name, so a renamed archive is caught too; checked for both zips,
// since the Load-unpacked one is the same build.
const SIGNATURES = [
  ['gzip', [0x1f, 0x8b]],
  ['zip', [0x50, 0x4b, 0x03, 0x04]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['bzip2', [0x42, 0x5a, 0x68]],
  ['rar', [0x52, 0x61, 0x72, 0x21]]
]
const compressed = entries.flatMap(({ name, data }) => {
  const hit = SIGNATURES.find(([, magic]) => magic.every((b, i) => data[i] === b))
  return hit ? [`${name} (${hit[0]})`] : []
})
if (compressed.length) {
  console.error(`Compressed file(s) in the extension — Edge Add-ons refuses the package:\n  ${compressed.join('\n  ')}`)
  process.exit(1)
}

mkdirSync(join(root, 'release'), { recursive: true })
writeZip(out, entries)

const version = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).version
const size = (statSync(out).size / 1024 / 1024).toFixed(2)
console.log(
  `Wrote ${out} — v${version}, ${entries.length} files, ${size} MB ` +
    `(${store ? 'manifest at zip root: store upload' : 'top-level folder: Load unpacked'})`
)

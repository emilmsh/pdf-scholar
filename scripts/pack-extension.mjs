// Pack dist-extension/ into release/pdf-scholar-extension.zip with a single
// top-level folder, so "unzip anywhere" leaves exactly one directory to point
// Load unpacked at (bare files at the zip root spilled assets/, icons/ etc.
// into whatever folder the user extracted to).
//
// Windows-only (shells out to PowerShell's Compress-Archive) — matches the
// rest of the tooling, which already targets Windows (electron-builder --win).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist-extension')
const out = join(root, 'release', 'pdf-scholar-extension.zip')

if (!existsSync(dist)) {
  console.error('dist-extension/ not found — run `npm run build:ext` first')
  process.exit(1)
}

const stage = join(tmpdir(), 'pdf-scholar-pack')
const folder = join(stage, 'pdf-scholar-extension')
rmSync(stage, { recursive: true, force: true })
mkdirSync(folder, { recursive: true })
cpSync(dist, folder, { recursive: true })
mkdirSync(join(root, 'release'), { recursive: true })

const ps = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${folder}' -DestinationPath '${out}' -Force`
  ],
  { stdio: 'inherit' }
)
rmSync(stage, { recursive: true, force: true })
if (ps.status !== 0) process.exit(ps.status ?? 1)
console.log(`Wrote ${out} (top-level folder: pdf-scholar-extension/)`)

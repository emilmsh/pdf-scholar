// Keep the folder Edge has loaded unpacked pointing at a CURRENT build.
//
// "Load unpacked" binds a browser to one absolute path forever, and Chromium
// derives an unpacked extension's ID from that path: move the folder and the
// browser sees a different extension, so chrome.storage.local — recents, reading
// positions, THE AI API KEYS — starts empty and "Allow access to file URLs" has
// to be granted again. The loaded path is therefore treated as fixed: the MAIN
// working tree's dist-extension/, which is where `npm run build:ext` writes when
// run in the main clone.
//
// The problem this solves is the git worktree. Every worktree has its own
// dist-extension/, so a build made in one leaves the folder the browser watches
// untouched — the app can sit at 0.39.0 while Edge still runs the 0.38.2 build
// somebody made in the main clone weeks ago. This script mirrors a freshly built
// dist-extension/ into the main tree's copy from wherever it was built, so the
// browser is one reload away from the newest code no matter which tree produced
// it.
//
// Two entry points:
//   npm run ext:local          build here, then sync (always)
//   postbuild:ext (--auto)     after any local build:ext — silent on CI, and it
//                              declines to push a feature branch's build into
//                              the browser's folder unless asked explicitly
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const auto = args.includes('--auto')
const force = args.includes('--force')
const outFlag = args.indexOf('--out')
const root = resolve(import.meta.dirname, '..')
const src = join(root, 'dist-extension')

/** The main working tree's root — a worktree's .git file points at its common dir. */
function mainTreeRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    // <main>/.git → <main>. A bare or unusual layout falls through to `root`.
    return common.endsWith('/.git') || common.endsWith('\.git') ? dirname(common) : root
  } catch {
    return root
  }
}

function branch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const dst = resolve(
  outFlag >= 0 ? args[outFlag + 1] : process.env.PDFX_EXT_LOCAL_DIR || join(mainTreeRoot(), 'dist-extension')
)

// CI builds the extension too (release.yml → pack:ext); it has no browser to
// serve, and writing outside the checkout there is pure noise.
if (auto && process.env.CI) process.exit(0)

if (!existsSync(join(src, 'manifest.json'))) {
  if (auto) process.exit(0)
  console.error('dist-extension/ not found here — run `npm run build:ext` first')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')).version

if (src === dst) {
  // The main clone: build:ext already wrote exactly where the browser looks.
  if (!auto) console.log(`dist-extension/ v${version} is the folder the browser loads — nothing to sync.`)
  process.exit(0)
}

const here = branch()
if (auto && !force && here !== 'master') {
  console.log(
    `(not synced to ${dst} — this is branch ${here || 'unknown'}; run \`npm run ext:local\` to load it in the browser anyway)`
  )
  process.exit(0)
}

// We delete whatever the source no longer has, so refuse to treat a folder that
// is plainly not an extension build as ours.
if (existsSync(dst) && readdirSync(dst).length > 0 && !existsSync(join(dst, 'manifest.json')) && !force) {
  console.error(`${dst} exists and holds no manifest.json — refusing to mirror into it (pass --force if it really is ours)`)
  process.exit(1)
}

/** Relative paths of every file under `dir`. */
function walk(dir, prefix = '') {
  const files = []
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(join(dir, name)).isDirectory()) files.push(...walk(join(dir, name), rel))
    else files.push(rel)
  }
  return files
}

const wanted = new Set(walk(src))
let copied = 0

// Copy first, delete after: a browser that reads the folder mid-sync sees a
// mixed build, never a missing one.
for (const rel of wanted) {
  const from = join(src, rel)
  const to = join(dst, rel)
  const a = statSync(from)
  const b = existsSync(to) ? statSync(to) : null
  if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) continue
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  utimesSync(to, a.atime, a.mtime) // so the next run can skip it
  copied++
}

let deleted = 0
if (existsSync(dst)) {
  for (const rel of walk(dst)) {
    if (wanted.has(rel)) continue
    rmSync(join(dst, rel))
    deleted++
  }
  // Prune directories the deletions emptied (assets/ churns on every build).
  const prune = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (!statSync(full).isDirectory()) continue
      prune(full)
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true })
    }
  }
  prune(dst)
}

console.log(
  `Extension v${version} (${here || 'unknown branch'}) → ${dst}\n` +
    `  ${copied} file(s) written, ${deleted} stale removed. Reload it in edge://extensions to pick it up.`
)

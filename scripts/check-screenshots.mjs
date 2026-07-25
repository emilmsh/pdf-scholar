// Are the shipped screenshots older than the UI they show?
//
//   npm run check:shots
//
// The screenshots in docs/screenshots/ and docs/store-screenshots/ are taken BY
// HAND (docs/RELEASE.md). That makes them the easiest thing in the repo to
// forget, and a stale one is worse than most stale docs: it is the first thing a
// visitor sees, and it ships to the Microsoft Store.
//
// It compares commit dates, not file mtimes: mtimes are all checkout time in a
// fresh clone. And for each image it dates the CONTENT, not the last commit that
// touched the path — the commit that first introduced the bytes now on disk.
// Otherwise restoring an old screenshot (as a revert does) makes a years-old
// image look freshly shot, which is exactly when you want to be told otherwise.
//
// Advisory by design — it exits 1 so a release checklist can gate on it, but it
// cannot know whether a renderer commit actually changed anything visible. Read
// what it says, then decide.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()

/** Newest commit touching any of `paths`: { iso, subject, short } or null */
function newestCommit(paths) {
  const out = git('log', '-1', '--format=%cI%x09%h%x09%s', '--', ...paths)
  if (!out) return null
  const [iso, short, ...rest] = out.split('\t')
  return { iso, short, subject: rest.join('\t'), date: new Date(iso) }
}

/** Files tracked under a folder */
const filesIn = (dir) =>
  git('ls-files', '--', dir)
    .split('\n')
    .filter((f) => f.endsWith('.png'))

/**
 * When the bytes currently at `file` first entered history. --find-object finds
 * every commit that added or removed exactly this blob; the oldest of those is
 * when the image was actually taken, no matter how often the path moved since.
 */
function contentDate(file) {
  let blob
  try {
    blob = git('rev-parse', `HEAD:${file}`)
  } catch {
    return null // not committed yet
  }
  const lines = git(
    'log',
    '--format=%cI%x09%h',
    '--diff-filter=AM',
    `--find-object=${blob}`,
    '--',
    file
  )
    .split('\n')
    .filter(Boolean)
  if (lines.length === 0) return null
  const [iso, short] = lines[lines.length - 1].split('\t') // oldest
  return { iso, short, date: new Date(iso) }
}

// What counts as "the UI changed": only what a screenshot can actually show —
// components, stylesheet, strings. NOT src/main (the annotation engine and save
// model are invisible here), and not the renderer's logic modules (bridge,
// pane-handle, tool-prefs, extension-api), which move often and change no pixels.
// Watching all of src/renderer made this check red on every commit, and a check
// that is always red is a check nobody reads.
const UI_PATHS = [
  'src/renderer/src/components',
  'src/renderer/src/styles',
  'src/renderer/src/i18n.ts'
]
const SETS = [
  { name: 'README screenshots', paths: ['docs/screenshots'] },
  { name: 'Store screenshots', paths: ['docs/store-screenshots'] }
]

const ui = newestCommit(UI_PATHS)
if (!ui) {
  console.log('No renderer history found — nothing to compare.')
  process.exit(0)
}

console.log(`Newest UI commit:  ${ui.short}  ${ui.iso.slice(0, 10)}  ${ui.subject}`)
console.log('')

let stale = 0
const allDates = []
for (const set of SETS) {
  const dirs = set.paths.filter((p) => existsSync(resolve(ROOT, p)))
  if (dirs.length === 0) {
    console.log(`${set.name}: no such folder, skipped`)
    continue
  }
  const files = dirs.flatMap(filesIn)
  if (files.length === 0) {
    console.log(`${set.name}: no committed PNGs`)
    stale++
    continue
  }
  const rows = files.map((f) => ({ file: f, when: contentDate(f) }))
  for (const r of rows) if (r.when) allDates.push(r.when.iso)
  const old = rows.filter((r) => !r.when || r.when.date < ui.date)
  console.log(`${set.name}: ${files.length - old.length}/${files.length} newer than the UI`)
  for (const r of rows.sort((a, b) => (a.when?.iso ?? '').localeCompare(b.when?.iso ?? ''))) {
    const label = r.when ? `${r.when.iso.slice(0, 10)}  ${r.when.short}` : 'uncommitted   '
    const flag = !r.when || r.when.date < ui.date ? 'STALE' : 'ok   '
    console.log(`  ${flag}  ${label}  ${r.file.replace(/^docs\//, '')}`)
  }
  if (old.length) stale += old.length
  console.log('')
}

if (stale) {
  // The point is not the verdict, it is this list: what visibly changed since.
  // Only a human can say whether any of it shows up in a screenshot.
  const oldest = allDates.length ? allDates.sort()[0] : null
  if (oldest) {
    const since = git('log', `--since=${oldest}`, '--format=%h%x09%cI%x09%s', '--', ...UI_PATHS)
      .split('\n')
      .filter(Boolean)
    console.log(`Visual commits since the oldest shipped screenshot (${since.length}):`)
    for (const line of since.slice(0, 12)) {
      const [short, iso, ...rest] = line.split('\t')
      console.log(`  ${short}  ${iso.slice(0, 10)}  ${rest.join('\t')}`)
    }
    if (since.length > 12) console.log(`  … and ${since.length - 12} more`)
    console.log('')
  }
  console.log('Judge whether any of that is visible. If it is, re-shoot by hand before releasing —')
  console.log('`npm run shoot` writes reference frames to docs/screenshots/_auto/ to work from.')
  console.log('See docs/RELEASE.md.')
  process.exit(1)
}
console.log('\nScreenshots are newer than every visual change.')

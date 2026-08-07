// Version arithmetic behind the macOS update notice (src/shared/update-channel.ts).
//
// This is the one piece of that flow with real failure modes, and both of them
// are silent: too eager and every mac user gets nagged every four hours about a
// version that isn't newer; too shy and they never hear about a release at all.
// Neither shows up in a build, and neither is reproducible on Windows — the
// notice only ever runs on hardware we don't have. So it gets tested here.
// Run: node scripts/test-update-channel.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/update-channel.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'update-channel-'))
const out = join(dir, 'update-channel.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const U = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
  }
}

// --- tag_name → version ------------------------------------------------------
// Our release tags carry the `v`; the app's own version never does.
console.log('versionFromTag')
eq(U.versionFromTag('v0.33.0'), '0.33.0', 'strips the leading v')
eq(U.versionFromTag('0.33.0'), '0.33.0', 'accepts a bare version too')
eq(U.versionFromTag(' v1.0.0 '), '1.0.0', 'tolerates surrounding whitespace')
eq(U.versionFromTag('v0.33'), null, 'two-part tag is not a version we understand')
eq(U.versionFromTag('v0.33.0-beta.1'), null, 'prerelease suffix rejected, not truncated')
eq(U.versionFromTag('nightly'), null, 'non-version tag')
eq(U.versionFromTag(undefined), null, 'missing tag_name (feed shape changed)')
eq(U.versionFromTag(42), null, 'non-string tag_name')

// --- is the release newer than what is running? -----------------------------
console.log('isNewerVersion')
eq(U.isNewerVersion('0.34.0', '0.33.0'), true, 'minor bump')
eq(U.isNewerVersion('0.33.1', '0.33.0'), true, 'patch bump')
eq(U.isNewerVersion('1.0.0', '0.99.99'), true, 'major bump')
eq(U.isNewerVersion('0.33.0', '0.33.0'), false, 'same version never nags')
eq(U.isNewerVersion('0.32.0', '0.33.0'), false, 'older release (a rollback) never nags')
// The one that bites string comparison: 10 sorts before 9 lexically.
eq(U.isNewerVersion('0.10.0', '0.9.1'), true, '0.10.0 > 0.9.1 — numeric, not lexical')
eq(U.isNewerVersion('0.9.1', '0.10.0'), false, '…and the reverse')
eq(U.isNewerVersion('0.33.10', '0.33.9'), true, 'same in the patch position')
// Garbage must be inert rather than truthy — a bad feed should go quiet.
eq(U.isNewerVersion('9.9', '0.33.0'), false, 'two-part left side')
eq(U.isNewerVersion('0.33.0', '0.33'), false, 'two-part right side')
eq(U.isNewerVersion('0.33.x', '0.33.0'), false, 'non-numeric segment')
eq(U.isNewerVersion('0..0', '0.33.0'), false, 'empty segment is not zero')
eq(U.isNewerVersion('', '0.33.0'), false, 'empty string')

// --- the constants the UI and the docs both quote ----------------------------
console.log('constants')
eq(
  U.BREW_UPGRADE_COMMAND,
  'brew upgrade --cask emilmsh/tap/pdf-scholar',
  'brew command is fully qualified (works without the tap tapped)'
)
eq(U.CASKROOM_PATHS.length, 2, 'both Homebrew prefixes are probed')
eq(
  U.CASKROOM_PATHS.every((p) => p.endsWith('/Caskroom/pdf-scholar')),
  true,
  'Caskroom paths point at the cask token'
)

if (failures === 0) {
  console.log('\nALL UPDATE-CHANNEL ASSERTIONS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

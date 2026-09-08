// Where a build that cannot install its own updates gets the next version.
//
// Two desktop builds are like that: macOS (ad-hoc signed → Squirrel.Mac refuses
// to apply an update; see docs/PLATFORMS.md "Allowed divergences" §1) and the
// portable Windows zip (electron-updater would install the Setup exe over a
// copy that was never installed; §21). DETECTING a new version is just an HTTPS
// GET though, and nothing about that needs a code signature or an install — so
// both builds still check and then tell the user how to update by hand. This module holds everything both sides of that flow have
// to agree on: the endpoints, the command, and the version comparison.
// Electron-free on purpose, so scripts/test-update-channel.mjs can import it.

/** Newest non-draft, non-prerelease release. `/releases/latest` filters both. */
export const RELEASES_API_URL =
  'https://api.github.com/repos/emilmsh/pdf-scholar/releases/latest'

/** Human-facing download page, for installs that did not come from Homebrew */
export const RELEASES_PAGE_URL = 'https://github.com/emilmsh/pdf-scholar/releases/latest'

/** Fully qualified (`owner/tap/cask`) so it resolves whether or not the user
 *  still has the tap tapped — a bare `pdf-scholar` fails after `brew untap`. */
export const BREW_UPGRADE_COMMAND = 'brew upgrade --cask emilmsh/tap/pdf-scholar'

/** Homebrew's staging directory for the cask, per prefix: Apple Silicon first,
 *  then Intel. Its presence is what distinguishes a cask install from a dmg
 *  dragged into /Applications — both end up at the same app path. */
export const CASKROOM_PATHS = [
  '/opt/homebrew/Caskroom/pdf-scholar',
  '/usr/local/Caskroom/pdf-scholar'
]

/** The version inside a release's `tag_name` (`v0.33.0` → `0.33.0`), or null
 *  when the feed hands us something we don't recognise. Unknown shapes must
 *  come back null rather than guess: the caller nags the user about whatever
 *  this returns. */
export function versionFromTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag.trim())
  return m ? m[1] : null
}

/** a > b for plain x.y.z versions. Anything unparseable answers false, so a
 *  garbled feed can never nag about a version that isn't actually newer. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.')
  const pb = b.split('.')
  if (pa.length !== 3 || pb.length !== 3) return false
  for (let i = 0; i < 3; i++) {
    // Number('') is 0 and Number('1x') is NaN — both must fail, not coerce
    const x = /^\d+$/.test(pa[i]) ? Number(pa[i]) : NaN
    const y = /^\d+$/.test(pb[i]) ? Number(pb[i]) : NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x > y
  }
  return false
}

/** The NSIS uninstaller electron-builder writes beside the exe on install
 *  (`Uninstall ${productName}.exe`). A zip extract of the same tree has none. */
export const NSIS_UNINSTALLER_NAME = 'Uninstall PDF Scholar.exe'

/** Whether a packaged Windows tree at `exeDir` is a zip extract rather than an
 *  install: the uninstaller is the one file the installer adds. `exists` and
 *  `join` are injected so this stays testable without a disk. Only meaningful
 *  for a packaged win32 build that is not a Store package — the caller checks
 *  that (src/main/portable.ts). */
export function isPortableExtract(
  exeDir: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string
): boolean {
  return !exists(join(exeDir, NSIS_UNINSTALLER_NAME))
}

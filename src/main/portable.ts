// The portable Windows build: the same win-unpacked tree the NSIS installer
// lays down, shipped as a zip and run from wherever it was extracted (a USB
// stick, a locked-down university PC, a Downloads folder). Nothing on the
// machine tells us so — a zip has no PORTABLE_EXECUTABLE_DIR the way
// electron-builder's `portable` target would — so we read it off the disk:
// an install has the NSIS uninstaller beside the exe, a zip extract does not.
//
// Two things follow from being portable (docs/PLATFORMS.md, divergence 21):
//  - state lives in a `data/` folder next to the exe, not in %APPDATA%, so the
//    folder can be moved as a whole. AI keys are still DPAPI-bound to the
//    Windows account that saved them and do not travel to another machine.
//  - electron-updater is out: it would download the Setup exe and turn the
//    portable copy into an install on quit. The build detects a release and
//    points at the zip instead (updater.ts → initManualUpdates).
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { isPortableExtract } from '../shared/update-channel'

let portable: boolean | null = null

/** True when this is a packaged Windows build running outside an install */
export function isPortableBuild(): boolean {
  if (portable !== null) return portable
  portable =
    process.platform === 'win32' &&
    app.isPackaged &&
    !process.windowsStore &&
    isPortableExtract(dirname(process.execPath), existsSync, join)
  return portable
}

/** Point userData (and with it sessionData, the single-instance lock, drafts
 *  and the state file) at `<exe folder>/data`. Must run before anything reads
 *  a path — call it at the top of main. A folder we cannot create (extracted
 *  into a read-only place) leaves the default %APPDATA% location standing;
 *  the app then works like an install would, which beats not starting. */
export function applyPortableUserData(): void {
  if (!isPortableBuild()) return
  const dir = join(dirname(process.execPath), 'data')
  try {
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
    app.setPath('sessionData', dir)
  } catch {
    /* fall back to the default location */
  }
}

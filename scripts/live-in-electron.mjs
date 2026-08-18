// The live conformance run, inside Electron, so the app's own API keys can be
// used without ever existing in plaintext outside this process.
//
// Started by scripts/test-live.mjs — not meant to be run by hand.
//
// Why Electron at all: the keys are stored encrypted with safeStorage
// (src/main/ai.ts). On Windows that is Chromium's OSCrypt — AES-GCM under a key
// DPAPI wrapped and stashed in the profile's `Local State` — and on macOS the
// Keychain. No plain Node process can undo either. Electron can, and this one
// does it and then spends the keys directly: they are handed to the suite as
// values, never printed, never written to disk, never put in the environment.
//
// The profile handling follows scripts/shoot-screenshots.mjs, which has done
// the same thing for the --with-ai screenshots since v0.30: work from a COPY of
// the real profile, so a run cannot disturb an app that may be open at the same
// time, and carry `os_crypt` along, because without it the copied blobs cannot
// be decrypted at all.
//
// TRAP, paid for once: everything below the profile setup runs inside
// `whenReady().then(…)` rather than under a top-level `await`. With an ESM main
// entry Electron defers the `ready` event until the entry module has finished
// evaluating — so `await app.whenReady()` at the top level is a deadlock that
// looks exactly like a hung process (no output, no window, no error).
import { app, safeStorage } from 'electron'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY_ENV, runLiveSuite } from './lib/live-suite.mjs'

const args = process.argv.slice(2)

// No window is ever created, so the GPU process is pure overhead — and on
// Windows its teardown is what turned a clean finish into an 0xC0000005 exit
// code, i.e. a passing run reported as a crash.
app.disableHardwareAcceleration()

/** The installed app's userData directory, per platform */
function realProfileDir() {
  if (process.platform === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'PDF Scholar')
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'PDF Scholar')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'PDF Scholar')
}

const real = realProfileDir()
const stateFile = join(real, 'pdfx-state.json')
if (!existsSync(stateFile)) {
  console.error(`No app settings at ${stateFile}`)
  console.error('Open PDF Scholar once and add an API key in the assistant settings,')
  console.error('or pass keys in the environment: npm run test:live -- --env-keys')
  app.exit(2)
}

// A copy of the profile, so a running app is never touched. os_crypt rides
// along or the copied key blobs stay undecryptable. Must happen before `ready`,
// which is the other reason this half stays at the top level.
const tempProfile = mkdtempSync(join(tmpdir(), 'pdfx-live-'))
copyFileSync(stateFile, join(tempProfile, 'pdfx-state.json'))
const localState = join(real, 'Local State')
if (existsSync(localState)) {
  const osCrypt = JSON.parse(readFileSync(localState, 'utf8')).os_crypt
  if (osCrypt) writeFileSync(join(tempProfile, 'Local State'), JSON.stringify({ os_crypt: osCrypt }))
}
app.setPath('userData', tempProfile)

/** app.exit() kills the process immediately, so a `finally` never gets to run:
 *  every exit path has to tidy up on its way out, or a temp profile is left
 *  behind on disk for each run. */
const finish = (code) => {
  rmSync(tempProfile, { recursive: true, force: true })
  app.exit(code)
}

app.whenReady().then(async () => {
  let exitCode = 1
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('safeStorage reports no key store on this machine — cannot decrypt the stored keys.')
      console.error('Pass them in the environment instead: npm run test:live -- --env-keys')
      return finish(2)
    }
    const stored = JSON.parse(readFileSync(stateFile, 'utf8')).ai?.keys ?? {}
    const keys = {}
    for (const provider of Object.keys(KEY_ENV)) {
      const blob = stored[provider]
      if (!blob) continue
      try {
        // 'plain:' is the legacy shape from versions that had no key store. The
        // app still reads it (src/main/ai.ts decryptKey), so this must too, or
        // a key the app can use would look missing here.
        keys[provider] = blob.startsWith('plain:')
          ? Buffer.from(blob.slice(6), 'base64').toString('utf-8')
          : safeStorage.decryptString(Buffer.from(blob, 'base64'))
      } catch {
        // A blob this machine cannot decrypt: a copied profile, or an OS
        // account change since it was written. Name it, carry on with the rest.
        console.error(`  ! ${provider}: the stored key could not be decrypted here — skipping`)
      }
    }
    const found = Object.keys(keys)
    if (found.length === 0) {
      console.error('The app holds no usable API key. Add one in the assistant settings.')
      return finish(2)
    }
    console.log(`Keys from the app's own store: ${found.join(', ')}`)
    // --dry-run proves the key path — profile copy, safeStorage, the legacy
    // shape — without asking a provider anything. The difference between
    // verifying the plumbing and spending money to verify the plumbing.
    if (args.includes('--dry-run')) {
      console.log('--dry-run: keys unlocked, nothing sent.')
      return finish(0)
    }
    console.log('')
    const { failures, noKeys } = await runLiveSuite({ keys, args })
    exitCode = noKeys || failures === 0 ? 0 : 1
  } catch (err) {
    console.error(`live run failed: ${err instanceof Error ? err.stack : String(err)}`)
  }
  finish(exitCode)
})

// The «Gi tilgang til URL-adresser for fil» plumbing — src/renderer/src/extension-file-access.ts.
//
// Why this is worth a test: every branch here is invisible until it is wrong in
// the field. Send an Edge user to `chrome://extensions` and the browser shows a
// dead page instead of the one switch that makes local PDFs work; treat "the
// probe is unavailable" as "no access" and every DESKTOP user (same renderer)
// gets a card asking them to fix a browser they are not using. Neither shows up
// in a build, in typecheck, or in the developer's own browser.
// Run: node scripts/test-file-access.mjs
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/extension-file-access.ts', import.meta.url))

// Declare the globals the module reaches for BEFORE importing it: `chrome` and
// `navigator` are ambient in a browser, and a bare read of an undeclared name is
// a ReferenceError in Node, not undefined.
globalThis.chrome = undefined
// defineProperty, not assignment: Node ships its own read-only `navigator`
// accessor, and an ESM module is strict mode — a plain assignment throws.
function setUserAgent(userAgent) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent },
    configurable: true,
    writable: true
  })
}
setUserAgent('')

const dir = mkdtempSync(join(tmpdir(), 'file-access-'))
const out = join(dir, 'extension-file-access.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const F = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
  }
}

const ID = 'abcdefghijklmnopabcdefghijklmnop'

// --- Which browser's settings page ------------------------------------------
// Real user-agent strings, trimmed to the part that decides.
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87'
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const EDGE_ANDROID = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.2592.87'
const EDGE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 EdgiOS/126.0.2592.87 Mobile/15E148 Safari/605.1.15'
const EDGEHTML = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/18.17763 Safari/537.36 Edge/18.17763'
const BRAVE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Brave/126'

const url = F.extensionDetailsUrl
eq(url(EDGE, ID), `edge://extensions/?id=${ID}`, 'Edge → edge://extensions')
eq(url(CHROME, ID), `chrome://extensions/?id=${ID}`, 'Chrome → chrome://extensions')
eq(url(EDGE_ANDROID, ID), `edge://extensions/?id=${ID}`, 'Edge Android (EdgA/) → edge://')
eq(url(EDGE_IOS, ID), `edge://extensions/?id=${ID}`, 'Edge iOS (EdgiOS/) → edge://')
// Legacy EdgeHTML never ran this extension; matching its token would only ever
// misfire on some other product that carries "Edge" in its UA.
eq(url(EDGEHTML, ID), `chrome://extensions/?id=${ID}`, 'legacy Edge/ token is not a match')
eq(url(BRAVE, ID), `chrome://extensions/?id=${ID}`, 'other Chromium → chrome://extensions')
eq(url('', ID), `chrome://extensions/?id=${ID}`, 'no user agent → chrome://extensions')

// --- The probe ---------------------------------------------------------------
// null is "cannot tell", and it must NOT be confused with false: the callers
// only nag on an explicit false.
eq(await F.fileAccessGranted(), null, 'no chrome global → null (cannot tell)')

globalThis.chrome = { runtime: { id: ID } }
eq(await F.fileAccessGranted(), null, 'browser without the probe → null')

globalThis.chrome = { runtime: { id: ID }, extension: { isAllowedFileSchemeAccess: async () => false } }
eq(await F.fileAccessGranted(), false, 'probe says no → false')

globalThis.chrome = { runtime: { id: ID }, extension: { isAllowedFileSchemeAccess: async () => true } }
eq(await F.fileAccessGranted(), true, 'probe says yes → true')

globalThis.chrome = {
  runtime: { id: ID },
  extension: {
    isAllowedFileSchemeAccess: async () => {
      throw new Error('nope')
    }
  }
}
eq(await F.fileAccessGranted(), null, 'probe throws → null, not false')

// --- Opening the settings page ----------------------------------------------
// The return value is the UI's only signal that it must print the address for
// the user to paste instead.
let opened = null
setUserAgent(EDGE)
globalThis.chrome = {
  runtime: { id: ID },
  tabs: {
    create: async (props) => {
      opened = props.url
      return {}
    }
  }
}
eq(await F.openExtensionDetails(), true, 'tabs.create accepted → true')
eq(opened, `edge://extensions/?id=${ID}`, 'opened this extension’s details page in Edge')

globalThis.chrome = {
  runtime: { id: ID },
  tabs: {
    create: async () => {
      throw new Error('Cannot navigate to a chrome:// URL')
    }
  }
}
eq(await F.openExtensionDetails(), false, 'browser refused the navigation → false')

globalThis.chrome = { runtime: { id: ID } }
eq(await F.openExtensionDetails(), false, 'no tabs API → false')

// --- Orphaned by the extension reload the flip itself causes ------------------
// The page that is WAITING for the switch is the one Chromium tears the runtime
// out from under. Getting this backwards on the desktop (no runtime at all)
// would reload the app for no reason.
globalThis.chrome = undefined
eq(F.extensionContextLost(), false, 'no extension runtime (desktop/dev:web) → not lost')
globalThis.chrome = { runtime: { id: ID } }
eq(F.extensionContextLost(), false, 'live runtime → not lost')
globalThis.chrome = { runtime: {} }
eq(F.extensionContextLost(), true, 'runtime without an id → orphaned page')

// --- The welcome card's dismissal -------------------------------------------
const stored = {}
globalThis.chrome = {
  runtime: { id: ID },
  storage: {
    local: {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (items) => Object.assign(stored, items)
    }
  }
}
eq(await F.fileAccessNoticeDismissed(), false, 'never dismissed → false')
F.dismissFileAccessNotice()
await new Promise((r) => setTimeout(r, 0)) // the setter is fire-and-forget
eq(await F.fileAccessNoticeDismissed(), true, 'dismissal survives into the next read')

globalThis.chrome = {
  runtime: { id: ID },
  storage: {
    local: {
      get: async () => {
        throw new Error('storage unavailable')
      },
      set: async () => {}
    }
  }
}
eq(await F.fileAccessNoticeDismissed(), false, 'unreadable storage → show the card, not swallow it')

// --- The service worker asks at install time --------------------------------
// background.ts stays a single self-contained file (see the comment there), so
// the install-time ask cannot be imported from here — this is the guard against
// it being dropped or firing on every update.
const bg = readFileSync(new URL('../src/extension/background.ts', import.meta.url), 'utf8')
eq(
  /isAllowedFileSchemeAccess/.test(bg),
  true,
  'background.ts probes file access before opening the onboarding tab'
)
eq(
  /details\.reason === 'install'/.test(bg),
  true,
  'the onboarding tab opens on install only, never on an update'
)

if (failures === 0) {
  console.log('\nALL FILE-ACCESS ASSERTIONS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

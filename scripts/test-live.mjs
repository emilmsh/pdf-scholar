// The live conformance run — `npm run test:live`.
//
// This file is only the front door. The suite itself is scripts/lib/live-suite.mjs;
// all this decides is WHERE THE KEYS COME FROM, and there are two answers:
//
//   1. The environment (ANTHROPIC_API_KEY etc.). Explicit, scriptable, and what
//      you want when testing a key that is not the one in the app.
//   2. The app's own store — the normal case. The keys are encrypted at rest
//      with safeStorage, which only Electron can undo, so this relaunches
//      itself under Electron (scripts/live-in-electron.mjs) and the keys are
//      decrypted inside that process and never leave it. No pasting, no
//      plaintext in a shell history, nothing to forget to unset.
//
// Run:
//   npm run test:live                       the app's keys, every curated model
//   npm run test:live -- --self-check       no keys at all: local fake endpoint
//   npm run test:live -- --record           …and save each stream for replay
//   npm run test:live -- --provider=openrouter --model=moonshotai/kimi-k2.5
//   npm run test:live -- --env-keys         force the environment instead
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { KEY_ENV, runLiveSuite } from './lib/live-suite.mjs'

const args = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))

const envKeys = Object.fromEntries(
  Object.entries(KEY_ENV)
    .map(([provider, envVar]) => [provider, process.env[envVar] ?? ''])
    .filter(([, key]) => key)
)

// --self-check spends nothing and needs nobody's key; --env-keys is the escape
// hatch for testing a key the app does not hold.
const useEnv = args.includes('--self-check') || args.includes('--env-keys') || Object.keys(envKeys).length > 0

if (!useEnv) {
  // Hand over to Electron, which can decrypt what the app stored. `electron`
  // required from plain Node resolves to the executable's path.
  const { default: electron } = await import('electron')
  const child = spawn(electron, [join(here, 'live-in-electron.mjs'), ...args], {
    stdio: 'inherit',
    // Electron prints a GPU/vulkan warning or two on a headless-ish run; the
    // suite's own output is what matters and it is on stdout either way.
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  child.on('exit', (code) => process.exit(code ?? 1))
} else {
  const { failures, noKeys } = await runLiveSuite({ keys: envKeys, args })
  if (noKeys) {
    console.log('No provider keys — nothing to ask.')
    console.log(`Set any of: ${Object.values(KEY_ENV).join(', ')}`)
    console.log('…or drop --env-keys to use the keys already stored in the app.')
    process.exit(0)
  }
  process.exit(failures === 0 ? 0 : 1)
}

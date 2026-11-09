// Bundles the relay the browser starts for the extension's ChatGPT plan
// (src/main/native-host-relay.ts) into ONE CommonJS file beside its Windows
// launcher, out/native-host/ — Node built-ins only. electron-builder ships the
// folder as resources/native-host (extraResources); Windows' native-messaging
// manifest names the .cmd there, macOS and Linux copy the relay into userData
// and write a launcher of their own (src/main/native-host-register.ts). Runs
// after every `npm run build` (the postbuild hook), like build-mcp.mjs.
// Run: node scripts/build-native-host.mjs
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = `${root}out/native-host`
const { productName } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

await build({
  entryPoints: [`${root}src/main/native-host-relay.ts`],
  outfile: `${outDir}/pdf-scholar-host.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning'
})

// The launcher's text comes from the shared module, so the test checks the
// same function that wrote it
const shared = join(tmpdir(), `native-host-shared-${process.pid}.mjs`)
await build({ entryPoints: [`${root}src/shared/native-host.ts`], outfile: shared, format: 'esm', logLevel: 'silent' })
const { windowsLauncher, WINDOWS_LAUNCHER } = await import(pathToFileURL(shared).href)
mkdirSync(outDir, { recursive: true })
writeFileSync(`${outDir}/${WINDOWS_LAUNCHER}`, windowsLauncher(`${productName}.exe`))
console.log(`out/native-host/ (relay + ${WINDOWS_LAUNCHER})`)

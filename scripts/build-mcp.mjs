// Bundles the MCP server (src/main/mcp-entry.ts) into ONE CommonJS file,
// out/mcp/pdf-scholar-mcp.cjs: Node built-ins only, nothing beside it — main
// copies the file alone into userData/mcp, where an AI tool runs it with the
// app's executable in Node mode (src/main/mcp-connect.ts). Runs after every
// `npm run build` (the postbuild hook), so a packaged app always carries it.
// Run: node scripts/build-mcp.mjs
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

await build({
  entryPoints: [`${root}src/main/mcp-entry.ts`],
  outfile: `${root}out/mcp/pdf-scholar-mcp.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __APP_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning'
})
console.log(`out/mcp/pdf-scholar-mcp.cjs (v${version})`)

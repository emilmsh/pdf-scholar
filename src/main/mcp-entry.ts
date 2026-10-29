// Entry of the MCP server script (src/main/mcp-server.ts). Bundled on its own
// by scripts/build-mcp.mjs into out/mcp/pdf-scholar-mcp.cjs — Node built-ins
// only, no chunks beside it — and copied by main into userData/mcp, where an
// AI tool runs it as `<the app's executable> <this script> --client <tool>`
// with ELECTRON_RUN_AS_NODE=1 (src/main/mcp-connect.ts). userData is
// therefore the folder above the script's own; `--data <dir>` names another
// (tests). `--client` is the switch this process answers to; none = 'other'.
import { dirname, resolve } from 'node:path'
import { clientFromArgv } from '../shared/mcp'
import { createMcpServer, serveStdio } from './mcp-server'

declare const __APP_VERSION__: string

const at = process.argv.indexOf('--data')
const dataDir = at > -1 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : dirname(dirname(__filename))

const server = createMcpServer({
  dataDir,
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  client: clientFromArgv(process.argv)
})
void serveStdio(server, process.stdin, process.stdout).then(() => process.exit(0))

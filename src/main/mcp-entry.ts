// Entry of the MCP server script (src/main/mcp-server.ts). Bundled on its own
// by scripts/build-mcp.mjs into out/mcp/pdf-scholar-mcp.cjs — Node built-ins
// only, no chunks beside it — and copied by main into userData/mcp, where an
// AI tool runs it as `<the app's executable> <this script> --client <tool>`
// with ELECTRON_RUN_AS_NODE=1 (src/main/mcp-connect.ts). userData is
// therefore the folder above the script's own; `--data <dir>` names another
// (tests). `--client` is the switch this process answers to; none = 'other'.
// `--session <hex>` makes this process part of a session its starter names
// (a caller that starts the script once per call); none = a session of its own.
import { spawn } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { clientFromArgv, sessionFromArgv } from '../shared/mcp'
import { createMcpServer, serveStdio } from './mcp-server'

declare const __APP_VERSION__: string

const at = process.argv.indexOf('--data')
const dataDir = at > -1 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : dirname(dirname(__filename))

/** Start the app this script belongs to, for a tool that asks something of
 *  the RUNNING app while none is (shared/tool-bridge.ts). The script is run by
 *  the app's own executable in Node mode, so that executable — the AppImage
 *  itself rather than the binary in its mount — started WITHOUT the Node-mode
 *  variable is the app. Not from a developer run (the executable is then
 *  Electron's own, which would open its default page) and not with `--data`
 *  (a test's folder is no installed app's). */
function startApp(): boolean {
  const exe = process.env.APPIMAGE || process.execPath
  if (at > -1 || !process.versions.electron || /^electron(\.exe)?$/i.test(basename(exe))) return false
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env })
    child.on('error', () => {
      /* answered as «not running» when nothing ever listens */
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

const server = createMcpServer({
  dataDir,
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  client: clientFromArgv(process.argv),
  session: sessionFromArgv(process.argv),
  startApp
})
void serveStdio(server, process.stdin, process.stdout).then(() => process.exit(0))

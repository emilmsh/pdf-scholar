// «Koble til» for the AI tools on this machine (shared/mcp.ts holds the
// rules): the MCP server script kept where a tool can run it, and each tool
// told about it in its own way.
//
// The script lives in userData/mcp, not inside the app: an installed app's
// path holds an asar (Node mode can read it, but the AppImage's mount moves
// on every launch), and userData is where the stores the server reads are —
// the script finds them as its own parent folder. It is copied there on
// «Koble til» and refreshed at every start once it exists, so an app update
// updates the server too. A tool runs it with the app's own executable and
// ELECTRON_RUN_AS_NODE=1 (VS Code's `code` command works the same way): no
// Node install, no window, no port.
//
// One switch per tool (shared/mcp.ts); «Claude» is both of Anthropic's:
// - Claude Desktop: its claude_desktop_config.json, merged (our one key,
//   nothing else touched; an unreadable file refused, never replaced).
// - Claude Code: its own CLI (`claude mcp add … --scope user`) — its config
//   file is rewritten by every running session, and a merge from outside
//   could be lost under one.
// - Codex: its config.toml (CLI, app and editor extension share it), our
//   one table written or taken out and every other line left as it was.
// - Anything else (Cursor, opencode, …): the panel copies the entry to paste.
// Every entry names its tool (`--client`), and the switch is written to the
// policy FIRST when turning off — so a tool is shut out even if taking its
// entry back fails.
//
// The Microsoft Store build cannot be run by another program (no execution
// alias) and its userData is virtualized away from the path the script would
// name, so it says so instead (`mcp-unsupported`, docs/PLATFORMS.md).
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  claudeCodeAddArgs,
  claudeCodeCommand,
  claudeCodeRemoveArgs,
  configSnippet,
  hasCodexServer,
  hasServer,
  MCP_KEY,
  mergeCodexToml,
  mergeServerInto,
  sanitizeMcpPolicy,
  serverEntry,
  shellQuote,
  type McpClient,
  type McpClientState,
  type McpPolicy,
  type McpResult,
  type McpServerEntry,
  type McpStatus,
  type McpTarget
} from '../shared/mcp'
import { getState, saveState } from './storage'

const SCRIPT_NAME = 'pdf-scholar-mcp.cjs'

/** Built beside main by scripts/build-mcp.mjs (out/mcp next to out/main) */
const bundledScript = (): string => join(__dirname, '..', 'mcp', SCRIPT_NAME)
const installedScript = (): string => join(app.getPath('userData'), 'mcp', SCRIPT_NAME)

/** Copy the script into userData/mcp when it differs from the one there */
async function installScript(): Promise<boolean> {
  const from = bundledScript()
  const to = installedScript()
  try {
    const [want, have] = await Promise.all([readFile(from), readFile(to).catch(() => null)])
    if (have && have.equals(want)) return true
    await mkdir(dirname(to), { recursive: true })
    const tmp = `${to}.${process.pid}.tmp`
    await copyFile(from, tmp)
    await rename(tmp, to)
    return true
  } catch {
    return false
  }
}

/** At start: an installed script follows the app's version. Nothing is
 *  written for a reader who never connected a tool. */
export function refreshMcpScriptAtStartup(): void {
  if (process.windowsStore) return
  if (existsSync(installedScript())) void installScript()
}

/** The executable a tool should start — the AppImage itself rather than the
 *  binary in its mount, which moves on every launch */
const appCommand = (): string => process.env.APPIMAGE || process.execPath

const entry = (client: McpClient): McpServerEntry => serverEntry(appCommand(), installedScript(), client)

// ---------- Claude Desktop ----------

/** The folders Claude Desktop keeps its config in, as many as exist: the
 *  installer's, and an MSIX install's virtualized copy of it */
function claudeDesktopDirs(): string[] {
  const dirs: string[] = []
  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'Claude'))
    const packages = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Packages') : ''
    try {
      for (const p of readdirSync(packages)) {
        if (/^Claude_/i.test(p)) dirs.push(join(packages, p, 'LocalCache', 'Roaming', 'Claude'))
      }
    } catch {
      /* no Packages folder — nothing virtualized */
    }
  } else if (process.platform === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Claude'))
  } else {
    dirs.push(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude'))
  }
  return dirs.filter((d) => existsSync(d))
}

const desktopConfig = (dir: string): string => join(dir, 'claude_desktop_config.json')

async function claudeDesktopState(): Promise<McpClientState> {
  const dirs = claudeDesktopDirs()
  if (dirs.length === 0) return 'absent'
  for (const d of dirs) {
    if (hasServer(await readFile(desktopConfig(d), 'utf-8').catch(() => null))) return 'connected'
  }
  return 'available'
}

async function setClaudeDesktop(on: boolean): Promise<{ code: 'mcp-client-missing' | 'mcp-config-unreadable'; error: string } | null> {
  const dirs = claudeDesktopDirs()
  if (dirs.length === 0) return { code: 'mcp-client-missing', error: 'Claude Desktop' }
  // Every copy first, then the writes: one unreadable file stops the lot
  // before any is changed
  const planned: { file: string; text: string }[] = []
  for (const d of dirs) {
    const file = desktopConfig(d)
    const text = await readFile(file, 'utf-8').catch(() => null)
    const next = mergeServerInto(text, on ? entry('claude') : null)
    if (next === null) return { code: 'mcp-config-unreadable', error: file }
    if (text !== null || on) planned.push({ file, text: next })
  }
  for (const { file, text } of planned) {
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, file)
  }
  return null
}

// ---------- Claude Code ----------

/** Where the `claude` command is: the native installer's place first (a GUI
 *  app's PATH is often not the terminal's), then the PATH */
async function findClaude(): Promise<string | null> {
  const home = homedir()
  const win = process.platform === 'win32'
  const known = win
    ? [join(home, '.local', 'bin', 'claude.exe')]
    : [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude', 'local', 'claude')]
  for (const p of known) if (existsSync(p)) return p
  return new Promise((done) => {
    execFile(win ? 'where.exe' : 'which', ['claude'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return done(null)
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      // On Windows `where` lists the extensionless npm shim first; it cannot
      // be started on its own
      done(lines.find((l) => !win || /\.(exe|cmd|bat)$/i.test(l)) ?? null)
    })
  })
}

/** Run the CLI; resolves with its exit code and what it printed */
function runClaude(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    // An npm install is a .cmd shim, which Windows starts only through the
    // shell — so the line is quoted by hand (a path cannot hold a quote)
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
    const child = viaShell
      ? spawn([bin, ...args].map((a) => shellQuote(a, true)).join(' '), { shell: true, windowsHide: true, cwd: homedir() })
      : spawn(bin, args, { windowsHide: true, cwd: homedir() })
    let out = ''
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ code: -1, out: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, out: out.trim() })
    })
  })
}

async function claudeCodeState(bin: string | null): Promise<McpClientState> {
  if (!bin) return 'absent'
  const { code } = await runClaude(bin, ['mcp', 'get', MCP_KEY])
  return code === 0 ? 'connected' : 'available'
}

// ---------- Codex ----------

/** Codex's home: CODEX_HOME when set, else ~/.codex */
const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')
const codexConfig = (): string => join(codexHome(), 'config.toml')

/** Whether a command is on the PATH */
function onPath(name: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true, timeout: 5000 }, (err) =>
      done(!err)
    )
  })
}

async function codexState(): Promise<McpClientState> {
  // Its home exists once any of the three has run; the CLI may be installed
  // and never started
  if (!existsSync(codexHome()) && !(await onPath('codex'))) return 'absent'
  return hasCodexServer(await readFile(codexConfig(), 'utf-8').catch(() => null)) ? 'connected' : 'available'
}

async function setCodex(on: boolean): Promise<{ code: 'mcp-client-missing' | 'mcp-config-unreadable'; error: string } | null> {
  const file = codexConfig()
  let text: string | null = null
  try {
    text = await readFile(file, 'utf-8')
  } catch (err) {
    // Missing is fine — an empty config; anything else is not ours to replace
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { code: 'mcp-config-unreadable', error: file }
  }
  if (text === null && !on) return null
  if (on && (await codexState()) === 'absent') return { code: 'mcp-client-missing', error: 'Codex' }
  const next = mergeCodexToml(text, on ? entry('codex') : null)
  if (next === (text ?? '')) return null
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, next)
  await rename(tmp, file)
  return null
}

// ---------- All of them ----------

async function status(): Promise<McpStatus> {
  const other = entry('other')
  const base = {
    config: configSnippet(other),
    command: claudeCodeCommand(entry('claude'), process.platform === 'win32')
  }
  const none = { claudeCode: 'absent', claudeDesktop: 'absent', codex: 'absent' } as const
  if (process.windowsStore) return { unsupported: 'store', ...none, ...base }
  if (!existsSync(bundledScript())) return { unsupported: 'no-script', ...none, ...base }
  const [claudeCode, claudeDesktop, codex] = await Promise.all([
    findClaude().then(claudeCodeState),
    claudeDesktopState(),
    codexState()
  ])
  return { unsupported: null, claudeCode, claudeDesktop, codex, ...base }
}

async function setClaudeCode(on: boolean): Promise<McpResult | null> {
  const bin = await findClaude()
  if (!bin) return null
  // Removed first, so a connect after a move (another exe path) replaces
  // the old entry; a remove of nothing fails harmlessly
  await runClaude(bin, claudeCodeRemoveArgs())
  if (on) {
    const added = await runClaude(bin, claudeCodeAddArgs(entry('claude')))
    if (added.code !== 0) return { ok: false, code: 'mcp-client-failed', error: added.out || `exit ${added.code}` }
  }
  return null
}

/** Turn one tool's switch on or off: the policy and the tool's own entry */
async function connect(target: McpTarget, on: boolean): Promise<McpResult> {
  if (process.windowsStore) return { ok: false, code: 'mcp-unsupported', error: 'store' }
  // Off is the policy first: the server refuses from this moment, whatever
  // happens to the entries after it
  if (!on) setClient(target, false)
  if (on && !(await installScript())) return { ok: false, code: 'mcp-unsupported', error: 'no-script' }
  if (target === 'claude') {
    const before = await status()
    if (on && before.claudeCode === 'absent' && before.claudeDesktop === 'absent') {
      return { ok: false, code: 'mcp-client-missing', error: 'Claude' }
    }
    const desktop = before.claudeDesktop === 'absent' ? null : await setClaudeDesktop(on)
    if (desktop) return { ok: false, ...desktop }
    const code = await setClaudeCode(on)
    if (code) return code
  } else if (target === 'codex') {
    const failed = await setCodex(on)
    if (failed) return { ok: false, ...failed }
  }
  // 'other': set up by hand from the copied entry — the script in place and
  // the switch are all there is to it
  if (on) setClient(target, true)
  return { ok: true, status: await status() }
}

function setClient(client: McpClient, on: boolean): void {
  const state = getState()
  setPolicy({ clients: { ...state.mcp.clients, [client]: on } })
}

/** The switches and what is kept out (shared/mcp.ts) — written to the state
 *  file at once, since the server reads it from there on every call */
function setPolicy(patch: Partial<McpPolicy>): McpPolicy {
  const state = getState()
  state.mcp = sanitizeMcpPolicy({ ...state.mcp, ...patch })
  saveState()
  return state.mcp
}

export function registerMcpIpc(windowFor: (e?: { sender: Electron.WebContents }) => BrowserWindow | null): void {
  ipcMain.handle('mcp:status', () => status())
  ipcMain.handle('mcp:policy', () => getState().mcp)
  ipcMain.handle('mcp:set-policy', (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return getState().mcp
    const p = patch as Record<string, unknown>
    // The switches are turned only through mcp:connect, which also writes or
    // takes back the tool's entry — never on their own from here
    return setPolicy({
      ...(Array.isArray(p.excludedDocs) ? { excludedDocs: p.excludedDocs as string[] } : {}),
      ...(Array.isArray(p.excludedFolders) ? { excludedFolders: p.excludedFolders as string[] } : {})
    })
  })
  ipcMain.handle('mcp:pick-folder', async (e): Promise<string | null> => {
    const parent = windowFor(e)
    const opts = { properties: ['openDirectory' as const] }
    const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('mcp:connect', (_e, target: unknown, on: unknown) =>
    target === 'claude' || target === 'codex' || target === 'other'
      ? connect(target, on !== false)
      : { ok: false, code: 'mcp-client-missing', error: String(target) }
  )
}

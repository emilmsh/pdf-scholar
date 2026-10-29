// Connecting an AI tool to PDF Scholar's MCP server (src/main/mcp-server.ts)
// — the rules, apart from the side effects (src/main/mcp-connect.ts runs
// them). The reader clicks «Koble til» once per tool and never sees a config
// file: Claude Desktop's is merged here, Claude Code is told through its own
// CLI, and for anything else the settings show the entry to paste.
//
// Merging into another program's config is the step that must never lose
// the reader's own servers: an unreadable file is refused, never replaced,
// and only our one key is ever written or removed. Pure, Node-testable
// (scripts/test-research-notes.mjs).

export const MCP_KEY = 'pdf-scholar'

/** How a tool starts the server: the app's own executable in Node mode on the
 *  script main keeps in userData/mcp */
export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export function serverEntry(command: string, script: string): McpServerEntry {
  return { command, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

// ---------- What may be shared (Emil, 2026-10-29) ----------
//
// One switch over everything, OFF until the reader connects a tool: turning
// it off shuts every tool out at once — those set up by hand too — without
// touching any tool's config, and turning it on again is the same click.
// Then what stays out: single documents, and whole folders (a client's folder
// once, and every file that lands in it later). Kept in the state file beside
// the settings, not in them: «Tilbakestill innstillinger» resets preferences,
// and a document the reader chose to keep out is not a preference.

export interface McpPolicy {
  /** The master switch; false = the server refuses every tool call */
  sharing: boolean
  /** Documents kept out, by path */
  excludedDocs: string[]
  /** Folders kept out, with everything under them */
  excludedFolders: string[]
}

export const DEFAULT_MCP_POLICY: McpPolicy = { sharing: false, excludedDocs: [], excludedFolders: [] }

const MAX_EXCLUDED_DOCS = 5000
const MAX_EXCLUDED_FOLDERS = 200

const pathList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0 && p.length < 4096))].slice(0, max)
    : []

/** A stored policy is untrusted input: anything unreadable shares nothing */
export function sanitizeMcpPolicy(input: unknown): McpPolicy {
  if (!isObj(input)) return { ...DEFAULT_MCP_POLICY }
  return {
    sharing: input.sharing === true,
    excludedDocs: pathList(input.excludedDocs, MAX_EXCLUDED_DOCS),
    excludedFolders: pathList(input.excludedFolders, MAX_EXCLUDED_FOLDERS)
  }
}

/** A path as compared: one kind of separator, no trailing one, and case
 *  folded where the file system folds it (Windows, macOS by default) */
function comparable(path: string, foldCase: boolean): string {
  const p = path.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return foldCase ? p.toLowerCase() : p
}

/** Why a document is kept out — itself, or a folder it lies under — or null */
export function excludedBy(path: string, policy: McpPolicy, foldCase: boolean): 'doc' | 'folder' | null {
  const p = comparable(path, foldCase)
  if (policy.excludedDocs.some((d) => comparable(d, foldCase) === p)) return 'doc'
  // A folder covers what lies UNDER it: «C:/a/b» keeps out «C:/a/b/x.pdf»,
  // never «C:/a/bc.pdf»
  if (policy.excludedFolders.some((f) => p.startsWith(`${comparable(f, foldCase)}/`))) return 'folder'
  return null
}

/** Keep a document out (or let it back in) */
export function withDocExcluded(policy: McpPolicy, path: string, excluded: boolean): McpPolicy {
  const rest = policy.excludedDocs.filter((d) => d !== path)
  return { ...policy, excludedDocs: excluded ? [...rest, path] : rest }
}

export type McpClientState =
  /** Our server is in the tool's config */
  | 'connected'
  /** The tool is here, without our server */
  | 'available'
  /** The tool is not installed (as far as we can find) */
  | 'absent'

export interface McpStatus {
  /** Why connecting is not offered on this install; null = it is */
  unsupported: null | 'store' | 'no-script'
  claudeCode: McpClientState
  claudeDesktop: McpClientState
  /** The entry as an `mcpServers` JSON block, for any other tool */
  config: string
  /** Claude Code's own command line, for a terminal */
  command: string
}

/** 'other' = any tool set up by hand from the copied entry: connecting it
 *  only puts the script in place for the entry to name */
export type McpTarget = 'claude-code' | 'claude-desktop' | 'other'

export type McpErrorCode =
  /** This install cannot run the server for another program (the Store
   *  build: no execution alias, and its userData is virtualized) */
  | 'mcp-unsupported'
  /** The tool was not found on this machine */
  | 'mcp-client-missing'
  /** The tool's config file exists but is not JSON we can read — left as it is */
  | 'mcp-config-unreadable'
  /** The tool's own CLI refused or failed; `error` holds what it said */
  | 'mcp-client-failed'

const MCP_ERROR_CODES: ReadonlySet<string> = new Set<McpErrorCode>([
  'mcp-unsupported',
  'mcp-client-missing',
  'mcp-config-unreadable',
  'mcp-client-failed'
])

export function isMcpErrorCode(code: string): code is McpErrorCode {
  return MCP_ERROR_CODES.has(code)
}

export type McpResult = { ok: true; status: McpStatus } | { ok: false; code: McpErrorCode; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A config file's text with our server set (or removed: entry null). null =
 *  the text is not a JSON object, so we will not touch it. An empty or
 *  missing file starts from {}. Every other key and server is kept as it was. */
export function mergeServerInto(text: string | null, entry: McpServerEntry | null): string | null {
  let config: Record<string, unknown> = {}
  if (text !== null && text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (!isObj(parsed)) return null
      config = parsed
    } catch {
      return null
    }
  }
  const servers = isObj(config.mcpServers) ? { ...config.mcpServers } : {}
  if (config.mcpServers !== undefined && !isObj(config.mcpServers)) return null
  if (entry) servers[MCP_KEY] = entry
  else delete servers[MCP_KEY]
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`
}

/** Whether a config's text names our server */
export function hasServer(text: string | null): boolean {
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as unknown
    return isObj(parsed) && isObj(parsed.mcpServers) && MCP_KEY in parsed.mcpServers
  } catch {
    return false
  }
}

/** The `mcpServers` block another tool's config takes */
export function configSnippet(entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { [MCP_KEY]: entry } }, null, 2)
}

/** Claude Code's arguments for adding the server at user scope. The name
 *  comes first and `--` ends the options: `--env` takes several values, and
 *  anything after it but before `--` would be read as one more. */
export function claudeCodeAddArgs(entry: McpServerEntry): string[] {
  const env = Object.entries(entry.env).flatMap(([k, v]) => ['--env', `${k}=${v}`])
  return ['mcp', 'add', MCP_KEY, '--scope', 'user', ...env, '--', entry.command, ...entry.args]
}

export const claudeCodeRemoveArgs = (): string[] => ['mcp', 'remove', MCP_KEY, '--scope', 'user']

/** One argument quoted for a shell line: double quotes on Windows (a path
 *  cannot hold one), single quotes elsewhere */
export function shellQuote(arg: string, windows: boolean): string {
  if (/^[\w.,:/\\=+@-]+$/.test(arg)) return arg
  return windows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The whole command line for a terminal */
export function claudeCodeCommand(entry: McpServerEntry, windows: boolean): string {
  return ['claude', ...claudeCodeAddArgs(entry)].map((a) => shellQuote(a, windows)).join(' ')
}

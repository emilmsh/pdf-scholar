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

/** Which switch a running server answers to. Each entry the app writes names
 *  its tool (`--client claude`), so turning one tool off shuts that tool out
 *  even where the app cannot take its entry back — one set up by hand, or a
 *  copy of the config elsewhere. Anything unnamed is 'other'. */
export type McpClient = 'claude' | 'codex' | 'other'

export const MCP_CLIENTS: readonly McpClient[] = ['claude', 'codex', 'other']

/** How a tool starts the server: the app's own executable in Node mode on the
 *  script main keeps in userData/mcp, tagged with the switch it answers to */
export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export function serverEntry(command: string, script: string, client: McpClient): McpServerEntry {
  return { command, args: [script, '--client', client], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** The switch a server started with these arguments answers to */
export function clientFromArgv(argv: readonly string[]): McpClient {
  const at = argv.indexOf('--client')
  const named = at > -1 ? argv[at + 1] : undefined
  return named === 'claude' || named === 'codex' ? named : 'other'
}

// ---------- What may be shared (Emil, 2026-10-29) ----------
//
// One switch per tool, every one OFF until the reader turns it on: on, the
// tool is told about the server and the server answers it; off, the tool's
// entry is taken back and the server refuses it — the same click either way.
// Then what stays out: single documents, and whole folders (a client's folder
// once, and every file that lands in it later). Kept in the state file beside
// the settings, not in them: «Tilbakestill innstillinger» resets preferences,
// and a document the reader chose to keep out is not a preference.

export interface McpPolicy {
  /** Per tool; false = the server refuses that tool's every call */
  clients: Record<McpClient, boolean>
  /** Documents kept out, by path */
  excludedDocs: string[]
  /** Folders kept out, with everything under them */
  excludedFolders: string[]
}

export const DEFAULT_MCP_POLICY: McpPolicy = {
  clients: { claude: false, codex: false, other: false },
  excludedDocs: [],
  excludedFolders: []
}

const MAX_EXCLUDED_DOCS = 5000
const MAX_EXCLUDED_FOLDERS = 200

const pathList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0 && p.length < 4096))].slice(0, max)
    : []

/** A stored policy is untrusted input: anything unreadable shares nothing.
 *  v0.79.0 kept one master switch (`sharing`); on, it let in the Claude
 *  entries it wrote (untagged, so read as 'other') and anything set up by
 *  hand — which is what the two switches it becomes let in. */
export function sanitizeMcpPolicy(input: unknown): McpPolicy {
  if (!isObj(input)) return { ...DEFAULT_MCP_POLICY, clients: { ...DEFAULT_MCP_POLICY.clients } }
  const stored = isObj(input.clients) ? input.clients : null
  const legacy = !stored && input.sharing === true
  return {
    clients: {
      claude: stored ? stored.claude === true : legacy,
      codex: stored ? stored.codex === true : false,
      other: stored ? stored.other === true : legacy
    },
    excludedDocs: pathList(input.excludedDocs, MAX_EXCLUDED_DOCS),
    excludedFolders: pathList(input.excludedFolders, MAX_EXCLUDED_FOLDERS)
  }
}

/** Whether any tool may read at all */
export const sharesWithAny = (policy: McpPolicy): boolean => MCP_CLIENTS.some((c) => policy.clients[c])

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
  codex: McpClientState
  /** The entry as an `mcpServers` JSON block, for any other tool */
  config: string
  /** Claude Code's own command line, for a terminal */
  command: string
}

/** What a switch in the panel turns on or off. 'claude' is Claude Code and
 *  Claude Desktop together — one app to the reader, two config files to us.
 *  'other' = any tool set up by hand from the copied entry: turning it on
 *  only puts the script in place for the entry to name. */
export type McpTarget = McpClient

/** One document as the panel lists it — the path stays in the app */
export interface McpDocument {
  path: string
  name: string
  title?: string
  notes: number
  conversations: number
  updatedAt: number
  locked: boolean
  excluded: 'doc' | 'folder' | null
}

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

// ---------- Codex (~/.codex/config.toml) ----------
//
// Codex — its CLI, Codex in the ChatGPT desktop app and the editor
// extension — reads one TOML file.
// No TOML parser here (the house rule on dependencies), and none is needed:
// we write and remove exactly one table of our own, `[mcp_servers.pdf-scholar]`,
// and every other line of the file is left byte for byte as it was. Our table
// runs from its header to the next header that is not one of its own
// sub-tables; a hand-made `[mcp_servers.pdf-scholar.env]` goes with it.

/** A TOML basic string */
const tomlString = (s: string): string =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`

const CODEX_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:pdf-scholar|"pdf-scholar"|'pdf-scholar')\s*(\.[^\]]*)?\]\s*(#.*)?$/

/** Our table, as written */
export function codexBlock(entry: McpServerEntry): string {
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(', ')
  return [
    `[mcp_servers.${MCP_KEY}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    `env = { ${env} }`
  ].join('\n')
}

/** The file's lines with our table taken out, and where it stood (-1 = it
 *  was not there) */
function withoutCodexBlock(lines: string[]): { rest: string[]; at: number } {
  const rest: string[] = []
  let at = -1
  let inside: string[] | null = null
  /** A comment run at the end of our table heads whatever follows it (we
   *  never write comments): it stays, without the blank lines before it */
  const keepTrailingComments = (): void => {
    if (!inside) return
    let from = inside.length
    while (from > 0 && /^\s*(#.*)?$/.test(inside[from - 1])) from--
    const tail = inside.slice(from)
    const first = tail.findIndex((l) => l.trim() !== '')
    if (first > -1) rest.push(...tail.slice(first))
  }
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      const ours = CODEX_HEADER.test(line)
      if (ours) {
        if (at === -1) at = rest.length
        inside = inside ?? []
        continue
      }
      keepTrailingComments()
      inside = null
    }
    if (inside) inside.push(line)
    else rest.push(line)
  }
  keepTrailingComments()
  return { rest, at }
}

/** config.toml's text with our server set (or removed: entry null). An empty
 *  or missing file starts empty; nothing but our table changes. */
export function mergeCodexToml(text: string | null, entry: McpServerEntry | null): string {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  const { rest, at } = withoutCodexBlock(lines)
  // Blank lines that stood between our table and the next go with it
  while (at > -1 && at < rest.length && rest[at].trim() === '' && (at === 0 || rest[at - 1].trim() === '')) {
    rest.splice(at, 1)
  }
  if (entry) {
    const block = codexBlock(entry).split('\n')
    if (at > -1) {
      rest.splice(at, 0, ...block, ...(at < rest.length ? [''] : []))
    } else {
      while (rest.length && rest[rest.length - 1].trim() === '') rest.pop()
      if (rest.length) rest.push('')
      rest.push(...block)
    }
  }
  while (rest.length && rest[rest.length - 1].trim() === '') rest.pop()
  return rest.length ? `${rest.join(eol)}${eol}` : ''
}

/** Whether config.toml names our server */
export const hasCodexServer = (text: string | null): boolean =>
  !!text && text.split(/\r?\n/).some((l) => CODEX_HEADER.test(l))

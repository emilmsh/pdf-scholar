// «KI-verktøy på maskinen» in the AI settings: Claude Code and Claude Desktop
// connected to the MCP server with one click each (src/main/mcp-connect.ts),
// and the entry to paste for any other tool. Desktop only — the bridge
// answers null on the web and in the extension, and the group is not drawn.
// Each row works like the ChatGPT sign-in above it: an action that takes
// effect at once, not a field the Save button commits.
import { useEffect, useState } from 'react'
import type { FileError } from '../../../shared/types'
import type { McpClientState, McpStatus, McpTarget } from '../../../shared/mcp'
import { bridge } from '../bridge'
import { errorText, t, useLang } from '../i18n'

/** The setup for each tool's own config format (Codex's TOML, opencode's
 *  `mcp` block, …) — the copied entry is the common `mcpServers` form */
const MCP_GUIDE_URL = 'https://github.com/emilmsh/pdf-scholar/blob/master/docs/MCP.md'

const ROWS: { target: Exclude<McpTarget, 'other'>; name: string; key: 'claudeCode' | 'claudeDesktop' }[] = [
  { target: 'claude-code', name: 'Claude Code', key: 'claudeCode' },
  { target: 'claude-desktop', name: 'Claude Desktop', key: 'claudeDesktop' }
]

export function McpSettings(): React.JSX.Element | null {
  useLang()
  /** undefined = still looking; null = no tool can be connected here */
  const [status, setStatus] = useState<McpStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState<McpTarget | null>(null)
  const [error, setError] = useState<FileError | null>(null)
  const [restartNote, setRestartNote] = useState(false)
  const [copied, setCopied] = useState<'config' | 'command' | null>(null)

  useEffect(() => {
    let live = true
    void bridge.mcpStatus().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])

  if (status === null) return null

  const toggle = async (target: McpTarget, on: boolean): Promise<void> => {
    setError(null)
    setBusy(target)
    const result = await bridge.mcpConnect(target, on)
    setBusy(null)
    if (!result.ok) {
      setError(result)
      return
    }
    setStatus(result.status)
    if (target === 'claude-desktop') setRestartNote(true)
  }

  /** Copy an entry for a tool set up by hand — after putting the script it
   *  names in place, or the entry would point at nothing */
  const copy = async (what: 'config' | 'command', text: string): Promise<void> => {
    setError(null)
    const ready = await bridge.mcpConnect('other', true)
    if (!ready.ok) {
      setError(ready)
      return
    }
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600)
      },
      () => {}
    )
  }

  const control = (target: McpTarget, state: McpClientState, s: McpStatus): React.JSX.Element => {
    if (state === 'connected') {
      return (
        <span className="ai-chatgpt-account">
          {t('mcp.connected')}
          {' · '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              if (!busy) void toggle(target, false)
            }}
          >
            {t('mcp.disconnect')}
          </a>
        </span>
      )
    }
    if (state === 'absent') {
      return (
        <span className="ai-field-hint">
          {t('mcp.absent')}
          {/* Claude Code may live where we did not look (WSL, a shell's own
              PATH): its command line still does the job from a terminal */}
          {target === 'claude-code' && (
            <>
              {' · '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  void copy('command', s.command)
                }}
              >
                {copied === 'command' ? t('mcp.copied') : t('mcp.copyCommand')}
              </a>
            </>
          )}
        </span>
      )
    }
    return (
      <button className="btn-secondary" disabled={busy !== null} onClick={() => void toggle(target, true)}>
        {t('mcp.connect')}
      </button>
    )
  }

  return (
    <div className="ai-field-group ai-mcp">
      <div className="ai-settings-heading">{t('mcp.title')}</div>
      <p className="ai-field-hint">{t('mcp.hint')}</p>
      {status === undefined ? (
        <p className="ai-field-hint">{t('mcp.checking')}</p>
      ) : status.unsupported ? (
        <p className="ai-field-hint">{t(status.unsupported === 'store' ? 'mcp.store' : 'mcp.noScript')}</p>
      ) : (
        <>
          {ROWS.map(({ target, name, key }) => (
            <div className="ai-field" key={target}>
              <span>{name}</span>
              {control(target, status[key], status)}
            </div>
          ))}
          <div className="ai-field">
            <span>{t('mcp.other')}</span>
            <button className="btn-secondary" onClick={() => void copy('config', status.config)}>
              {copied === 'config' ? t('mcp.copied') : t('mcp.copyConfig')}
            </button>
            <p className="ai-field-hint">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  bridge.openExternal(MCP_GUIDE_URL)
                }}
              >
                {t('mcp.guide')}
              </a>
            </p>
          </div>
          {restartNote && status.claudeDesktop === 'connected' && (
            <p className="ai-field-hint">{t('mcp.restartDesktop')}</p>
          )}
        </>
      )}
      {error && (
        <p className="ai-field-hint ai-field-error">
          {errorText(error)}
          {error.code === 'mcp-client-failed' && error.error ? ` (${error.error})` : ''}
        </p>
      )}
    </div>
  )
}

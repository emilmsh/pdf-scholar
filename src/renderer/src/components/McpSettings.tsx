// «KI-verktøy på maskinen» in the AI settings: the master switch, Claude Code
// and Claude Desktop connected with one click each (src/main/mcp-connect.ts),
// the entry to paste for any other tool, and what is kept out (shared/mcp.ts).
// Desktop only — the bridge answers null on the web and in the extension, and
// the group is not drawn. Everything here takes effect at once, like the
// ChatGPT sign-in above it; the Save button commits none of it.
//
// Giving and taking back cost the same (Emil, 2026-10-29): «Koble til» and
// «Koble fra» are the same kind of button in the same place, and the switch
// shuts every tool out in one click — those set up by hand too, which the
// app cannot disconnect for the reader.
import { useEffect, useState } from 'react'
import type { FileError } from '../../../shared/types'
import type { McpClientState, McpPolicy, McpStatus, McpTarget } from '../../../shared/mcp'
import { docNameFromPath } from '../../../shared/chat-history'
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
  const [policy, setPolicy] = useState<McpPolicy | null>(null)
  const [busy, setBusy] = useState<McpTarget | null>(null)
  const [error, setError] = useState<FileError | null>(null)
  const [restartNote, setRestartNote] = useState(false)
  const [copied, setCopied] = useState<'config' | 'command' | null>(null)

  useEffect(() => {
    let live = true
    void bridge.mcpPolicy().then((p) => {
      if (live) setPolicy(p)
    })
    void bridge.mcpStatus().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])

  if (status === null) return null

  const update = async (patch: Partial<McpPolicy>): Promise<void> => {
    const next = await bridge.mcpSetPolicy(patch)
    if (next) setPolicy(next)
  }

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
    // Connecting turned the switch on in main; show it
    setPolicy(await bridge.mcpPolicy())
    if (target === 'claude-desktop') setRestartNote(on)
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
    setPolicy(await bridge.mcpPolicy())
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600)
      },
      () => {}
    )
  }

  const control = (target: McpTarget, state: McpClientState, s: McpStatus): React.JSX.Element => {
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
    const connected = state === 'connected'
    return (
      <span className="ai-mcp-row">
        {connected && <span className="ai-chatgpt-account">{t('mcp.connected')}</span>}
        <button className="btn-secondary" disabled={busy !== null} onClick={() => void toggle(target, !connected)}>
          {connected ? t('mcp.disconnect') : t('mcp.connect')}
        </button>
      </span>
    )
  }

  const keptOut = policy ? [...policy.excludedFolders.map((p) => ({ p, folder: true })), ...policy.excludedDocs.map((p) => ({ p, folder: false }))] : []

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
          {policy && (
            <>
              <label className="theme-menu-toggle ai-mcp-switch">
                <input
                  type="checkbox"
                  checked={policy.sharing}
                  onChange={(e) => void update({ sharing: e.target.checked })}
                />
                {t('mcp.sharing')}
              </label>
              {!policy.sharing && <p className="ai-field-hint">{t('mcp.sharingOffHint')}</p>}
            </>
          )}
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
          {policy && (
            <div className="ai-field">
              <span>{t('mcp.keptOut')}</span>
              {keptOut.length > 0 && (
                <ul className="ai-mcp-kept">
                  {keptOut.map(({ p, folder }) => (
                    <li key={`${folder ? 'f' : 'd'}:${p}`} title={p}>
                      <span className="ai-mcp-kept-name">
                        {folder ? `${docNameFromPath(p)}/` : docNameFromPath(p)}
                      </span>
                      <button
                        className="ai-mcp-kept-remove"
                        aria-label={t('mcp.letBackIn')}
                        title={t('mcp.letBackIn')}
                        onClick={() =>
                          void update(
                            folder
                              ? { excludedFolders: policy.excludedFolders.filter((f) => f !== p) }
                              : { excludedDocs: policy.excludedDocs.filter((d) => d !== p) }
                          )
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                className="btn-secondary"
                onClick={() =>
                  void bridge.mcpPickFolder().then((folder) => {
                    if (folder && !policy.excludedFolders.includes(folder)) {
                      void update({ excludedFolders: [...policy.excludedFolders, folder] })
                    }
                  })
                }
              >
                {t('mcp.addFolder')}
              </button>
              <p className="ai-field-hint">{t('mcp.keptOutHint')}</p>
            </div>
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

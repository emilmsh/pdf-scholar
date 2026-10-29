// «KI-verktøy på maskinen»: which AI tools on this computer may read the
// reader's notes and conversations (src/main/mcp-server.ts), and about which
// documents. Its own dialog from the settings menu — not part of the API-key
// settings, which are about the app's own assistant and have nothing to do
// with this (Emil, 2026-10-29). Desktop only: the bridge answers null on the
// web and in the extension, and the menu offers no entry there.
//
// One switch per tool and one per document, all in one place:
// - A tool's switch writes or takes back its entry in that tool's own config
//   and turns the server's answer to it on or off — giving and taking back
//   are the same click (src/main/mcp-connect.ts). «Claude» is Claude Code and
//   Claude Desktop together, one app to the reader.
// - A document's switch keeps it out or lets it back in; a folder keeps out
//   everything under it, files added later too.
// Everything takes effect at once; there is no Save.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileError } from '../../../shared/types'
import type { McpDocument, McpPolicy, McpStatus, McpTarget } from '../../../shared/mcp'
import { docNameFromPath } from '../../../shared/chat-history'
import { bridge } from '../bridge'
import { errorText, t, useLang } from '../i18n'
import { runNotesBackfill } from '../notes-backfill'

/** How to paste the entry into a tool set up by hand */
const MCP_GUIDE_URL = 'https://github.com/emilmsh/pdf-scholar/blob/master/docs/MCP.md'

const OPEN_EVENT = 'pdfx:ai-tools'

/** Open the dialog, scrolled to one document's switch when a path is given */
export function openAiTools(path?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { path } }))
}

/** For the one place that hosts the dialog (the toolbar) */
export function onOpenAiTools(cb: (path: string | undefined) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<{ path?: string }>).detail?.path)
  window.addEventListener(OPEN_EVENT, handler)
  return () => window.removeEventListener(OPEN_EVENT, handler)
}

const count = (n: number, one: 'mcp.notesOne' | 'mcp.convOne', many: 'mcp.notesMany' | 'mcp.convMany'): string =>
  t(n === 1 ? one : many, { count: String(n) })

export default function AiToolsDialog({
  focusPath,
  onClose
}: {
  focusPath?: string | undefined
  onClose(): void
}): React.JSX.Element {
  useLang()
  /** undefined = still looking; null = no tool can be connected here */
  const [status, setStatus] = useState<McpStatus | null | undefined>(undefined)
  const [policy, setPolicy] = useState<McpPolicy | null>(null)
  const [docs, setDocs] = useState<McpDocument[] | null>(null)
  const [busy, setBusy] = useState<McpTarget | null>(null)
  const [error, setError] = useState<FileError | null>(null)
  const [restartNote, setRestartNote] = useState(false)
  const [copied, setCopied] = useState<'config' | 'command' | null>(null)
  const [query, setQuery] = useState('')
  const focusRef = useRef<HTMLLabelElement | null>(null)

  const reloadDocs = (): void => {
    void bridge.mcpDocuments().then(setDocs)
  }

  useEffect(() => {
    let live = true
    void bridge.mcpPolicy().then((p) => live && setPolicy(p))
    void bridge.mcpStatus().then((s) => live && setStatus(s))
    void bridge.mcpDocuments().then((d) => live && setDocs(d))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The document the Merknader tab asked about, in view once the list is in
  useEffect(() => {
    if (docs && focusPath) focusRef.current?.scrollIntoView({ block: 'center' })
  }, [docs, focusPath])

  const shown = useMemo(() => {
    if (!docs) return []
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return docs
    return docs.filter((d) => {
      const hay = `${d.name} ${d.title ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [docs, query])

  const toggleTool = async (target: McpTarget, on: boolean): Promise<void> => {
    setError(null)
    setBusy(target)
    const result = await bridge.mcpConnect(target, on)
    setBusy(null)
    // The switch may have moved even when the entry failed (off is written
    // first), so the policy is read back either way
    setPolicy(await bridge.mcpPolicy())
    if (!result.ok) {
      setError(result)
      return
    }
    setStatus(result.status)
    if (target === 'claude') setRestartNote(on && result.status.claudeDesktop === 'connected')
    // Marks of papers not opened since notes were kept, read quietly now
    if (on) void runNotesBackfill().then(reloadDocs)
  }

  const update = async (patch: Partial<Pick<McpPolicy, 'excludedDocs' | 'excludedFolders'>>): Promise<void> => {
    const next = await bridge.mcpSetPolicy(patch)
    if (next) setPolicy(next)
    reloadDocs()
  }

  const toggleDoc = (d: McpDocument): void => {
    if (!policy) return
    const rest = policy.excludedDocs.filter((p) => p !== d.path)
    void update({ excludedDocs: d.excluded === 'doc' ? rest : [...rest, d.path] })
  }

  const copy = (what: 'config' | 'command', text: string): void => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600)
      },
      () => {}
    )
  }

  const toolRow = (
    target: McpTarget,
    name: string,
    sub: React.ReactNode,
    found: boolean
  ): React.JSX.Element => {
    const on = policy?.clients[target] === true
    return (
      <label className="theme-menu-toggle ai-tools-row" key={target}>
        <span className="ai-tools-text">
          <span className="ai-tools-name">{name}</span>
          <span className="ai-tools-sub">{sub}</span>
        </span>
        <input
          type="checkbox"
          checked={on}
          // A tool not found can still be switched OFF
          disabled={busy !== null || !policy || (!on && !found)}
          onChange={(e) => void toggleTool(target, e.target.checked)}
        />
      </label>
    )
  }

  const link = (label: string, onClick: () => void): React.JSX.Element => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault()
        // Inside a label: a click here must not flip the switch
        e.stopPropagation()
        onClick()
      }}
    >
      {label}
    </a>
  )

  const tools = (s: McpStatus): React.JSX.Element => {
    const claudeFound = s.claudeCode !== 'absent' || s.claudeDesktop !== 'absent'
    const claudeSub =
      s.claudeCode !== 'absent' && s.claudeDesktop !== 'absent'
        ? t('mcp.claudeBoth')
        : s.claudeCode !== 'absent'
          ? 'Claude Code'
          : s.claudeDesktop !== 'absent'
            ? 'Claude Desktop'
            : null
    return (
      <>
        {toolRow(
          'claude',
          'Claude',
          claudeSub ?? (
            <>
              {t('mcp.notFound')}
              {/* Claude Code may live where we did not look (WSL, a shell's
                  own PATH): its command line still does it from a terminal */}
              {' · '}
              {link(copied === 'command' ? t('mcp.copied') : t('mcp.copyCommand'), () => copy('command', s.command))}
            </>
          ),
          claudeFound
        )}
        {restartNote && <p className="ai-tools-note">{t('mcp.restartDesktop')}</p>}
        {toolRow('codex', 'Codex', s.codex === 'absent' ? t('mcp.notFound') : t('mcp.codexSub'), s.codex !== 'absent')}
        {toolRow(
          'other',
          t('mcp.other'),
          policy?.clients.other ? (
            <>
              {link(copied === 'config' ? t('mcp.copied') : t('mcp.copyConfig'), () => copy('config', s.config))}
              {' · '}
              {link(t('mcp.guide'), () => bridge.openExternal(MCP_GUIDE_URL))}
            </>
          ) : (
            t('mcp.otherSub')
          ),
          true
        )}
        <p className="ai-tools-note">{t('mcp.copyHint')}</p>
      </>
    )
  }

  const docRow = (d: McpDocument): React.JSX.Element => {
    const focused = d.path === focusPath
    const why = d.locked ? t('mcp.lockedDoc') : d.excluded === 'folder' ? t('mcp.folderOut') : null
    return (
      <label
        className={`theme-menu-toggle ai-tools-row ai-tools-doc${focused ? ' is-focused' : ''}`}
        key={d.path}
        ref={focused ? focusRef : undefined}
        title={d.title ? `${d.title}\n${d.path}` : d.path}
      >
        <span className="ai-tools-text">
          <span className="ai-tools-name">{d.title || d.name}</span>
          <span className="ai-tools-sub">
            {why ??
              [
                ...(d.title ? [d.name] : []),
                ...(d.notes ? [count(d.notes, 'mcp.notesOne', 'mcp.notesMany')] : []),
                ...(d.conversations ? [count(d.conversations, 'mcp.convOne', 'mcp.convMany')] : [])
              ].join(' · ')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={!d.locked && d.excluded === null}
          disabled={!policy || d.locked || d.excluded === 'folder'}
          onChange={() => toggleDoc(d)}
        />
      </label>
    )
  }

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="shortcuts-dialog ai-tools-dialog" role="dialog" aria-modal="true" aria-label={t('mcp.title')}>
        <div className="shortcuts-head">
          <div className="shortcuts-title-row">
            <h2 className="shortcuts-title">{t('mcp.title')}</h2>
            <button className="shortcuts-close" onClick={onClose} aria-label={t('app.close')}>
              ✕
            </button>
          </div>
          <p className="ai-tools-intro">{t('mcp.intro')}</p>
        </div>
        <div className="shortcuts-body ai-tools-body">
          {status === undefined ? (
            <p className="ai-tools-note">{t('mcp.checking')}</p>
          ) : status === null || status.unsupported ? (
            <p className="ai-tools-note">{t(status?.unsupported === 'no-script' ? 'mcp.noScript' : 'mcp.store')}</p>
          ) : (
            <>
              <section className="keys-group">
                <h3 className="keys-group-title">{t('mcp.tools')}</h3>
                {tools(status)}
                {error && (
                  <p className="ai-tools-note ai-field-error">
                    {errorText(error)}
                    {error.code === 'mcp-client-failed' && error.error ? ` (${error.error})` : ''}
                  </p>
                )}
              </section>
              <section className="keys-group">
                <h3 className="keys-group-title">{t('mcp.docs')}</h3>
                <p className="ai-tools-note">{t('mcp.docsHint')}</p>
                {docs && docs.length > 8 && (
                  <input
                    className="shortcuts-filter ai-tools-filter"
                    type="search"
                    value={query}
                    placeholder={t('mcp.filter')}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                )}
                {docs === null ? null : docs.length === 0 ? (
                  <p className="ai-tools-note">{t('mcp.noDocs')}</p>
                ) : shown.length === 0 ? (
                  <p className="ai-tools-note">{t('mcp.noMatches')}</p>
                ) : (
                  <div className="ai-tools-docs">{shown.map(docRow)}</div>
                )}
              </section>
              {policy && (
                <section className="keys-group">
                  <h3 className="keys-group-title">{t('mcp.folders')}</h3>
                  {policy.excludedFolders.length > 0 && (
                    <ul className="ai-mcp-kept">
                      {policy.excludedFolders.map((p) => (
                        <li key={p} title={p}>
                          <span className="ai-mcp-kept-name">{`${docNameFromPath(p)}/`}</span>
                          <button
                            className="ai-mcp-kept-remove"
                            aria-label={t('mcp.letBackIn')}
                            title={t('mcp.letBackIn')}
                            onClick={() => void update({ excludedFolders: policy.excludedFolders.filter((f) => f !== p) })}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="btn-secondary ai-tools-add-folder"
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
                  <p className="ai-tools-note">{t('mcp.foldersHint')}</p>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

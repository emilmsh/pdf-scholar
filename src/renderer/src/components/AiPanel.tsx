// AI assistant: right-hand chat panel with grounded citation chips, provider
// settings, and the quick "explain selection" popover. Keys and API calls
// live in the main process; this component only sees the PdfxApi surface.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCitation,
  AiConfigView,
  AiContentPart,
  AiProviderId,
  AiUsage,
  ThinkingLevel
} from '../../../shared/types'
import { bridge } from '../bridge'
import {
  annotationsQuestion,
  chatSystem,
  citationPage,
  estimateCost,
  explainSystem,
  explainUserMessage,
  formatCost,
  resolveCitation,
  summaryPrompt
} from '../ai'
import { t, useLang } from '../i18n'
import type { MsgKey } from '../i18n'
import type { AiDocument, ResolvedCitation } from '../ai'
import type { PageText } from '../search'
import { IconGear, IconSend, IconSparkle, IconStop, IconSummary } from './icons'

let requestCounter = 1
const nextRequestId = (): number => requestCounter++

export interface EnsuredDocument {
  pages: PageText[]
  doc: AiDocument
}

// ---------- Minimal markdown (paragraphs, lists, headings, bold/italic/code) ----------

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) out.push(<strong key={`${keyBase}-${i++}`}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) out.push(<code key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</code>)
    else out.push(<em key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</em>)
    last = regex.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderMarkdownLite(text: string): React.ReactNode {
  const blocks = text.split(/\n{2,}/)
  return blocks.map((block, b) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) return null
    const isList = lines.every((l) => /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l))
    if (isList) {
      return (
        <ul key={b}>
          {lines.map((l, i) => (
            <li key={i}>{renderInline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), `${b}-${i}`)}</li>
          ))}
        </ul>
      )
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0])
    if (heading && lines.length === 1) {
      return <h4 key={b}>{renderInline(heading[2], `${b}-h`)}</h4>
    }
    return <p key={b}>{renderInline(lines.join(' '), `${b}-p`)}</p>
  })
}

// ---------- Message rendering ----------

type PanelMessage =
  | { role: 'user'; text: string; /** compact bubble label when text is a long scaffold */ display?: string }
  | { role: 'assistant'; parts: AiContentPart[]; usage?: AiUsage; model?: string; error?: string }

interface AssistantBodyProps {
  parts: AiContentPart[]
  doc: AiDocument | null
  onCitation(citation: AiCitation): void
}

function AssistantBody({ parts, doc, onCitation }: AssistantBodyProps): React.JSX.Element {
  return (
    <>
      {parts.map((part, i) => (
        <div className="ai-part" key={i}>
          {renderMarkdownLite(part.text)}
          {part.citations.length > 0 && (
            <span className="ai-chips">
              {part.citations.map((c, j) => {
                const page = citationPage(c, doc)
                return (
                  <button
                    key={j}
                    className="ai-chip"
                    title={t('ai.chipTip')}
                    onClick={() => onCitation(c)}
                  >
                    {page !== null ? `${t('app.pageAbbrev')} ${page}` : t('ai.sourceChip')}
                  </button>
                )
              })}
            </span>
          )}
        </div>
      ))}
    </>
  )
}

// ---------- Settings ----------

const providerLabels = (): { id: AiProviderId; label: string }[] => [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'mock', label: t('ai.providerMock') }
]

// Curated, verified model lists (see docs/agent-notes/modeller-api.md)
const MODELS: Record<AiProviderId, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — anbefalt' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — mest kapabel' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — rask/billig' },
    { id: 'claude-fable-5', label: 'Claude Fable 5 — tyngst/dyrest' }
  ],
  openai: [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — anbefalt' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — flaggskip' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — rask' }
  ],
  azure: [],
  mock: [{ id: 'mock-1', label: 'mock-1' }]
}

const THINKING_LEVELS: { id: ThinkingLevel; key: MsgKey }[] = [
  { id: 'off', key: 'ai.thinkOff' },
  { id: 'low', key: 'ai.thinkLow' },
  { id: 'medium', key: 'ai.thinkMedium' },
  { id: 'high', key: 'ai.thinkHigh' }
]

interface SettingsProps {
  config: AiConfigView
  onSaved(next: AiConfigView): void
  onClose(): void
}

function AiSettings({ config, onSaved, onClose }: SettingsProps): React.JSX.Element {
  useLang()
  const [provider, setProvider] = useState<AiProviderId>(config.provider)
  const [model, setModel] = useState(config.models[config.provider] ?? '')
  const [thinking, setThinking] = useState<ThinkingLevel>(config.thinking ?? 'medium')
  const [key, setKey] = useState('')
  const [endpoint, setEndpoint] = useState(config.azure.endpoint)
  const [deployment, setDeployment] = useState(config.azure.deployment)
  const [saving, setSaving] = useState(false)

  const pickProvider = (p: AiProviderId): void => {
    setProvider(p)
    setModel(config.models[p] || MODELS[p][0]?.id || '')
    setKey('')
  }

  // Haiku ignores reasoning effort — hide the control for it
  const thinkingApplies = !/haiku/i.test(model) && provider !== 'mock'

  const save = async (): Promise<void> => {
    setSaving(true)
    const patch: Parameters<typeof bridge.aiSetConfig>[0] = {
      provider,
      models: { ...config.models, [provider]: model.trim() },
      azure: { endpoint: endpoint.trim(), deployment: deployment.trim() },
      thinking
    }
    if (key.trim()) patch.keys = { [provider]: key.trim() }
    const next = await bridge.aiSetConfig(patch)
    setSaving(false)
    onSaved(next)
  }

  return (
    <div className="ai-settings">
      <label className="ai-field">
        <span>{t('ai.provider')}</span>
        <select value={provider} onChange={(e) => pickProvider(e.target.value as AiProviderId)}>
          {providerLabels().map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {provider !== 'mock' && (
        <label className="ai-field">
          <span>{t('ai.apiKey')}</span>
          <input
            type="password"
            value={key}
            placeholder={config.hasKey[provider] ? t('ai.keySaved') : t('ai.keyNew')}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
          />
        </label>
      )}
      {provider !== 'azure' && provider !== 'mock' && (
        <label className="ai-field">
          <span>{t('ai.model')}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS[provider].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS[provider].some((m) => m.id === model) && model && (
              <option value={model}>{model}</option>
            )}
          </select>
        </label>
      )}
      {thinkingApplies && (
        <label className="ai-field">
          <span>{t('ai.reasoning')}</span>
          <select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel)}>
            {THINKING_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {t(l.key)}
              </option>
            ))}
          </select>
        </label>
      )}
      {provider === 'azure' && (
        <>
          <label className="ai-field">
            <span>{t('ai.endpoint')}</span>
            <input
              value={endpoint}
              placeholder="https://…openai.azure.com"
              onChange={(e) => setEndpoint(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="ai-field">
            <span>{t('ai.deployment')}</span>
            <input
              value={deployment}
              onChange={(e) => setDeployment(e.target.value)}
              spellCheck={false}
            />
          </label>
        </>
      )}
      <p className="ai-settings-note">
        {t('ai.settingsNote')}
        {!config.encryptionAvailable && provider !== 'mock' && (
          <strong>{t('ai.encryptionWarn')}</strong>
        )}
      </p>
      <div className="ai-settings-actions">
        <button className="btn-secondary" onClick={onClose}>
          {t('app.cancel')}
        </button>
        <button className="btn-primary" disabled={saving} onClick={() => void save()}>
          {t('app.save')}
        </button>
      </div>
    </div>
  )
}

// ---------- Chat panel ----------

export interface AiSeed {
  question: string
  answer: string
}

interface PanelProps {
  open: boolean
  docTitle: string
  /** Exchange handed over from the explain-selection popover */
  seed: AiSeed | null
  onSeedConsumed(): void
  ensureDocument(): Promise<EnsuredDocument | null>
  /** Whether the document currently has any annotations (gates the suggestion) */
  hasAnnotations: boolean
  /** Bumped by the viewer (sidebar ✦) to fire the annotations question */
  annotsAskId: number
  getAnnotationsText(): Promise<string | null>
  onCitationClick(resolved: ResolvedCitation): void
  onClose(): void
}

const suggestions = (): string[] => [t('ai.suggestion1'), t('ai.suggestion2'), t('ai.suggestion3')]

export default function AiPanel({
  open,
  docTitle,
  seed,
  onSeedConsumed,
  ensureDocument,
  hasAnnotations,
  annotsAskId,
  getAnnotationsText,
  onCitationClick,
  onClose
}: PanelProps): React.JSX.Element | null {
  useLang()
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const docRef = useRef<EnsuredDocument | null>(null)
  const currentIdRef = useRef<number | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    let stale = false
    void bridge.aiGetConfig().then((view) => {
      if (stale) return
      setConfig(view)
      if (!view.hasKey[view.provider]) setShowSettings(true)
    })
    return () => {
      stale = true
    }
  }, [open])

  useEffect(
    () =>
      bridge.onAiDelta((id, text) => {
        if (id === currentIdRef.current) setStreamText((s) => s + text)
      }),
    []
  )

  // Import an exchange handed over from the explain popover
  useEffect(() => {
    if (!open || !seed) return
    setMessages((m) => [
      ...m,
      { role: 'user', text: seed.question },
      { role: 'assistant', parts: [{ text: seed.answer, citations: [] }] }
    ])
    onSeedConsumed()
  }, [open, seed, onSeedConsumed])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamText, busy])

  useEffect(() => {
    if (open && !showSettings) inputRef.current?.focus()
  }, [open, showSettings])

  const send = useCallback(
    async (question: string, display?: string) => {
      const trimmed = question.trim()
      if (!trimmed || busy) return
      setInput('')
      setBusy(true)
      setStreamText('')
      setMessages((m) => [...m, { role: 'user', text: trimmed, display }])
      const history = [
        ...messagesRef.current.map((m) =>
          m.role === 'user'
            ? { role: 'user' as const, text: m.text }
            : { role: 'assistant' as const, text: m.parts.map((p) => p.text).join('') }
        ),
        { role: 'user' as const, text: trimmed }
      ]
      const ensured = docRef.current ?? (await ensureDocument())
      docRef.current = ensured
      const requestId = nextRequestId()
      currentIdRef.current = requestId
      const result = await bridge.aiChat({
        requestId,
        system: chatSystem(),
        messages: history,
        document: ensured ? { title: docTitle, text: ensured.doc.text } : null
      })
      currentIdRef.current = null
      setStreamText('')
      setBusy(false)
      if ('error' in result) {
        setMessages((m) => [...m, { role: 'assistant', parts: [], error: result.error }])
      } else {
        setMessages((m) => [
          ...m,
          { role: 'assistant', parts: result.parts, usage: result.usage, model: result.model }
        ])
      }
    },
    [busy, docTitle, ensureDocument]
  )

  const stop = useCallback(() => {
    if (currentIdRef.current !== null) bridge.aiAbort(currentIdRef.current)
  }, [])

  const sendAnnots = useCallback(async () => {
    const block = await getAnnotationsText()
    if (block) void send(annotationsQuestion(block), t('ai.annotsBtn'))
  }, [getAnnotationsText, send])

  // Sidebar ✦ bumps annotsAskId to fire the annotations question from outside
  const lastAnnotsAskRef = useRef(annotsAskId)
  useEffect(() => {
    if (!open || annotsAskId === lastAnnotsAskRef.current) return
    lastAnnotsAskRef.current = annotsAskId
    void sendAnnots()
  }, [open, annotsAskId, sendAnnots])

  const handleCitation = useCallback(
    (citation: AiCitation) => {
      const ensured = docRef.current
      if (!ensured) return
      const resolved = resolveCitation(citation, ensured.pages, ensured.doc)
      if (resolved) {
        onCitationClick(resolved)
        return
      }
      // Never a dead button: an unlocatable quote still jumps to its page
      const page = citationPage(citation, ensured.doc)
      if (page && page >= 1 && page <= ensured.pages.length) {
        onCitationClick({ pageNumber: page, start: 0, end: 0 })
      }
    },
    [onCitationClick]
  )

  const totalCost = useMemo(() => {
    let sum = 0
    let known = false
    for (const m of messages) {
      if (m.role === 'assistant' && m.usage && m.model) {
        const cost = estimateCost(m.model, m.usage)
        if (cost !== null) {
          sum += cost
          known = true
        }
      }
    }
    return known ? sum : null
  }, [messages])

  if (!open) return null

  const providerLabel = providerLabels().find((p) => p.id === config?.provider)?.label ?? ''

  return (
    <aside className="ai-panel">
      <header className="ai-header">
        <IconSparkle size={16} />
        <span className="ai-title">{t('ai.assistant')}</span>
        <span className="ai-model" title={providerLabel}>
          {config ? (config.provider === 'azure' ? config.azure.deployment : config.models[config.provider]) : ''}
        </span>
        <button
          className="tb-btn"
          title={t('ai.summaryTip')}
          disabled={busy || showSettings}
          onClick={() => void send(summaryPrompt(), t('ai.summaryBtn'))}
        >
          <IconSummary size={15} />
        </button>
        <button
          className={`tb-btn${showSettings ? ' is-active' : ''}`}
          title={t('ai.settingsTip')}
          onClick={() => setShowSettings((s) => !s)}
        >
          <IconGear size={15} />
        </button>
        <button className="tb-btn" title={t('ai.closeTip')} onClick={onClose}>
          ✕
        </button>
      </header>

      {showSettings && config ? (
        <AiSettings
          config={config}
          onSaved={(next) => {
            setConfig(next)
            setShowSettings(false)
          }}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <>
          <div className="ai-messages" ref={scrollRef}>
            {messages.length === 0 && !busy && (
              <div className="ai-empty">
                <p>{t('ai.emptyIntro')}</p>
                <div className="ai-suggestions">
                  <button
                    className="ai-summary-btn"
                    title={t('ai.summaryTip')}
                    onClick={() => void send(summaryPrompt(), t('ai.summaryBtn'))}
                  >
                    <IconSummary size={15} />
                    {t('ai.summaryBtn')}
                  </button>
                  {hasAnnotations && (
                    <button title={t('ai.annotsTip')} onClick={() => void sendAnnots()}>
                      {t('ai.annotsBtn')}
                    </button>
                  )}
                  {suggestions().map((s) => (
                    <button key={s} onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div className="ai-msg ai-user" key={i}>
                  {m.display ?? m.text}
                </div>
              ) : (
                <div className="ai-msg ai-assistant" key={i}>
                  {m.error ? (
                    <div className="ai-error">{m.error}</div>
                  ) : (
                    <AssistantBody parts={m.parts} doc={docRef.current?.doc ?? null} onCitation={handleCitation} />
                  )}
                  {m.usage && m.model && (
                    <div className="ai-meta">
                      {(() => {
                        const cost = estimateCost(m.model, m.usage)
                        const tokens = `${m.usage.inputTokens + m.usage.cacheReadTokens + m.usage.cacheWriteTokens}→${m.usage.outputTokens} tokens`
                        return cost !== null ? `≈ ${formatCost(cost)} · ${tokens}` : tokens
                      })()}
                    </div>
                  )}
                </div>
              )
            )}
            {busy && (
              <div className="ai-msg ai-assistant">
                {streamText ? (
                  renderMarkdownLite(streamText)
                ) : (
                  <div className="ai-thinking">{t('ai.readingDoc')}</div>
                )}
              </div>
            )}
          </div>

          <footer className="ai-composer">
            <textarea
              ref={inputRef}
              value={input}
              rows={2}
              placeholder={t('ai.composerPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
                e.stopPropagation()
              }}
            />
            {busy ? (
              <button className="ai-send" title={t('ai.stopTip')} onClick={stop}>
                <IconStop size={16} />
              </button>
            ) : (
              <button
                className="ai-send"
                title={t('ai.sendTip')}
                disabled={!input.trim()}
                onClick={() => void send(input)}
              >
                <IconSend size={16} />
              </button>
            )}
          </footer>
          {totalCost !== null && (
            <div className="ai-total">{t('ai.totalCost', { cost: formatCost(totalCost) })}</div>
          )}
        </>
      )}
    </aside>
  )
}

// ---------- Explain-selection popover ----------

export interface AiQuickState {
  x: number
  y: number
  mode: 'explain' | 'simplify' | 'define'
  selection: string
  pageNumber: number
  pageContext: string
}

const quickTitle = (mode: AiQuickState['mode']): string =>
  mode === 'explain' ? t('ai.quickExplain') : mode === 'simplify' ? t('ai.quickSimplify') : t('ai.quickDefine')

interface QuickProps {
  state: AiQuickState
  onSendToChat(seed: AiSeed): void
  onClose(): void
}

export function AiQuickPopover({ state, onSendToChat, onClose }: QuickProps): React.JSX.Element {
  useLang()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [meta, setMeta] = useState<string | null>(null)
  const requestIdRef = useRef<number | null>(null)
  const finalRef = useRef('')

  useEffect(() => {
    let stale = false
    const requestId = nextRequestId()
    requestIdRef.current = requestId
    const unsubscribe = bridge.onAiDelta((id, delta) => {
      if (id === requestId && !stale) setText((s) => s + delta)
    })
    void (async () => {
      const result = await bridge.aiChat({
        requestId,
        system: explainSystem(state.mode),
        messages: [
          { role: 'user', text: explainUserMessage(state.selection, state.pageNumber, state.pageContext) }
        ],
        document: null
      })
      if (stale) return
      setDone(true)
      if ('error' in result) {
        setError(result.error)
      } else {
        const full = result.parts.map((p) => p.text).join('')
        finalRef.current = full
        setText(full)
        const cost = estimateCost(result.model, result.usage)
        if (cost !== null) setMeta(`≈ ${formatCost(cost)}`)
      }
    })()
    return () => {
      stale = true
      unsubscribe()
      if (!finalRef.current && requestIdRef.current !== null) bridge.aiAbort(requestIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const left = Math.max(8, Math.min(state.x, window.innerWidth - 360 - 8))
  const top = Math.max(8, Math.min(state.y + 10, window.innerHeight - 260 - 8))

  return (
    <div className="ai-quick" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ai-quick-head">
        <IconSparkle size={14} />
        <span>
          {quickTitle(state.mode)}: «{state.selection.length > 42 ? `${state.selection.slice(0, 42)}…` : state.selection}»
        </span>
      </div>
      <div className="ai-quick-body">
        {error ? (
          <div className="ai-error">{error}</div>
        ) : text ? (
          renderMarkdownLite(text)
        ) : (
          <div className="ai-thinking">{t('ai.thinking')}</div>
        )}
      </div>
      <div className="ai-quick-actions">
        {meta && <span className="ai-meta">{meta}</span>}
        <button
          className="btn-secondary"
          disabled={!done || !!error}
          onClick={() =>
            onSendToChat({
              question: t('ai.quickQuestion', {
                title: quickTitle(state.mode),
                selection: state.selection,
                page: state.pageNumber
              }),
              answer: finalRef.current
            })
          }
        >
          {t('ai.sendToChat')}
        </button>
        <button className="btn-primary" onClick={onClose}>
          {t('app.close')}
        </button>
      </div>
    </div>
  )
}

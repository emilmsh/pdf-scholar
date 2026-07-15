// AI assistant: right-hand chat panel with grounded citation chips, provider
// settings, and the quick "explain selection" popover. Keys and API calls
// live in the main process; this component only sees the PdfxApi surface.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCitation,
  AiConfigView,
  AiContentPart,
  AiProviderId,
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
  nextAiRequestId,
  referenceSystem,
  referenceUserMessage,
  resolveCitation,
  summaryPrompt
} from '../ai'
import { t, useLang, locale } from '../i18n'
import type { MsgKey } from '../i18n'
import type { AiDocument, ResolvedCitation } from '../ai'
import type { PageText } from '../search'
import type { ChatMessage, StoredConversation } from '../chat-store'
import { deleteConversation, loadConversations, newConversationId, saveConversations } from '../chat-store'
import {
  IconChevronDown,
  IconGear,
  IconHistory,
  IconPlus,
  IconSend,
  IconSparkle,
  IconStop,
  IconSummary
} from './icons'

const nextRequestId = nextAiRequestId

export interface EnsuredDocument {
  pages: PageText[]
  doc: AiDocument
}

// ---------- Markdown rendering (Claude/ChatGPT-style subset) ----------
// Headings, paragraphs, nested bullet/numbered lists, fenced + inline code,
// bold/italic, blockquotes, tables and horizontal rules. Citation chips
// travel through the text as private-use sentinels (\uE000<index>\uE001)
// glued to the sentence they support, so they render inline — never on a
// line of their own.

interface ChipContext {
  chips: AiCitation[]
  doc: AiDocument | null
  onCitation(citation: AiCitation): void
}

const chipToken = (index: number): string => `\uE000${index}\uE001`

function renderInline(text: string, keyBase: string, ctx?: ChipContext): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const regex = /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\uE000\d+\uE001)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('\uE000')) {
      const chip = ctx?.chips[Number(token.slice(1, -1))]
      if (chip && ctx) {
        const page = citationPage(chip, ctx.doc)
        out.push(
          <button
            key={`${keyBase}-${i++}`}
            className="ai-chip"
            title={t('ai.chipTip')}
            onClick={() => ctx.onCitation(chip)}
          >
            {page !== null ? `${t('app.pageAbbrev')} ${page}` : t('ai.sourceChip')}
          </button>
        )
      }
    } else if (token.startsWith('***')) {
      out.push(
        <strong key={`${keyBase}-${i++}`}>
          <em>{token.slice(3, -3)}</em>
        </strong>
      )
    } else if (token.startsWith('**')) {
      out.push(<strong key={`${keyBase}-${i++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      out.push(<code key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</code>)
    } else {
      out.push(<em key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</em>)
    }
    last = regex.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LIST_ITEM_RE = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/
const TABLE_DIVIDER_RE = /^\|?[\s:|-]+\|?$/

const splitTableRow = (line: string): string[] =>
  line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())

/** Parse a run of list lines starting at `start`; supports one nesting level
 *  per recursion via indentation. Returns the list node and the next index. */
function parseList(
  lines: string[],
  start: number,
  keyBase: string,
  ctx?: ChipContext
): [React.ReactNode, number] {
  const first = LIST_ITEM_RE.exec(lines[start])!
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2][0])
  const items: { text: string; subLines: string[] }[] = []
  let i = start
  while (i < lines.length) {
    const m = LIST_ITEM_RE.exec(lines[i])
    if (!m) {
      // An indented non-list line continues the previous item
      if (items.length > 0 && lines[i].trim() !== '' && /^\s{2,}/.test(lines[i])) {
        items[items.length - 1].text += ' ' + lines[i].trim()
        i++
        continue
      }
      break
    }
    if (m[1].length > baseIndent && items.length > 0) {
      items[items.length - 1].subLines.push(lines[i])
      i++
      continue
    }
    if (m[1].length < baseIndent) break
    items.push({ text: m[3], subLines: [] })
    i++
  }
  const children = items.map((item, j) => (
    <li key={j}>
      {renderInline(item.text, `${keyBase}-${j}`, ctx)}
      {item.subLines.length > 0 && parseList(item.subLines, 0, `${keyBase}-${j}s`, ctx)[0]}
    </li>
  ))
  return [ordered ? <ol key={keyBase}>{children}</ol> : <ul key={keyBase}>{children}</ul>, i]
}

function renderMarkdown(text: string, ctx?: ChipContext): React.ReactNode {
  const out: React.ReactNode[] = []
  const lines = text.split('\n')
  const para: string[] = []
  let key = 0
  const flushPara = (): void => {
    if (para.length === 0) return
    out.push(<p key={key++}>{renderInline(para.join(' '), `p${key}`, ctx)}</p>)
    para.length = 0
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') {
      flushPara()
      i++
      continue
    }
    if (trimmed.startsWith('```')) {
      flushPara()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence
      out.push(
        <pre key={key++}>
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushPara()
      const content = renderInline(heading[2], `h${key}`, ctx)
      const level = heading[1].length
      out.push(
        level <= 2 ? (
          <h3 key={key++}>{content}</h3>
        ) : level === 3 ? (
          <h4 key={key++}>{content}</h4>
        ) : (
          <h5 key={key++}>{content}</h5>
        )
      )
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara()
      out.push(<hr key={key++} />)
      i++
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(<blockquote key={key++}>{renderMarkdown(buf.join('\n'), ctx)}</blockquote>)
      continue
    }
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      TABLE_DIVIDER_RE.test(lines[i + 1].trim())
    ) {
      flushPara()
      const header = splitTableRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i].trim()))
        i++
      }
      out.push(
        <div className="ai-table-wrap" key={key++}>
          <table>
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c}>{renderInline(cell, `t${key}h${c}`, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{renderInline(cell, `t${key}r${r}c${c}`, ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (LIST_ITEM_RE.test(line)) {
      flushPara()
      const [node, next] = parseList(lines, i, `l${key++}`, ctx)
      out.push(node)
      i = next
      continue
    }
    para.push(trimmed)
    i++
  }
  flushPara()
  return out
}

// ---------- Message rendering ----------

type PanelMessage = ChatMessage

interface AssistantBodyProps {
  parts: AiContentPart[]
  doc: AiDocument | null
  onCitation(citation: AiCitation): void
}

function AssistantBody({ parts, doc, onCitation }: AssistantBodyProps): React.JSX.Element {
  // Merge all parts into one markdown document so citation boundaries never
  // split paragraphs; each part's chips are glued (as inline sentinels) to
  // the end of the sentence that carries them.
  const chips: AiCitation[] = []
  let md = ''
  for (const part of parts) {
    const trailing = /\s*$/.exec(part.text)?.[0] ?? ''
    md += trailing ? part.text.slice(0, part.text.length - trailing.length) : part.text
    for (const c of part.citations) {
      md += chipToken(chips.length)
      chips.push(c)
    }
    md += trailing
  }
  return <>{renderMarkdown(md, { chips, doc, onCitation })}</>
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
        {provider !== 'mock' &&
          (config.encryptionAvailable ? (
            t('ai.settingsNoteEncrypted')
          ) : (
            <strong>{t('ai.encryptionWarn')}</strong>
          ))}
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

// ---------- Model quick-menu (click the header chip) ----------

interface ModelMenuProps {
  config: AiConfigView
  onSaved(next: AiConfigView): void
  onClose(): void
  onOpenSettings(): void
}

/** Small popover under the header model chip: switch model + reasoning effort
 *  for the current provider without opening full settings. */
function ModelQuickMenu({ config, onSaved, onClose, onOpenSettings }: ModelMenuProps): React.JSX.Element {
  useLang()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  const provider = config.provider
  const model = config.models[provider] ?? ''
  const models = MODELS[provider] ?? []
  // Haiku ignores reasoning effort; mock has none — mirror AiSettings
  const thinkingApplies = !/haiku/i.test(model) && provider !== 'mock'

  const patch = (p: Parameters<typeof bridge.aiSetConfig>[0]): void => {
    void bridge.aiSetConfig(p).then(onSaved)
  }

  return (
    <div className="ai-model-menu" ref={ref}>
      <label className="ai-field">
        <span>{t('ai.model')}</span>
        <select
          value={model}
          onChange={(e) => patch({ models: { ...config.models, [provider]: e.target.value } })}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
        </select>
      </label>
      {thinkingApplies && (
        <label className="ai-field">
          <span>{t('ai.reasoning')}</span>
          <select
            value={config.thinking}
            onChange={(e) => patch({ thinking: e.target.value as ThinkingLevel })}
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {t(l.key)}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="ai-model-more" onClick={onOpenSettings}>
        {t('ai.settingsTip')}
      </button>
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
  docPath: string
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

const chatTitle = (msgs: PanelMessage[]): string => {
  const first = msgs.find((m) => m.role === 'user') as Extract<PanelMessage, { role: 'user' }> | undefined
  const s = (first?.display ?? first?.text ?? '').replace(/\s+/g, ' ').trim()
  return s ? (s.length > 60 ? `${s.slice(0, 57)}…` : s) : t('ai.untitledChat')
}

export default function AiPanel({
  open,
  docTitle,
  docPath,
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
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [conversations, setConversations] = useState<StoredConversation[]>(() => loadConversations(docPath))
  const [activeChatId, setActiveChatId] = useState<string | null>(() => conversations[0]?.id ?? null)
  const [messages, setMessages] = useState<PanelMessage[]>(() => conversations[0]?.messages ?? [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [pinned, setPinned] = useState(true)
  const [, setDocReady] = useState(false) // bump-only: re-renders chips once docRef resolves
  const docRef = useRef<EnsuredDocument | null>(null)
  const currentIdRef = useRef<number | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const pinnedRef = useRef(true)
  const jumpingRef = useRef(false)
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
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

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (jumpingRef.current) {
      if (atBottom) jumpingRef.current = false // smooth jump finished
      return // ignore intermediate positions during the animation
    }
    pinnedRef.current = atBottom
    setPinned(atBottom)
  }, [])

  // Instant autoscroll while pinned (streaming); useLayoutEffect so the user
  // never sees the pre-scroll frame.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, busy])

  const jumpToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    jumpingRef.current = true
    pinnedRef.current = true
    setPinned(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (open && !showSettings) inputRef.current?.focus()
  }, [open, showSettings])

  const send = useCallback(
    async (question: string, display?: string) => {
      const trimmed = question.trim()
      if (!trimmed || busy) return
      pinnedRef.current = true
      setPinned(true)
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
      if (ensured) setDocReady(true)
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

  // Write-through: persist only settled states (never mid-stream). An aborted
  // send still settles (error message appended, busy=false) and is persisted.
  useEffect(() => {
    if (busy || messages.length === 0) return
    const id = activeChatIdRef.current ?? newConversationId()
    const existing = conversationsRef.current.find((c) => c.id === id)
    const chat: StoredConversation = {
      id,
      title: existing?.title ?? chatTitle(messages),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages
    }
    const next = [chat, ...conversationsRef.current.filter((c) => c.id !== id)]
    saveConversations(docPath, next)
    setConversations(next.slice(0, 10)) // mirror the store cap
    if (activeChatIdRef.current !== id) setActiveChatId(id)
  }, [messages, busy, docPath])

  const startNewChat = useCallback((): void => {
    if (busy) return
    setActiveChatId(null)
    setMessages([])
    setShowHistory(false)
    pinnedRef.current = true
    setPinned(true)
    inputRef.current?.focus()
  }, [busy])

  const openConversation = useCallback(
    (id: string): void => {
      if (busy) return
      const chat = conversationsRef.current.find((c) => c.id === id)
      if (!chat) return
      pinnedRef.current = true
      setPinned(true)
      setActiveChatId(id)
      setMessages(chat.messages)
      setShowHistory(false)
    },
    [busy]
  )

  const removeConversation = useCallback(
    (id: string): void => {
      const next = deleteConversation(docPath, id)
      setConversations(next)
      if (activeChatIdRef.current === id) {
        setActiveChatId(null)
        setMessages([]) // stay in the history view
      }
    },
    [docPath]
  )

  const toggleHistory = useCallback((): void => {
    if (busy) return
    setShowHistory((s) => {
      if (!s) setConversations(loadConversations(docPath)) // fresh across windows
      return !s
    })
    setShowSettings(false)
  }, [busy, docPath])

  const handleCitation = useCallback(
    async (citation: AiCitation): Promise<void> => {
      let ensured = docRef.current
      if (!ensured) {
        ensured = await ensureDocument()
        docRef.current = ensured
        if (ensured) setDocReady(true) // re-render: chip labels resolve to page numbers
      }
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
    [onCitationClick, ensureDocument]
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
        <div className="ai-model-anchor">
          <button
            className="ai-model"
            title={config ? `${providerLabel} — ${t('ai.modelMenuTip')}` : providerLabel}
            disabled={!config}
            onClick={() => {
              if (!config) return
              // Azure has no curated model list — send them to full settings
              if (config.provider === 'azure') {
                setShowSettings(true)
                setShowHistory(false)
                return
              }
              setShowModelMenu((s) => !s)
            }}
          >
            <span className="ai-model-name">
              {config
                ? config.provider === 'azure'
                  ? config.azure.deployment
                  : config.models[config.provider]
                : ''}
            </span>
            {config && config.provider !== 'azure' && <IconChevronDown size={11} />}
          </button>
          {showModelMenu && config && (
            <ModelQuickMenu
              config={config}
              onSaved={setConfig}
              onClose={() => setShowModelMenu(false)}
              onOpenSettings={() => {
                setShowModelMenu(false)
                setShowSettings(true)
                setShowHistory(false)
              }}
            />
          )}
        </div>
        <button
          className="tb-btn"
          title={t('ai.newChatTip')}
          disabled={busy}
          onClick={startNewChat}
        >
          <IconPlus size={15} />
        </button>
        <button
          className={`tb-btn${showHistory ? ' is-active' : ''}`}
          title={t('ai.historyTip')}
          disabled={busy}
          onClick={toggleHistory}
        >
          <IconHistory size={15} />
        </button>
        <button
          className={`tb-btn${showSettings ? ' is-active' : ''}`}
          title={t('ai.settingsTip')}
          onClick={() => {
            setShowSettings((s) => !s)
            setShowHistory(false)
          }}
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
      ) : showHistory ? (
        <div className="ai-history">
          <div className="ai-history-heading">{t('ai.historyTitle')}</div>
          {conversations.length === 0 ? (
            <p className="ai-history-empty">{t('ai.historyEmpty')}</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`ai-history-item${c.id === activeChatId ? ' is-active' : ''}`}
                onClick={() => openConversation(c.id)}
              >
                <span className="ai-history-title">{c.title}</span>
                <span className="ai-history-meta">
                  {new Date(c.updatedAt).toLocaleDateString(locale())} ·{' '}
                  {t('ai.historyMessages', { count: String(c.messages.length) })}
                </span>
                <button
                  className="ai-history-delete"
                  title={t('ai.historyDeleteTip')}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeConversation(c.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="ai-messages-wrap">
          <div className="ai-messages" ref={scrollRef} onScroll={handleScroll}>
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
                  renderMarkdown(streamText)
                ) : (
                  <div className="ai-thinking">{t('ai.readingDoc')}</div>
                )}
              </div>
            )}
          </div>
          {!pinned && (
            <button className="ai-jump-bottom" title={t('ai.jumpNewestTip')} onClick={jumpToBottom}>
              <IconChevronDown size={14} />
            </button>
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
  mode: 'explain' | 'simplify' | 'define' | 'reference'
  selection: string
  pageNumber: number
  pageContext: string
  /** Reference lookup needs the whole document attached so the model can find
   *  the bibliography entry itself; explain/simplify/define do not.
   *  pageStarts lets the citation chips resolve char offsets to page numbers. */
  document?: { title: string; text: string; pageStarts: number[] } | null
}

const quickTitle = (mode: AiQuickState['mode']): string =>
  mode === 'explain'
    ? t('ai.quickExplain')
    : mode === 'simplify'
      ? t('ai.quickSimplify')
      : mode === 'reference'
        ? t('ai.quickReference')
        : t('ai.quickDefine')

interface QuickProps {
  state: AiQuickState
  onSendToChat(seed: AiSeed): void
  onCitation?(citation: AiCitation): void
  onClose(): void
}

export function AiQuickPopover({ state, onSendToChat, onCitation, onClose }: QuickProps): React.JSX.Element {
  useLang()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [meta, setMeta] = useState<string | null>(null)
  const [parts, setParts] = useState<AiContentPart[] | null>(null)
  const requestIdRef = useRef<number | null>(null)
  const finalRef = useRef('')
  const isReference = state.mode === 'reference'

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
        system: isReference ? referenceSystem() : explainSystem(state.mode as 'explain' | 'simplify' | 'define'),
        messages: [
          {
            role: 'user',
            text: isReference
              ? referenceUserMessage(state.selection, state.pageNumber, state.pageContext)
              : explainUserMessage(state.selection, state.pageNumber, state.pageContext)
          }
        ],
        // Reference lookup attaches the whole document so the model can find
        // the bibliography entry; the others stay page-local.
        document: isReference && state.document
          ? { title: state.document.title, text: state.document.text }
          : null
      })
      if (stale) return
      setDone(true)
      if ('error' in result) {
        setError(result.error)
      } else {
        const full = result.parts.map((p) => p.text).join('')
        finalRef.current = full
        setText(full)
        setParts(result.parts)
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
        ) : parts && isReference ? (
          <AssistantBody
            parts={parts}
            doc={state.document ? { text: state.document.text, pageStarts: state.document.pageStarts } : null}
            onCitation={(c) => onCitation?.(c)}
          />
        ) : text ? (
          renderMarkdown(text)
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

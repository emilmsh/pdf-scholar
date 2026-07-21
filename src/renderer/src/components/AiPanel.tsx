// AI assistant: right-hand chat panel with grounded citation chips, provider
// settings, and the quick "explain selection" popover. Keys and API calls
// live in the main process; this component only sees the PdfxApi surface.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type {
  AiCitation,
  AiConfigView,
  AiContentPart,
  AiImage,
  AiProviderId,
  AiWebSearchMode,
  ThinkingLevel
} from '../../../shared/types'
import { bridge } from '../bridge'
import {
  annotationsQuestion,
  askSystem,
  askUserMessage,
  chatSystem,
  citationPage,
  critiqueSystem,
  estimateCost,
  explainSystem,
  explainUserMessage,
  figureSystem,
  figureUserMessage,
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
  IconGlobe,
  IconHistory,
  IconImage,
  IconPlus,
  IconSend,
  IconSnip,
  IconSparkle,
  IconStop,
  IconSummary
} from './icons'

const nextRequestId = nextAiRequestId

/** Max images per message and max long side before downscale — keeps request
 *  sizes and the localStorage chat store sane. */
const MAX_IMAGES = 4
const MAX_IMAGE_SIDE = 1400

/** Decode + downscale a pasted/picked image into an AiImage. JPEG stays JPEG
 *  (photos would balloon as PNG); everything else becomes PNG. */
async function fileToAiImage(file: Blob): Promise<AiImage | null> {
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * k))
    canvas.height = Math.max(1, Math.round(bmp.height * k))
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const jpeg = file.type === 'image/jpeg'
    const dataUrl = canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.85)
    return {
      mediaType: jpeg ? 'image/jpeg' : 'image/png',
      dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1)
    }
  } catch {
    return null
  }
}

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

/** KaTeX render of a TeX snippet; throwOnError:false degrades bad TeX to
 *  red-tinted source instead of breaking the message. */
function mathNode(tex: string, display: boolean, key: string): React.ReactNode {
  return (
    <span
      key={key}
      className={display ? 'ai-math-block' : 'ai-math'}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(tex, { throwOnError: false, displayMode: display })
      }}
    />
  )
}

function renderInline(text: string, keyBase: string, ctx?: ChipContext): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const regex =
    /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\uE000\d+\uE001|\\\(.+?\\\)|\$\$[^$\n]+\$\$)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('\\(')) {
      out.push(mathNode(token.slice(2, -2), false, `${keyBase}-${i++}`))
      last = regex.lastIndex
      continue
    }
    if (token.startsWith('$$')) {
      out.push(mathNode(token.slice(2, -2), false, `${keyBase}-${i++}`))
      last = regex.lastIndex
      continue
    }
    if (token.startsWith('\uE000')) {
      const chip = ctx?.chips[Number(token.slice(1, -1))]
      if (chip && ctx && chip.kind === 'web') {
        // Web-search source: labelled by domain, opens in the browser
        let host = ''
        try {
          host = new URL(chip.url).hostname.replace(/^www\./, '')
        } catch {
          /* malformed URL - fall back to the generic label */
        }
        out.push(
          <button
            key={`${keyBase}-${i++}`}
            className="ai-chip ai-chip-web"
            title={`${chip.title}\n${chip.url}`}
            onClick={() => ctx.onCitation(chip)}
          >
            {host || t('ai.sourceChip')}
          </button>
        )
      } else if (chip && ctx) {
        const page = citationPage(chip, ctx.doc)
        // Hover shows the cited excerpt so two same-page chips ("p. 6", "p. 6")
        // are tellable apart; fall back to the generic hint when there is none.
        const raw =
          (chip.kind === 'char' ? chip.citedText : chip.kind === 'quote' ? chip.quote : '')?.trim() ?? ''
        const excerpt = raw.length > 180 ? `${raw.slice(0, 179)}…` : raw
        out.push(
          <button
            key={`${keyBase}-${i++}`}
            className="ai-chip"
            title={excerpt ? `“${excerpt}”\n${t('ai.chipTip')}` : t('ai.chipTip')}
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
    // Display math: \[ … \] or $$ … $$, single- or multi-line
    if (trimmed.startsWith('\\[') || trimmed.startsWith('$$')) {
      flushPara()
      const close = trimmed.startsWith('\\[') ? '\\]' : '$$'
      const buf: string[] = []
      let content = trimmed.slice(2)
      for (;;) {
        const at = content.indexOf(close)
        if (at !== -1) {
          buf.push(content.slice(0, at))
          break
        }
        buf.push(content)
        i++
        if (i >= lines.length) break
        content = lines[i]
      }
      i++ // past the closing line
      out.push(mathNode(buf.join('\n').trim(), true, `m${key++}`))
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

// Curated, verified model lists (see docs/agent-notes/modeller-api.md),
// ordered by capability (heaviest first) with clean names only — the
// descriptor lives in `hint`, shown as the option's hover tooltip so the
// list stays clean without leaving new users guessing. `label` is the
// dropdown text; `short` is for the compact header chip (never the raw
// hyphenated id).
const MODELS: Record<
  AiProviderId,
  { id: string; label: string; short: string; hint?: MsgKey }[]
> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5', short: 'Fable 5', hint: 'ai.modelHintHeaviest' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', short: 'Opus 4.8', hint: 'ai.modelHintCapable' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', short: 'Sonnet 5', hint: 'ai.modelHintRecommended' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', short: 'Haiku 4.5', hint: 'ai.modelHintFast' }
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', short: 'GPT-5.6 Sol', hint: 'ai.modelHintCapable' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', short: 'GPT-5.6 Terra', hint: 'ai.modelHintRecommended' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', short: 'GPT-5.6 Luna', hint: 'ai.modelHintFast' }
  ],
  azure: [],
  mock: [{ id: 'mock-1', label: 'Testmodell (mock)', short: 'Testmodell' }]
}

/** Fallback default per provider when no model is stored yet. Mirrors main's
 *  storage defaults — MODELS is display-ordered by capability, so [0] is the
 *  heaviest model, NOT the default. */
const DEFAULT_MODELS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra'
}

/** Clean display name for the header chip. Uses the curated `short` name when the
 *  model is one we know; for custom ids the user typed themselves we title-case
 *  the segments so the chip never shows a raw lowercase-with-hyphens id. */
function prettyModelName(provider: AiProviderId, id: string): string {
  const found = MODELS[provider]?.find((m) => m.id === id)
  if (found) return found.short
  if (!id) return ''
  return id
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .trim()
}

// Where each provider lets you set a spending cap — linked from the key field
// so the reminder to cap a key is one click from acting on it.
const SPEND_CAP_URLS: Partial<Record<AiProviderId, string>> = {
  anthropic: 'https://console.anthropic.com/settings/limits',
  openai: 'https://platform.openai.com/settings/organization/limits',
  azure: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview'
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

/** Key-holding providers, in display order (mock is not key-based) */
const KEY_PROVIDERS: { id: AiProviderId; name: string }[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'azure', name: 'Azure OpenAI' }
]

/** Key manager: one view with every provider's key field stacked — fill in
 *  the keys you have, leave the rest empty. Model and reasoning effort are
 *  NOT here: they are picked from the header chip's menu in the chat. */
export function AiSettings({ config, onSaved, onClose }: SettingsProps): React.JSX.Element {
  useLang()
  const [keys, setKeys] = useState<Record<AiProviderId, string>>({
    anthropic: '',
    openai: '',
    azure: '',
    mock: ''
  })
  const [endpoint, setEndpoint] = useState(config.azure.endpoint)
  const [deployment, setDeployment] = useState(config.azure.deployment)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const patch: Parameters<typeof bridge.aiSetConfig>[0] = {
      azure: { endpoint: endpoint.trim(), deployment: deployment.trim() }
    }
    for (const { id } of KEY_PROVIDERS) {
      if (keys[id].trim()) (patch.keys ??= {})[id] = keys[id].trim()
    }
    let next = await bridge.aiSetConfig(patch)
    // If the active provider still has no key but another one now does,
    // switch to it (with its stored or default model) so the chat is usable
    // right after saving the very first key
    if (!next.hasKey[next.provider]) {
      const first = KEY_PROVIDERS.find((p) => next.hasKey[p.id])?.id
      if (first) {
        next = await bridge.aiSetConfig({
          provider: first,
          models: { ...next.models, [first]: next.models[first] || DEFAULT_MODELS[first] || '' }
        })
      }
    }
    setSaving(false)
    onSaved(next)
  }

  // The plain-web preview cannot store keys at all — just say so
  if (!config.keysSupported) {
    return (
      <div className="ai-settings">
        <p className="ai-settings-note">{t('ai.calloutMock')}</p>
        <div className="ai-settings-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('app.cancel')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-settings">
      <div className="ai-settings-heading">{t('ai.keysTitle')}</div>
      <p className="ai-field-hint">
        {t('ai.keyCapHint')}{' '}
        {KEY_PROVIDERS.map(({ id }, i) => (
          <span key={id}>
            {i > 0 && ' · '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                bridge.openExternal(SPEND_CAP_URLS[id]!)
              }}
            >
              {id === 'anthropic' ? 'Anthropic' : id === 'openai' ? 'OpenAI' : 'Azure'}
            </a>
          </span>
        ))}
      </p>
      {KEY_PROVIDERS.map(({ id, name }) => (
        <div className="ai-field-group" key={id}>
          <label className="ai-field">
            <span>{name}</span>
            <input
              type="password"
              value={keys[id]}
              placeholder={config.hasKey[id] ? t('ai.keySaved') : t('ai.keyNew')}
              onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
              spellCheck={false}
            />
          </label>
          {id === 'azure' && (
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
        </div>
      ))}
      <p className="ai-settings-note">
        {t('ai.settingsNote')}
        {config.encryptionAvailable ? (
          t('ai.settingsNoteEncrypted')
        ) : (
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

// ---------- Model quick-menu (click the header chip) ----------

interface ModelMenuProps {
  config: AiConfigView
  onSaved(next: AiConfigView): void
  onClose(): void
  onOpenSettings(): void
}

/** Popover under the header model chip: EVERY provider's models in one flat
 *  list (keyless providers greyed out) plus reasoning effort. Selecting a
 *  model from another provider switches provider too — the chat history is
 *  resent in full on the next question, so mid-chat switches are safe.
 *  Keys/providers are managed in the key settings (button at the bottom). */
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
  const anyKey = KEY_PROVIDERS.some((p) => config.hasKey[p.id])
  // Haiku ignores reasoning effort; mock has none — mirror AiSettings
  const thinkingApplies = !/haiku/i.test(model) && provider !== 'mock'

  const patch = (p: Parameters<typeof bridge.aiSetConfig>[0]): void => {
    void bridge.aiSetConfig(p).then(onSaved)
  }

  // One flat <select> across providers; option values are "<provider>:<id>".
  // Azure has no curated list — its configured deployment is the entry.
  const value = provider === 'azure' ? `azure:${config.azure.deployment}` : `${provider}:${model}`
  const pick = (v: string): void => {
    const sep = v.indexOf(':')
    const p = v.slice(0, sep) as AiProviderId
    const id = v.slice(sep + 1)
    patch(p === 'azure' ? { provider: p } : { provider: p, models: { ...config.models, [p]: id } })
  }

  const groups = KEY_PROVIDERS.map(({ id, name }) => {
    const options = MODELS[id].map((m) => ({
      value: `${id}:${m.id}`,
      label: m.label,
      hint: m.hint ? t(m.hint) : undefined
    }))
    if (id === 'azure' && config.azure.deployment)
      options.push({
        value: `azure:${config.azure.deployment}`,
        label: config.azure.deployment,
        hint: undefined
      })
    // A custom model id typed in an older version still shows up
    if (id === provider && id !== 'azure' && model && !MODELS[id].some((m) => m.id === model))
      options.push({ value: `${id}:${model}`, label: model, hint: undefined })
    return { id: id as string, name, options, enabled: config.hasKey[id] }
    // Platforms that cannot store keys (plain-web preview) hide the keyless
    // real providers instead of greying them — there is no way to enable them
  }).filter((g) => g.options.length > 0 && (config.keysSupported || g.enabled))
  if (provider === 'mock' || !config.keysSupported)
    groups.push({
      id: 'mock',
      name: t('ai.providerMock'),
      options: MODELS.mock.map((m) => ({ value: `mock:${m.id}`, label: m.label, hint: undefined })),
      enabled: true
    })

  return (
    <div className="ai-model-menu" ref={ref}>
      {anyKey || provider === 'mock' || !config.keysSupported ? (
        <label className="ai-field">
          <span>{t('ai.model')}</span>
          {/* The closed select echoes the selected model's hint on hover */}
          <select
            value={value}
            title={(() => {
              const h = MODELS[provider]?.find((m) => m.id === model)?.hint
              return h ? t(h) : undefined
            })()}
            onChange={(e) => pick(e.target.value)}
          >
            {groups.map((g) => (
              <optgroup key={g.id} label={g.enabled ? g.name : `${g.name} — ${t('ai.keyMissing')}`}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={!g.enabled} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : (
        // No key anywhere: nothing to pick yet — send them to the key manager
        <p className="ai-model-menu-note">{t('ai.noKeysYet')}</p>
      )}
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
        {anyKey ? t('ai.keysTitle') : t('ai.calloutCta')}
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
  /** Bumped from outside (gear menu, search) to open the key settings view */
  openSettingsAskId: number
  onCitationClick(resolved: ResolvedCitation): void
  onClose(): void
  /** A page region snipped for the chat — staged as a composer attachment */
  chatSnip: { id: number; image: AiImage } | null
  onChatSnipConsumed(): void
  /** Arm the viewer's snip overlay with the chat as destination */
  onRequestSnip(): void
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
  openSettingsAskId,
  onCitationClick,
  onClose,
  chatSnip,
  onChatSnipConsumed,
  onRequestSnip
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Images staged for the next composer send (pasted or attached) */
  const [pendingImages, setPendingImages] = useState<AiImage[]>([])
  /** Composer globe: three web-search modes cycled by click. 'ask' is the
   *  default — the tool is attached but nothing leaves the machine unless
   *  the user's own message explicitly asks for a web lookup. */
  const [webSearch, setWebSearch] = useState<AiWebSearchMode>('ask')
  const webSearchRef = useRef(webSearch)
  webSearchRef.current = webSearch

  const addImageFiles = useCallback(async (files: Iterable<Blob>) => {
    for (const file of files) {
      const img = await fileToAiImage(file)
      if (img) setPendingImages((l) => (l.length >= MAX_IMAGES ? l : [...l, img]))
    }
  }, [])

  // ChatGPT-style composer: one line at rest, grows with the text (the CSS
  // max-height caps it and hands over to scrolling)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

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

  // A region snipped for the chat lands as a staged composer attachment
  useEffect(() => {
    if (!open || !chatSnip) return
    setPendingImages((l) => (l.length >= MAX_IMAGES ? l : [...l, chatSnip.image]))
    onChatSnipConsumed()
    inputRef.current?.focus()
  }, [open, chatSnip, onChatSnipConsumed])

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

  // Deliberately NO autofocus when the panel opens: stealing focus into the
  // composer kills every single-key shortcut (A to toggle this very panel, V,
  // W, F …) until the user clicks back out — rapid hotkey toggling must stay
  // fluid. Explicit in-panel actions (new chat) still focus the composer.

  const send = useCallback(
    async (question: string, display?: string, images?: AiImage[]) => {
      const trimmed = question.trim()
      if (!trimmed || busy) return
      pinnedRef.current = true
      setPinned(true)
      setInput('')
      setBusy(true)
      setStreamText('')
      setMessages((m) => [...m, { role: 'user', text: trimmed, display, images }])
      // Earlier turns' images ride along in the history — the model needs
      // them to answer follow-ups about the picture.
      const history = [
        ...messagesRef.current.map((m) =>
          m.role === 'user'
            ? { role: 'user' as const, text: m.text, images: m.images }
            : { role: 'assistant' as const, text: m.parts.map((p) => p.text).join('') }
        ),
        { role: 'user' as const, text: trimmed, images }
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
        document: ensured ? { title: docTitle, text: ensured.doc.text } : null,
        webSearch: webSearchRef.current
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

  // Gear menu / search bump openSettingsAskId to land in the key settings
  const lastSettingsAskRef = useRef(openSettingsAskId)
  useEffect(() => {
    if (!open || openSettingsAskId === lastSettingsAskRef.current) return
    lastSettingsAskRef.current = openSettingsAskId
    setShowSettings(true)
    setShowHistory(false)
    setShowModelMenu(false)
  }, [open, openSettingsAskId])

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
      // Web sources live outside the document — straight to the browser
      if (citation.kind === 'web') {
        bridge.openExternal(citation.url)
        return
      }
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

  // Rendered even while closed: the host right-panel collapses to width 0
  // (mirroring the left sidebar) so opening never mounts a fresh tree. All
  // fetch/focus effects above stay gated on `open`.
  const providerLabel = providerLabels().find((p) => p.id === config?.provider)?.label ?? ''

  /** Composer send: takes the staged images along and clears them */
  const sendFromComposer = useCallback(() => {
    if (!input.trim() || busy) return
    const imgs = pendingImages
    setPendingImages([])
    void send(input, undefined, imgs.length > 0 ? imgs : undefined)
  }, [input, busy, pendingImages, send])

  // One composer, reused in both layouts: centred on the empty "landing"
  // (ChatGPT-style) and pinned to the bottom once the chat has content.
  const composer = (
    <footer className="ai-composer">
      {/* ChatGPT-style field: the textarea and its controls live INSIDE one
          rounded surface — the buttons sit bottom-right, never beside it. */}
      <div className="ai-composer-field">
        {pendingImages.length > 0 && (
          <div className="ai-attach-row">
            {pendingImages.map((img, i) => (
              <div className="ai-attach" key={i}>
                <img src={`data:${img.mediaType};base64,${img.dataBase64}`} alt={t('ai.imageAlt')} />
                <button
                  className="ai-attach-x"
                  title={t('ai.removeImageTip')}
                  onClick={() => setPendingImages((l) => l.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder={t('ai.composerPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendFromComposer()
            }
            e.stopPropagation()
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.items]
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f)
            if (files.length > 0) {
              e.preventDefault()
              void addImageFiles(files)
            }
          }}
        />
        <div className="ai-composer-controls">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addImageFiles(e.target.files)
              e.target.value = ''
            }}
          />
          {(config?.provider === 'anthropic' ||
            config?.provider === 'openai' ||
            config?.provider === 'mock') && (
            <button
              className={`ai-attach-add${webSearch === 'off' ? '' : ` ${webSearch}`}`}
              title={t(
                webSearch === 'on'
                  ? 'ai.webSearchOnTip'
                  : webSearch === 'ask'
                    ? 'ai.webSearchAskTip'
                    : 'ai.webSearchOffTip'
              )}
              onClick={() =>
                setWebSearch((m) => (m === 'off' ? 'ask' : m === 'ask' ? 'on' : 'off'))
              }
            >
              <IconGlobe size={16} />
            </button>
          )}
          <button
            className="ai-attach-add"
            title={t('tb.snipTip')}
            onClick={onRequestSnip}
          >
            <IconSnip size={16} />
          </button>
          <button
            className="ai-attach-add"
            title={t('ai.attachTip')}
            onClick={() => fileInputRef.current?.click()}
          >
            <IconImage size={16} />
          </button>
          {busy ? (
            <button className="ai-send" title={t('ai.stopTip')} onClick={stop}>
              <IconStop size={15} />
            </button>
          ) : (
            <button
              className="ai-send"
              title={t('ai.sendTip')}
              disabled={!input.trim()}
              onClick={sendFromComposer}
            >
              <IconSend size={15} />
            </button>
          )}
        </div>
      </div>
    </footer>
  )

  const suggestionsBlock = (
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
  )

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
              setShowModelMenu((s) => !s)
            }}
          >
            <span className="ai-model-name">
              {config
                ? config.provider === 'azure'
                  ? config.azure.deployment
                  : prettyModelName(config.provider, config.models[config.provider] ?? '')
                : ''}
            </span>
            {config && <IconChevronDown size={11} />}
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
        {/* No settings gear: AI settings live one click inside the model chip's
            menu ("KI-innstillinger"), open straight from the chip for Azure, and
            auto-open on first run when no key is set — so the header stays
            uncluttered and the model name gets the freed width. */}
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
      ) : messages.length === 0 && !busy ? (
        <div className="ai-landing">
          <div className="ai-landing-inner">
            <div className="ai-landing-head">
              <IconSparkle size={22} />
              <p>{t('ai.emptyIntro')}</p>
            </div>
            {config?.keysSupported && (config.provider === 'mock' || !config.hasKey[config.provider]) && (
              <div className="ai-key-callout">
                <p>{t(config.provider === 'mock' ? 'ai.calloutMock' : 'ai.calloutNoKey')}</p>
                <button
                  className="btn-primary"
                  onClick={() => {
                    setShowSettings(true)
                    setShowHistory(false)
                  }}
                >
                  {t('ai.calloutCta')}
                </button>
              </div>
            )}
            {composer}
            {suggestionsBlock}
          </div>
        </div>
      ) : (
        <>
          <div className="ai-messages-wrap">
            <div className="ai-messages" ref={scrollRef} onScroll={handleScroll}>
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div className="ai-msg ai-user" key={i}>
                    {m.images && m.images.length > 0 && (
                      <div className="ai-msg-images">
                        {m.images.map((img, j) => (
                          <img
                            key={j}
                            src={`data:${img.mediaType};base64,${img.dataBase64}`}
                            alt={t('ai.imageAlt')}
                          />
                        ))}
                      </div>
                    )}
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

          {composer}
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
  mode: 'explain' | 'simplify' | 'reference' | 'critique' | 'ask' | 'figure'
  selection: string
  pageNumber: number
  pageContext: string
  /** Reference lookup, critique and free-form questions need the whole
   *  document attached so the model can draw on the full paper;
   *  explain/simplify/figure stay page-local. pageStarts lets the citation
   *  chips resolve char offsets to page numbers. */
  document?: { title: string; text: string; pageStarts: number[] } | null
  /** Figure mode: the snipped page region, sent as an image */
  image?: AiImage
}

const quickTitle = (mode: AiQuickState['mode']): string =>
  mode === 'explain'
    ? t('ai.quickExplain')
    : mode === 'simplify'
      ? t('ai.quickSimplify')
      : mode === 'reference'
        ? t('ai.quickReference')
        : mode === 'critique'
          ? t('ai.quickCritique')
          : mode === 'figure'
            ? t('ai.quickFigure')
            : t('ai.quickAsk')

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
  const isCritique = state.mode === 'critique'
  const isAsk = state.mode === 'ask'
  const isFigure = state.mode === 'figure'
  /** Reference lookup, critique and ask attach the whole document */
  const usesDocument = isReference || isCritique || isAsk
  const [question, setQuestion] = useState('')
  /** Ask mode waits for the user's question before firing the request */
  const [asked, setAsked] = useState<string | null>(null)
  const active = !isAsk || asked !== null

  useEffect(() => {
    if (!active) return
    let stale = false
    const requestId = nextRequestId()
    requestIdRef.current = requestId
    const unsubscribe = bridge.onAiDelta((id, delta) => {
      if (id === requestId && !stale) setText((s) => s + delta)
    })
    void (async () => {
      const result = await bridge.aiChat({
        requestId,
        system: isReference
          ? referenceSystem()
          : isCritique
            ? critiqueSystem()
            : isAsk
              ? askSystem()
              : isFigure
                ? figureSystem()
                : explainSystem(state.mode as 'explain' | 'simplify'),
        messages: [
          {
            role: 'user',
            text: isReference
              ? referenceUserMessage(state.selection, state.pageNumber, state.pageContext)
              : isAsk
                ? askUserMessage(asked ?? '', state.selection, state.pageNumber, state.pageContext)
                : isFigure
                  ? figureUserMessage(state.pageNumber, state.pageContext)
                  : explainUserMessage(state.selection, state.pageNumber, state.pageContext),
            ...(isFigure && state.image ? { images: [state.image] } : {})
          }
        ],
        // Reference lookup, critique and free-form questions attach the whole
        // document so the model can draw on the full paper; the others stay
        // page-local (figure carries its snip as an image instead).
        document: usesDocument && state.document
          ? { title: state.document.title, text: state.document.text }
          : null,
        // Context-menu actions have no globe toggle — always instruction-gated:
        // «sjekk denne referansen på nettet» in a free-form question just works,
        // but nothing is searched unless the user asked for it.
        webSearch: 'ask'
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
  }, [active])

  // Measured positioning: the popover grows while the answer streams (and
  // when the figure image decodes), so a fixed height guess drifts offscreen.
  // Re-clamp on every content change (deltas, image decode via sizeBump) —
  // deliberately NOT ResizeObserver-only, whose callbacks ride the frame loop.
  // Once the user has dragged the popover, their position wins: growth only
  // re-clamps against the viewport edges, never back to the anchor.
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [sizeBump, setSizeBump] = useState(0)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const draggedRef = useRef(false)
  useLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const clampTo = (left: number, top: number): { left: number; top: number } => ({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8))
    })
    setPos((p) => {
      const next = draggedRef.current && p ? clampTo(p.left, p.top) : clampTo(state.x, state.y + 10)
      return p && p.left === next.left && p.top === next.top ? p : next
    })
  }, [state.x, state.y, text, parts, asked, error, sizeBump])

  // Esc and clicks outside dismiss the popover — the Lukk button must never
  // be the only way out (it once sat offscreen and trapped the bubble open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  return (
    <div
      className="ai-quick"
      ref={popRef}
      style={pos ?? { left: state.x, top: state.y, visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="ai-quick-head"
        onPointerDown={(e) => {
          if (!pos) return
          dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
          try {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {
            /* synthetic events have no active pointer */
          }
          e.preventDefault()
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          draggedRef.current = true
          const el = popRef.current
          const w = el?.offsetWidth ?? 360
          const h = el?.offsetHeight ?? 200
          setPos({
            left: Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8)),
            top: Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - h - 8))
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
      >
        <IconSparkle size={14} />
        <span>
          {state.selection
            ? `${quickTitle(state.mode)}: «${state.selection.length > 42 ? `${state.selection.slice(0, 42)}…` : state.selection}»`
            : `${quickTitle(state.mode)} (${t('app.pageAbbrev')} ${state.pageNumber})`}
        </span>
      </div>
      {/* The snip stays visible outside the scrolling body, so the answer
          can be read against the figure it describes */}
      {isFigure && state.image && (
        <img
          className="ai-quick-figure"
          src={`data:${state.image.mediaType};base64,${state.image.dataBase64}`}
          alt={t('ai.imageAlt')}
          onLoad={() => setSizeBump((n) => n + 1)}
        />
      )}
      <div className="ai-quick-body">
        {!active ? (
          <div className="ai-quick-ask">
            <input
              type="text"
              autoFocus
              value={question}
              placeholder={t('ai.askPlaceholder')}
              spellCheck={false}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && question.trim()) setAsked(question.trim())
                if (e.key === 'Escape') onClose()
              }}
            />
            <button
              className="ai-send"
              title={t('ai.sendTip')}
              disabled={!question.trim()}
              onClick={() => question.trim() && setAsked(question.trim())}
            >
              <IconSend size={15} />
            </button>
          </div>
        ) : (
          <>
            {isAsk && <div className="ai-quick-question">{asked}</div>}
            {error ? (
              <div className="ai-error">{error}</div>
            ) : parts && usesDocument ? (
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
          </>
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
                title: isAsk && asked ? asked : quickTitle(state.mode),
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

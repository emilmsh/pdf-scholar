// AI assistant: the right-hand chat panel. What lives here is the conversation
// itself — messages, streaming, per-document history, the composer and its
// staged attachments. Everything else the AI surface needs sits in siblings:
//   ai-markdown.tsx    — markdown/LaTeX rendering of answers
//   ai-models.ts       — the provider/model catalogue
//   AiSettings.tsx     — the API-key manager (also used by the start screen)
//   AiModelMenu.tsx    — the header chip's model/effort popover
//   AiQuickPopover.tsx — the explain-selection bubble
// Those five are re-exported below, so PdfViewer and Welcome keep reaching the
// whole AI surface through this one module — don't remove the re-exports
// without updating them.
//
// Keys and API calls live in the main process; this component only sees the
// PdfxApi surface.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCitation,
  AiConfigView,
  AiImage,
  AiWebSearchMode
} from '../../../shared/types'
import { bridge } from '../bridge'
import {
  annotationsDefaultQuestion,
  annotationsQuestion,
  chatSystem,
  citationPage,
  formatTokens,
  nextAiRequestId,
  resolveCitation,
  summaryPrompt
} from '../ai'
import { t, useLang, locale } from '../i18n'
import { isFindHotkey } from '../platform'
import type { AiDocument, ResolvedCitation } from '../ai'
import type { PageText } from '../search'
import type { ChatMessage, StoredConversation } from '../chat-store'
import { deleteConversation, loadConversations, newConversationId, saveConversations } from '../chat-store'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { AssistantBody, renderMarkdown } from './ai-markdown'
import { prettyModelName, providerLabels } from './ai-models'
import { AiSettings } from './AiSettings'
import { ModelQuickMenu } from './AiModelMenu'
import type { AiSeed } from './AiQuickPopover'
import {
  IconChevronDown,
  IconGlobe,
  IconGlobeLive,
  IconGlobeOff,
  IconHistory,
  IconImage,
  IconPlus,
  IconSend,
  IconSnip,
  IconSparkle,
  IconStop,
  IconSummary
} from './icons'

// The AI surface's public face: importers get the panel, the key manager and the
// popover from here, whichever file they now live in.
export { AiSettings } from './AiSettings'
export { AiQuickPopover } from './AiQuickPopover'
export type { AiQuickState, AiSeed } from './AiQuickPopover'

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

type PanelMessage = ChatMessage

// ---------- Chat panel ----------

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
  /** Annotations staged for the next composer send (sidebar ✦): the block is
   *  fetched and appended at send time, shown as a removable chip until then */
  const [annotsStaged, setAnnotsStaged] = useState(false)
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

  /** Composer height the user dragged to (null = the auto-growing default).
   *  Height only — the panel's own width is already drag-resizable from its
   *  inner edge, so a width grip here would fight it. */
  const [composerSize, setComposerSize] = useState<BoxSize | null>(null)
  const { gripProps: composerGrip } = useResizable(inputRef, composerSize, setComposerSize, {
    axis: 'height',
    // The grip sits on the composer's TOP edge: dragging UP must grow it.
    invert: true,
    minH: 38
  })

  // ChatGPT-style composer: one line at rest, grows with the text (the CSS
  // max-height caps it and hands over to scrolling). Written imperatively
  // rather than via a style prop because the height is measured from
  // scrollHeight — so an explicitly dragged height has to be applied the same
  // way, here, instead of through useResizable's style.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (composerSize?.h != null) {
      el.style.maxHeight = 'none'
      el.style.height = `${composerSize.h}px`
      return
    }
    el.style.maxHeight = ''
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input, composerSize])

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
    if (block) void send(annotationsQuestion(annotationsDefaultQuestion(), block), t('ai.annotsBtn'))
  }, [getAnnotationsText, send])

  // Sidebar ✦ bumps annotsAskId to STAGE the annotations question: the default
  // question lands editable in the composer with the annotations as a chip —
  // nothing is sent until the user presses send themselves.
  const lastAnnotsAskRef = useRef(annotsAskId)
  useEffect(() => {
    if (!open || annotsAskId === lastAnnotsAskRef.current) return
    lastAnnotsAskRef.current = annotsAskId
    setAnnotsStaged(true)
    setInput((current) => current.trim() ? current : annotationsDefaultQuestion())
    // The panel may be opening in this same commit — focus after layout
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, annotsAskId])

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

  /** Everything this conversation has sent and received, as the provider counted
   *  it. The app deliberately does not turn that into money — see ai.ts. */
  const totalUsage = useMemo(() => {
    const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    let any = false
    for (const m of messages) {
      const usage = m.role === 'assistant' ? m.usage : null
      if (!usage) continue
      any = true
      sum.inputTokens += usage.inputTokens
      sum.outputTokens += usage.outputTokens
      sum.cacheReadTokens += usage.cacheReadTokens
      sum.cacheWriteTokens += usage.cacheWriteTokens
    }
    return any ? sum : null
  }, [messages])

  // Rendered even while closed: the host right-panel collapses to width 0
  // (mirroring the left sidebar) so opening never mounts a fresh tree. All
  // fetch/focus effects above stay gated on `open`.
  const providerLabel = providerLabels().find((p) => p.id === config?.provider)?.label ?? ''

  /** Composer send: takes the staged images/annotations along and clears them.
   *  Staged annotations append the block to the message at send time; the chat
   *  bubble shows only the user's (editable) question. */
  const sendFromComposer = useCallback(() => {
    if (!input.trim() || busy) return
    const imgs = pendingImages
    setPendingImages([])
    if (annotsStaged) {
      setAnnotsStaged(false)
      void (async () => {
        const block = await getAnnotationsText()
        const text = block ? annotationsQuestion(input, block) : input
        void send(text, block ? input.trim() : undefined, imgs.length > 0 ? imgs : undefined)
      })()
      return
    }
    void send(input, undefined, imgs.length > 0 ? imgs : undefined)
  }, [input, busy, pendingImages, annotsStaged, getAnnotationsText, send])

  // One composer, reused in both layouts: centred on the empty "landing"
  // (ChatGPT-style) and pinned to the bottom once the chat has content.
  const composer = (
    <footer className="ai-composer">
      {/* Pull this to give a long prompt more room; double-click it to go back
          to the one-line-that-grows default. */}
      <div className="ai-composer-grip" title={t('bubble.resizeHeightTip')} {...composerGrip}>
        <i />
      </div>
      {/* ChatGPT-style field: the textarea and its controls live INSIDE one
          rounded surface — the buttons sit bottom-right, never beside it. */}
      <div className="ai-composer-field">
        {(annotsStaged || pendingImages.length > 0) && (
          <div className="ai-attach-row">
            {annotsStaged && (
              <div className="ai-attach ai-attach-annots">
                <IconSparkle size={12} />
                {t('ai.annotsChip')}
                <button
                  className="ai-attach-x"
                  title={t('ai.removeAnnotsTip')}
                  onClick={() => {
                    setAnnotsStaged(false)
                    // A pristine default question goes with it; edits are kept
                    setInput((i) => (i === annotationsDefaultQuestion() ? '' : i))
                  }}
                >
                  ✕
                </button>
              </div>
            )}
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
            if (isFindHotkey(e)) return // bubbles to the window handler: focus search
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
              {webSearch === 'off' ? (
                <IconGlobeOff size={16} />
              ) : webSearch === 'on' ? (
                <IconGlobeLive size={16} />
              ) : (
                <IconGlobe size={16} />
              )}
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
                      <div className="ai-meta">{formatTokens(m.usage)}</div>
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
          {totalUsage !== null && (
            <div className="ai-total">{t('ai.totalTokens', { tokens: formatTokens(totalUsage) })}</div>
          )}
        </>
      )}
    </aside>
  )
}

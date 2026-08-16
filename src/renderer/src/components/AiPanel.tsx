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
import { PROVIDER_PROFILES } from '../../../shared/ai-provider-profile'
import { bridge } from '../bridge'
import {
  annotationsDefaultQuestion,
  annotationsQuestion,
  chatSystem,
  scannedPagesNote,
  citationPage,
  excerptSystemNote,
  formatTokens,
  nextAiRequestId,
  prepareDocumentForRequest,
  resolveCitation,
  summaryPrompt
} from '../ai'
import { charCitationsToQuotes } from '../ai-retrieval'
import { errorText, t, useLang, locale } from '../i18n'
import { loadAiTextScale, saveAiTextScale, stepAiTextScale } from '../ai-text-scale'
import { bubblesWhileTyping } from '../keymap'
import type { AiDocument, ResolvedCitation } from '../ai'
import type { PageText } from '../search'
import type { ChatMessage, StoredConversation } from '../chat-store'
import { CHATS_LS_KEY, deleteConversation, loadConversations, newConversationId, saveConversations } from '../chat-store'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { AssistantBody, renderMarkdown } from './ai-markdown'
import { modelSupportsImages, prettyModelName, providerLabels } from './ai-models'
import { AiSettings } from './AiSettings'
import { ModelQuickMenu } from './AiModelMenu'
import type { AiSeed } from './AiQuickPopover'
import {
  IconChevronDown,
  IconDetach,
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

const clampPage = (n: number, pageCount: number): number =>
  Number.isFinite(n) ? Math.min(Math.max(1, Math.round(n)), Math.max(1, pageCount)) : 1

/** "7" for one page, "7–10" for a run, "7, 9, 12" when they are not contiguous */
function pageListLabel(pages: number[]): string {
  if (pages.length === 0) return ''
  if (pages.length === 1) return String(pages[0])
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1)
  return contiguous ? `${pages[0]}–${pages[pages.length - 1]}` : pages.join(', ')
}

export interface EnsuredDocument {
  pages: PageText[]
  doc: AiDocument
  /** False for a scanned PDF: pdf.js extracts nothing, so `doc` is page markers
   *  and no more. The panel says so instead of asking a model about it. */
  hasText: boolean
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
  /** Arm the viewer's snip overlay with the chat as destination. Optional:
   *  only a host with a mounted viewer can offer it — the detached window
   *  omits it and the button simply is not rendered. */
  onRequestSnip?(): void
  /** Detach the chat into its own window/tab. Only the DOCKED host passes it
   *  (a detached window has nowhere further to go). */
  onDetach?(): void
  /** Whole pages rendered as images, for a document with no text layer. Staged
   *  like a snip: they land in the composer with an editable question, and the
   *  chip says exactly which pages will go along — nothing is sent by itself. */
  chatPages: { id: number; pages: number[]; images: AiImage[] } | null
  onChatPagesConsumed(): void
  onRequestPageImages(from: number, count: number): void
  /** True while those pages are rendering */
  pagesBusy: boolean
  /** The page the reader is on — the default for "read these pages" */
  currentPage: number
  /** Total pages, so the range field cannot ask for page 900 of 12 */
  pageCount: number
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
  onRequestSnip,
  onDetach,
  chatPages,
  onChatPagesConsumed,
  onRequestPageImages,
  pagesBusy,
  currentPage,
  pageCount
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
  // The model is reasoning (thinking deltas seen, no answer text yet)
  const [thinking, setThinking] = useState(false)
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
  const panelRef = useRef<HTMLElement>(null)

  /** Conversation text size, applied as --ai-scale on the panel root. Owned
   *  here; the quick popover reads the same stored value on its own. */
  const [textScale, setTextScale] = useState(loadAiTextScale)
  const applyTextScale = useCallback((next: number): void => {
    setTextScale(next)
    saveAiTextScale(next)
  }, [])
  // Reopening re-reads the stored value: an app-wide reset (or another
  // window) may have changed it while the panel was closed.
  useEffect(() => {
    if (open) setTextScale(loadAiTextScale())
  }, [open])
  // Ctrl+scroll over the panel steps the size. The document's wheel-zoom
  // listener sits on the .pages container, so the gesture is unclaimed here —
  // and non-passive, because preventDefault must also stop the browser's own
  // page zoom on the web/extension targets. Literal ctrlKey on macOS too: this
  // is the documented ctrl+wheel exception (docs/PLATFORMS.md §3) — a mac
  // trackpad pinch reports ctrlKey, and Cmd+wheel is not a zoom idiom there.
  const wheelAccRef = useRef(0)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      // Mouse notches (|deltaY| >= 90) step immediately; a trackpad pinch is a
      // stream of small deltas that accumulate into steps — the same split the
      // viewer's zoom wheel makes.
      const notch = Math.abs(e.deltaY) >= 90
      wheelAccRef.current = notch ? e.deltaY : wheelAccRef.current + e.deltaY
      if (!notch && Math.abs(wheelAccRef.current) < 30) return
      const direction = wheelAccRef.current < 0 ? 1 : -1
      wheelAccRef.current = 0
      setTextScale((s) => {
        const next = stepAiTextScale(s, direction)
        saveAiTextScale(next)
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  /** Images staged for the next composer send (pasted or attached) */
  const [pendingImages, setPendingImages] = useState<AiImage[]>([])
  /** When those images ARE pages of this document, which ones — so the chip can
   *  name them and the model can be told what it is (and is not) looking at. */
  const [stagedPages, setStagedPages] = useState<number[]>([])
  /** The range the "read these pages" button will render. Starts at the page the
   *  reader is on; editable, because they know which pages they mean. */
  const [readFrom, setReadFrom] = useState(currentPage)
  const [readTo, setReadTo] = useState(currentPage)
  const readTouchedRef = useRef(false)
  const stagedPagesRef = useRef(stagedPages)
  stagedPagesRef.current = stagedPages
  // Follow the reader until they type their own range — then leave it alone.
  useEffect(() => {
    if (readTouchedRef.current) return
    setReadFrom(currentPage)
    setReadTo(currentPage)
  }, [currentPage])
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
      bridge.onAiDelta((id, text, kind) => {
        if (id !== currentIdRef.current) return
        // Reasoning deltas are liveness, not answer: a reasoning model (Kimi,
        // Claude with utvidet tenking) can spend minutes here before its first
        // content delta, and without this signal the panel sits on «Leser
        // dokumentet …» and reads as hung. The text itself is not rendered.
        if (kind === 'thinking') setThinking(true)
        else setStreamText((s) => s + text)
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

  // Find out whether the document has a text layer BEFORE the first question,
  // not on the way into it: a scanned PDF cannot be read by any model here, and
  // that belongs in the landing state rather than in an answer that reports the
  // document says nothing. Extraction is cached in the viewer, so this is the
  // same work the first question would have done anyway.
  useEffect(() => {
    if (!open || docRef.current) return
    let cancelled = false
    void ensureDocument().then((ensured) => {
      if (cancelled || !ensured) return
      docRef.current = ensured
      setDocReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [open, ensureDocument])

  // A region snipped for the chat lands as a staged composer attachment
  useEffect(() => {
    if (!open || !chatSnip) return
    setPendingImages((l) => (l.length >= MAX_IMAGES ? l : [...l, chatSnip.image]))
    onChatSnipConsumed()
    inputRef.current?.focus()
  }, [open, chatSnip, onChatSnipConsumed])

  // Pages rendered for reading replace the staged images outright (they are the
  // subject of the question, not one more attachment) and prefill an editable
  // question. The reader still presses send — that rule has no exceptions.
  useEffect(() => {
    if (!open || !chatPages) return
    setPendingImages(chatPages.images.slice(0, MAX_IMAGES))
    setStagedPages(chatPages.pages.slice(0, MAX_IMAGES))
    setInput((i) => (i.trim() === '' ? t('ai.readPagesQuestion') : i))
    onChatPagesConsumed()
    inputRef.current?.focus()
  }, [open, chatPages, onChatPagesConsumed])

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
      setThinking(false)
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
      // Above the model's context window the full text cannot ride along:
      // attach a BM25 excerpt picked for this conversation's questions instead
      // (ai-retrieval.ts). On the everyday path prep.excerpt is null and the
      // attached document is byte-identical to before (prompt cache intact).
      const prep = ensured
        ? config
          ? prepareDocumentForRequest(
              ensured,
              config.provider,
              config.models[config.provider],
              history
                .filter((m) => m.role === 'user')
                .map((m) => m.text)
                .join('\n'),
              config.catalog
            )
          : { doc: ensured.doc, excerpt: null }
        : null
      const requestId = nextRequestId()
      currentIdRef.current = requestId
      // A scanned document with pages attached: the images ARE the document, so
      // say so and leave the "document" out entirely — without a text layer it
      // would be page markers and nothing else, which is tokens spent on saying
      // nothing and an invitation to answer about pages nobody attached.
      const shownPages = stagedPagesRef.current
      const imagesOnly = shownPages.length > 0 && ensured?.hasText === false
      const result = await bridge.aiChat({
        requestId,
        system:
          chatSystem() +
          (imagesOnly ? scannedPagesNote(shownPages) : '') +
          (prep?.excerpt && !imagesOnly ? excerptSystemNote() : ''),
        messages: history,
        document: imagesOnly || !prep ? null : { title: docTitle, text: prep.doc.text },
        webSearch: webSearchRef.current
      })
      currentIdRef.current = null
      setStreamText('')
      setThinking(false)
      setBusy(false)
      if ('error' in result) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', parts: [], error: result.error, errorCode: result.code }
        ])
      } else {
        // Char citations point into the excerpt this request attached —
        // resolve them to real pages now, while that exact text is known
        const parts = prep?.excerpt
          ? charCitationsToQuotes(result.parts, prep.doc)
          : result.parts
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            parts,
            usage: result.usage,
            model: result.model,
            excerpt: prep?.excerpt ?? undefined
          }
        ])
      }
    },
    [busy, config, docTitle, ensureDocument]
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

  // Another window wrote the shared chat store (a detached assistant and a
  // docked panel edit the same per-document history). `storage` events fire
  // only in OTHER windows/tabs, so this can never loop; skipped while busy —
  // the write-through below persists the settled state right after anyway.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== CHATS_LS_KEY || busy) return
      const fresh = loadConversations(docPath)
      setConversations(fresh)
      const activeId = activeChatIdRef.current
      if (activeId) {
        const chat = fresh.find((c) => c.id === activeId)
        if (chat) setMessages(chat.messages)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [busy, docPath])

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

  /** The conversation's first excerpt answer — the language hint renders once,
   *  under that answer, not under every excerpt answer */
  const firstExcerptIndex = useMemo(
    () => messages.findIndex((m) => m.role === 'assistant' && m.excerpt),
    [messages]
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
    setStagedPages([])
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

  // Whether the selected model can read images. Per-model knowledge exists
  // only for the compat catalog (Ollama reports capabilities); everything else
  // stays permissive. Disabled-with-reason, not hidden: the buttons say why.
  const visionOk =
    !config || modelSupportsImages(config.provider, config.models[config.provider], config.catalog)
  const noVisionTip = config
    ? t('ai.noVisionTip', {
        model: prettyModelName(config.provider, config.models[config.provider] ?? '')
      })
    : ''

  // One composer, reused in both layouts: centred on the empty "landing"
  // (ChatGPT-style) and pinned to the bottom once the chat has content.
  const composer = (
    <footer className="ai-composer">
      {/* Pull this to give a long prompt more room; double-click it to go back
          to the one-line-that-grows default. */}
      <div className="ai-composer-grip" title={t('bubble.resizeHeightTip')} {...composerGrip}>
        <i />
      </div>
      {/* No text layer: the only way in is page images, so the picker lives with
          the composer rather than in the landing notice — reading a scanned
          report means attaching the next pages as you go, which was impossible
          once the first question had been asked and the landing was gone. */}
      {docRef.current && !docRef.current.hasText && (
        <div className="ai-notice-pages">
          <label>
            {t('ai.readPagesFrom')}
            <input
              type="number"
              min={1}
              max={pageCount}
              value={readFrom}
              onChange={(e) => {
                readTouchedRef.current = true
                const v = clampPage(Number(e.target.value), pageCount)
                setReadFrom(v)
                setReadTo((to) => Math.max(v, to))
              }}
            />
          </label>
          <label>
            {t('ai.readPagesTo')}
            <input
              type="number"
              min={readFrom}
              max={pageCount}
              value={readTo}
              onChange={(e) => {
                readTouchedRef.current = true
                setReadTo(clampPage(Number(e.target.value), pageCount))
              }}
            />
          </label>
          <button
            className="btn-primary"
            disabled={pagesBusy || !visionOk}
            title={visionOk ? t('ai.readPagesTip', { max: MAX_IMAGES }) : noVisionTip}
            onClick={() => {
              const from = clampPage(readFrom, pageCount)
              const to = Math.max(from, clampPage(readTo, pageCount))
              onRequestPageImages(from, Math.min(MAX_IMAGES, to - from + 1))
            }}
          >
            {pagesBusy ? t('ai.readPagesBusy') : t('ai.readPagesCta')}
          </button>
          {readTo - readFrom + 1 > MAX_IMAGES && (
            <p className="ai-notice-cap">{t('ai.readPagesCap', { max: MAX_IMAGES })}</p>
          )}
        </div>
      )}
      {/* ChatGPT-style field: the textarea and its controls live INSIDE one
          rounded surface — the buttons sit bottom-right, never beside it. */}
      <div className="ai-composer-field">
        {(annotsStaged || pendingImages.length > 0) && (
          <div className="ai-attach-row">
            {/* Which pages are going along, in words — a row of thumbnails does
                not tell you whether page 7 or page 8 is in the request. */}
            {stagedPages.length > 0 && (
              <div className="ai-attach ai-attach-pages">
                {t('ai.pagesChip', { pages: pageListLabel(stagedPages) })}
                <button
                  className="ai-attach-x"
                  title={t('ai.removePagesTip')}
                  onClick={() => {
                    setStagedPages([])
                    setPendingImages([])
                  }}
                >
                  ✕
                </button>
              </div>
            )}
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
            if (bubblesWhileTyping(e)) return // an app shortcut (find, save, zoom …)
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendFromComposer()
            }
            e.stopPropagation()
          }}
          onPaste={(e) => {
            if (!visionOk) return // model can't read images — leave the paste as text
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
          {config && PROVIDER_PROFILES[config.provider].webSearch && (
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
          {onRequestSnip && (
            <button
              className="ai-attach-add"
              disabled={!visionOk}
              title={visionOk ? t('tb.snipTip') : noVisionTip}
              onClick={onRequestSnip}
            >
              <IconSnip size={16} />
            </button>
          )}
          <button
            className="ai-attach-add"
            disabled={!visionOk}
            title={visionOk ? t('ai.attachTip') : noVisionTip}
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
    <aside
      className="ai-panel"
      aria-label={t('ai.assistant')}
      ref={panelRef}
      style={{ '--ai-scale': textScale } as React.CSSProperties}
    >
      <header className="ai-header">
        {/* Icon only, no "Assistent" caption: the word cost ~67px of a 340px
            header and the model chip was paying for it — "GPT-5.6 …" hides
            exactly the part that separates Sol from Terra from Luna. Nothing
            is lost: the panel is named by the toolbar button that opens it
            (and by the window title in the detached one), and the aside
            carries the name for screen readers. */}
        <IconSparkle size={16} />
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
              textScale={textScale}
              onTextScale={applyTextScale}
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
        {onDetach && (
          <button className="tb-btn" title={t('ai.detachTip')} onClick={onDetach}>
            <IconDetach size={15} />
          </button>
        )}
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
            {docRef.current && !docRef.current.hasText && (
              <div className="ai-notice">
                <p>{t('ai.calloutNoText')}</p>
              </div>
            )}
            {composer}
            {/* "Summarize the document" is a dead end without a text layer */}
            {docRef.current?.hasText !== false && suggestionsBlock}
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
                      <div className="ai-error">
                        {errorText({ error: m.error, code: m.errorCode })}
                      </div>
                    ) : (
                      <AssistantBody parts={m.parts} doc={docRef.current?.doc ?? null} onCitation={handleCitation} />
                    )}
                    {(m.excerpt || (m.usage && m.model)) && (
                      <div className="ai-meta">
                        {m.excerpt && (
                          <span className="ai-excerpt-chip" title={t('ai.excerptTip')}>
                            {t('ai.excerptChip', { included: m.excerpt.included, total: m.excerpt.total })}
                          </span>
                        )}
                        {m.usage && m.model && formatTokens(m.usage)}
                      </div>
                    )}
                    {/* Once per conversation: excerpt selection is lexical, so
                        a question in the document's language retrieves better */}
                    {m.excerpt && i === firstExcerptIndex && (
                      <div className="ai-excerpt-hint">{t('ai.excerptLangHint')}</div>
                    )}
                  </div>
                )
              )}
              {busy && (
                <div className="ai-msg ai-assistant">
                  {streamText ? (
                    renderMarkdown(streamText)
                  ) : (
                    // «Tenker …» once reasoning deltas arrive — the difference
                    // between a model that is working and one that is not
                    <div className="ai-thinking">
                      {t(thinking ? 'ai.thinking' : 'ai.readingDoc')}
                    </div>
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

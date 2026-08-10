// Shell for the DETACHED assistant: a window (desktop) or tab (extension,
// dev:web) that hosts the chat panel for one document — and nothing else. No
// pages are ever mounted; the document is read once and opened in pdf.js
// purely so the panel can extract text (and render page images for scanned
// files) exactly as the docked panel would.
//
// What cannot work without a viewer is handed across instead: a citation
// click asks whichever window is SHOWING the document to jump
// (bridge.assistantJumpToCitation; main relays on desktop, a BroadcastChannel
// does outside it), with a toast offering to open the document when nobody
// has it. The snip and annotation affordances are omitted — those genuinely
// need the mounted viewer, and the panel hides their buttons when the host
// does not pass the callbacks.
//
// The chrome around the panel (theme resolution, language, titlebar colors)
// mirrors ExtensionApp.tsx deliberately, like every shell in this app.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { AiImage, FilePayload, Settings, ThemeName } from '../../shared/types'
import { bridge, isExtension } from './bridge'
import { errorText, setLanguage, t, useLang } from './i18n'
import { openDocument, isPasswordException } from './pdf-doc'
import type { DocResources } from './pdf-doc'
import { renderPagesAsImages } from './ai-page-images'
import { buildPageTexts, hasExtractableText } from './search'
import type { PageText } from './search'
import { buildAiDocument } from './ai'
import type { ResolvedCitation } from './ai'
import AiPanel from './components/AiPanel'
import type { EnsuredDocument } from './components/AiPanel'
import { PasswordPrompt } from './components/PasswordPrompt'
import { IconSparkle } from './components/icons'
import { DEFAULT_SETTINGS as FALLBACK_SETTINGS } from '../../shared/defaults'

const noop = (): void => {}

/** Close this surface: the OS window on desktop (scripted windows may close
 *  themselves), our own tab in the extension (window.close is unreliable for
 *  tabs the user could have navigated), a plain window.close in dev:web. */
function closeSelf(): void {
  if (isExtension && chrome?.tabs) {
    void chrome.tabs.getCurrent().then((tab) => {
      if (tab?.id !== undefined) void chrome.tabs?.remove(tab.id)
      else window.close()
    })
    return
  }
  window.close()
}

export default function AssistantApp({ docPath }: { docPath: string }): React.JSX.Element {
  useLang()
  const [settings, setSettingsState] = useState<Settings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const [payload, setPayload] = useState<FilePayload | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Non-null while the document waits for its password; true = one was tried */
  const [passwordAsk, setPasswordAsk] = useState<{ retry: boolean } | null>(null)
  /** The last citation click found no window showing the document */
  const [jumpFailed, setJumpFailed] = useState(false)
  const docResourcesRef = useRef<DocResources | null>(null)
  const pageTextsRef = useRef<PageText[] | null>(null)

  // ---------- Theme + language (mirrors ExtensionApp/App) ----------

  const resolvedTheme: ThemeName =
    settings.theme === 'auto'
      ? systemDark
        ? settings.autoDark
        : settings.autoLight
      : settings.theme

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    const overlay: Record<ThemeName, [string, string]> = {
      day: ['#ededf0', '#1d1d1f'],
      sepia: ['#e9e6db', '#3d3929'],
      night: ['#21211f', '#eeece2'],
      nightHc: ['#111113', '#f5f5f7']
    }
    bridge.setTitleBarColors(...overlay[resolvedTheme])
  }, [resolvedTheme])

  useEffect(() => {
    setLanguage(settings.language)
  }, [settings.language])

  // ---------- The document (text only — no page is ever mounted) ----------

  const load = useCallback(
    async (password?: string) => {
      setError(null)
      // readFile is draft-aware on desktop (readPathFor): the assistant reads
      // the same annotated bytes the viewer shows, unsaved marks included.
      const result = await bridge.readFile(docPath)
      if ('error' in result) {
        setError(t('app.openFailed', { error: errorText(result) }))
        return
      }
      setPayload(result)
      document.title = t('ai.windowTitle', { name: result.name })
      try {
        // pdf.js transfers the buffer to its worker — always hand it a copy
        const resources = openDocument(result.data.slice(), password)
        const doc = await resources.task.promise
        docResourcesRef.current = resources
        pageTextsRef.current = null
        setPasswordAsk(null)
        setPdf(doc)
      } catch (err) {
        if (isPasswordException(err)) {
          // Passwords are never persisted (PLATFORMS.md §15) — a fresh window
          // asks again, exactly like a fresh app start would.
          setPasswordAsk({ retry: password !== undefined })
          return
        }
        setError(t('app.openFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    },
    [docPath]
  )

  useEffect(() => {
    bridge.getSettings().then(setSettingsState)
    void load()
  }, [load])

  const ensureDocument = useCallback(async (): Promise<EnsuredDocument | null> => {
    if (!pdf) return null
    const pages = (pageTextsRef.current ??= await buildPageTexts(pdf))
    return { pages, doc: buildAiDocument(pages), hasText: hasExtractableText(pages) }
  }, [pdf])

  // ---------- Handed across to the window showing the document ----------

  const onCitationClick = useCallback(
    (resolved: ResolvedCitation): void => {
      void bridge.assistantJumpToCitation(docPath, resolved).then((ok) => setJumpFailed(!ok))
    },
    [docPath]
  )

  // ---------- Page images for scanned documents (no viewer needed) ----------

  const [chatPages, setChatPages] = useState<{ id: number; pages: number[]; images: AiImage[] } | null>(null)
  const [pagesBusy, setPagesBusy] = useState(false)
  const chatPagesSeqRef = useRef(0)
  const onRequestPageImages = useCallback(
    (from: number, count: number): void => {
      if (!pdf) return
      setPagesBusy(true)
      void renderPagesAsImages(pdf, from, count)
        .then(({ pages, images }) => {
          if (images.length > 0) setChatPages({ id: ++chatPagesSeqRef.current, pages, images })
        })
        .finally(() => setPagesBusy(false))
    },
    [pdf]
  )

  return (
    <div className="assistant-window">
      {/* The strip IS the titlebar on desktop (frameless window): a drag
          region inset to the native window controls. In a browser tab it is
          simply the header naming the document. */}
      <header className="assistant-titlebar">
        <div className="assistant-titlebar-inner">
          <IconSparkle size={14} />
          <span>{payload ? t('ai.windowTitle', { name: payload.name }) : t('ai.assistant')}</span>
        </div>
      </header>

      {error ? (
        <div className="assistant-error" role="alert">
          <p>{error}</p>
        </div>
      ) : (
        <AiPanel
          open
          docTitle={payload?.name ?? ''}
          docPath={docPath}
          seed={null}
          onSeedConsumed={noop}
          ensureDocument={ensureDocument}
          hasAnnotations={false}
          annotsAskId={0}
          getAnnotationsText={async () => null}
          openSettingsAskId={0}
          onCitationClick={onCitationClick}
          onClose={closeSelf}
          chatSnip={null}
          onChatSnipConsumed={noop}
          chatPages={chatPages}
          onChatPagesConsumed={() => setChatPages(null)}
          onRequestPageImages={onRequestPageImages}
          pagesBusy={pagesBusy}
          currentPage={1}
          pageCount={pdf?.numPages ?? 1}
        />
      )}

      {passwordAsk && payload && (
        <PasswordPrompt
          name={payload.name}
          retry={passwordAsk.retry}
          active
          onSubmit={(password) => void load(password)}
          onCancel={closeSelf}
        />
      )}

      {jumpFailed && (
        <div className="toast assistant-toast" role="status">
          <span>{t('ai.noViewerOpen')}</span>
          <button
            className="btn-primary"
            onClick={() => {
              bridge.newWindow(docPath)
              setJumpFailed(false)
            }}
          >
            {t('ai.openDocBtn')}
          </button>
          <button className="assistant-toast-close" aria-label={t('ai.closeTip')} onClick={() => setJumpFailed(false)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

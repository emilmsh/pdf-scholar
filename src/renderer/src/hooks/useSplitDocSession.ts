// The split view's SECOND document: a self-contained load/reload/dirty session
// for the file shown in pane B when it differs from the tab's own document.
//
// Deliberately a miniature of PdfViewer's primary load path rather than a
// refactor of it: the primary path is 6000 lines of carefully-ordered state
// with eleven late-bound refs (docs/agent-notes/pdfviewer-decomposition.md),
// and threading a second document through it is exactly the class of change
// that file's postmortem warns against. The session owns what a second
// document really needs — a pdf.js proxy, page sizes, the annotation records,
// a dirty flag, reload-on-change — and nothing else. In same-file split mode
// the hook is passed null and returns null: pane B then shares the primary
// document exactly as it always has, at zero cost.
//
// Sync model: main keeps ONE draft per path; this session never talks to the
// engine directly (writes are routed by PdfViewer with the session's path) —
// it only re-reads when the draft changes, whether the change came from
// another window (bridge broadcasts) or from this one (the local bus).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { FilePayload } from '../../../shared/types'
import type { PageAnnotation } from '../annotations'
import { bridge, isElectron } from '../bridge'
import { browserCurrentBytes } from '../annotation-engine-browser'
import { openDocument, isPasswordException } from '../pdf-doc'
import type { DocResources } from '../pdf-doc'
import { collectAnnotations } from '../doc-load'
import { onLocalDocEvent } from '../local-doc-events'
import { t } from '../i18n'

export interface SplitDocSession {
  path: string
  name: string
  pdf: PDFDocumentProxy | null
  sizes: { w: number; h: number }[]
  annots: ReadonlyMap<number, PageAnnotation[]>
  /** The path has an unsaved draft (mirrors the primary viewer's flag) */
  dirty: boolean
  /** This session's identity on the local doc bus — writes routed on its
   *  behalf must emit with THIS sender so the session doesn't reload on its
   *  own changes (and the same file's own tab does). */
  sender: symbol
  /** Re-read the current bytes (draft included) and swap the document in
   *  place — old canvases stay up until the new ones render. */
  reload(): Promise<void>
  /** Mark the session dirty from a write routed on its behalf. */
  markDirty(): void
}

const EMPTY_ANNOTS: ReadonlyMap<number, PageAnnotation[]> = new Map()

/** Current bytes for a path — main resolves the draft behind readFile on
 *  desktop; the browser serializes the engine's live document if it has one. */
async function currentBytes(path: string): Promise<Uint8Array | null> {
  if (isElectron) {
    const result = await bridge.readFile(path)
    return 'error' in result ? null : result.data
  }
  return (await browserCurrentBytes(path)) ?? null
}

export function useSplitDocSession(
  payload: FilePayload | null,
  /** The document cannot be shown (encrypted, or broken) — the caller closes
   *  the split and surfaces the message. */
  onFailed: (message: string) => void
): SplitDocSession | null {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([])
  const [annots, setAnnots] = useState<ReadonlyMap<number, PageAnnotation[]>>(EMPTY_ANNOTS)
  const [dirty, setDirty] = useState(false)
  const senderRef = useRef<symbol>(Symbol('split-doc-session'))
  const resourcesRef = useRef<DocResources | null>(null)
  const path = payload?.path ?? null
  const pathRef = useRef(path)
  pathRef.current = path

  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed

  const reload = useCallback(async (): Promise<void> => {
    const p = pathRef.current
    if (!p) return
    const data = await currentBytes(p)
    if (!data || pathRef.current !== p) return
    const resources = openDocument(data.slice())
    try {
      const doc = await resources.task.promise
      const fileAnnots = await collectAnnotations(doc)
      if (pathRef.current !== p) {
        resources.task.destroy()
        resources.port.terminate()
        return
      }
      const old = resourcesRef.current
      resourcesRef.current = resources
      setPdf(doc)
      setAnnots(fileAnnots)
      old?.task.destroy()
      old?.port.terminate()
    } catch {
      resources.task.destroy()
      resources.port.terminate()
    }
  }, [])

  const markDirty = useCallback(() => setDirty(true), [])

  // ---------- Load ----------
  useEffect(() => {
    if (!payload) return
    let destroyed = false
    ;(async () => {
      const resources = openDocument(payload.data.slice())
      resourcesRef.current = resources
      let doc: PDFDocumentProxy
      try {
        doc = await resources.task.promise
      } catch (err) {
        if (destroyed) return
        // v1 boundary: an encrypted file does not open in the second column —
        // the password prompt flow (ask/retry/unlock) belongs to a real tab.
        onFailedRef.current(
          isPasswordException(err) ? t('split.docEncrypted') : t('split.docFailed')
        )
        return
      }
      if (destroyed) return
      setPdf(doc)
      const collected: { w: number; h: number }[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        if (destroyed) return
        const vp = page.getViewport({ scale: 1 })
        collected.push({ w: vp.width, h: vp.height })
      }
      setSizes(collected)
      const fileAnnots = await collectAnnotations(doc)
      if (!destroyed) setAnnots(fileAnnots)
      // A draft may already exist (the file is open elsewhere, or a previous
      // session left one) — the pane shows it via the bytes; mirror the flag
      const isDirty = await bridge.docIsDirty(payload.path)
      if (!destroyed && isDirty) setDirty(true)
    })().catch(() => {
      if (!destroyed) onFailedRef.current(t('split.docFailed'))
    })
    return () => {
      destroyed = true
      setPdf(null)
      setSizes([])
      setAnnots(EMPTY_ANNOTS)
      setDirty(false)
      resourcesRef.current?.task.destroy()
      resourcesRef.current?.port.terminate()
      resourcesRef.current = null
    }
  }, [payload])

  // ---------- Converge on draft changes, wherever they came from ----------
  // Same debounced-reload discipline as the primary viewer's cross-window
  // effect: a burst of strokes must not mean a reload per stroke.
  const armTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (!path) return
    const arm = (): void => {
      if (armTimerRef.current) window.clearTimeout(armTimerRef.current)
      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = null
        void reload()
      }, 250)
    }
    const offChanged = bridge.onAnnotationsChangedElsewhere((p) => {
      if (p !== path) return
      setDirty(true)
      arm()
    })
    const offEnded = bridge.onDraftEndedElsewhere((p) => {
      if (p !== path) return
      setDirty(false)
      arm()
    })
    const offLocal = onLocalDocEvent((p, kind, sender) => {
      if (p !== path || sender === senderRef.current) return
      setDirty(kind === 'changed')
      arm()
    })
    return () => {
      offChanged()
      offEnded()
      offLocal()
      if (armTimerRef.current) window.clearTimeout(armTimerRef.current)
    }
  }, [path, reload])

  if (!payload) return null
  return {
    path: payload.path,
    name: payload.name,
    pdf,
    sizes,
    annots,
    dirty,
    sender: senderRef.current,
    reload,
    markDirty
  }
}

// The two surfaces for a document's files besides the sidebar list: the
// toolbar chip that says they exist, and the bubble a paperclip on a page
// opens.
//
// The chip is the point of the whole feature. Before it, a filing whose
// exhibits rode along as attached spreadsheets opened here looking complete
// — the files were simply not there, and nothing said so. Same shape as
// «Signert» and «XFA-skjema»: a property of the DOCUMENT, shown only when the
// document has it.
import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '../i18n'
import { isElectron } from '../bridge'
import { useDismissable } from '../useDismissable'
import { useDraggable } from '../useDraggable'
import { attachmentExtension, canOpenAttachment, isPdfAttachment } from '../../../shared/attachments'
import type { DocAttachment } from '../attachments'
import { IconExternal, IconPaperclip, IconSaveAs } from './icons'

export function AttachmentsBadge({
  count,
  active,
  onClick
}: {
  count: number
  /** The sidebar is showing them right now — a second click hides it again */
  active: boolean
  onClick(): void
}): React.JSX.Element | null {
  useLang()
  if (count === 0) return null
  return (
    <div className="signature-info">
      <button
        className={`tb-btn tb-labeled${active ? ' is-active' : ''}`}
        onClick={onClick}
        title={t('attach.badgeTip')}
      >
        <IconPaperclip size={15} />
        <span>{count === 1 ? t('attach.badgeOne') : t('attach.badge', { count: String(count) })}</span>
      </button>
    </div>
  )
}

export interface AttachmentPopState {
  att: DocAttachment
  /** Which document the paperclip belongs to (the split can show another) */
  docKey: string
  /** The icon's box on screen — the bubble opens clear of it */
  box: { top: number; bottom: number; left: number }
}

/** What a click on a paperclip opens: the file's name and description, and
 *  what can be done with it here — Acrobat's double-click-to-open, made a
 *  visible choice so a finger can make it too. */
export function AttachmentPopover({
  state,
  onOpen,
  onSave,
  onClose
}: {
  state: AttachmentPopState
  onOpen(): Promise<boolean>
  onSave(): Promise<boolean>
  onClose(): void
}): React.JSX.Element {
  useLang()
  const { att, box } = state
  const { ref, style, positioned, handleProps } = useDraggable<HTMLDivElement>(
    box.left,
    box.bottom,
    [att.id],
    box
  )
  useDismissable(ref, true, onClose)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const ext = attachmentExtension(att.name)
  const openable = isElectron && canOpenAttachment(att.name)
  const blocked = isElectron && !openable

  // Enter does the obvious thing: the primary button is focused as soon as the
  // bubble is measured and visible (a hidden element cannot take focus).
  const focusedRef = useRef(false)
  useEffect(() => {
    if (positioned && !focusedRef.current) {
      focusedRef.current = true
      primaryRef.current?.focus()
    }
  }, [positioned])

  const run = (action: () => Promise<boolean>): void => {
    setBusy(true)
    void action().then(
      (done) => {
        setBusy(false)
        if (done) onClose()
      },
      () => setBusy(false)
    )
  }

  return (
    <div className="attach-pop" ref={ref} style={style} {...handleProps}>
      {att.page !== null && (
        <div className="attach-pop-head">{t('attach.popHead', { page: att.page })}</div>
      )}
      <div className="attach-pop-name">
        <span className={`attach-ext${blocked ? ' is-blocked' : ''}`}>
          {ext ? ext.toUpperCase() : <IconPaperclip size={12} />}
        </span>
        <span title={att.name}>{att.name}</span>
      </div>
      {att.description && <p className="attach-pop-desc">{att.description}</p>}
      {/* Said here in words because this is the moment it matters — the
          sidebar row carries the same sentence as its tooltip */}
      {blocked && <p className="attach-pop-note">{t('attach.blockedTip', { ext })}</p>}
      <div className="attach-pop-actions" onPointerDown={(e) => e.stopPropagation()}>
        {isElectron ? (
          <>
            <button
              className={openable ? 'btn-secondary' : 'btn-primary'}
              ref={openable ? undefined : primaryRef}
              disabled={busy}
              onClick={() => run(onSave)}
              title={t('attach.saveTip')}
            >
              <IconSaveAs size={14} /> {t('attach.save')}
            </button>
            {openable && (
              <button
                className="btn-primary"
                ref={primaryRef}
                disabled={busy}
                onClick={() => run(onOpen)}
                title={isPdfAttachment(att.name) ? t('attach.openPdfTip') : t('attach.openTip')}
              >
                <IconExternal size={14} /> {t('attach.open')}
              </button>
            )}
          </>
        ) : (
          <button
            className="btn-primary"
            ref={primaryRef}
            disabled={busy}
            onClick={() => run(onSave)}
            title={t('attach.downloadTip')}
          >
            <IconSaveAs size={14} /> {t('attach.download')}
          </button>
        )}
      </div>
    </div>
  )
}

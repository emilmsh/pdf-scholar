// What came out of the image marquee, before it goes anywhere: the crop
// itself, its pixel size, and the two things anyone wants to do with it.
//
// The preview is the point. A reader who drags a box around a figure cannot
// tell from the marquee whether the caption came along or the axis labels got
// clipped, and finding out by pasting into Word and coming back is the kind of
// round trip this app exists to remove. Showing the result also makes one
// menu row enough per surface — «Kopier» and «Lagre …» are the same gesture
// until the picture exists, so they are offered here rather than duplicated
// as two entries everywhere the tool is armed.
import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '../i18n'
import { useDismissable } from '../useDismissable'
import { useDraggable } from '../useDraggable'
import { IconCopy, IconSaveAs } from './icons'

export interface ImageExportState {
  /** Where the marquee ended — the bubble opens clear of the box */
  x: number
  y: number
  /** The box itself, so the bubble can avoid covering what was just captured */
  avoid?: { top: number; bottom: number; left: number } | null
  dataUrl: string
  width: number
  height: number
  /** Rendered at a real image's own pixel grid, rather than off the page
   *  description — the difference between the file's picture and a print of
   *  the page, which the meta line states outright. */
  native: boolean
  /** Dots per inch the crop was rendered at, for when `native` is false */
  dpi: number
  pageNumber: number
  /** The file the crop came from — the split column's other document is a
   *  real possibility, and the saved file is named after it. */
  docName: string
}

interface Props {
  state: ImageExportState
  onCopy(): void | Promise<void>
  onSave(): void | Promise<void>
  /** Arm the marquee again — the preview said the box was wrong */
  onRedo(): void
  onClose(): void
}

export function ImageExportPopover({
  state,
  onCopy,
  onSave,
  onRedo,
  onClose
}: Props): React.JSX.Element {
  useLang()
  const { ref, style, positioned, handleProps } = useDraggable<HTMLDivElement>(
    state.x,
    state.y,
    [state.dataUrl],
    state.avoid
  )
  useDismissable(ref, true, onClose)
  const copyRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)

  // Enter copies: the overwhelmingly common ending, and the reason the button
  // is focused the moment the bubble is measured and visible.
  const focusedRef = useRef(false)
  useEffect(() => {
    if (positioned && !focusedRef.current) {
      focusedRef.current = true
      copyRef.current?.focus()
    }
  }, [positioned])

  const run = (action: () => void | Promise<void>): void => {
    setBusy(true)
    void Promise.resolve(action()).finally(() => setBusy(false))
  }

  return (
    <div className="image-export-pop" ref={ref} style={style} {...handleProps}>
      <div className="image-export-preview">
        <img src={state.dataUrl} alt="" draggable={false} />
      </div>
      <div className="image-export-meta">
        {t('imgExport.size', { w: String(state.width), h: String(state.height) })}
        <span className="image-export-source">
          {state.native
            ? t('imgExport.native')
            : t('imgExport.rendered', { dpi: String(state.dpi) })}
        </span>
      </div>
      <div className="image-export-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="btn-secondary image-export-redo"
          onClick={onRedo}
          title={t('imgExport.redoTip')}
        >
          {t('imgExport.redo')}
        </button>
        <button className="btn-secondary" disabled={busy} onClick={() => run(onSave)}>
          <IconSaveAs size={14} /> {t('imgExport.save')}
        </button>
        <button className="btn-primary" ref={copyRef} disabled={busy} onClick={() => run(onCopy)}>
          <IconCopy size={14} /> {t('imgExport.copy')}
        </button>
      </div>
    </div>
  )
}

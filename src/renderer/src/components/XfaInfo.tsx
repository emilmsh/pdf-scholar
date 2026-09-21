// "This is an XFA form — you are reading it, not filling it in."
//
// The badge exists because the alternative is silence: without it the tools
// simply do nothing and the fields simply do not take input, and the reader is
// left to guess whether the app or the file is broken. It names the format,
// says what works (reading, search, the assistant) and what does not (filling,
// marking, saving), and points to the program that can. Same shape as the
// «Signert» badge: a toolbar chip, a popover, gone for every other document.
import { useRef } from 'react'
import { t } from '../i18n'
import { useDismissable } from '../useDismissable'
import { IconDocument } from './icons'

interface Props {
  open: boolean
  onToggle(): void
  onClose(): void
}

export function XfaInfo({ open, onToggle, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(ref, open, onClose)

  return (
    <div className="signature-info xfa-info" ref={ref}>
      <button
        className={`tb-btn tb-labeled${open ? ' is-active' : ''}`}
        onClick={onToggle}
        title={t('xfaInfo.tip')}
      >
        <IconDocument size={15} />
        <span>{t('xfaInfo.badge')}</span>
      </button>
      {open && (
        <div className="signature-info-panel">
          <p className="confirm-message">{t('xfaInfo.title')}</p>
          <p className="xfa-info-body">{t('xfaInfo.body')}</p>
          <p className="signature-info-caveat">{t('xfaInfo.limits')}</p>
        </div>
      )}
    </div>
  )
}

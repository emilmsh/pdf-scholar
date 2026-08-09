import { useState } from 'react'
import { detailsUrl, openExtensionDetails } from '../extension-file-access'
import { t, useLang } from '../i18n'
import { IconExternal, IconLock } from './icons'

// The ask for «Gi tilgang til URL-adresser for fil» (see extension-file-access.ts
// for why it can only ever be an ask). One card, two homes:
//
//   'welcome'  — a quiet row on the welcome screen, dismissible, shown when the
//                browser tells us the switch is off. Nothing is broken yet.
//   'blocked'  — the whole screen, when a local PDF is the thing that failed to
//                open. Here it is not advice, it IS the error message, so it
//                carries the escape hatch (the browser's own reader) too.
//
// The button cannot be an <a href="chrome://…">: Chromium blocks extension pages
// from linking into its own UI. tabs.create is the only door, and when even that
// is refused the address is printed for the user to paste.

interface Props {
  variant: 'welcome' | 'blocked'
  /** 'blocked' only: hand the document to the browser's own reader instead */
  onOpenInBrowser?: (() => void) | undefined
  /** 'blocked' only: re-read the document after the switch was flipped */
  onRetry?: (() => void) | undefined
  onDismiss?: (() => void) | undefined
}

export default function FileAccessNotice({
  variant,
  onOpenInBrowser,
  onRetry,
  onDismiss
}: Props): React.JSX.Element {
  useLang()
  const blocked = variant === 'blocked'
  // Only shown once tabs.create has actually refused — the address is useless
  // noise the rest of the time.
  const [showManual, setShowManual] = useState(false)

  return (
    <div className={`fileaccess-card${blocked ? ' blocked' : ''}`} role="group">
      <div className="fileaccess-head">
        <div className="fileaccess-icon">
          <IconLock size={18} />
        </div>
        <div className="fileaccess-title">
          {t(blocked ? 'fileaccess.blockedTitle' : 'fileaccess.title')}
        </div>
      </div>

      <p className="fileaccess-body">{t('fileaccess.body')}</p>

      <ol className="fileaccess-steps">
        <li>{t('fileaccess.step1')}</li>
        <li>{t('fileaccess.step2')}</li>
        <li>{t(blocked ? 'fileaccess.step3Blocked' : 'fileaccess.step3')}</li>
      </ol>

      <div className="fileaccess-actions">
        <button
          className="btn-primary"
          onClick={() => {
            void openExtensionDetails().then((ok) => setShowManual(!ok))
          }}
        >
          <IconExternal size={15} />
          {t('fileaccess.open')}
        </button>
        {blocked && onRetry && (
          <button className="btn-secondary" onClick={onRetry}>
            {t('fileaccess.retry')}
          </button>
        )}
        {blocked && onOpenInBrowser && (
          <button className="btn-secondary" onClick={onOpenInBrowser}>
            {t('app.openInBrowser')}
          </button>
        )}
        {!blocked && onDismiss && (
          <button className="btn-secondary" onClick={onDismiss}>
            {t('fileaccess.dismiss')}
          </button>
        )}
      </div>

      {showManual && (
        <p className="fileaccess-manual">
          {t('fileaccess.manual')} <code className="fileaccess-url">{detailsUrl()}</code>
        </p>
      )}
    </div>
  )
}

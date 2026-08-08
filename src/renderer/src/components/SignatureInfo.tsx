// "This document is digitally signed" — and, deliberately, nothing stronger.
//
// We can read that signatures exist, when they were made and why. We CANNOT say
// whether they are valid: that means parsing the PKCS#7 blob and walking a
// certificate chain to a trust store, which needs a crypto dependency the app
// does not carry. A badge that reads as "verified" when nothing was verified is
// worse than no badge at all — someone would rely on it — so the panel says in
// plain words that the check has not been done and where to do it.
import { useRef } from 'react'
import { t } from '../i18n'
import type { DocSignature } from '../../../shared/types'
import { useDismissable } from '../useDismissable'
import { IconSignature } from './icons'

/** PDF dates are `D:YYYYMMDDHHmmSS±HH'mm'`. Render what parses, show the raw
 *  string when it does not — a date we cannot read is still evidence. */
function formatPdfDate(raw: string, locale: string): string {
  const m = /^D?:?(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(raw.trim())
  if (!m) return raw
  const [, y, mo, d, hh, mm] = m
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hh ? Number(hh) : 0,
    mm ? Number(mm) : 0
  )
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface Props {
  signatures: DocSignature[]
  open: boolean
  onToggle(): void
  onClose(): void
  locale: string
}

export function SignatureInfo({
  signatures,
  open,
  onToggle,
  onClose,
  locale
}: Props): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(ref, open, onClose)
  if (signatures.length === 0) return null

  return (
    <div className="signature-info" ref={ref}>
      <button
        className={`tb-btn tb-labeled${open ? ' is-active' : ''}`}
        onClick={onToggle}
        title={t('sigInfo.tip')}
      >
        <IconSignature size={15} />
        <span>{t('sigInfo.badge', { count: String(signatures.length) })}</span>
      </button>
      {open && (
        <div className="signature-info-panel">
          <p className="confirm-message">
            {t('sigInfo.title', { count: String(signatures.length) })}
          </p>
          <ul className="signature-info-list">
            {signatures.map((s, i) => (
              <li key={i}>
                <span className="signature-info-when">
                  {s.time ? formatPdfDate(s.time, locale) : t('sigInfo.noDate')}
                </span>
                {s.reason && <span className="signature-info-reason">{s.reason}</span>}
                {s.certifying && (
                  <span className="signature-info-tag">{t('sigInfo.certifying')}</span>
                )}
              </li>
            ))}
          </ul>
          {/* The whole point of the panel. Not a footnote — the reason it exists */}
          <p className="signature-info-caveat">{t('sigInfo.notVerified')}</p>
        </div>
      )}
    </div>
  )
}

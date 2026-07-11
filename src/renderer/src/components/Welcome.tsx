import type { RecentFile } from '../../../shared/types'
import { isElectron } from '../bridge'
import { locale, t, useLang } from '../i18n'
import { IconDocument, IconFolderOpen } from './icons'

interface Props {
  recents: RecentFile[]
  onOpenDialog(): void
  onOpenRecent(path: string): void
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Welcome({ recents, onOpenDialog, onOpenRecent }: Props): React.JSX.Element {
  useLang()
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-logo">PDF Scholar</div>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>

        <div className="welcome-actions">
          <button className="btn-primary" onClick={onOpenDialog}>
            <IconFolderOpen />
            {t('welcome.openPdf')}
          </button>
          {!isElectron && (
            <button className="btn-secondary" onClick={() => onOpenRecent('/sample.pdf')}>
              {t('welcome.openSample')}
            </button>
          )}
        </div>
        <p className="welcome-hint">{t('welcome.dragHint')}</p>

        {recents.length > 0 && (
          <div className="recents">
            <h2>{t('welcome.recents')}</h2>
            <ul>
              {recents.map((r) => (
                <li key={r.path}>
                  <button className="recent-row" onClick={() => onOpenRecent(r.path)} title={r.path}>
                    <IconDocument />
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.path}</span>
                    <span className="recent-date">{formatDate(r.lastOpened)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

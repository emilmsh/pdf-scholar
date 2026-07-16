import { useEffect, useState } from 'react'
import type { AiConfigView, RecentFile } from '../../../shared/types'
import { bridge } from '../bridge'
import { locale, t, useLang } from '../i18n'
import { AppMark, IconDocument, IconFolderOpen, IconSparkle } from './icons'
import { AiSettings } from './AiPanel'

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
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [showAiSetup, setShowAiSetup] = useState(false)

  // Load the AI config so we can invite first-time users to add a key. Gate the
  // invitation on "no key for the active provider" so it disappears once set up.
  useEffect(() => {
    let stale = false
    void bridge.aiGetConfig().then((view) => {
      if (!stale) setConfig(view)
    })
    return () => {
      stale = true
    }
  }, [])

  const hasKey = config ? config.hasKey[config.provider] : true

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-lockup">
          <AppMark className="welcome-mark" />
          <div className="welcome-logo">PDF Scholar</div>
        </div>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>

        <div className="welcome-actions">
          <button className="btn-primary" onClick={onOpenDialog}>
            <IconFolderOpen />
            {t('welcome.openPdf')}
          </button>
        </div>
        <p className="welcome-hint">{t('welcome.dragHint')}</p>

        {config && !hasKey && (
          <div className="welcome-ai-card">
            <div className="welcome-ai-icon">
              <IconSparkle size={18} />
            </div>
            <div className="welcome-ai-text">
              <div className="welcome-ai-title">{t('welcome.aiTitle')}</div>
              <p className="welcome-ai-body">{t('welcome.aiBody')}</p>
            </div>
            <button className="btn-secondary welcome-ai-btn" onClick={() => setShowAiSetup(true)}>
              {t('welcome.aiSetup')}
            </button>
          </div>
        )}

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

      {showAiSetup && config && (
        <div className="welcome-ai-backdrop" onMouseDown={() => setShowAiSetup(false)}>
          <div className="welcome-ai-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="welcome-ai-modal-head">
              <IconSparkle size={16} />
              <span>{t('welcome.aiTitle')}</span>
            </header>
            <p className="welcome-ai-guide">{t('welcome.aiGuide')}</p>
            <AiSettings
              config={config}
              onSaved={(next) => {
                setConfig(next)
                setShowAiSetup(false)
              }}
              onClose={() => setShowAiSetup(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

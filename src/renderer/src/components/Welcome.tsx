import { useEffect, useState } from 'react'
import type { AiConfigView, RecentFile, UpdateCheckOutcome } from '../../../shared/types'
import { bridge, isElectron } from '../bridge'
import { locale, t, useLang } from '../i18n'
import { AppMark, IconDocument, IconFolderOpen, IconHeart, IconSparkle } from './icons'
import { AiSettings } from './AiPanel'

interface Props {
  recents: RecentFile[]
  onOpenDialog(): void
  onOpenRecent(path: string): void
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
}

export function updateOutcomeText(outcome: UpdateCheckOutcome): string {
  switch (outcome.status) {
    case 'none':
      return t('update.upToDate', { current: outcome.current })
    case 'available':
      return t('update.checkAvailable', { version: outcome.version ?? '' })
    case 'ready':
      return t('update.checkReady', { version: outcome.version ?? '' })
    case 'unsupported':
      if (outcome.reason === 'store') return t('update.unsupportedStore')
      if (outcome.reason === 'mac') return t('update.unsupportedMac')
      return t('update.unsupportedDev')
    case 'error':
      return t('update.checkError')
  }
}

export default function Welcome({ recents, onOpenDialog, onOpenRecent }: Props): React.JSX.Element {
  useLang()
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [showAiSetup, setShowAiSetup] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateOutcome, setUpdateOutcome] = useState<UpdateCheckOutcome | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void bridge.getVersion().then(setVersion)
  }, [])

  const checkForUpdates = (): void => {
    if (updateChecking) return
    setUpdateChecking(true)
    setUpdateOutcome(null)
    void bridge
      .updateCheck()
      .then(setUpdateOutcome)
      .catch(() => setUpdateOutcome({ status: 'error', current: '' }))
      .finally(() => setUpdateChecking(false))
  }

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

        {/* Quiet footer: version + manual update check (the toolbar's gear
            menu offers the same — this is the copy you see before any
            document is open). If a newer version is found, the regular
            update toast (with its download button) appears alongside. */}
        <div className="welcome-updates">
          {version && <span className="welcome-version">PDF Scholar {version}</span>}
          {isElectron && (
            <button className="welcome-updates-btn" onClick={checkForUpdates} disabled={updateChecking}>
              {updateChecking ? t('update.checking') : t('update.check')}
            </button>
          )}
          {updateOutcome && <span className="welcome-updates-result">{updateOutcomeText(updateOutcome)}</span>}
        </div>

        <p className="welcome-credit">
          <span>{t('welcome.logoCredit')}</span>
          <span className="welcome-credit-sep">·</span>
          <button
            className="welcome-sponsor"
            onClick={() => bridge.openExternal('https://github.com/sponsors/emilmsh')}
            title={t('app.sponsorTip')}
          >
            <IconHeart size={12} />
            {t('app.sponsor')}
          </button>
        </p>
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

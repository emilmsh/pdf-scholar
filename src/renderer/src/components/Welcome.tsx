import type { RecentFile } from '../../../shared/types'
import { isElectron } from '../bridge'
import { IconDocument, IconFolderOpen } from './icons'

interface Props {
  recents: RecentFile[]
  onOpenDialog(): void
  onOpenRecent(path: string): void
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('no-NB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Welcome({ recents, onOpenDialog, onOpenRecent }: Props): React.JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-logo">PDFX</div>
        <p className="welcome-tagline">Les, annotér og organiser PDF-er — vakkert og distraksjonsfritt.</p>

        <div className="welcome-actions">
          <button className="btn-primary" onClick={onOpenDialog}>
            <IconFolderOpen />
            Åpne PDF …
          </button>
          {!isElectron && (
            <button className="btn-secondary" onClick={() => onOpenRecent('/sample.pdf')}>
              Åpne eksempeldokument
            </button>
          )}
        </div>
        <p className="welcome-hint">… eller dra og slipp en PDF hvor som helst i vinduet</p>

        {recents.length > 0 && (
          <div className="recents">
            <h2>Nylig lest</h2>
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

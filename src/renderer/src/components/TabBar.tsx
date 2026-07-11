import { t, useLang } from '../i18n'

export interface TabInfo {
  id: string
  name: string
  path: string
}

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  /** Distraction-free mode: collapse the bar (top-edge hover brings it back) */
  hidden: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onNewTab(): void
}

export default function TabBar({
  tabs,
  activeId,
  hidden,
  onSelect,
  onClose,
  onNewTab
}: Props): React.JSX.Element {
  useLang()
  return (
    <div className={`tab-bar${hidden ? ' tucked' : ''}`}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeId ? ' active' : ''}`}
          title={tab.path}
          onAuxClick={(e) => {
            if (e.button === 1) onClose(tab.id)
          }}
        >
          <button className="tab-label" onClick={() => onSelect(tab.id)}>
            {tab.name}
          </button>
          <button className="tab-close" aria-label={t('tabs.close')} onClick={() => onClose(tab.id)}>
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNewTab} title={t('tabs.new')}>
        +
      </button>
    </div>
  )
}

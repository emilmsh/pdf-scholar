export interface TabInfo {
  id: string
  name: string
  path: string
}

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  onSelect(id: string): void
  onClose(id: string): void
  onNewTab(): void
}

export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab
}: Props): React.JSX.Element {
  return (
    <div className="tab-bar">
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
          <button className="tab-close" aria-label="Lukk fane" onClick={() => onClose(tab.id)}>
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNewTab} title="Åpne PDF (Ctrl+O)">
        +
      </button>
    </div>
  )
}

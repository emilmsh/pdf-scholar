// Minimal ambient declarations for the subset of the WebExtension `chrome.*`
// API the extension bridge/background use. We hand-roll this instead of pulling
// in @types/chrome (see CLAUDE.md: no new deps without a good reason) — the
// surface we touch is tiny. Everything is optional at runtime and guarded by
// `isExtensionContext()`; these types only make the guarded calls type-safe.

interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

interface ChromeTab {
  id?: number
  url?: string
}

interface ChromeEvent<T extends (...args: never[]) => void> {
  addListener(cb: T): void
  removeListener(cb: T): void
}

interface DnrRule {
  id: number
  priority: number
  action: {
    type: 'redirect' | 'block' | 'allow'
    redirect?: { regexSubstitution?: string; extensionPath?: string; url?: string }
  }
  condition: {
    regexFilter?: string
    urlFilter?: string
    resourceTypes?: string[]
    requestDomains?: string[]
  }
}

interface ChromeApi {
  runtime: {
    id?: string
    getURL(path: string): string
    onInstalled: ChromeEvent<(details: { reason: string }) => void>
    lastError?: { message?: string }
  }
  declarativeNetRequest?: {
    updateDynamicRules(opts: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>
    getDynamicRules(): Promise<DnrRule[]>
  }
  storage?: {
    local: ChromeStorageArea
  }
  tabs?: {
    create(props: { url: string; active?: boolean }): Promise<ChromeTab>
    getCurrent(): Promise<ChromeTab | undefined>
    remove(tabId: number): Promise<void>
  }
  action?: {
    onClicked: ChromeEvent<(tab: ChromeTab) => void>
  }
}

declare const chrome: ChromeApi | undefined

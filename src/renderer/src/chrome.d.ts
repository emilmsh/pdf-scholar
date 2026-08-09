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
    requestMethods?: string[]
    /** Chrome 128+. Values match case-insensitively and support `*` / `?`.
     *  A rule carrying these is evaluated once the response headers arrive. */
    responseHeaders?: { header: string; values?: string[] }[]
    excludedResponseHeaders?: { header: string; values?: string[] }[]
    /** Session-scoped rules only — how the "open in the browser's own reader"
     *  bypass stays confined to the tab that asked for it. */
    tabIds?: number[]
  }
}

interface ChromeApi {
  runtime: {
    id?: string
    getURL(path: string): string
    getManifest(): { version: string }
    onInstalled: ChromeEvent<(details: { reason: string }) => void>
    lastError?: { message?: string }
  }
  // The last survivor of the MV2 chrome.extension namespace we need: whether the
  // user has granted "Allow access to file URLs". Callable without any
  // permission (it only reports our own state), promisified in MV3.
  extension?: {
    isAllowedFileSchemeAccess?(): Promise<boolean>
  }
  // getSelf is callable WITHOUT the "management" permission (own extension only)
  management?: {
    getSelf(): Promise<{ installType: 'development' | 'normal' | 'sideload' | 'admin' | 'other' }>
  }
  declarativeNetRequest?: {
    updateDynamicRules(opts: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>
    getDynamicRules(): Promise<DnrRule[]>
    updateSessionRules?(opts: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>
    getSessionRules?(): Promise<DnrRule[]>
  }
  storage?: {
    local: ChromeStorageArea
  }
  tabs?: {
    create(props: { url: string; active?: boolean }): Promise<ChromeTab>
    getCurrent(): Promise<ChromeTab | undefined>
    update?(tabId: number, props: { url: string }): Promise<ChromeTab | undefined>
    remove(tabId: number): Promise<void>
  }
  action?: {
    onClicked: ChromeEvent<(tab: ChromeTab) => void>
  }
}

declare const chrome: ChromeApi | undefined

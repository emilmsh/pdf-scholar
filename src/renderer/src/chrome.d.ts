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

/** Blocking webRequest — the Firefox redirect path (Chrome MV3 forbids it for
 *  non-policy installs, so this branch only runs on Firefox; see background.ts). */
interface WebRequestDetails {
  url: string
  type: string
  tabId: number
}
type WebRequestBlockingResponse = { redirectUrl?: string; cancel?: boolean } | void
interface WebRequestOnBeforeRequest {
  addListener(
    cb: (details: WebRequestDetails) => WebRequestBlockingResponse,
    filter: { urls: string[]; types?: string[] },
    extraInfoSpec?: string[]
  ): void
  removeListener(cb: (details: WebRequestDetails) => WebRequestBlockingResponse): void
  hasListener(cb: (details: WebRequestDetails) => WebRequestBlockingResponse): boolean
}

interface ChromeApi {
  runtime: {
    id?: string
    getURL(path: string): string
    getManifest(): { version: string }
    onInstalled: ChromeEvent<(details: { reason: string }) => void>
    lastError?: { message?: string }
  }
  // getSelf is callable WITHOUT the "management" permission (own extension only)
  management?: {
    getSelf(): Promise<{ installType: 'development' | 'normal' | 'sideload' | 'admin' | 'other' }>
  }
  declarativeNetRequest?: {
    updateDynamicRules(opts: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>
    getDynamicRules(): Promise<DnrRule[]>
  }
  webRequest?: {
    onBeforeRequest: WebRequestOnBeforeRequest
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

// Chrome exposes `chrome` (promise-based in MV3). Firefox exposes BOTH `chrome`
// (callback-based) and `browser` (promise-based). Renderer/background code must
// therefore route promise-style calls through the `browser ?? chrome` alias in
// `ext.ts` (renderer) / the local alias in `background.ts`, never bare `chrome`.
declare const chrome: ChromeApi | undefined
declare const browser: ChromeApi | undefined

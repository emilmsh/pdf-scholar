// Background worker for the PDF Scholar browser extension.
//
// Its one job is to make the browser hand PDF navigations to our viewer instead
// of the built-in reader, by redirecting any main-frame navigation to a *.pdf
// URL to  <extension-origin>/viewer.html?file=<original-url>.
//
// TWO redirect mechanisms, picked at RUNTIME by feature detection, because the
// engines diverge on which one is available/reliable:
//
//   • Chromium (Edge/Chrome): declarativeNetRequest. A dynamic rule with
//     regexFilter + action.redirect.regexSubstitution. Chrome MV3 removed
//     blocking webRequest for normal installs, so DNR is the only option — and
//     it works well there.
//
//   • Firefox: blocking webRequest (webRequest.onBeforeRequest → {redirectUrl}).
//     Firefox keeps blocking webRequest in MV3 (that is how uBlock Origin still
//     works), and — critically — main_frame redirect *to an extension page* via
//     DNR is an under-specified / historically flaky area on Firefox
//     (w3c/webextensions#610), whereas the webRequest→moz-extension redirect is
//     the long-proven path used by pdf.js's own viewer and the JSON viewers.
//     So on Firefox we deliberately take the webRequest route.
//
// Feature detection is manifest-driven and needs no UA sniffing: the Chromium
// manifest grants `declarativeNetRequest` (and no webRequest), the Firefox
// manifest grants `webRequest`+`webRequestBlocking` (and no DNR). Whichever
// namespace the running browser actually exposes is the one we use.
//
// file:// interception additionally requires the user to grant file access:
// Chromium's per-extension "Allow access to file URLs" toggle; Firefox has no
// such toggle and support for webRequest on file:// navigations is not
// guaranteed — see docs/BROWSER-EXTENSION.md.

// Firefox exposes promise-based `browser`; Chrome exposes only `chrome`. Use the
// alias so async calls (updateDynamicRules, tabs.create) resolve on both.
const ext: ChromeApi | undefined =
  typeof browser !== 'undefined' && browser
    ? browser
    : typeof chrome !== 'undefined'
      ? chrome
      : undefined

const REDIRECT_RULE_ID = 1

// Match http(s)/file URLs ending in .pdf, tolerating a trailing query/hash.
// \\0 in the DNR substitution is the whole matched URL.
const PDF_URL_FILTER = '^(https?|file)://[^#]*\\.pdf(\\?[^#]*)?(#.*)?$'
// Same predicate for the Firefox webRequest path (case-insensitive: file
// systems and servers vary on `.PDF`).
const PDF_URL_RE = /^(https?|file):\/\/[^#]*\.pdf(\?[^#]*)?(#.*)?$/i

// ---------- Chromium: declarativeNetRequest ----------

async function installRedirectRule(): Promise<void> {
  if (!ext?.declarativeNetRequest) return
  const viewer = ext.runtime.getURL('viewer.html')
  await ext.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [
      {
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${viewer}?file=\\0` }
        },
        condition: {
          regexFilter: PDF_URL_FILTER,
          resourceTypes: ['main_frame']
        }
      }
    ]
  })
}

// ---------- Firefox: blocking webRequest ----------

// Module-level (stable) listener so hasListener/removeListener work across
// event-page wakeups and we never double-register.
function onBeforePdf(details: WebRequestDetails): WebRequestBlockingResponse {
  const viewer = ext?.runtime.getURL('viewer.html') ?? ''
  // Never touch our own viewer page (its ?file= fetch is not a main_frame, but
  // guard anyway) and only redirect genuine PDF navigations.
  if (!viewer || details.url.startsWith(viewer)) return
  if (!PDF_URL_RE.test(details.url)) return
  return { redirectUrl: `${viewer}?file=${encodeURIComponent(details.url)}` }
}

function installWebRequestRedirect(): void {
  if (!ext?.webRequest?.onBeforeRequest) return
  if (ext.webRequest.onBeforeRequest.hasListener(onBeforePdf)) return
  ext.webRequest.onBeforeRequest.addListener(
    onBeforePdf,
    // Restrict to the schemes we hold host permissions for; the precise .pdf
    // test happens in the listener (match patterns can't express the regex).
    { urls: ['http://*/*', 'https://*/*', 'file:///*'], types: ['main_frame'] },
    ['blocking']
  )
}

// ---------- Install (whichever path this browser supports) ----------

function installRedirect(): void {
  if (ext?.webRequest?.onBeforeRequest) {
    installWebRequestRedirect() // Firefox
  } else {
    void installRedirectRule() // Chromium
  }
}

ext?.runtime.onInstalled.addListener(() => {
  installRedirect()
})

// DNR dynamic rules persist across worker restarts and webRequest listeners must
// be re-registered on every event-page wakeup, so re-assert on startup too.
installRedirect()

// Clicking the toolbar icon opens an empty viewer tab (welcome screen).
ext?.action?.onClicked.addListener(() => {
  if (ext?.tabs) void ext.tabs.create({ url: ext.runtime.getURL('viewer.html'), active: true })
})

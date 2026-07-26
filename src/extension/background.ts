// Service worker for the PDF Scholar browser extension.
//
// Its one job is to make the browser hand PDF navigations to our viewer instead
// of the built-in reader. We do this with a dynamic declarativeNetRequest rule
// that redirects any main-frame navigation to a *.pdf URL to
//   chrome-extension://<id>/viewer.html?rawfile=<original-url>
//
// The rule is registered dynamically (not as a static rule) because the
// redirect target contains the extension's own origin, which is only known at
// runtime via chrome.runtime.getURL — a static rule can't express it, and
// regexSubstitution lets us fold the matched URL in as the ?rawfile= param.
// `rawfile` (not `file`) because regexSubstitution cannot percent-encode: the
// URL arrives verbatim and must be read back verbatim — see
// src/shared/viewer-url.ts for why parsing it as a query param loses signed and
// utm-tagged links.
//
// file:// interception additionally requires the user to enable "Allow access
// to file URLs" on the extension's details page; http(s) is covered by
// host_permissions in the manifest.

const REDIRECT_RULE_ID = 1

// Deliberately a literal, not an import from shared/viewer-url.ts: importing it
// makes rollup hoist the shared module into a hashed chunk that this worker then
// depends on, and the worker is the one component whose failure mode is "the
// extension silently does nothing". It stays self-contained; test:viewer-url
// asserts this literal still matches RAW_FILE_PARAM.
const RAW_FILE_PARAM = 'rawfile'

// Match http(s)/file URLs ending in .pdf, tolerating a trailing query/hash.
// \\0 in the substitution is the whole matched URL.
const PDF_URL_FILTER = '^(https?|file)://[^#]*\\.pdf(\\?[^#]*)?(#.*)?$'

async function installRedirectRule(): Promise<void> {
  if (!chrome?.declarativeNetRequest) return
  const viewer = chrome.runtime.getURL('viewer.html')
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [
      {
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${viewer}?${RAW_FILE_PARAM}=\\0` }
        },
        condition: {
          regexFilter: PDF_URL_FILTER,
          resourceTypes: ['main_frame']
        }
      }
    ]
  })
}

chrome?.runtime.onInstalled.addListener(() => {
  void installRedirectRule()
})

// Dynamic rules persist across service-worker restarts, but re-asserting on
// startup is cheap insurance against a partially-applied install.
void installRedirectRule()

// Clicking the toolbar icon opens an empty viewer tab (welcome screen).
// NB: chrome.tabs.create needs NO "tabs" permission — that permission only gates
// the sensitive tab fields (url/pendingUrl/title/favIconUrl), which we never
// read. Chrome Web Store review rejected the extension for declaring it
// ("Purple Potassium", 2026-07-24); do not add it back.
chrome?.action?.onClicked.addListener(() => {
  if (chrome?.tabs) void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html'), active: true })
})

// Service worker for the PDF Scholar browser extension.
//
// Its one job is to make the browser hand PDF navigations to our viewer instead
// of the built-in reader, by redirecting the navigation to
//   chrome-extension://<id>/viewer.html?rawfile=<original-url>
//
// Two dynamic declarativeNetRequest rules, because a PDF announces itself in two
// different ways and covering only the first leaves half the web behind:
//   1. the URL ends in .pdf                      → matched before the request
//   2. the response says content-type: application/pdf → matched on the headers
// Rule 2 is what makes arXiv's /pdf/2401.12345, SSRN's Delivery.cfm and every
// "download" endpoint open in our reader. See each function for its trade-offs.
//
// The rules are registered dynamically (not as static rules) because the
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

const URL_RULE_ID = 1
const CONTENT_TYPE_RULE_ID = 2

// Deliberately a literal, not an import from shared/viewer-url.ts: importing it
// makes rollup hoist the shared module into a hashed chunk that this worker then
// depends on, and the worker is the one component whose failure mode is "the
// extension silently does nothing". It stays self-contained; test:viewer-url
// asserts this literal still matches RAW_FILE_PARAM.
const RAW_FILE_PARAM = 'rawfile'

// Match http(s)/file URLs ending in .pdf, tolerating a trailing query/hash.
// \\0 in the substitution is the whole matched URL.
const PDF_URL_FILTER = '^(https?|file)://[^#]*\\.pdf(\\?[^#]*)?(#.*)?$'

// Rule 2 matches every http(s) navigation and lets the response's content-type
// decide, so the filter is deliberately wide; \\0 folds the URL in the same way.
const ANY_HTTP_FILTER = '^https?://.*'

function redirectToViewer(viewer: string): DnrRule['action'] {
  return { type: 'redirect', redirect: { regexSubstitution: `${viewer}?${RAW_FILE_PARAM}=\\0` } }
}

/** Rule 1 — the URL ends in .pdf. Decided *before* the request is sent, so the
 *  document is fetched exactly once and nothing reaches the server twice. This is
 *  the rule that must never fail to register. */
async function installUrlRule(viewer: string): Promise<void> {
  await chrome!.declarativeNetRequest!.updateDynamicRules({
    removeRuleIds: [URL_RULE_ID],
    addRules: [
      {
        id: URL_RULE_ID,
        priority: 1,
        action: redirectToViewer(viewer),
        condition: { regexFilter: PDF_URL_FILTER, resourceTypes: ['main_frame'] }
      }
    ]
  })
}

/** Rule 2 — the URL says nothing about the content: arXiv's /pdf/2401.12345,
 *  SSRN's Delivery.cfm, DOI resolvers, Drive, every "download" endpoint. Only the
 *  response's content-type can tell, which Chrome exposes to declarativeNetRequest
 *  from 128 on. Registered in its own call so an older browser, which rejects the
 *  condition outright, still keeps rule 1.
 *
 *  Chrome evaluates this once the response HEADERS arrive and then abandons the
 *  body, so the document is not downloaded twice — but the request has reached
 *  the server, which is why the scope is narrow:
 *  - GET only: a PDF that is the answer to a POST cannot be re-fetched by the
 *    viewer (the body is gone), and the browser's own reader renders it fine.
 *  - not an attachment: `Content-Disposition: attachment` means the browser saves
 *    the file, which is what the user asked for by clicking a download link.
 *  - main_frame only: a PDF embedded in a page stays with the browser's plugin.
 *  A single-use signed URL can still be spent by the time the viewer re-fetches
 *  it; that surfaces in the error banner's "open in the browser's reader". */
async function installContentTypeRule(viewer: string): Promise<void> {
  await chrome!.declarativeNetRequest!.updateDynamicRules({
    removeRuleIds: [CONTENT_TYPE_RULE_ID],
    addRules: [
      {
        id: CONTENT_TYPE_RULE_ID,
        priority: 1,
        action: redirectToViewer(viewer),
        condition: {
          regexFilter: ANY_HTTP_FILTER,
          resourceTypes: ['main_frame'],
          requestMethods: ['get'],
          // Trailing * so a charset parameter still matches.
          responseHeaders: [
            { header: 'content-type', values: ['application/pdf*', 'application/x-pdf*'] }
          ],
          excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }]
        }
      }
    ]
  })
}

async function installRedirectRules(): Promise<void> {
  if (!chrome?.declarativeNetRequest) return
  const viewer = chrome.runtime.getURL('viewer.html')
  await installUrlRule(viewer)
  try {
    await installContentTypeRule(viewer)
  } catch {
    // Chrome < 128: no response-header conditions. PDFs whose URL does not end
    // in .pdf keep going to the browser's own viewer — a smaller feature set,
    // not a broken one.
  }
}

/** The install-time ask for «Gi tilgang til URL-adresser for fil».
 *
 *  A store install arrives with file:// access OFF and no way to request it:
 *  the toggle lives on the extension's own details page and only the user may
 *  flip it, so it appears in no install dialog and in no permission prompt. The
 *  File Explorer story — double-click a PDF, read it here — is therefore
 *  silently dead until someone says so out loud. One tab, once, at install:
 *  the welcome screen, whose access card is that sentence (Welcome.tsx).
 *
 *  Only when the browser confirms the access is missing — a re-load of an
 *  unpacked build that already has it gets no tab. If the probe is unavailable
 *  we ask anyway: a card the user can wave away beats a feature they never
 *  learn about. */
async function openInstallOnboarding(): Promise<void> {
  if (!chrome?.tabs) return
  try {
    if (await chrome.extension?.isAllowedFileSchemeAccess?.()) return
  } catch {
    // Older browser without the probe — fall through and show the card.
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html'), active: true })
}

chrome?.runtime.onInstalled.addListener((details) => {
  void installRedirectRules()
  // 'install' only: an update fires here too, and a tab on every auto-update
  // would be the extension talking over the user's work.
  if (details.reason === 'install') void openInstallOnboarding()
})

// Dynamic rules persist across service-worker restarts, but re-asserting on
// startup is cheap insurance against a partially-applied install.
void installRedirectRules()

// Clicking the toolbar icon opens an empty viewer tab (welcome screen).
// NB: chrome.tabs.create needs NO "tabs" permission — that permission only gates
// the sensitive tab fields (url/pendingUrl/title/favIconUrl), which we never
// read. Chrome Web Store review rejected the extension for declaring it
// ("Purple Potassium", 2026-07-24); do not add it back.
chrome?.action?.onClicked.addListener(() => {
  if (chrome?.tabs) void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html'), active: true })
})

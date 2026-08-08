// «Gi tilgang til URL-adresser for fil» — the one permission an extension can
// never hold on its own.
//
// Chromium grants http(s) hosts from the manifest at install time, but file://
// is different: the toggle lives on the extension's own details page, only the
// user may flip it, and a STORE install always arrives with it off. So the
// extension's File Explorer story — double-click a PDF, read it here — is dead
// on arrival until the user is told, in words, that the switch exists.
//
// This module is only the plumbing (probe, address, open); the words live in
// components/FileAccessNotice.tsx, which the welcome screen and the failed-open
// path both render.
//
// NB: deliberately import-free, like src/extension/background.ts. That keeps it
// loadable on its own in `npm run test:file-access`, which is where the two
// browser-specific details below are pinned.

/** No import for the same reason (see above): the key is a literal here and in
 *  the test. */
const K_DISMISSED = 'pdfx-file-access-dismissed'

/** Whether the browser lets us read `file://` URLs.
 *
 *  `null` means we cannot tell — not an extension page, or a browser without
 *  the probe. Callers treat that as "granted": nagging about a switch we cannot
 *  see the state of would put an unfixable card in front of every desktop user
 *  (the renderer is shared) and in front of anyone whose browser never had the
 *  restriction. */
export async function fileAccessGranted(): Promise<boolean | null> {
  const ext = chrome?.extension
  if (!ext?.isAllowedFileSchemeAccess) return null
  try {
    return await ext.isAllowedFileSchemeAccess()
  } catch {
    return null
  }
}

/** The details page that carries the toggle. The scheme is the browser's own
 *  UI namespace, so it differs per browser and there is no API that resolves
 *  it — Edge answers to `edge://`, every other Chromium to `chrome://`. Pure
 *  function of the two things that decide it, so the test can pin both. */
export function extensionDetailsUrl(userAgent: string, id: string): string {
  // `Edg/` is desktop Edge, `EdgA/`/`EdgiOS/` its mobile builds. The old
  // `Edge/` (EdgeHTML) never ran extensions like this and is not matched — a
  // stray "edge" in some other product's UA must not send Chrome users to a
  // scheme their browser does not know.
  const isEdge = /\bEdg(?:A|iOS)?\//.test(userAgent)
  return `${isEdge ? 'edge' : 'chrome'}://extensions/?id=${id}`
}

/** The details page for THIS extension in THIS browser. */
export function detailsUrl(): string {
  return extensionDetailsUrl(navigator.userAgent, chrome?.runtime?.id ?? '')
}

/** Open the details page in a new tab. `false` = the browser refused (an
 *  extension may not navigate to `chrome://` from a link, and some managed
 *  builds block it from `tabs.create` too) — the notice then shows the address
 *  for the user to paste, which always works. */
export async function openExtensionDetails(): Promise<boolean> {
  if (!chrome?.tabs?.create || !chrome.runtime?.id) return false
  try {
    await chrome.tabs.create({ url: detailsUrl(), active: true })
    return true
  } catch {
    return false
  }
}

/** True once this page has been orphaned by an extension reload — which is
 *  exactly what flipping the file-access switch does in Chromium. The page
 *  survives visually, but `chrome.runtime.id` goes undefined and every API call
 *  from here on throws, so nothing on it works again until it is reloaded. The
 *  viewer URL still carries the document, so a reload brings the PDF straight
 *  back. False when there is no extension runtime at all (desktop, dev:web) —
 *  there is nothing to lose there. */
export function extensionContextLost(): boolean {
  return !!chrome?.runtime && !chrome.runtime.id
}

/** Whether the user waved the welcome-screen card away. Only that card honours
 *  it — a local PDF that actually failed to open still shows the fix, because
 *  there the switch is the difference between reading the document and not. */
export async function fileAccessNoticeDismissed(): Promise<boolean> {
  try {
    const got = await chrome?.storage?.local.get(K_DISMISSED)
    return got?.[K_DISMISSED] === true
  } catch {
    return false
  }
}

export function dismissFileAccessNotice(): void {
  void chrome?.storage?.local.set({ [K_DISMISSED]: true })
}

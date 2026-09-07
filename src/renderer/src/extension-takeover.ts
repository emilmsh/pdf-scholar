// «Åpne PDF-er fra nettet her» — the extension's one switch over what it takes
// from the browser.
//
// The extension redirects every main-frame PDF navigation to our viewer
// (src/extension/background.ts). For a user who has set the browser to DOWNLOAD
// PDFs instead of viewing them — a batch of articles opened by another tool, a
// reference manager's «save these» flow — that redirect silently overrides
// their own setting (issue #16, 2026-09-07). This flag lets them keep it: off,
// http(s) PDFs go wherever the browser was told to send them, and only file://
// documents (the File Explorer story, already gated by the user's own «Allow
// access to file URLs» toggle) open here.
//
// Only the renderer half lives here: read and write the flag. The service
// worker reads the same key itself and re-applies its rules when it changes.
//
// NB: deliberately import-free, like src/extension/background.ts and
// extension-file-access.ts — the key is a literal here, in the worker and in
// `npm run test:file-access`, which pins that the three agree.

/** chrome.storage.local key. Absent = on (the shipped behaviour). */
const K_WEB_TAKEOVER = 'pdfx-web-takeover'

/** Whether http(s) PDFs open in the viewer. True outside an extension context
 *  too, so the shared renderer never has to special-case a missing API. */
export async function webTakeoverEnabled(): Promise<boolean> {
  const storage = chrome?.storage?.local
  if (!storage) return true
  try {
    const got = await storage.get(K_WEB_TAKEOVER)
    return got[K_WEB_TAKEOVER] !== false
  } catch {
    return true
  }
}

/** Flip the switch. The service worker's storage listener does the rest. */
export function setWebTakeover(on: boolean): void {
  const storage = chrome?.storage?.local
  if (!storage) return
  void storage.set({ [K_WEB_TAKEOVER]: on })
}

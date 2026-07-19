// Cross-browser WebExtension runtime alias — the single seam that lets the
// extension renderer work in BOTH Chromium and Firefox.
//
// The incompatibility this solves: Chrome MV3 makes `chrome.*` async methods
// return promises, so the renderer can write `chrome.storage.local.get(k)
// .then(...)`. Firefox does NOT — on Firefox `chrome.*` is the legacy
// callback-based namespace; only `browser.*` returns promises. Firefox exposes
// both globals; Chrome exposes only `chrome`.
//
//   Firefox → `browser` (promises)   Chrome → `chrome` (promises)
//
// Routing every promise-style call through this one alias makes the existing
// promise code correct on both engines, without pulling in webextension-polyfill
// (its overhead is unnecessary when a plain global alias suffices — see
// CLAUDE.md: no new deps without a good reason). Synchronous calls
// (`runtime.getURL`, `getManifest`) and event `addListener` calls behave
// identically on either global, so they may still be reached through `ext` too.
export const ext: ChromeApi | undefined =
  typeof browser !== 'undefined' && browser
    ? browser
    : typeof chrome !== 'undefined'
      ? chrome
      : undefined

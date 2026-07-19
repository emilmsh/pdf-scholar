# Browser-extension target

A parallel packaging of PDF Scholar as a **WebExtension** for both Chromium
(Edge/Chrome) **and Firefox** (desktop + Firefox for Android), developed in
tandem with the native Electron app. The goal: the same reader and annotator, but
integrated into the browser's own tab system — open a PDF and it becomes a normal
browser tab, exactly like the browser's built-in viewer, only with our features
on top. Set the extension's browser as the default PDF app and double-clicking a
PDF in File Explorer opens it in PDF Scholar instead of the built-in reader.

One codebase, two output flavours (same renderer, background source, viewer and
icons; only `manifest.json` and the runtime redirect path differ):

- `npm run build:ext` → `dist-extension/` — Chromium, MV3 **service worker** +
  **declarativeNetRequest** redirect.
- `npm run build:ext:firefox` → `dist-extension-firefox/` — Firefox, MV3 **event
  page** + **blocking webRequest** redirect, plus the `browser_specific_settings`
  gecko id/min-versions Firefox and AMO require.

The Firefox manifest is derived from the Chromium one at build time by a single
override function (`toFirefoxManifest` in `vite.extension.config.ts`), so the two
can never drift.

This document explains the architecture, what has parity with the native app,
what is deliberately adapted for the browser, and how to build/load it.

## Why this is cheap to maintain alongside the app

The renderer is already platform-agnostic. Every platform call goes through a
single interface, `PdfxApi` (`src/shared/types.ts`), resolved at runtime in
`src/renderer/src/bridge.ts`:

```
             ┌──────────────── shared core (React renderer) ────────────────┐
             │     PdfViewer, annotation overlay, AI, themes, search, i18n   │
             └──────────────────────────┬───────────────────────────────────┘
                                        │  window.api : PdfxApi   (the seam)
        ┌───────────────────────────────┼───────────────────────────────┐
   Electron main/preload         web fallback (bridge.ts)         WebExtension
   (native app)                  (plain-browser dev preview)      (this target)
```

The extension is a **third implementation of `PdfxApi`**, not a fork. The only
renderer additions are new, additive files; `bridge.ts` gained one selection
branch. When a renderer feature is added, both targets get it for free unless it
touches a `PdfxApi` method, in which case the compiler forces both to implement
it.

## Files

| Path | Role |
|------|------|
| `src/extension/manifest.json` | MV3 manifest — the **Chromium base**; Firefox variant is derived from it at build time |
| `src/extension/background.ts`  | Background worker: registers the PDF→viewer redirect (DNR on Chromium, blocking webRequest on Firefox — feature-detected) |
| `src/extension/viewer.html`    | The extension page each PDF tab loads |
| `src/renderer/src/extension-main.tsx` | React entry for the viewer page |
| `src/renderer/src/ExtensionApp.tsx`   | Single-document shell (no in-app TabBar) |
| `src/renderer/src/extension-api.ts`   | `PdfxApi` over the WebExtension API + File System Access |
| `src/renderer/src/ext.ts`             | `browser ?? chrome` alias — the one seam that makes promise-style calls work on Firefox too |
| `src/renderer/src/chrome.d.ts`        | Minimal ambient `chrome`/`browser` types (no new dep) |
| `vite.extension.config.ts`     | Build factory; default export builds `dist-extension/` (Chromium) |
| `vite.extension.firefox.config.ts` | Reuses the factory to build `dist-extension-firefox/` (Firefox) |
| `tsconfig.extension.json`      | Typecheck for the background worker |

`ExtensionApp` mirrors the chrome around the viewer in `App.tsx` (theme
resolution, settings, fullscreen, language). Once the tab-mode work in `App.tsx`
lands, the shared parts are the natural thing to extract into a common
`<AppShell>` so the two shells converge instead of drifting.

## How PDF interception works

`background.ts` makes the browser hand any main-frame navigation to a `*.pdf` URL
to `<extension-origin>/viewer.html?file=<original-url>` (the origin is
`chrome-extension://` on Chromium, `moz-extension://` on Firefox — obtained at
runtime via `runtime.getURL`, so no code hard-codes the scheme).
`extension-api.ts:getPendingPath` reads that `?file=` param and the shell opens
the document — the same "pending path" pattern the Electron app uses for a freshly
spawned window.

**Two redirect mechanisms, picked at runtime by feature detection**, because the
engines diverge on what is available and reliable (see the DNR-vs-webRequest note
below):

- **Chromium → declarativeNetRequest.** A dynamic DNR rule with `regexFilter` +
  `action.redirect.regexSubstitution`. Dynamic because the redirect target embeds
  the extension's own origin; `regexSubstitution` folds the matched URL in as the
  `?file=` param. Chrome MV3 removed blocking webRequest for normal installs, so
  DNR is the only option there — and it works well.
- **Firefox → blocking webRequest.** `webRequest.onBeforeRequest` returns
  `{ redirectUrl }`. Firefox keeps blocking webRequest in MV3 (this is how uBlock
  Origin still works there), and the webRequest→extension-page redirect is the
  long-proven path (pdf.js's own viewer, the JSON viewers). We deliberately avoid
  DNR here — see below.

Feature detection is manifest-driven, no UA sniffing: the Chromium manifest grants
`declarativeNetRequest` (no `webRequest`); the Firefox manifest grants
`webRequest`+`webRequestBlocking` (no DNR). `background.ts` uses whichever
namespace the running browser actually exposes. The identical `background.js` ships
in both bundles.

- **http(s) PDFs**: covered by `host_permissions` on both engines.
- **file:// PDFs** (the File Explorer double-click case):
  - **Chromium**: require the user to enable **"Allow access to file URLs"** on the
    extension's details page — a one-time manual toggle Chromium reserves for the
    user; an extension cannot grant it to itself.
  - **Firefox**: has **no** per-extension file-URL toggle, and blocking webRequest
    on `file://` main-frame navigations is not guaranteed across versions. The
    `file:///*` host permission is declared and the redirect is attempted, but
    treat local-file takeover on Firefox as **best-effort / to be verified** (see
    the watch-list). http(s) PDFs are the fully-supported path on Firefox.

### The `chrome.*` promise incompatibility (why `ext.ts` exists)

Chrome MV3 makes `chrome.*` async methods return promises, so the renderer can do
`chrome.storage.local.get(k).then(...)`. Firefox does **not**: on Firefox `chrome.*`
is the legacy callback-based namespace and only `browser.*` returns promises
(Firefox exposes both globals; Chrome exposes only `chrome`). Every promise-style
call therefore goes through one alias — `ext = browser ?? chrome` in
`src/renderer/src/ext.ts` (and an identical local alias in `background.ts`, which
is a separate build scope). Result: Firefox routes to `browser` (promises), Chrome
to `chrome` (promises), and the existing promise code is correct on both without
pulling in `webextension-polyfill`.

## Build & load

```
npm run build:ext              # → dist-extension/          (Chromium)
npm run dev:ext                # Chromium, rebuild on change
npm run build:ext:firefox      # → dist-extension-firefox/  (Firefox)
npm run dev:ext:firefox        # Firefox, rebuild on change
```

**Chromium** — in `edge://extensions` (or `chrome://extensions`):

1. Enable **Developer mode**.
2. **Load unpacked** → select `dist-extension/`.
3. Open the extension's **Details** → enable **Allow access to file URLs** (for
   local PDFs).
4. To make double-click work: Windows **Settings → Apps → Default apps →** set
   `.pdf` to the extension's browser.

**Firefox** — in `about:debugging#/runtime/this-firefox`:

1. **Load Temporary Add-on…** → pick any file in `dist-extension-firefox/` (e.g.
   `manifest.json`). Stays loaded until Firefox restarts.
2. Open an http(s) `.pdf` link → it should redirect into the viewer.
3. For distribution the add-on must be **signed by Mozilla (AMO)** — mandatory but
   free. Submit via [addons.mozilla.org](https://addons.mozilla.org) (listed;
   auto-updates; covers desktop + Android), or self-host a signed XPI from
   `web-ext sign` / the AMO signing API. The add-on id
   `pdf-scholar@emilmsh.github.io` is set in the manifest (`web-ext sign` requires
   one). The same signed XPI installs on **Firefox for Android**.

## Firefox testing checklist

Automated tests can't drive Firefox here, so verify manually. Desktop first, then
Android.

**Desktop Firefox**

1. `npm run build:ext:firefox`.
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
   `dist-extension-firefox/manifest.json`. → *Expected:* "PDF Scholar" appears in
   the temporary add-ons list with no manifest errors; toolbar icon shows.
3. Open an **http(s) PDF** (e.g. an arXiv `.pdf` link) in a normal tab. →
   *Expected:* the URL is redirected to `moz-extension://…/viewer.html?file=…` and
   the PDF renders in our viewer, not Firefox's built-in reader.
4. Open a **`file://` PDF** (drag a local `.pdf` into a tab, or `file:///C:/…/x.pdf`).
   → *Expected (best-effort):* redirects into the viewer. If it opens in Firefox's
   built-in reader instead, that's the documented `file://` limitation — record the
   Firefox version.
5. **Annotate + save:** draw a highlight / note, then Ctrl+S (Save) and Save As. →
   *Expected:* for a PDF opened via the in-app **Open** picker, save writes silently
   over the file; for a URL/`file://` PDF, one Save-location dialog appears, then the
   annotated PDF is written. Reopen it → annotations persist.
6. **Settings persistence:** change theme (day/sepia/night) and language, close the
   tab, open another PDF. → *Expected:* the new tab uses the saved theme/language
   (proves `browser.storage.local` via the `ext` alias works — this is the call that
   would break on Firefox without the alias).
7. **Toolbar-icon click:** click the PDF Scholar toolbar icon with no PDF open. →
   *Expected:* a new tab opens the viewer welcome screen.
8. **AI settings** (optional): open KI settings, paste a provider key, save, reload →
   the key is remembered and a test chat streams a reply.

**Firefox for Android**

9. Install the **AMO-signed** XPI (or load via `about:debugging` from a connected
   desktop against Firefox Nightly/Debug on the device).
10. Repeat steps 3, 5, 6, 7 on the phone/tablet. → *Expected:* http(s) PDF opens in
    the viewer; annotate + save works (save uses the Android download/save flow);
    theme/language persist; tapping the add-on menu entry opens the viewer.
    (`file://` interception is not expected on Android — out of scope.)

## Parity matrix (as of this foundation)

| Capability | Native app | Extension | Notes |
|---|---|---|---|
| Render / navigate / zoom / search | ✅ | ✅ | Shared renderer, verified mounting in the extension bundle |
| Tab system | in-app TabBar | **browser tabs** | The intended adaptation — one PDF = one tab |
| Open from File Explorer | ✅ | ✅¹ | ¹ needs "Allow access to file URLs" + default-app setting |
| Themes / recoloring / i18n | ✅ | ✅ | Shared |
| Reading position / recents / settings | JSON store | `chrome.storage.local` | Parity, different backend |
| Annotation UI (draw, notes, shapes) | ✅ | ✅ | Overlay is renderer-side |
| **Persist annotations to disk** | ✅ | ✅¹ | ¹ real EmbedPDF pdfium writes in-page (`annotation-engine-browser.ts`); files opened via the in-app picker save silently over the original, URL/`file://` PDFs prompt once for a location — see roadmap for silent-overwrite full parity |
| AI chat / grounded citations | ✅ live | ✅ live¹ | ¹ real Anthropic/OpenAI/Azure, BYO key in `chrome.storage.local` (not encrypted — see roadmap); shares the provider core `src/shared/ai-chat.ts` |
| New window / side-by-side | native window | `chrome.tabs.create` | Adapted |
| Print | ✅ | ✅ | Browser print |

## Roadmap — the remaining gaps

The remaining gaps share one root cause: the browser sandbox withholds
privileged operations (silent disk writes to arbitrary paths, secret keys at
rest) that the Electron **main process** performs freely today.

### 1. Annotation write-back — DONE (in-page engine), two refinements left
Annotation writes are live: the viewer page runs the same EmbedPDF pdfium WASM
engine as the desktop (`src/renderer/src/annotation-engine-browser.ts`), baking
annotations into an in-memory twin of the document via the shared
`src/shared/annotation-build.ts`, so both platforms produce identical bytes.
Persistence:

- **In-app "Open" (File System Access handle)**: `showOpenFilePicker` yields a
  writable handle → silent save over the original for the rest of the session
  (`extension-api.ts`: `handles` map, `saveDocumentBytes`).
- **URL / file:// double-click**: no automatic writable handle. First save shows
  one `showSaveFilePicker` dialog (pre-filled name); plain download as fallback.

Refinements for full parity:

- **Native messaging host**: a tiny companion binary the extension talks to via
  `chrome.runtime.connectNative`, with real filesystem access. This restores
  silent overwrite of any path — nearly the same privileged layer the Electron
  main process already is.
- **Huge files**: the in-page engine refuses documents over `WASM_SAFE_LIMIT`
  (300 MB — the wasm32 heap makes serialization impossible beyond that). The
  desktop routes these to its incremental appender; porting the appender to the
  browser closes this.

### 2. Live AI — DONE (first step), one gap left
Real Anthropic/OpenAI/Azure chat now runs directly from the viewer page
(`src/renderer/src/extension-ai.ts`), sharing the provider core with the
Electron app (`src/shared/ai-chat.ts` → `runProviderChat`). The CORS problem is
moot inside an extension: the manifest `host_permissions` let the page fetch the
provider origins directly, and the Anthropic SDK runs with
`dangerouslyAllowBrowser`.

The remaining gap is **key-at-rest safety**: keys sit in `chrome.storage.local`,
which is isolated per-extension but not encrypted (the UI surfaces this via
`encryptionAvailable:false`). The Electron app encrypts keys with the OS
keychain. Full parity routes AI through the **same native messaging host** as
the annotation write-back above, which would own the encrypted keys and make the
calls — mirroring how keys never leave the Electron main process today.

## Why DNR on Chromium but webRequest on Firefox

Both engines *nominally* support both APIs, but each has a decisive constraint:

- **Chrome MV3 removed blocking `webRequest`** for normal (non-policy) installs —
  a "load unpacked" install that registers a blocking listener errors out
  (`webRequestBlocking is only supported in manifest v2`). So Chromium **must** use
  declarativeNetRequest, which handles the main_frame→extension-page redirect
  cleanly.
- **Firefox `declarativeNetRequest` supports `regexSubstitution`**, but redirecting
  a **main_frame to an extension page** via DNR is an under-specified, historically
  flaky area on Firefox (tracked in w3c/webextensions#610), whereas Firefox
  **keeps** blocking `webRequest` in MV3 and the webRequest→`moz-extension`
  redirect is the long-proven path (pdf.js viewer, JSON viewers). So Firefox uses
  webRequest.

This is a deliberate, documented divergence (see `PLATFORMS.md`). Both paths hit
the same `viewer.html?file=` entry point, so everything downstream is identical.

## Known limitations / watch-list

- The `file://` takeover fights the browser's built-in PDF viewer; this is the
  part most sensitive to browser version. Established viewer extensions
  (pdf.js's own) prove it works, but re-verify on major Edge/Chrome updates.
- **Firefox `file://`**: no per-extension file-URL toggle exists, and blocking
  webRequest on `file://` navigations is not guaranteed — treat local-file
  takeover on Firefox as best-effort and re-verify per Firefox version. http(s)
  is the reliable path.
- MV3 background is a **service worker on Chromium** but an **event page on
  Firefox** (Firefox does not implement extension service workers as of 2026).
  Both are short-lived — keep the background worker to redirect registration
  only, never hold state there. The redirect (DNR rule / webRequest listener) is
  re-asserted on every startup for exactly this reason.
- Extension-page CSP is `script-src 'self' 'wasm-unsafe-eval'` (wasm for pdfium);
  the build disables the module-preload polyfill so no inline script is emitted.
  Firefox accepts this MV3 CSP and the MV3 `web_accessible_resources` shape.

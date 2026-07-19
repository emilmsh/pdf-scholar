# Browser-extension target

A parallel packaging of PDF Scholar as a Chromium (Edge/Chrome) **WebExtension**,
developed in tandem with the native Electron app. The goal: the same reader and
annotator, but integrated into the browser's own tab system — open a PDF and it
becomes a normal browser tab, exactly like Edge's built-in viewer, only with our
features on top. Set the extension's browser as the default PDF app and
double-clicking a PDF in File Explorer opens it in PDF Scholar instead of the
built-in reader.

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
| `src/extension/manifest.json` | MV3 manifest |
| `src/extension/background.ts`  | Service worker: registers the PDF→viewer redirect rule |
| `src/extension/viewer.html`    | The extension page each PDF tab loads |
| `src/renderer/src/extension-main.tsx` | React entry for the viewer page |
| `src/renderer/src/ExtensionApp.tsx`   | Single-document shell (no in-app TabBar) |
| `src/renderer/src/extension-api.ts`   | `PdfxApi` over `chrome.*` + File System Access |
| `src/renderer/src/chrome.d.ts`        | Minimal ambient `chrome.*` types (no new dep) |
| `vite.extension.config.ts`     | Builds `dist-extension/` |
| `tsconfig.extension.json`      | Typecheck for the background worker |

`ExtensionApp` mirrors the chrome around the viewer in `App.tsx` (theme
resolution, settings, fullscreen, language). Once the tab-mode work in `App.tsx`
lands, the shared parts are the natural thing to extract into a common
`<AppShell>` so the two shells converge instead of drifting.

## How PDF interception works

`background.ts` registers a dynamic `declarativeNetRequest` rule that redirects
any main-frame navigation to a `*.pdf` URL to
`chrome-extension://<id>/viewer.html?file=<original-url>`. The rule is dynamic
because the redirect target embeds the extension's own origin, only known at
runtime via `chrome.runtime.getURL`; `regexSubstitution` folds the matched URL
in as the `?file=` param. `extension-api.ts:getPendingPath` reads that param and
the shell opens the document — the same "pending path" pattern the Electron app
uses for a freshly spawned window.

- **http(s) PDFs**: covered by `host_permissions`.
- **file:// PDFs** (the File Explorer double-click case): additionally require
  the user to enable **"Allow access to file URLs"** on the extension's details
  page. This is a one-time manual toggle Chromium reserves for the user; an
  extension cannot grant it to itself.

## Build & load

```
npm run build:ext      # → dist-extension/
npm run dev:ext        # rebuild on change (vite build --watch)
```

Then in `edge://extensions` (or `chrome://extensions`):

1. Enable **Developer mode**.
2. **Load unpacked** → select `dist-extension/`.
3. Open the extension's **Details** → enable **Allow access to file URLs** (for
   local PDFs).
4. To make double-click work: Windows **Settings → Apps → Default apps →** set
   `.pdf` to the extension's browser.

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

## Known limitations / watch-list

- The `file://` takeover fights the browser's built-in PDF viewer; this is the
  part most sensitive to browser version. Established viewer extensions
  (pdf.js's own) prove it works, but re-verify on major Edge/Chrome updates.
- MV3 service workers are short-lived — keep the background worker to rule
  registration only; never hold state there.
- Extension-page CSP is `script-src 'self'`; the build disables the
  module-preload polyfill so no inline script is emitted.

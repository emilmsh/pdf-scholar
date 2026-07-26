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
| `config/vite.extension.config.ts`     | Builds `dist-extension/` |
| `config/tsconfig.extension.json`      | Typecheck for the background worker |

`ExtensionApp` mirrors the chrome around the viewer in `App.tsx` (theme
resolution, settings, fullscreen, language). Once the tab-mode work in `App.tsx`
lands, the shared parts are the natural thing to extract into a common
`<AppShell>` so the two shells converge instead of drifting.

## How PDF interception works

`background.ts` registers dynamic `declarativeNetRequest` rules that redirect a
main-frame PDF navigation to
`chrome-extension://<id>/viewer.html?rawfile=<original-url>`. The rules are
dynamic because the redirect target embeds the extension's own origin, only known
at runtime via `chrome.runtime.getURL`; `regexSubstitution` folds the matched URL
in as the `?rawfile=` param. `extension-api.ts:getPendingPath` reads that param
and the shell opens the document — the same "pending path" pattern the Electron
app uses for a freshly spawned window.

A PDF announces itself in two different ways, and covering only the first leaves
half the web with the browser's own reader:

| | Rule 1 | Rule 2 |
|---|---|---|
| Matches on | URL ends in `.pdf` | response `content-type: application/pdf` |
| Decided | before the request is sent | when the response headers arrive |
| Covers | most direct links, `file://` | arXiv `/pdf/2401.12345`, SSRN `Delivery.cfm`, DOI resolvers, Drive, `?download=1` endpoints |
| Needs | — | Chrome/Edge 128+ (`responseHeaders` conditions) |

Rule 2 is registered in its own `updateDynamicRules` call and its failure is
swallowed: an older browser rejects the condition outright, and rule 1 must not
go down with it. Chrome evaluates it on the headers and then abandons the body,
so the document is not downloaded twice — but the request *has* reached the
server, which is why rule 2's scope is narrow:

- **GET only.** A PDF that is the answer to a POST cannot be re-fetched by the
  viewer (the body is gone), and the browser's reader renders it fine.
- **Not `Content-Disposition: attachment`.** That response is a download; saving
  it to disk is what the user asked for by clicking the link. It also stays
  openable in our reader afterwards — that is the File Explorer path.
- **`main_frame` only.** A PDF embedded in a page stays with the browser's
  plugin viewer; taking those over is a separate, much larger feature.
- A **single-use signed URL** can be spent by the time the viewer re-fetches it.
  That lands in the escape hatch below.

**Why `rawfile` and not `file`:** `regexSubstitution` cannot percent-encode, so
the document URL lands in the page URL *verbatim*. Read back with
`URLSearchParams` that is silently wrong — the `&` in
`report.pdf?utm_source=chatgpt.com&utm_medium=app` (or in any signed CDN link)
starts a new param and everything after it is lost, and `+` decodes to a space.
The distinct param name marks the value as "verbatim, to the end of the URL";
links the app builds itself stay on the encoded `?file=`. Both forms are parsed
by `src/shared/viewer-url.ts`, gated by `npm run test:viewer-url`.

### Getting the bytes: the second fetch

The redirect discards the browser's own request, so the viewer page fetches the
URL again — and that fetch is *not* the navigation the site expected. It is
cross-site, so it carries no cookies, and anything behind a session, a paywall or
a bot check answers 401/403, or 200 with a sign-in page. `readFile` therefore
makes up to two attempts: the plain one, then a retry with
`credentials: 'include'` — the cookies the built-in viewer would have sent. A
body that is markup rather than a PDF is named as such (`doc.notPdf`) instead of
surfacing later as a pdf.js parse error, and the server's own
`Content-Disposition` name wins over anything the URL can suggest, so an arXiv
link is `2401.12345.pdf` and not a bare number in the library.

**The escape hatch.** When even that fails, the error banner offers **"Åpne i
nettleserens leser"**: a session-scoped `allow` rule at a higher priority than
both redirect rules — Chrome re-applies matching `allow` rules in the response
phase too — steps them aside for that tab, and the tab navigates to the URL so
the built-in reader takes it. Tab-scoped, not URL-scoped, on purpose: an anchored
per-URL rule misses the case this exists for, where the host answers with a
redirect of its own and rule 2 then grabs the *next* URL and drops the user back
into the error they were escaping. The cost is that this one tab prefers the
built-in reader for the rest of the session; a new tab gets our viewer back. A URL
the browser can open is never a dead end.

**What is still out of reach**, and why it has to be the escape hatch rather than
a fix: MV3 has no `filterResponseData`, so the extension can never read the bytes
the browser already downloaded — every path ends in "fetch it again". That leaves
PDFs delivered as the answer to a POST, single-use signed links, and hosts that
reject the request for a reason we cannot reproduce (hotlink protection wants a
`Referer` that `fetch` may not set from an extension page; a dNR `modifyHeaders`
rule on our own request is the untested next lever).

### Per-scheme notes

- **http(s) PDFs**: covered by `host_permissions`.
- **file:// PDFs** (the File Explorer double-click case): additionally require
  the user to enable **"Allow access to file URLs"** on the extension's details
  page. This is a one-time manual toggle Chromium reserves for the user; an
  extension cannot grant it to itself. Rule 2 is http(s)-only, so a local PDF
  without a `.pdf` name stays with the browser.

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

**Key-at-rest safety** is a genuine divergence, not a gap that was left open.
Keys are encrypted with AES-GCM under a non-extractable WebCrypto key held in
IndexedDB (`src/renderer/src/extension-key-crypto.ts`) before they go into
`chrome.storage.local`; the UI reports this as `KeyStorageMode`
`'browser-nonextractable'` and states its limits verbatim. Be precise about those
limits: it defeats anything that merely READS the browser profile, but not code
running inside that profile — which can ask the browser to decrypt exactly as we
do — and Chrome makes no promise the AES key material is itself encrypted where
it is stored. An extension has no path to an OS key store, so this is the ceiling
here.

Full parity with the desktop's DPAPI/Keychain would route AI through the **same
native messaging host** as the annotation write-back above, which would own the
keys and make the calls — mirroring how keys never leave the Electron main
process today.

## Known limitations / watch-list

- The `file://` takeover fights the browser's built-in PDF viewer; this is the
  part most sensitive to browser version. Established viewer extensions
  (pdf.js's own) prove it works, but re-verify on major Edge/Chrome updates.
- MV3 service workers are short-lived — keep the background worker to rule
  registration only; never hold state there.
- Extension-page CSP is `script-src 'self'`; the build disables the
  module-preload polyfill so no inline script is emitted.

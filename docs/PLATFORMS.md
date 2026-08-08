# Platform support & parity contract

PDF Scholar targets **desktop + the browser extension**. Mobile/tablet is out of
scope for now. The reference platform is **Windows x64** — every other target is
measured against it. This file is the contract: which platforms we ship, what
"parity" means per tier, and the complete list of allowed divergences. If a
difference between platforms is not listed here, it is a bug.

Constraint behind several decisions below: **zero recurring distribution costs**
(decided 2026-07-19). No Apple Developer Program ($99/yr) — macOS ships unsigned.
One-time fees (Microsoft Partner Center, Chrome Web Store) are acceptable.

## Tier matrix

| Platform | Tier | Artifact | Auto-update |
| --- | --- | --- | --- |
| Windows x64 | 1 | `PDF-Scholar-Setup-<v>.exe` (universal NSIS) | electron-updater |
| Windows arm64 | 1 | same universal installer (arch picked at install) | electron-updater |
| Microsoft Store (x64 + arm64) | 1 | `PDF-Scholar-<v>-x64.appx` + `-arm64.appx` (MSIX, signed by the Store on ingestion) | the Store; electron-updater self-disables via `process.windowsStore` (`src/main/updater.ts`) |
| Extension (Edge/Chrome) | 1 | `pdf-scholar-extension.zip` | store auto-update; sideload = in-app notice |
| macOS 11+ (arm64 + x64) | 2 | `PDF-Scholar-<v>-arm64.dmg` / `-x64.dmg` — **unsigned** | detect-only: in-app notice with the `brew upgrade` command (see below); no self-install |
| Linux x64 | 2 | `PDF-Scholar-<v>.AppImage` + `.deb` | electron-updater |

The Microsoft Store is a live release channel, not a plan: the same Windows build
ships there as MSIX, which removes the SmartScreen "unknown publisher" warning the
GitHub exe cannot escape. Build it with `npm run dist:store`; publishing is
`docs/STORE.md` and step 4 of `docs/RELEASE.md`.

Deferred (revisit deliberately, don't drift into them): Linux arm64 (free GitHub
arm runners exist when wanted), Firefox port of the extension (≈days of work,
unlocks Firefox for Android too), PWA/iPad/Android.

**Tier 1** — full feature parity, manually verified, release-blocking.
**Tier 2** — same renderer and features *by construction* (shared code, `PdfxApi`
abstraction), built and packaged in CI on every push, but not manually verified
per release (no owner hardware — macOS has had hands-on testing on a tester's
Apple machine as of v0.34.0; Linux has not run on real hardware). User-reported
regressions are treated as bugs, not as acceptable platform lag.

## Allowed divergences (the complete list)

1. **macOS is unsigned and un-notarized** (zero-cost decision): Gatekeeper shows
   the "damaged / unverified developer" flow on first launch; README documents
   the workaround (copy to Applications, then `xattr -cr` — the "damaged"
   variant never offers System Settings → Open Anyway). Consequence:
   **no auto-INSTALL on macOS** — Squirrel.Mac validates the update against the
   running app's designated requirement, and an ad-hoc signature's DR is
   cdhash-based, so it changes every build and can never match. (There is no
   free way around this: a free Apple account issues Development certificates,
   not the Developer ID that distribution outside the App Store requires.)
   **Detection is not affected** — it is an HTTPS GET against the releases API,
   no signature involved — so the mac build DOES check on the same cadence as
   the others (`initManualUpdates` in `src/main/updater.ts`) and shows a notice
   carrying the way out: the `brew upgrade` command with a copy button when the
   app was installed from the cask (a `Caskroom/pdf-scholar` directory exists),
   a "download" button to the releases page otherwise. The **Homebrew tap**
   ([`emilmsh/homebrew-tap`](https://github.com/emilmsh/homebrew-tap),
   auto-bumped by `.github/workflows/update-tap.yml` when a release is
   published — needs the `TAP_GITHUB_TOKEN` secret) is the recommended
   install: `brew upgrade` stands in for auto-update. It does NOT ease the
   Gatekeeper step — Homebrew ≥ 5 removed `--no-quarantine`, so the `xattr`
   command recurs after every install/upgrade (the cask's caveats print it).
2. **Window chrome**: Windows/Linux use the native window-controls overlay
   (right side, theme-colored via `setTitleBarOverlay`); macOS has traffic
   lights (left, colors fixed — the `window:titlebar-colors` IPC is a no-op
   there by design). The tab strip insets itself via `env(titlebar-area-*)` on
   all platforms.
3. **Keyboard**: Cmd replaces Ctrl on macOS for shortcuts
   (`src/renderer/src/platform.ts` → `primaryMod`). Two deliberate exceptions:
   Ctrl+Tab cycles tabs on every platform (Cmd+Tab is the macOS app switcher),
   and ctrl+wheel zoom tests `ctrlKey` everywhere (trackpad pinch arrives as
   ctrl+wheel, also on macOS).
4. **File open plumbing**: Windows/Linux get paths via argv + `second-instance`;
   macOS via `app.on('open-file')`. Same renderer behavior (`open-path` event).
5. **Windows-only cosmetics**: taskbar Jump List. Nothing else — and one thing
   that briefly was: v0.36.0 shipped a **«Velg standardapp for PDF-filer»**
   settings entry that deep-linked to `ms-settings:defaultapps`, and it was
   removed the same day (Emil, 2026-08-08). Which app opens a PDF is the user's
   business; the installer's «Åpne med» association is as far as we go. Do not
   reintroduce it in any form — the divergence it would create is not worth
   having on any platform, and `shell:open-external` stays restricted to
   http(s).
   macOS-only: Dock + app menu, app stays alive on window-all-closed.
6. **Linux packaging reality**: the AppImage gets no menu entry / PDF
   association without AppImageLauncher, and Ubuntu 24.04+'s AppArmor default
   blocks the Chromium sandbox inside AppImages — the **deb is the recommended
   install on Ubuntu/Debian** and README says so. AI-key encryption
   (`safeStorage`) needs a keyring daemon (gnome-keyring/kwallet); without one the
   app keeps the key in memory for that session and writes nothing to disk
   (`src/main/ai.ts`, `KeyStorageMode` = `session-only`), because with no key
   store there is nowhere safe to keep a key-encryption key either. The user
   re-enters it each launch and the settings panel says why. Versions before
   2026-07-26 wrote `plain:<base64>` instead; `migrateLegacyPlaintextKeys()`
   clears that on first launch.
7. **Extension in-place save needs one write-access grant for read-only-opened
   PDFs**: the extension DOES save annotations back to the current file in place
   (desktop parity — `Toolbar.tsx` shows the same «Lagre» + «Lagre kopi» split,
   `canSaveInPlace = isElectron || isExtension`). When the file was opened via
   the app's picker it already holds a writable File System Access handle and
   saves silently from the first click. When it was opened by navigating to a
   `file://`/URL PDF (fetched read-only, no handle), the browser's security
   model forbids silent writes to a local file, so the FIRST save opens a Save
   picker to grant write access. That handle is retained for the session AND
   persisted across sessions in IndexedDB (`extension-fs-grants.ts`, keyed by the
   file URL — chrome.storage's JSON store can't hold a FileSystemHandle), so the
   same file is granted AT MOST ONCE EVER: a later session pre-warms the handle
   on open (`docOpened`, silent `queryPermission`) and saves silently, or asks
   once to resume permission on the Save click. Grants are deliberately
   **per-file, not folder-wide** — the extension never requests broader access
   than the user reached for (keeps the store-review permission story simple). A
   stale handle (file moved/deleted) is dropped so the next save re-grants. Edge's
   built-in viewer skips even the one grant only because it is privileged
   first-party browser code, not sandboxed web content. The plain-web dev
   fallback (`dev:web`, no `chrome.runtime`) has no writable path at all and keeps
   the single download-export button. See `docs/BROWSER-EXTENSION.md`. (Standing
   rule: extension and desktop otherwise stay at feature parity.)
8. **Extension update mechanism**: store installs auto-update (that is the whole
   point of publishing — see `docs/STORE.md`); Chromium gives sideloaded
   ("Load unpacked") installs NO update channel, so those get a once-a-day
   GitHub-release check + dismissible notice
   (`src/renderer/src/extension-update.ts`), gated on
   `chrome.management.getSelf().installType === 'development'`.
9. **«Save a copy» adopts the copy on desktop only**: after the save dialog,
   the tab switches to the new file (same reading position) and the original's
   draft is discarded — work continues in the copy. The browser/extension
   cannot reopen a file it just downloaded (no readable path back from a
   download, and the FS Access picker handle is not a recents-addressable
   file), so there it stays a plain export with a «Kopi lagret» toast.
   **Ctrl+S with nothing to save** splits by document SOURCE, not by platform
   (`isRemoteSource` in `PdfViewer.tsx`): an unchanged local file — desktop
   path, `file://` double-click, or picked `fsa:` file — does nothing, exactly
   like the desktop app, because the bytes on disk already match the screen. An
   unchanged http(s) PDF has no local copy at all, so there the extension routes
   the key to save-a-copy (same picker, download as fallback): the app swallows
   the browser's own Ctrl+S (which would offer to save the viewer PAGE), and
   Edge's built-in viewer downloads the PDF on that key, so leaving it inert
   would read as broken.
10. **Document button (browser/extension only)**: the single-tab extension shell
    has no tab bar, so the file's identity (name + source path) and the
    "open another file" action have no home. A left-most toolbar button
    (`Toolbar.tsx`, gated on the `onOpenFile` prop, which only `ExtensionApp`
    passes) surfaces both: it shows the open file's name, reveals the full path
    on click (`prettyPath` renders a `file://` URL as `C:\…`, a picked file as
    just its name, an http(s) URL decoded) with copy-to-clipboard, and opens
    another file. Desktop leaves `onOpenFile` undefined — the tab bar already
    carries the file name (+ path tooltip, «Vis i mappe»), so the button never
    appears there. Rationale: an `extension://…/viewer.html?file=…` page cannot
    make the browser address bar show a clean path, so the app must.
11. **Cross-WINDOW annotation sync is Electron-only.** Two desktop windows on the
    same file write into the ONE draft main keeps per path, so a save from either
    window writes every mark exactly once; main broadcasts
    `annots:changed-elsewhere` to the other windows holding that path (tracked in
    `openDocs`) and they re-read the draft — the file, not a replayed patch, is
    the source of truth, so the two views cannot drift. The browser/extension has
    no equivalent: a second browser tab holds its own in-memory copy of the
    document with no shared draft to re-read, so
    `onAnnotationsChangedElsewhere` is a no-op there (`bridge.ts`), as is its
    counterpart `onDraftEndedElsewhere` (which clears the other windows'
    unsaved-changes flag when one of them saves or discards the shared draft).
    The SPLIT VIEW (two columns in one window) is renderer-only and therefore
    identical on every platform — both columns share one annotation map in one
    component tree, with no IPC involved. `npm run test:windows` covers the
    Electron behaviour end to end (two real windows, verified with mupdf).
12. **API-key protection is per-platform, because the platforms genuinely differ.**
    `KeyStorageMode` (`src/shared/types.ts`) names each case and the settings panel
    states the active one verbatim; do NOT collapse this back into a boolean or
    write copy that promises "encrypted" generically. Desktop with a key store →
    `os-keystore` (DPAPI/Keychain/Secret Service). Desktop without one →
    `session-only`, in memory, nothing on disk. Extension → `browser-nonextractable`:
    AES-GCM under a non-extractable WebCrypto key in IndexedDB
    (`src/renderer/src/extension-key-crypto.ts`), which defeats reading the profile
    but not code running inside it. An extension cannot reach an OS key store at
    all; full parity would need a native-messaging host. If a new platform is added,
    it must map to one of these modes and say so — a platform whose protection is
    not describable here does not ship the AI features.
13. **The live AI model catalog is parity-identical by construction.** Fetch,
    TTL and merge logic live once in `src/shared/ai-model-catalog.ts` (same rule
    as the chat core); only the cache location differs — desktop persists it in
    `pdfx-state.json` (main process, `ai:refresh-models` IPC), the extension in
    `chrome.storage.local` (`extension-ai.ts`). The plain-web preview is
    keyless/mock-only, so it has no catalog to fetch (`aiRefreshModels` no-ops).
    Curated-list maintenance is platform-neutral: `docs/MODEL-UPDATE.md`.
14. **The compat family (the five hosted services + custom/local endpoints)
    has FULL parity on the extension — a correction.** An earlier version of
    this point claimed user-typed endpoints were CORS-dependent there; that
    was wrong: the manifest already carries `host_permissions` for
    `http://*/*` + `https://*/*` (required for the PDF-viewer takeover), and
    host permissions exempt extension-page fetches from CORS for every host —
    typed-in ones included. The one residual seam is server-side: a server
    that itself rejects foreign `Origin` headers (Ollama honors
    `OLLAMA_ORIGINS`, but its defaults allow extension origins; LM Studio has
    a CORS toggle for browser use). Such a rejection surfaces as the named
    `ai-endpoint-unreachable` error, never something cryptic.

15. **Password-protected documents open, and annotate, on every platform — with
    two named exceptions.** The unlock prompt lives in the renderer (pdf.js is
    what refuses the bytes), so all three targets share it. Where they differ is
    only in where the password is then kept: desktop hands it to main over
    `doc:unlock` because the write engine opens the draft there
    (`src/main/doc-passwords.ts`, memory only, dropped when the draft is
    discarded); the browser and extension keep it beside the bytes in
    `annotation-engine-browser.ts`, since their engine is already in the
    renderer. Nothing is ever persisted, on any platform — re-opening a locked
    document asks again. The two exceptions, both platform-independent:
    **printing** a locked document (`pdf-print-encrypted`) — Electron prints
    through Chromium's own PDF plugin in a hidden window and there is no way to
    hand it a password, so it says so instead of hanging; and **annotating a
    locked document over 150 MB** (`append-encrypted`) — that size routes to the
    incremental appender, which writes object bytes with plain Node and has no
    cipher. Reading a locked file of any size works everywhere. Covered by
    `npm run test:password` on all three OSes.

16. **Signature stamps work everywhere; over 150 MB they do not.** The saved
    signature lives in the renderer (`src/renderer/src/signatures.ts`,
    localStorage, same as the tool preferences), so all three targets behave
    identically — including the pad, which accepts mouse, pen and finger. The
    one divergence is by document SIZE, not platform: above 150 MB writes route
    to the incremental appender, which builds annotation dictionaries by hand
    and has no image encoder, so a stamp is refused there with
    `append-no-image` while every other mark still works. Reading a document's
    EXISTING digital signatures is likewise uniform — and uniformly limited: we
    report that signatures are present and what they say about themselves
    (`getSignatures`), and never whether they are valid, which would need a
    PKCS#7 parser and a trust store. The UI says so in words rather than
    implying a check we did not do. Covered by `npm run test:signatures` (CI,
    all three OSes) and `npm run test:signature-stamp` (desktop session).

## Maintenance rules

- **CI is the parity backbone**: `.github/workflows/ci.yml` builds, typechecks,
  engine-tests and packages on windows/macos/ubuntu for every push. A red
  non-Windows job is release-blocking, same as Windows.
- Releases are built by `.github/workflows/release.yml` (tag `v*` → draft
  release with all artifacts). Local `npm run dist` stays Windows-only for dev.
- New keyboard shortcuts must use `primaryMod()` unless the Ctrl-on-mac
  exception applies — then document why at the call site.
- `process.platform` checks live in the main process; the renderer uses
  `src/renderer/src/platform.ts`.
- **No new native Node modules** — pure JS/WASM is what makes free
  cross-platform builds (and the MIT audit) possible.
- Paths: main process uses `node:path`; the renderer treats paths as opaque
  strings (never split on `\` or `/`).
- Fonts: every `font-family` stack must end in a generic family and not assume
  Windows fonts exist (Segoe → `system-ui`, Consolas → `monospace`, …).
- Dev scripts may be Windows-only (e.g. `scripts/pack-extension.mjs`); anything
  CI or users depend on must be portable.
- Review-time check: run the `platform-parity` skill over a diff that touches
  keyboard handling, window chrome, paths, packaging or dependencies.

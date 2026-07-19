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
| Extension (Edge/Chrome) | 1 | `pdf-scholar-extension.zip` | store auto-update; sideload = in-app notice |
| Extension (Firefox desktop + Android) | 2 | AMO-signed `.xpi` (`dist-extension-firefox/`) | AMO auto-update; sideload = in-app notice |
| macOS 11+ (arm64 + x64) | 2 | `PDF-Scholar-<v>-arm64.dmg` / `-x64.dmg` — **unsigned** | none (see below) |
| Linux x64 | 2 | `PDF-Scholar-<v>.AppImage` + `.deb` | electron-updater |

Deferred (revisit deliberately, don't drift into them): Linux arm64 (free GitHub
arm runners exist when wanted), Microsoft Store MSIX (`docs/STORE.md`),
PWA/iPad/Android.

The **Firefox port of the extension** (once deferred) has landed — the same
codebase builds a Firefox flavour (`npm run build:ext:firefox` →
`dist-extension-firefox/`), which is also the Firefox for Android artifact. It is
Tier 2: built from shared code, but held to the Chromium extension's parity and
manually spot-checked, not release-blocked on owner hardware. Distribution needs a
free AMO signature (mandatory for Firefox); see `docs/BROWSER-EXTENSION.md`.

**Tier 1** — full feature parity, manually verified, release-blocking.
**Tier 2** — same renderer and features *by construction* (shared code, `PdfxApi`
abstraction), built and packaged in CI on every push, but not manually verified
per release (no owner hardware). User-reported regressions are treated as bugs,
not as acceptable platform lag.

## Allowed divergences (the complete list)

1. **macOS is unsigned and un-notarized** (zero-cost decision): Gatekeeper shows
   the "damaged / unverified developer" flow on first launch; README documents
   the workaround (System Settings → open anyway, or `xattr -cr`). Consequence:
   **no auto-update on macOS** — Squirrel.Mac refuses unsigned apps. Users
   update by downloading the new dmg.
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
5. **Windows-only cosmetics**: taskbar Jump List. macOS-only: Dock + app menu,
   app stays alive on window-all-closed.
6. **Linux packaging reality**: the AppImage gets no menu entry / PDF
   association without AppImageLauncher, and Ubuntu 24.04+'s AppArmor default
   blocks the Chromium sandbox inside AppImages — the **deb is the recommended
   install on Ubuntu/Debian** and README says so. AI-key encryption
   (`safeStorage`) needs a keyring daemon (gnome-keyring/kwallet); without one
   the app already degrades to "key not set" rather than storing plaintext.
7. **Extension vs desktop**: see `docs/BROWSER-EXTENSION.md` — URL PDFs and the
   File System Access save path replace local-file in-place save. (Standing
   rule: extension and desktop otherwise stay at feature parity.)
8. **Extension update mechanism**: store installs auto-update (that is the whole
   point of publishing — see `docs/STORE.md`); Chromium gives sideloaded
   ("Load unpacked") installs NO update channel, so those get a once-a-day
   GitHub-release check + dismissible notice
   (`src/renderer/src/extension-update.ts`), gated on
   `management.getSelf().installType === 'development'` (via the `ext` alias, so it
   also fires for Firefox `about:debugging` temporary installs).
9. **Extension redirect engine (Chromium vs Firefox)**: Chromium redirects PDF
   navigations with **declarativeNetRequest** (Chrome MV3 removed blocking
   webRequest for normal installs); Firefox uses **blocking webRequest**
   (`webRequest.onBeforeRequest` → `{redirectUrl}`) because main_frame→extension
   redirect via DNR is unreliable on Firefox while blocking webRequest is fully
   supported there. Chosen at runtime by manifest-driven feature detection in
   `src/extension/background.ts`; both hit the same `viewer.html?file=` entry, so
   nothing downstream diverges. Rationale in `docs/BROWSER-EXTENSION.md`.
10. **Extension background type**: Chromium ships an MV3 **service worker**;
    Firefox ships an MV3 **event page** (`background.scripts`, no extension service
    workers on Firefox as of 2026). Same `background.js` in both bundles.
11. **Firefox `file://` PDFs**: no per-extension "allow file URLs" toggle exists on
    Firefox and blocking webRequest on `file://` navigations is version-dependent, so
    local-file takeover on Firefox is best-effort, not guaranteed. http(s) is the
    fully-supported path. (Chromium's file case is divergence-free once the user
    grants "Allow access to file URLs".)

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

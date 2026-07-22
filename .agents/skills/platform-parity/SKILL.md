---
name: platform-parity
description: Audit the working diff (or a named commit range) for cross-platform pitfalls against the docs/PLATFORMS.md parity contract — Windows x64 is the reference; win-arm64, macOS, Linux and the browser extension must not silently regress. Use before releases, after changes to keyboard handling, window chrome, file paths, packaging, dependencies, or main-process code, and as a review dimension in code review. Trigger phrases; "platform parity", "paritetssjekk", "sjekk plattformene", "virker dette på mac/linux".
---

# Platform parity audit

Audit scope: the uncommitted working diff by default; a commit range or PR if the
user names one. Read `docs/PLATFORMS.md` first — it is the contract; this skill checks
diffs against it.

## Method

1. `git diff` (or the named range) — collect changed files.
2. Skip the audit for diffs that only touch docs, tests, or `scripts/` dev tooling
   (report "not parity-relevant" and stop).
3. Check every finding against the checklist below. For each hit, verify in the
   surrounding code whether it is actually guarded (a `process.platform` branch, a
   `primaryMod()` call, an entry in docs/PLATFORMS.md's allowed-divergence list) before
   reporting it.
4. Report findings with file:line, the platform(s) affected, and a concrete fix.
   No findings → say so explicitly. If a divergence is genuinely platform-forced,
   the fix is to add it to docs/PLATFORMS.md's list, not to hide it.

## Checklist

**Keyboard & input**
- New `e.ctrlKey` shortcut checks in the renderer → must use `primaryMod()` from
  `src/renderer/src/platform.ts`, unless it is the documented Ctrl-on-mac
  exception (Ctrl+Tab tab cycling; ctrl+wheel pinch-zoom). The exception must be
  commented at the call site.
- New `Alt+…` shortcuts: verify they don't collide with macOS dead-key/option
  input for characters the app's text fields need.
- Every new mouse/hover interaction needs a touch equivalent (standing
  touch-parity rule).

**Window chrome & main process**
- `setTitleBarOverlay` / `titleBarOverlay` colors: Windows-only — must stay
  behind the existing guard/try-catch; macOS traffic lights are the divergence.
- New `process.platform === 'win32'` branches: is there a macOS/Linux equivalent,
  or is the omission listed in docs/PLATFORMS.md?
- New Electron APIs: check the docs' platform column — anything marked
  Windows-only or macOS-only needs a guard AND a parity story.
- File-open plumbing: argv/`second-instance` changes need the matching
  `open-file` change for macOS.

**Paths & filesystem**
- Hardcoded `\\` or drive-letter assumptions anywhere; renderer code splitting
  paths on separators (paths are opaque strings in the renderer).
- Case-sensitivity: Linux filesystems are case-sensitive — imports and asset URLs
  must match file casing exactly (Windows dev machines hide this).
- New writes outside `userData`/draft dirs: valid on all platforms?

**Dependencies & packaging**
- New runtime dependency: MUST be pure JS/WASM (no native modules — breaks free
  cross-compilation) and permissively licensed (MIT audit).
- Changes to `electron-builder*.yml`: do win/mac/linux blocks stay consistent
  (icons, fileAssociations, artifact-name contracts in release.yml header)?
- Changes to `scripts/`: dev-only scripts may be Windows-only; anything invoked
  by CI or documented for users must be portable.

**Renderer & styling**
- New `font-family` stacks must end in a generic family and not require
  Windows-only fonts.
- `env(titlebar-area-*)` insets: layout changes to the tab strip must keep
  working when the controls are on the LEFT (macOS traffic lights).
- New `PdfxApi` members: implemented in preload (Electron), `bridge.ts` web
  fallback, AND considered for the extension target — a missing fallback breaks
  `dev:web` and the extension build.

**Extension parity**
- Feature added on desktop only? The standing rule is both-or-documented
  (`docs/BROWSER-EXTENSION.md` + docs/PLATFORMS.md item 7).

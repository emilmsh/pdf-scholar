# Releasing PDF Scholar

The order matters more than the ceremony. Screenshots come first because they are
the only step that cannot be automated and the easiest to forget — and a stale
one is the first thing a visitor sees, and it ships to the Microsoft Store.

## 0. Screenshots — by hand, Emil

**What ships is Emil's call.** Framing, what is on screen, which answer is worth
showing and which page tells the story are judgement calls, so `npm run shoot`
writes to the gitignored `docs/screenshots/_auto/` and cannot touch the shipped
set without `--out`. Review the frames, then copy over the ones that are right.

The run needs no API key: it takes every shot, including the assistant ones,
replaying recorded answers from `docs/ai-fixtures/`. Re-record with
`npm run shoot -- --with-ai --record` when the *answer* should change — a change
to the assistant's UI needs nothing, since only the provider call is replayed.
Every shot is taken with the app in English, seeded into the throwaway profile.

```bash
npm run check:shots
```

Lists every shipped image with the date its **content** first entered history (so
restoring an old file does not make it look freshly shot), and the visual commits
since. Judge which of those changes is actually visible, then re-shoot what needs
it into:

- `docs/screenshots/` — the README set, 2880×1800
- `docs/store-screenshots/` — the store set. 1280×800 is the *Chrome/Edge*
  requirement; the Microsoft Store takes the full-resolution files directly, and
  in fact the live listing already uses the README-sized ones.

The house demo document is "Attention Is All You Need" (arXiv 1706.03762) at
`docs/screenshots/attention.pdf` — gitignored, never committed. Keep it free of
saved annotations, or they turn up as clutter in unrelated shots.

## 1. Checks

```bash
npm run typecheck
npm run test:engine      # annotation engine round-trip, verified with mupdf
npm run test:appender    # incremental appender
npm run build            # needed by the two below
npm run test:windows     # two windows on one file, end to end
npm run test:listing     # the Store copy still parses out of the doc
```

**Also open the browser extension.** `npm run build:ext`, load
`dist-extension/` unpacked, open a PDF and a file from the recents list. Neither
`shoot` nor `test:windows` touches the extension — both drive Electron — and
v0.27.1 shipped a broken recents-open there for exactly that reason.

## 2. Version and tag

Bump `version` in `package.json`, commit as `vX.Y.Z: <one-line summary>` (the
repo's convention: feature/fix commits first, then a version commit), then:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z: <summary>" && git push origin master --follow-tags
```

The tag triggers `.github/workflows/release.yml`: builds Windows, macOS and Linux
plus the extension zips, and creates a **draft** release. Nothing is public yet.

## 3. Publish the draft

Review the draft's assets and notes, then:

```bash
gh release edit vX.Y.Z --draft=false
```

Only now does electron-updater see it. Prune `release/` locally so one current
installer remains.

## 4. Microsoft Store

```bash
gh workflow run store-publish.yml -f check_only=true
```

The dry run creates nothing: it verifies the secrets, prints the copy it would
send, and diffs it against the live listing. Then run it for real (no
`check_only`). It builds the MSIX and pushes description, short description,
product features and release notes per language from
`docs/STORE-LISTING-DESKTOP.md`.

Two consequences: the **"What's new" heading is version-stamped** and the run
fails if it does not match the version being published — update that section. And
**screenshots are not synced**; upload them in Partner Center by hand. Once a
submission is created through the API, never edit it in the Partner Center UI.

## 5. Extension stores

Upload `pdf-scholar-extension-store.zip` (manifest at the zip root) to Edge
Add-ons and the Chrome Web Store. Copy from `docs/STORE-LISTING.md`; the
permission justifications there are written to pre-empt the reviewer. See
`docs/STORE.md`.

# Releasing PDF Scholar

The order matters more than the ceremony. Screenshots come first because they are
the only step that cannot be automated and the easiest to forget — and a stale
one is the first thing a visitor sees, and it ships to the Microsoft Store.

**Two sizes of release.** A **release** — the default meaning of the word when
nothing more is said — is GitHub only: steps 0–3. A **full release** also pushes
the store channels: steps 4–5 (Microsoft Store, then the extension stores). The
distinction exists because the store channels routinely have submissions still
sitting in review, and a new push there while one is pending is at best queued
and at worst a conflict — so the stores are only touched on an explicit "full
release" from Emil. A monthly reminder issue
(`.github/workflows/release-reminder.yml`, the 1st of each month) nudges that
batch so the stores never silently fall a season behind.

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

**Which frame goes where.** Four surfaces draw on the same shoot, and they drift:
a shot has landed with no home, a deleted frame has stayed referenced, and the
store set once fell five weeks behind the README set. The map lives in
`scripts/lib/shots.json` — `npm run shoot:store` reads it to know what to
downscale, and `npm run check:shots` fails on a frame that ships nowhere or a
surface missing one it needs.

| Frame | README | Landing page | Stores |
|---|---|---|---|
| `tricolor` (composed) | ✓ | ✓ | 1 |
| `reading` | hero | hero + `og:image` | — |
| `annotations` | ✓ | ✓ | 2 |
| `assistant` | ✓ | ✓ | 3 |
| `assistant_figure` | ✓ | — | 4 |
| `assistant_snip` | ✓ | — | — |
| `dual-pane` | ✓ | ✓ | 5 |
| `parchment`, `night` | — | — | — (tricolor's sources) |
| `night+`, `annotations_edit`, `reading_tabs` | — | — | — (shot as smoke tests) |

Shoot everything in one run when you re-shoot anything: the frames share a
session, and a set mixed across runs shows the app at two different moments.

`npm run shoot:store` builds that set out of `_auto/`: it downscales the four
frames listed in `docs/STORE-LISTING.md` and composes the fifth, `tricolor.png`
— the cover wiped Day → Sepia → Night, so one slot carries the themes and the
other four can show the app doing something. Both 2880×1800 and 1280×800 are
16:10, so nothing is cropped; a frame with any other aspect is refused rather
than stretched. Output lands in `_auto/store/`. Same rule as `shoot`: reaching
the shipped folder takes an explicit `-- --out docs/store-screenshots`.

The tricolor seam runs straight down through the toolbar (between two icons,
`--at`) and then leans across the page (`--slant`). Both are measured against
the current chrome — if the toolbar changes, re-measure rather than assume.

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
npm run test:annot-edit  # a mark can be corrected: handles reachable AND working
npm run test:listing     # the Store copy still parses out of the doc
```

**Also open the browser extension.** `npm run build:ext`, load
`dist-extension/` unpacked, open a PDF and a file from the recents list. Neither
`shoot` nor `test:windows` touches the extension — both drive Electron — and
v0.27.1 shipped a broken recents-open there for exactly that reason.

## 1b. Copy — `docs/MESSAGING.md` first

If the release changes **what the app is** — a new pillar-level capability, a
platform graduating out of beta, a store listing going live — update
[`docs/MESSAGING.md`](MESSAGING.md) first, then the four surfaces it lists:
`README.md`, `docs/index.html`, `docs/STORE-LISTING-DESKTOP.md` and
`docs/STORE-LISTING.md`. It is the master for every product claim precisely
because a change made in one listing is a change three other places do not know
about.

`npm run test:listing` (step 1) proves the Microsoft Store copy still parses and
fits the field limits. Nothing proves the README and the landing page agree —
that is a read-through, and it is short.

## 2. Version and tag

Bump `version` in `package.json`, then `npm install --package-lock-only` so the
lockfile carries the same version (nothing else re-syncs it, and it had silently
fallen three releases behind by v0.31.3). Commit as `vX.Y.Z: <one-line summary>`
(the repo's convention: feature/fix commits first, then a version commit), then:

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

Publishing also fires `update-tap.yml`, which bumps the Homebrew cask to the
new dmgs (it needs the `TAP_GITHUB_TOKEN` secret and fails loudly without it).
Check that run went green; the tap's own audit workflow then test-installs the
bumped cask on a macOS runner.

## 4. Microsoft Store — full release only

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

## 5. Extension stores — full release only

Upload `pdf-scholar-extension-store.zip` (manifest at the zip root) to Edge
Add-ons and the Chrome Web Store. Copy from `docs/STORE-LISTING.md`; the
permission justifications there are written to pre-empt the reviewer. See
`docs/STORE.md`.

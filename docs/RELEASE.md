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

```bash
npm run build
```

**Build first, every time.** `shoot` drives the app in `out/`, not the sources,
so a stale build photographs a stale app — silently, because every frame still
comes out looking like a screenshot. This is why the step order here is a trap:
`build` lives in step 1, and step 0 needs it too. It has already cost one full
set: on 2026-08-08 the shoot ran against a build from the previous morning, and
the only reason it was caught is that `signature` failed outright — the feature
had not existed when that build was made. Every other frame in that run was
wrong in ways nothing would have flagged.

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
| `tricolor` (composed) | hero | hero + `og:image` | 1 |
| `annotations` | ✓ | ✓ | 2 |
| `search_ai` | ✓ | ✓ | — (carries the search section) |
| `assistant` | ✓ | ✓ | 3 |
| `assistant_figure` | ✓ | — | 4 |
| `assistant_snip` | ✓ | — | — |
| `dual-pane` | ✓ | ✓ | 5 |
| `margin` | ✓ | — | — |
| `reading`, `parchment`, `night` | — | — | — (tricolor's sources) |
| `shortcuts` | ✓ | ✓ | — (its own section after the assistant, never an opening frame) |
| `night+`, `annotations_edit`, `reading_tabs`, `page_only`, `feedback`, `signature`, `search` | — | — | — (shot as smoke tests) |

**Why tricolor opens everything, and why it keeps its toolbar** (Emil, 2026-08-08).
A frame that OPENS a surface has to read as an application, so the opening frame
keeps the toolbar — and tricolor is the app's most recognisable single image, so
it opens all three surfaces, `og:image` included (that is the thumbnail LinkedIn
draws under a shared link). Consequence: `reading` keeps its toolbar too, because
tricolor is composed from it, and `reading` therefore stopped shipping anywhere of
its own.

**And why nothing toolbar-less ships at all** (Emil, 2026-08-09). `page_only` — a
body page at fit-width with the toolbar unpinned — used to be the second frame on
both the README and the landing page. It came out because a picture with no
application in it cannot carry a section: the other frames all show the app doing
something, and this one showed its absence, which next to a browser's built-in
viewer proves nothing. The reading section sits directly under `tricolor` and
carries no picture of its own; the keyboard map has its own small section after
the assistant (2026-08-10). The rule behind its placement stands: a settings
dialog is a thing you go and find, so it must never begin a surface. Do not reach
for an unshipped frame to fill a section either — the ones sitting at `ships: []`
are there because they were judged and rejected, not because nobody got around to
them (`search`, the text mode, lost to `search_ai` on exactly those terms).

Shoot everything in one run when you re-shoot anything: the frames share a
session, and a set mixed across runs shows the app at two different moments.

`npm run shoot:store` builds that set out of `_auto/`: it downscales the four
frames listed in `docs/STORE-LISTING.md` and composes the fifth, `tricolor.png`
— the cover wiped Day → Sepia → Night, so one slot carries the themes and the
other four can show the app doing something. Both 2880×1800 and 1280×800 are
16:10, so nothing is cropped; a frame with any other aspect is refused rather
than stretched. Output lands in `_auto/store/`. Same rule as `shoot`: reaching
the shipped folder takes an explicit `-- --out docs/store-screenshots`.

**Tricolor is composed twice, at two sizes, and each channel's own command makes
its own.** `shoot:store` composes the 1280×800 one for the stores; `shoot`
composes the 2880×1800 one for the README and the landing page, at the end of
any run that shot all three of its sources. Neither is a step you perform.

It used to be one — a `compose-tricolor.cjs --full` you had to remember — which
was survivable while tricolor sat halfway down the page and is not now that it
opens both surfaces. Emil's rule (2026-08-08): if a frame ships to a channel, the
shoot for that channel produces it.

The sources must come from the SAME run. `_auto/` persists, so composing from
whatever is on disk would build a cover out of two different moments of the app —
`shoot` therefore refuses rather than mixing, and says which source it is missing.

The tricolor seam runs straight down through the toolbar (between two icons,
`--at`) and then leans across the page (`--slant`). Both are measured against
the current chrome — if the toolbar changes, re-measure rather than assume.

The house demo document is "Attention Is All You Need" (arXiv 1706.03762) at
`docs/screenshots/attention.pdf` — gitignored, never committed. Keep it free of
saved annotations, or they turn up as clutter in unrelated shots.

Being gitignored, it exists only in the checkout you put it in. `shoot` looks in
this tree, then in the MAIN checkout (so a run from a git worktree finds it),
then at `PDFX_DEMO_PDF`; if none of those has it the run REFUSES rather than
quietly shooting `sample.pdf`, which is how a set of wrong-document frames used
to reach the README. `--sample` shoots it deliberately, for working on the
script itself.

You can work in other windows while it runs — the app is launched with
Chromium's backgrounding switches off, because pdf.js renders inside
requestAnimationFrame and a covered window otherwise stops rendering pages half
way through the run. Two runs at once is the one thing to avoid, and `launchApp`
refuses rather than let them drive each other's windows.

## 1. Checks

```bash
npm run typecheck
npm run test:engine      # annotation engine round-trip, verified with mupdf
npm run test:appender    # incremental appender
npm run build            # needed by the two below
npm run test:windows     # two windows on one file, end to end
npm run test:annot-edit  # a mark can be corrected: handles reachable AND working
npm run test:quick-ai    # the selection bubble: no reasoning leak, the wait is visible
npm run test:listing     # the Store copy still parses out of the doc
```

**And the one that needs your keys** — CI cannot run it, and it is the only
check that asks the providers whether the models we ship still work:

```bash
npm run test:live        # a few øre; uses the keys already in the app
```

Per model it proves the answer arrives, a citation survives into it, a pasted
image is read or refused by name, and the degrade-on-400 net stayed quiet (two
requests for one question = a parameter we send is being refused). Add
`-- --record` when a provider surprises you: the stream lands in the replay
library and CI guards it keylessly from then on. See
[docs/AI-TESTING.md](AI-TESTING.md).

**Also open the browser extension.** `npm run ext:local` — it builds and
mirrors the result into the `dist-extension/` your browser already has loaded
unpacked (see [BROWSER-EXTENSION.md](BROWSER-EXTENSION.md#keeping-the-loaded-folder-current)
for why that path is fixed) — then hit ⟳ on the card in `edge://extensions`,
open a PDF and a file from the recents list. Neither `shoot` nor `test:windows`
touches the extension — both drive Electron — and v0.27.1 shipped a broken
recents-open there for exactly that reason. Running it here also leaves the
sideloaded install on the version you are about to ship.

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

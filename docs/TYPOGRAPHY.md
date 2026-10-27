# Typography: roles, weights and the optional reading font

Design note, written 2026-10-27 before any implementation. Emil wants to be
able to read the app's own text in a face of his choosing (Libertinus Serif,
to begin with) without imposing a font on anyone else, and without the app
carrying large font packages on principle. This file decides three things
first — what the app's typography IS today, which roles a font can fill, and
how a user's choice maps onto them — so the implementation is a mapping, not
a redesign.

---

## 1. What the app does today

Measured in `src/renderer/src/styles/app.css` on 2026-10-27:

| Thing | Today |
|---|---|
| Interface face | `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` on `body` — Segoe on Windows, San Francisco on macOS, whatever the system has on Linux. Nothing shipped. |
| Wordmark | Libertinus Serif Semibold, subset to Latin letters and space (~10 KB, SIL OFL 1.1 beside it in `src/renderer/src/assets/fonts/`). Used by `.welcome-logo` only. |
| Monospace | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (code in answers, a few fields). |
| Emphasis | **600 is the one emphasis weight** — 72 declarations. 700 appears only in the assistant's h3–h5 and table headers, 650 in three rules written for Segoe UI Variable's optical range, `bold` once (the text tool's style toggle). |
| Italic | Four rules, all hints and notices (`.lpa-note`, `.ai-excerpt-hint`, `.ai-msg-withheld`, the text tool's italic toggle). The interface is in practice never italic. |
| Size scale | 9.5–16 px, the bulk at 11–13 px. The assistant's conversation surface has its own user scale (`--ai-scale`, 0.8–1.6 in steps of 0.1, `src/renderer/src/ai-text-scale.ts`), applied to the messages, composer and landing — not the panel's chrome. |
| Text on the pages | The document's own fonts, rendered by pdf.js. The text tool's boxes carry one of the Standard-14 faces and nothing else (see the FreeText gotcha in `CLAUDE.md`). |

So the app already has a typographic vocabulary, and it is a strict one: one
sans, one emphasis weight, no italic in the chrome. The task is to name it,
not to invent one.

## 2. Roles

The CSS gets three font roles, each a custom property on `:root`. A
`font-family` declaration anywhere in the app names a role, never a face —
the only literal face names left in `app.css` are the `@font-face` for the
wordmark and the Standard-14 fallbacks on the page marks.

| Role | Property | Surfaces | User setting |
|---|---|---|---|
| Interface | `--font-ui` | tabs, toolbar, menus, buttons, search bar, dialogs, settings, sidebar headers, the library's chrome | **none** — always the system stack |
| Reading | `--font-reading` | the assistant's messages (`.ai-assistant`, `.ai-quick-body`) and the reader's own (`.ai-user` — since 2026-10-27, Emil: a conversation reads as one surface), comment and note text in the sidebar and popovers, the link preview card's entry text and abstracts (`.lp-card`, `.lpa-text`), conversation snippets in the library's «Samtaler» view | **yes** |
| Mono | `--font-mono` | code blocks in answers, the few monospace fields | none |

Outside the roles, and unchanged: the wordmark (its own `@font-face`), the
text tool's boxes (Standard-14 — a FreeText appearance stream can carry
nothing else, so a reading font can never reach the page), the text tool's
own **A** / *A* toggles (`.font-style`, a Times «A» in bold and italic — they
depict the page mark, so they keep the literal face and the `bold` keyword),
and the page text itself.

**Why the interface is not a setting.** At 11–13 px the chrome has to match
the operating system to read as native, and a book serif in a button reads
as a web page. Obsidian draws the same line with separate «Interface font»
and «Text font» fields; we ship the second field only. Because the roles
exist in CSS from the start, adding an interface field later is one more
setting, not a refactor.

**Why serif vs. sans is not the app's decision.** The default for both roles
stays the system sans, so the shipped look is unchanged bit for bit. A user
who chooses a serif gets it on the reading surfaces, where a serif belongs,
and keeps a sans chrome. The app decides WHERE a chosen face lands, never
WHAT kind of face it is.

## 3. Weights and italic: the contract a face must meet

The reading role asks a face for exactly four cuts:

| Cut | Used for |
|---|---|
| regular | body text |
| italic | markdown `*em*` in answers; titles of works in the citation card; the four hint rules above |
| 600 | markdown `**strong**`; headings in answers (with size); every emphasis the chrome uses |
| 600 italic | the two combined |

Rules that follow:

- **One emphasis weight in the reading role.** The assistant's h3 moves
  from 700 to 600, its h4/h5 and table headers from 650 to 600 (650 existed
  only because Segoe UI Variable interpolates — a chosen face has no such
  axis). After this, no reading surface asks for anything above 600. A face
  without a 600 cut gets the browser's nearest (700) or a synthesised one;
  both are acceptable fallbacks for a face the user picked. Two 700s remain
  in the interface role — the paperclip's attachment counter and the
  toolbar's Zotero badge, 8.5–9.5 px white-on-colour marks that need the
  weight to survive at that size — and that role is the system stack always,
  so no chosen face is ever asked for them.
- **Italic lives in the reading role only.** The interface never sets
  `font-style: italic`; the four existing hint rules are reading text and
  stay.
- **No `bold` keyword, no 700, on a reading surface**, so a face with a
  heavy bold (Libertinus Bold is heavy) is never asked for it.
- The interface role keeps using 400/500/600 of the system stack as today.

## 4. Size: x-height, not pixels

A serif at the same pixel size reads a step smaller than Segoe: Libertinus
Serif's x-height is low. Two scales fighting each other (the app's and a per-
font fudge) is the thing to avoid.

Decision: when a reading face other than the default is active, the reading
surfaces set `font-size-adjust` to the default face's x-height ratio.
Chromium then scales the chosen face so its x-height matches Segoe's at the
same `font-size`, and every pixel value in `app.css` keeps meaning what it
means. `--ai-scale` stays what it is: the user's own size step, now riding on
top of a normalised face. With the default face active no
`font-size-adjust` is set at all, so the shipped rendering is untouched —
the same «1 = exactly as shipped» discipline `theme-tune.ts` uses.

Measured 2026-10-27 in Chromium on Windows (canvas `measureText('x')`
ascent at 100 px, so ±0.01):

| Face | x-height | cap height |
|---|---|---|
| Segoe UI Variable Text (400 and 600) | 0.50 | 0.70 |
| Segoe UI | 0.50 | 0.70 |
| Libertinus Serif | 0.43 | 0.65 |
| Palatino Linotype | 0.46 | 0.69 |
| Cambria | 0.47 | 0.67 |
| Georgia | 0.48 | 0.69 |
| Times New Roman | 0.45 | 0.67 |
| Calibri | 0.46 | 0.63 |

So the value is **`font-size-adjust: 0.5`**, and Libertinus at 13 px
renders at about 15 px, Georgia at about 13.5 px. The ratio is Segoe's,
not the platform's: on macOS the default face is San Francisco (x-height
near 0.52), and the shipped look there is also untouched, since the
adjustment applies only when a reader has chosen a face.

Line height on the reading surfaces is already unitless, so it follows.

## 5. Where the face comes from

Three options were weighed on 2026-10-27:

1. **Import a font file** (ttf/otf/woff2 copied into `userData`, served to
   the renderer; stored as a blob in IndexedDB on the extension). Rejected
   for now: file machinery on three platforms, a second code path for the
   extension, and a copy of the user's font in our folder — for no gain over
   option 3 when the font is already installed.
2. **Ship curated families** as alternatives to the system font. A Latin
   subset of four Libertinus cuts is under 200 KB, which is small, but it is
   still a face carried for the few, and the principle is no language
   packages in the installer. Kept as a possible later step on top of the
   same roles, if the name field below proves too technical for readers.
3. **An installed font, chosen by name.** Chosen. Zero bytes shipped, no
   files touched, one install away for whoever wants Libertinus or anything
   else, and the extension resolves the same name the same way — parity by
   construction (`docs/PLATFORMS.md` needs no new divergence).

The reading role's stack is therefore the chosen name followed by the
system stack, so any glyph the chosen face lacks — a Chinese interface, æøå
in a font without them — falls through per glyph instead of breaking the
line.

**Font picker.** Chromium has a Local Font Access API (`queryLocalFonts`)
that could list the installed faces in a menu. Whether Electron passes it
through without a permission handler, and whether the extension's permission
prompt is acceptable, is untested — try it during implementation, but the
text field is the baseline and must work alone.

## 6. The setting

- **Where it lives.** A renderer-only view preference in localStorage, like
  `--ai-scale` and the panel widths: no IPC consumer, so desktop, `dev:web`
  and the extension behave identically with no store work. Key
  `pdfx-reading-font`.
- **Shape.** One text field, «Leseskrift», in the appearance group of
  settings next to the theme, with the system face as the empty default. The
  field's placeholder names the system face. Under it a one-line preview
  rendered in the typed face (a pangram with æøå), and when the face is not
  on the machine a line says so while the preview shows the system face
  instead of a silent fallback. The «is it installed» question cannot be
  put to `document.fonts.check()` — in Chromium it answers only for
  @font-face sets, so an installed face and a missing one both read as
  true — so it is measured: a probe string in the typed face with a generic
  fallback against the generic alone, for monospace, serif and sans-serif;
  any width that differs means the face was used. Hover hint, not a
  permanent line (`feedback-hover-hints`). A reset link when the value is not
  the default, as the AI text scale has. The field commits on Enter or on
  leaving it, not per keystroke — the reading surfaces must not flicker
  through every prefix of a name — while the preview follows the keystrokes.
- **Suggestions as the name is typed** (Emil, 2026-10-27). Under the field,
  chips with the installed faces whose names the typed text opens — a whole
  name first, then a word of it, then anywhere in it — each chip drawn in its
  own face, at most six, gone once the whole name stands in the field. A
  click commits that face (the chip keeps the focus in the field, or the blur
  would commit the half-typed name first). The list of faces is asked for
  once per session, on the first keystroke: Chromium's own
  `queryLocalFonts()` where the platform offers and allows it — it wants a
  user gesture, which the keystroke is — and otherwise a curated list of
  common faces (`COMMON_FONT_FAMILIES`: the Windows, macOS and Linux sets
  plus the reading faces people install on purpose) filtered by the measured
  installed rule. Nothing leaves the machine either way; the extension, where
  the browser would prompt, takes the measured list. The matching rule is
  `matchFontNames`, proved by `test:reading-font`.
- **The stored value is untrusted input.** The name goes into a CSS custom
  property, so the pure half (`src/renderer/src/reading-font.ts`) normalises
  it: trim, cap the length, drop quotes, semicolons, braces, backslashes and
  control characters, and treat junk or a non-string as the default. A
  pure-Node test (`test:reading-font`, added to the test battery composite
  action like every other) covers the normaliser, the empty-is-default rule,
  the quoting of the family in the stack, and that the default produces NO
  override at all (the shipped CSS renders bit-identically — the same
  assertion `test:theme-tune` makes).
- **Strings** in all three dictionaries, nb master, en, zh.
- **Screenshots** are unaffected: the default is unchanged, and the shipped
  set is shot in the default (`feedback-screenshots-by-hand`).

## 7. Order of work

1. **Name the roles.** Refactor every `font-family` in `app.css` onto
   `--font-ui` / `--font-reading` / `--font-mono`, and collapse 700/650 to
   600 on the reading surfaces per section 3. No visible change beyond the
   headings' weight step; `npm run check:shots` tells if any shipped frame
   shows one. Done 2026-10-27: the three monospace stacks that had drifted
   (`Consolas, monospace` in two places) were unified onto `--font-mono`,
   which resolves to the same face on every platform — Chromium ignores
   `ui-monospace`, so Windows lands on Consolas and macOS on Menlo, its
   default monospace, either way.
2. **Measure** Segoe UI Variable Text's x-height ratio for section 4.
   Done 2026-10-27: 0.50.
3. **The setting** per section 6, with the pure half and its test first.
   Done 2026-10-27: `src/renderer/src/reading-font.ts`, `test:reading-font`,
   the «Leseskrift» field at the foot of the reading-mode menu, the face
   applied at start in all three apps (viewer, detached assistant,
   extension) and cleared by the app-wide reset. Checked in dev:web: the
   sample follows the keystrokes, Enter commits, the reading surfaces get
   the face and the adjustment, body and code do not, a name the machine
   lacks says so, reset clears everything.
4. **Try `queryLocalFonts`** on desktop and in the extension; keep the menu
   only if it works on both without a dialog the reader would not expect.
5. Only on request, and on the same roles: an interface-font field, or
   shipped families (option 2).

## 8. Out of scope, on purpose

- A font for the text tool on the pages (Standard-14 only — see `CLAUDE.md`).
- Changing the default face on any platform.
- Font size as a general setting: the assistant's scale exists, and the
  x-height normalisation makes a per-face size step unnecessary.

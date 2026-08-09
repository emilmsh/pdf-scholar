# Messaging — one source for what we say about PDF Scholar

Every user-facing description of the product derives from this file: the README,
the landing page, both store listings, the app's own metadata. They are written
at different lengths for different audiences, but they must not disagree about
what the app *is*, what it does, or what it costs.

**Edit this file first, then the surfaces it lists.** A change made straight in a
store listing is a change three other places do not know about.

---

## Surfaces

| Surface | File | Notes |
| --- | --- | --- |
| README | `README.md` | The long form. Screenshots, download paths, feature list, development notes |
| Landing page | `docs/index.html` | Published by GitHub Pages from `master`. Version and download link come from the Releases API at load time — **never write a version number into it** |
| Microsoft Store | `docs/STORE-LISTING-DESKTOP.md` | **Machine-parsed** by `scripts/lib/store-listing.ps1` and pushed by `store-publish.ps1`. Keep the heading shape and the `**EN:**` / `**NO:**` fenced blocks intact; `npm run test:listing` checks the parse offline |
| Edge Add-ons / Chrome Web Store | `docs/STORE-LISTING.md` | Paste-ready. Neither store's API can set listing copy, so it is typed into the dashboards by hand |
| App metadata | `package.json` (`description`), `src/extension/manifest.json` (`description`), `config/electron-builder.yml` (`productName`) | Short forms of the one-liner below |
| Privacy policy | `docs/PRIVACY.md` | The authority on data handling. The privacy claims below summarise it and must not exceed it |
| GitHub repo description + topics | GitHub UI (manual) | The one-liner |
| Citation metadata | `CITATION.cff` | Name, author, licence, URL |

Not a copy surface, but adjacent and easy to leave stale: `docs/PLATFORMS.md`
(what each platform actually supports) and `docs/STORE.md` (publishing state).
When a claim here depends on a platform detail, PLATFORMS is the authority.

---

## Facts

| | |
| --- | --- |
| Product name | **PDF Scholar** — always, in every language. Not "PDFX" (the repo's internal name), not "PDF Expert clone" |
| One-line what | A PDF reader and annotator for Windows, for documents you work through rather than skim |
| Price | Free. No account, no sign-in, no trial, no ads, no tracking |
| Licence | MIT. Every bundled runtime component is permissively licensed |
| Repo | <https://github.com/emilmsh/pdf-scholar> |
| Landing page | <https://emilmsh.github.io/pdf-scholar/> |
| Privacy policy URL | `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md` |
| Windows | Tier 1. One installer carries x64 and native arm64; per-user install, no admin rights. Also on the **Microsoft Store**, `9N75CPC0G9M2` (live) |
| macOS / Linux | **Beta.** Built in CI, feature-identical by construction. macOS has been tested on Apple hardware (a tester's machine, not the owner's — say "tested", never "verified by the owner"); Linux has not run on real hardware. macOS is unsigned (Gatekeeper workaround in the README) and cannot *install* an update itself; it does **notice** one and tell you how to get it, which is not the same claim — never write that macOS auto-updates. The recommended macOS install is the Homebrew tap — `brew install --cask emilmsh/tap/pdf-scholar` — which makes `brew upgrade` the update channel, and the in-app notice hands you that exact command. The Gatekeeper `xattr` step still applies after every install/upgrade (Homebrew ≥ 5 removed `--no-quarantine`) — never claim brew skips it |
| Browser extension | **Beta**, Edge and Chrome. **Not in either store yet** — install is Load-unpacked from the release zip. Do not write otherwise until the listings are live |
| Engine | pdf.js renders, PDFium (EmbedPDF) writes the annotations. Say this only where it earns its place — the README and the landing footer |
| AI | Optional, bring your own key: Anthropic, OpenAI, Azure OpenAI, OpenRouter, Google Gemini, Grok (xAI), Mistral, Groq (one key field each) — or any OpenAI-compatible endpoint, including local models via Ollama/LM Studio (no key needed for local). No server of ours in between |
| Author | Emil Mathias Strøm Halseth, who reads PDFs for a living — full name wherever he is credited. Where the author is named in long form (README footer, landing footer), the approved signature is verbatim: "Built by Emil Mathias Strøm Halseth, who reads PDFs for a living, with assistance from Claude Code." (Emil's wording, 2026-08-04 — no stronger Claude credit than "assistance".) The store copyright line stays author-only |
| Logo | Elisabeth Walle — credit her wherever the logo appears |

---

## The one-liner

**EN:** A Windows PDF reader that is nearly all page.

**NO:** En PDF-leser for Windows som er nesten bare side.

The interface leads, deliberately (Emil's call, 2026-08-08): the first thing
said about the app is what the window looks like, because that is what a reader
notices first and what the app is actually built around. The assistant is named
in the same breath — but last, and always as optional.

Store-length variant, where the one-liner alone is too thin. Verbatim what the
Microsoft Store listing carries — **250 characters is the cap**, and
`npm run test:listing` enforces it:

**EN:** A PDF reader for Windows where the window is nearly all page — one slim
toolbar, and everything else out of the way until you call it, including an
optional AI assistant that cites the passage it used. Free and open source.

**NO:** En PDF-leser for Windows der vinduet er nesten bare side — én slank
verktøylinje, og alt annet unna til du henter det fram, inkludert en valgfri
AI-assistent som viser hvor svaret kom fra. Gratis og åpen kildekode.

## The lede

**EN:** For the documents you work through rather than skim: research articles,
reports, books. One slim toolbar carries the tools you use frequently, and
everything else — contents, notes, the assistant — stays out of the way until
you call it. Free, MIT-licensed, and offline unless you ask a question.

**NO:** For dokumentene du jobber deg gjennom og ikke bare skummer:
forskningsartikler, rapporter, bøker. Én slank verktøylinje bærer verktøyene du
bruker ofte, og alt annet — innhold, notater, assistenten — holder seg unna til
du henter det fram. Gratis, MIT-lisensiert, og offline med mindre du stiller
et spørsmål.

*(The lede no longer opens with "the window is nearly all page": the one-liner
above now says exactly that, and the two of them in a row read as a stutter.)*

---

## The pillars

Five, in this order. Every surface tells the same story at its own length: the
landing page gives each a heading and **four to six** points, the store listings
a block of bullets, the README the full account.

The landing page's count is a ceiling, not a target (Emil, 2026-08-09: "vi
holder ting skarpt og direkte"). It said "three or four" and had drifted to
eight and nine — a section that lists everything sells nothing. When a pillar
grows past six, the fix is to cut or merge, not to add a seventh: the README is
where the full account belongs, and a claim that only earns its place there is
not a claim the landing page was missing.

### 1. Reading

**EN heading:** Reading.
**NO heading:** Lesing.

*(Until 2026-08-09 every pillar carried an aphoristic claim for a heading —
"Everything a long document asks of you", "Marks that are always within reach and
never in the way", "Nowhere, unless you ask a question". Emil retired the register:
it reads as AI-generated marketing, not as something a professional would write.
Headings are plain topic labels now, and the substance lives in the body; the
one-liner is the only positioning line that survives. The opening frame — one
window shown in three themes — still opens every surface, so the reading section
sits directly under it and carries no picture of its own.)*

- Smooth scrolling; zoom centres on the cursor or pinch point; fit width or
  whole page
- Four themes — Day, Sepia on warm ivory, Night and Night+ (higher contrast) —
  plus Auto, which follows the system setting. Contrast and brightness are
  adjustable per theme
- Page rotation, two-page spread, full-screen presentation mode
- Table of contents, thumbnails, bookmarks, and back/forward navigation after
  following an internal link
- The toolbar can be unpinned; the page then fills the window, and the toolbar
  and panels return on hover at the window edges
- Reading positions and recent files are remembered. Documents open in tabs or
  separate windows, and a tab can be dragged out into its own window
- Going back to the library closes nothing: open documents stay in the tab
  strip, and returning to one restores page, zoom and panels
- Password-protected documents open, can be annotated, and are saved with their
  protection intact. *Supporting, not a headline: a browser opens these too.*
- Keyboard shortcuts are listed in one map in settings and can be rebound or
  reset. Keep this to a line
- Interface in Norwegian and English; the choice also applies to the AI
  prompts, exports and date formats

### 2. Split view

**EN heading:** Split view.
**NO heading:** Delt visning.

- Two columns of the same document, each with its own page, zoom and rotation —
  a table or figure can stay in view beside the text that discusses it
- Ctrl+click on an internal link opens its target in the other column
- Annotations can be made in either column and appear in both; it is a single
  document
- A closed column's page, zoom and width are restored when the split is
  reopened

### 3. Annotation

**EN heading:** Annotation.
**NO heading:** Annotering.

**The pillar's substance:** annotating does not interrupt reading. The tools
appear at the selection, the marks are listed in a panel, and neither clutters
the page. Durability is what anyone expects of a PDF annotator — it stays a
supporting bullet, phrased as a consequence, never a headline.

**EN body:** Selecting text opens the annotation menu at the selection —
highlight, underline, a comment, or a question for the assistant. A notes panel
lists every mark by page, with search and colour and type filters; comments are
edited directly in the list, and a click goes to the mark. For comments that
others will read — feedback on a draft, a marked-up student paper — a margin
view presents them as visible text beside the page, and an export produces a
copy with the comments set in a widened margin.

**NO body:** Å merke tekst åpner annoteringsmenyen ved merkingen — utheving,
understreking, kommentar, eller et spørsmål til assistenten. Et notatpanel
lister hvert merke per side, med søk og farge- og typefilter; kommentarer
redigeres direkte i lista, og ett klikk går til merket. Kommentarer som andre
skal lese — tilbakemelding på et utkast, en rettet besvarelse — kan vises i
margen som synlig tekst ved siden av siden, og en eksport lager en kopi med
kommentarene satt i en utvidet marg.

- The toolbar carries the same tools, and can be unpinned entirely
- Highlight, underline, strikeout and squiggly; pen and marker with
  hold-to-straighten; shapes, sticky notes, free text, and text-anchored
  comments
- With a stylus, the pen draws while a finger scrolls and zooms; pen pressure
  varies the line width **(beta)** and is preserved in the saved file
- The text tool uses the standard PDF typefaces — Helvetica, Times and Courier,
  with bold and italic — chosen before typing or changed on an existing box.
  Nothing is embedded in the file; the text remains searchable and renders
  identically in other readers. (Claim the fonts, never "any font": a typeface
  outside the standard fourteen would have to travel inside the document, and
  we deliberately do not do that. v0.36 shipped a handwriting font that did,
  and it came back out.)
- A signature is drawn once — or uploaded or pasted as an image — and stamped
  where needed. It is stored locally and saved as a standard stamp annotation.
  *(Placing a signature is not the same as digitally signing a document, and no
  surface may blur the two. Where a document already carries digital signatures
  the app reports them and states that it does not verify them.)*
- Colour, thickness and opacity are set per tool and remembered between
  sessions
- Existing marks can be adjusted rather than redrawn: the ends of a highlight,
  the corner of a shape, text box or drawing
- Comments in the margin: every note and comment as a visible card beside the
  page — left or right — colour-keyed to its mark, with a leader line to the
  passage it belongs to
- Margin export: a copy of the document with every page widened and the
  comments set in the new margin as ordinary annotations, numbered at their
  anchors. The original file is untouched
- The notes panel exports a summary, highlighted text included, to Word,
  Markdown or HTML
- An optional name in settings fills the standard PDF author field on new
  annotations; left empty, they stay unsigned
- Edits are held in a draft until saved; closing prompts, and the draft
  survives a crash
- *Supporting, never the headline:* marks are standard PDF annotations with
  appearance streams and open correctly in other readers

### 4. The assistant

**EN heading:** The AI assistant.
**NO heading:** AI-assistenten.

- Optional, and it runs on your own API key
- Answers cite their sources: each claim carries a reference, and following it
  goes to the passage the claim came from
- Structured article summaries — research question, method, data, findings,
  limitations
- A figure or region can be cropped into the chat and asked about; nothing is
  sent until a question is asked
- Semantic search: describe a topic in your own words and get the passages that
  discuss it, ranked
- Questions about your own annotations ("summarize what I've highlighted")
- Scanned documents are identified as such rather than answered about blindly;
  a page range can be attached as images instead
- Optional web search, off by default (Anthropic and OpenAI only — the toggle
  does not appear elsewhere)
- LaTeX in answers is rendered
- Providers: Anthropic (Claude), OpenAI, Azure OpenAI, OpenRouter, Google
  Gemini, Grok (xAI), Mistral and Groq — one key field each, entered once —
  plus any OpenAI-compatible endpoint, including local models via Ollama or
  LM Studio (no key needed). Model lists are fetched live from each keyed
  provider, and every answer reports the provider's token count

### 5. Privacy

**EN heading:** Privacy.
**NO heading:** Personvern.

- Reading, annotating and saving are entirely local; the app runs without
  network access
- Assistant requests go directly to the chosen provider, under your key and
  that provider's terms — there is no intermediary server
- With a local model (Ollama, LM Studio), questions also stay on the machine
- The key is stored in the platform's own key store; the exact mode differs per
  platform and the settings panel names the one in force. See "Wording we do not
  use" below before writing anything shorter than that

---

## Wording we do not use

- **"Marks that survive the file" / durability as a headline.** Interoperable
  annotations are table stakes; leading with them says we are proud of the
  minimum. Interop is a supporting bullet in pillar 3, phrased as a consequence,
  not an achievement.
- **"AI-powered".** The assistant is optional, off without a key, and never the
  first thing said about the app.
- **Anything that reads as "digitally signed" or "signature verified".** The
  signature tool stamps a picture on the page — legally an ordinary annotation,
  not a cryptographic signature — and the signature *reader* deliberately makes
  no claim about validity. Say "sign" only in the sense a pen signs paper, and
  never let a badge or a bullet suggest the app has checked a certificate.
- **"Encrypted" on its own, about the API key.** `docs/PLATFORMS.md` §12 lists
  four distinct storage modes and the settings panel states the active one; copy
  that flattens them into one promise is wrong on at least one platform. Say
  "the platform's own key store — DPAPI on Windows, Keychain on macOS, the
  system keyring on Linux", and for the extension say what it actually is.
- **Store availability the extension does not have.** Until the Edge and Chrome
  listings are live, every surface says Load-unpacked and why.
- **Version numbers in evergreen surfaces.** The landing page reads the version
  from the Releases API; the README uses a badge. Only
  `docs/STORE-LISTING-DESKTOP.md` names a version, in its "What's new" heading,
  and the publish script fails if that does not match the build.
- **Self-praise adjectives** — "polished", "beautiful", "powerful". The house
  voice states what the thing does and lets the reader conclude. Concrete beats
  superlative.
- **Design slogans as information.** "The library is a place, not an exit" is
  how the behaviour was *decided*, and it leaked from commit messages into four
  surfaces (Emil, 2026-08-09: "fjas og intern metadebt"). The reader needs what
  happens — going back closes nothing, returning restores everything — never the
  metaphor it was built under.
- **The AI register** (Emil, 2026-08-09: "typisk KI"). Aphoristic mirrors
  ("within reach, never in the way"), anthropomorphised features ("the menu
  comes to you"), benefit tails that restate the sentence ("so the cost stays
  visible"), reassurance ("nothing is lost"), cutesy detail ("a hair of
  margin"), and validation by name-drop ("as Acrobat does"). The test for every
  sentence: would a colleague write it in a paper? State the capability and its
  consequence, then stop.
- **Bug history in evergreen copy.** A bullet that describes the absence of a
  former defect — "zoom that stays where you release it", "writes each mark
  exactly once", "the box can never be shrunk below its own words" — advertises
  the repair, not the capability, and dates the text. Evergreen surfaces state
  what the app does; a fix is named as a fix only in a "What's new" block.
- **Claims about untested platforms.** Linux has not run on real hardware and no
  surface may imply otherwise. macOS HAS been tested on Apple hardware (since
  v0.34.0) but remains beta — "tested" is the strongest word on offer; never
  "verified", "stable" or anything that promises the owner stands behind the
  build day to day.
- **A third macOS install path, or Gatekeeper explained twice.** Every surface
  offers at most two ways in — Homebrew and by hand — sharing one explanation
  of what the unsigned build costs (one `xattr` per version, no self-update).
  A surface that explains quarantine per-path has grown too convoluted.

---

## Keeping it true

Copy goes stale in three places at once, so before a release (`docs/RELEASE.md`
step 1b):

1. If the release changes **what the app is** — a new pillar-level capability, a
   platform graduating out of beta, a store listing going live — update this
   file first.
2. Then the four copy surfaces in the table above. The store listings are the
   ones nobody looks at between releases; they drift furthest.
3. `npm run test:listing` proves the Microsoft Store copy still parses. Nothing
   proves the README and the landing page agree — that is a read-through, and it
   is short.

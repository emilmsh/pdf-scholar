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
| One-line what | A PDF reader and annotator for Windows and macOS, for documents you work through rather than skim. A store listing names only its own platform |
| Price | Free. No account, no sign-in, no trial, no ads, no tracking |
| Licence | MIT. Every bundled runtime component is permissively licensed |
| Repo | <https://github.com/emilmsh/pdf-scholar> |
| Landing page | <https://emilmsh.github.io/pdf-scholar/> |
| Privacy policy URL | `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md` |
| Windows | Tier 1. One installer carries x64 and native arm64; per-user install, no admin rights. Also on the **Microsoft Store**, `9N75CPC0G9M2` (live) |
| macOS | **Presented alongside Windows, no beta label** (Emil, 2026-08-11 — it has run on real Apple hardware since v0.34.0). Built in CI, feature-identical by construction. Tested on a tester's machine, not the owner's — say "tested", never "verified by the owner". The build is unsigned (Gatekeeper workaround in the README) and cannot *install* an update itself; it does **notice** one and tell you how to get it, which is not the same claim — never write that macOS auto-updates. The recommended install is the Homebrew tap — `brew install --cask emilmsh/tap/pdf-scholar` — which makes `brew upgrade` the update channel, and the in-app notice hands you that exact command. The Gatekeeper `xattr` step still applies after every install/upgrade (Homebrew ≥ 5 removed `--no-quarantine`) — never claim brew skips it |
| Linux | **Beta.** Built in CI, feature-identical by construction, but it has not run on real hardware and no surface may imply otherwise. **Say why, and ask for help** (Emil, 2026-09-04): the author develops on Windows and has no Linux machine, so the build is untested there and reports from Linux users are wanted. State the reason plainly — it is the honest version of the beta label, not an apology — and pair it with the issue tracker. It carries no weight on the store surfaces (neither store sells the Linux build); the README says it in the Linux section, the landing page in the small print under the download buttons |
| Browser extension | **Beta — and live in BOTH stores** (confirmed 2026-08-12). Edge Add-ons: `https://microsoftedge.microsoft.com/addons/detail/pdf-scholar/jdmemepojgjhflpeckiiciibnhmbdjcc`. Chrome Web Store: `https://chromewebstore.google.com/detail/pdf-scholar/jhhlaaiegmdmjeeiopmdmoiidnbbhbmd`. One click, self-updating — this is the install to lead with, and the Load-unpacked route is now only for running a build newer than the stores carry. **Both listings lag the current release** while their updates sit in review, so never name a version on a store surface |
| Engine | pdf.js renders, PDFium (EmbedPDF) writes the annotations. Say this only where it earns its place — the README and the landing footer |
| AI | Optional, bring your own key: Anthropic, OpenAI, Azure OpenAI, OpenRouter, Google Gemini, Grok (xAI), Mistral, Groq (one key field each) — or any OpenAI-compatible endpoint, including local models via Ollama/LM Studio (no key needed for local). No server of ours in between |
| Zotero | Works as Zotero's external PDF reader (Zotero 7+, its "Open PDFs using" setting). A document living in a Zotero library gets a Zotero section in the save menu — show the item in Zotero, copy an in-text citation, a full reference (APA), or the BibTeX entry, fetched from Zotero's **local** API on the same machine. BibTeX comes from the translator that ships with Zotero — Better BibTeX is not needed, and its citation keys are Zotero's own generated ones, not BBT's pinned ones. Two fields are stripped before the entry reaches the clipboard: `file` (the attachment's absolute path on that machine — local disk layout nobody meant to publish) and `abstract` (several hundred words that belong in the library, not in a .bib) (2026-09-03) (no account, no network; the user enables the API once in Zotero's Advanced settings). Annotations saved into the file are standard PDF annots, which Zotero's own «Import Annotations…» adopts — highlights and underlines; text boxes and ink are not importable on Zotero's side, and that boundary is Zotero's to claim, not ours to hide. Importing MOVES them (Zotero strips the file and keeps them in its database — verified 2026-09-02); the guide says so plainly and advises skipping the import in a PDF-Scholar-first workflow. Covers stored AND linked attachments: a stored file is recognised by its path alone; a linked file (ZotFile-style libraries, a base folder on a synced drive — Emil's own setup) by asking the local API for the library's attachment list and matching the filename, so it shows its Zotero section only while Zotero runs with the API on (2026-09-03; v0.44.0 showed linked libraries nothing) |
| Author | Emil Mathias Strøm Halseth, who reads PDFs for a living — full name wherever he is credited. Where the author is named in long form (README footer, landing footer), the approved signature is verbatim: "Built by Emil Mathias Strøm Halseth, who reads PDFs for a living, with assistance from Claude Code." (Emil's wording, 2026-08-04 — no stronger Claude credit than "assistance".) The store copyright line stays author-only |
| Logo | Elisabeth Walle — credit her wherever the logo appears, and link her name to <https://www.linkedin.com/in/elisabeth-walle-239028140/> on every surface that supports links |

---

## The one-liner

**EN:** A PDF reader for research.

**NO:** En PDF-leser for forskning.

The audience leads (Emil's call, 2026-08-09, replacing the interface-led
"nearly all page" line of 2026-08-08): the app is named for the work it
serves, and the window description moved into the lede. Keep both claims,
each said once — whichever heads a surface, the other follows in the body.

The platform left the one-liner when macOS graduated (2026-08-11): the
download buttons name the platforms, the headline names the work. The
Microsoft Store variant below keeps "for Windows" — it is the Windows store.

Store-length variant, where the one-liner alone is too thin. Verbatim what the
Microsoft Store listing carries — **250 characters is the cap**, and
`npm run test:listing` enforces it:

**EN:** A PDF reader for Windows, built for research — one slim toolbar,
everything else out of the way until you call it, and an optional AI assistant
that cites the passage it used. Free and open source.

**NO:** En PDF-leser for Windows, laget for forskning — én slank verktøylinje,
alt annet unna til du henter det fram, og en valgfri AI-assistent som viser
hvor svaret kom fra. Gratis og åpen kildekode.

## The lede

**EN:** The window is nearly all page: one slim toolbar carries the tools you
use frequently, and everything else — contents, notes, the assistant — stays
out of the way until you call it. Free, MIT-licensed, and offline unless you
ask a question.

**NO:** Vinduet er nesten bare side: én slank verktøylinje bærer verktøyene du
bruker ofte, og alt annet — innhold, notater, assistenten — holder seg unna til
du henter det fram. Gratis, MIT-lisensiert, og offline med mindre du stiller
et spørsmål.

*(The one-liner and the lede swapped roles on 2026-08-09: the one-liner names
the audience, so the lede describes the window. Opening both with the same
claim reads as a stutter, in either order.)*

---

## The pillars

Seven, in this order — the fourth and sixth deliberately small. Every surface
tells the same story at its own length: the landing page gives each a heading
and **four to six** points, the store listings a block of bullets, the README
the full account.

The landing page's count is a ceiling, not a target (Emil, 2026-08-09: "vi
holder ting skarpt og direkte"). It said "three or four" and had drifted to
eight and nine — a section that lists everything sells nothing. When a pillar
grows past six, the fix is to cut or merge, not to add a seventh: the README is
where the full account belongs, and a claim that only earns its place there is
not a claim the landing page was missing.

### 1. Reading

**EN heading:** Undistracted reading.
**NO heading:** Uforstyrret lesing.

*(Two heading decisions on 2026-08-09. First the aphoristic claims —
"Everything a long document asks of you", "Nowhere, unless you ask a question"
— were retired: that register reads as AI-generated marketing, not as something
a professional would write. Then bare topic labels proved too flat. The rule
that stuck: an active, factual phrase — it must state something true about the
app, never perform. The opening frame — one window shown in three themes —
still opens every surface, so the reading section sits directly under it and
carries no picture of its own.)*

- Smooth scrolling; zoom centres on the cursor or pinch point; fit width or
  whole page
- Four reading modes — Day, «Farge» (a light paper tone: the classic Sepia
  cream plus gray, green, blue and sand), Night and Night+ (higher contrast) —
  plus Auto, which follows the system setting. Night has its own dark tones
  (the standard near-black, gray, blue, green). The tinted modes take a strength slider — tint
  strength for the light tones, brightness for night; 100 % is the standard
  look — and the UI chrome follows the chosen tone, the way Sepia's cream
  chrome always did. A keyboard shortcut cycles the modes
- Night mode can keep pictures in their original colours — figures and photos
  stay true while the page inverts *(reader ask, 2026-09-02, same batch as the
  intensity slider and the two-document split)*
- Page rotation, two-page spread, full-screen presentation mode
- Table of contents, thumbnails and bookmarks in one panel; the toolbar's page
  field jumps straight to a page number
- Internal links and cross-references can be followed and returned from —
  back/forward buttons hold the navigation history *(navigation elevated to two
  bullets on Emil's ask, 2026-08-12: moving around a long document matters to
  him as much as the split view, and it was buried in a subclause)*
- The toolbar can be unpinned; the page then fills the window, and the toolbar
  and panels return on hover at the window edges
- Reading positions and recent files are remembered. Documents open in tabs or
  separate windows, and a tab can be dragged out into its own window
- Going back to the library closes nothing: open documents stay in the tab
  strip, and returning to one restores page, zoom and panels
- Password-protected documents open, can be annotated, and are saved with their
  protection intact. *Supporting, not a headline: a browser opens these too.*
- Interface in Norwegian and English; the choice also applies to the AI
  prompts, exports and date formats

### 2. Split view

**EN heading:** Two pages at once.
**NO heading:** To sider samtidig.

- Two columns of the same document, each with its own page, zoom and rotation —
  a table or figure can stay in view beside the text that discusses it
- The second column can also hold ANOTHER document — drag its tab into the
  view, pick it under «Åpne i delt visning» in the view menu (the other open
  documents by name, or «Annen fil …»), right-click its tab, or drop a PDF on
  the column — so two papers can be read and annotated side by side *(the top
  reader ask, 2026-09-02; the view menu and the drag arrived 2026-09-03 after
  the tab menu alone went unfound — same words everywhere, «delt visning», and
  never the other paper's name in a label)*
- A dropped tab or file lands where it is dropped: on the column it hits, or,
  with one column open, on the half of it the pointer is over *(2026-09-03 —
  before this every new document took the right column)*
- The document already in a column, put into the other one — its tab dropped
  there, «Åpne i delt visning» on its own tab, or its name in the view menu —
  fills both columns: that is the same-file split's home
- Swapping the column's document for another one keeps the column: it holds
  its width while the next file loads, so the swap is one layout change and
  never a blink out to full width and straight back *(2026-09-03)*
- «Bytt plass» trades the columns' sides, in both modes
- Ctrl+click on an internal link opens its target in the other column
- Annotations can be made in either column and land in the document they are
  made in — the tools, the selection menu, the right-click menu and a mark's own
  popover all work the same in the other document's column; only the AI actions
  stay with the tab's document *(2026-09-03: with the menus staying home, the
  column read as a preview)*. With one document open they appear in both — it
  is a single document
- S reopens whatever the split held last — the other document too, on the side
  and at the width it had; a closed same-file column comes back at its page,
  zoom and width
- The two-page spread is suspended while the view is split (a pair in a
  half-width column is two thumbnails) and returns when the document is shown
  alone; the choice itself is kept, and so is the zoom the column had before
  the split — a hand-set zoom comes back exactly, a fit re-fits for the full
  width *(2026-09-03)*

### 3. Annotation

**EN heading:** Annotating while you read.
**NO heading:** Annotering mens du leser.

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
- A document from a Zotero library gets a Zotero section in the save menu —
  show the item in Zotero, or copy its citation, full reference or BibTeX
  entry, fetched from Zotero's local API on the same machine *(landing page:
  merged into the standard-annotations bullet, not a bullet of its own — the
  pillar is at its six-point ceiling)*
- Edits are held in a draft until saved; closing prompts, and the draft
  survives a crash
- *Supporting, never the headline:* marks are standard PDF annotations with
  appearance streams and open correctly in other readers — Zotero included,
  whose «Import Annotations…» adopts the highlights and underlines

### 4. Search

**EN heading:** Search by words or by meaning.
**NO heading:** Søk etter ord eller mening.

*(Small, like the keyboard section. Promoted to a section of its own on
2026-08-10 — it had been a README-only block, and Emil wants the surfaces at
parity: what one presents, the others present. Both modes live in ONE search
bar, a tab apart, and the frame that ships with the section shows exactly
that.)*

- By words: match case, whole word, a results list with excerpts, and every
  match marked on the page
- By meaning: describe a topic in your own words and get the passages that
  discuss it, ranked. This mode uses the assistant's key

### 5. The assistant

**EN heading:** An assistant that cites its sources.
**NO heading:** En assistent som oppgir kildene sine.

- Optional, and it runs on your own API key
- Answers cite their sources: each claim carries a reference, and following it
  goes to the passage the claim came from
- Structured article summaries — research question, method, data, findings,
  limitations
- A figure or region can be cropped into the chat and asked about — staged in
  the composer until you press send. *(The quick «Forklar utsnitt» path is the
  exception: it sends the crop as soon as the region is drawn — the action IS
  the request. Never claim "nothing is sent until a question is asked" about
  cropping in general; PRIVACY.md states the sending rules and copy must not
  exceed it.)*
- Questions about your own annotations ("summarize what I've highlighted")
- Scanned documents are identified as such rather than answered about blindly;
  a page range can be attached as images instead
- The assistant can open in its own window, so the document keeps the whole
  screen; a citation click still goes to the passage in the window showing the
  document. *(The extension opens a separate tab instead — say "window" only
  on desktop surfaces; PLATFORMS §17 is the authority.)*
- The answer text has its own size control (80–160 %), separate from the
  document's zoom. *(README only — at listing length this is trivia.)*
- Optional web search, off by default (Anthropic and OpenAI only — the toggle
  does not appear elsewhere)
- LaTeX in answers is rendered
- Providers: Anthropic (Claude), OpenAI, Azure OpenAI, OpenRouter, Google
  Gemini, Grok (xAI), Mistral and Groq — one key field each, entered once —
  plus any OpenAI-compatible endpoint, including local models via Ollama or
  LM Studio (no key needed). The model menu offers a curated, verified list
  per provider, strongest first — the provider's full live listing stays
  reachable by search — and every answer reports the provider's token count.
  *(The named roll-call is for OUR surfaces — README, landing page, Microsoft
  Store. The **extension** listing carries no third-party brand name at all,
  not even "OpenAI-compatible" or "Acrobat": the Chrome Web Store rejected the
  eight-name line as keyword spam, ref "Yellow Argon", 2026-08-12, and that
  listing is now written to give a brand scanner nothing. See
  [`STORE-LISTING.md`](STORE-LISTING.md).)*

### 6. Keyboard

**EN heading:** Shortcuts you can rebind.
**NO heading:** Snarveier du kan binde om.

*(Deliberately small — one short paragraph and the keyboard-map frame, placed
after the assistant (Emil, 2026-08-09). A supporting point rather than a pillar
of the app, but the map is the proof and earns its own picture. Never at the
head of a surface: a settings dialog is a thing you go and find, not what the
app looks like.)*

- Every command is listed in one map in settings, grouped by task, with its
  keys beside it
- Any shortcut can be rebound or reset — one key or all at once

### 7. Privacy

**EN heading:** Local by default.
**NO heading:** Lokalt som standard.

- Reading, annotating and saving are entirely local; the app runs without
  network access
- Assistant requests go directly to the chosen provider, under your key and
  that provider's terms — there is no intermediary server
- An AI action normally attaches the whole document text (an excerpt for very
  long documents), and the answer labels what rode along — say "document
  content is sent when you use an AI action", never "only when you ask a
  question": several actions fire on one click
- An AI access switch in settings: **Confirm before sharing** pauses the first
  request that takes a document to a provider in a session — naming the model
  and what is about to be attached — and lets follow-up questions about the
  same document pass; a new document or a new provider asks again *(Emil,
  2026-09-03: a prompt on every request trains the click-through)*; **Off**
  blocks every AI request in the transport layer, so a stored key cannot leak
  content by accident
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
- **A store version the listing does not actually carry.** Both extension
  listings are live (2026-08-12), so every surface leads with the one-click
  install — but review lags, and a listing routinely trails the newest release.
  Never state or imply which version a store holds; Load-unpacked is now
  described as the way to run something newer, not as the way in.
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
  surface may imply otherwise. macOS is presented alongside Windows without a
  beta label (Emil, 2026-08-11) — it has been tested on Apple hardware since
  v0.34.0, and "tested" remains the strongest word on offer; never "verified",
  "stable" or anything that promises the owner stands behind the build day to
  day.
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

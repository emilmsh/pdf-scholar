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
| macOS / Linux | **Beta.** Built in CI, feature-identical by construction, not verified on owner hardware. macOS is unsigned (Gatekeeper workaround in the README) and cannot auto-update; the recommended macOS install is the Homebrew tap — `brew install --cask emilmsh/tap/pdf-scholar` — which makes `brew upgrade` the update channel. The Gatekeeper `xattr` step still applies after every install/upgrade (Homebrew ≥ 5 removed `--no-quarantine`) — never claim brew skips it |
| Browser extension | **Beta**, Edge and Chrome. **Not in either store yet** — install is Load-unpacked from the release zip. Do not write otherwise until the listings are live |
| Engine | pdf.js renders, PDFium (EmbedPDF) writes the annotations. Say this only where it earns its place — the README and the landing footer |
| AI | Optional, bring your own key: Anthropic, OpenAI, Azure OpenAI, OpenRouter, Google Gemini, Grok (xAI), Mistral, Groq (one key field each) — or any OpenAI-compatible endpoint, including local models via Ollama/LM Studio (no key needed for local). No server of ours in between |
| Author | Emil Mathias Strøm Halseth, who reads PDFs for a living — full name wherever he is credited. Where the author is named in long form (README footer, landing footer), the approved signature is verbatim: "Built by Emil Mathias Strøm Halseth, who reads PDFs for a living, with assistance from Claude Code." (Emil's wording, 2026-08-04 — no stronger Claude credit than "assistance".) The store copyright line stays author-only |
| Logo | Elisabeth Walle — credit her wherever the logo appears |

---

## The one-liner

**EN:** A Windows PDF reader built for reading.

**NO:** En PDF-leser for Windows, bygget for lesing.

Store-length variant, where the one-liner alone is too thin. Verbatim what the
Microsoft Store listing carries — **250 characters is the cap**, and
`npm run test:listing` enforces it:

**EN:** A PDF reader and annotator for Windows, for people who read long
documents for work. Annotation tools within reach and never in the way, split
view, and an optional AI assistant that cites the passage it used. Free and open
source.

**NO:** En PDF-leser og -annotator for Windows, for folk som leser lange
dokumenter i jobben. Annoteringsverktøy innen rekkevidde og aldri i veien, delt
visning, og en valgfri AI-assistent som viser hvor svaret kom fra. Gratis og åpen
kildekode.

## The lede

**EN:** For the documents you work through rather than skim: research articles,
reports, books. The window is nearly all page — one slim toolbar carries the
tools you use frequently, and everything else stays out of the way until you
call it. Free, MIT-licensed, and offline unless you ask a question.

**NO:** For dokumentene du jobber deg gjennom og ikke bare skummer:
forskningsartikler, rapporter, bøker. Vinduet er nesten bare side — én slank
verktøylinje bærer verktøyene du bruker ofte, og alt annet holder seg unna
til du henter det fram. Gratis, MIT-lisensiert, og offline med mindre du stiller
et spørsmål.

---

## The pillars

Five, in this order. Every surface tells the same story at its own length: the
landing page gives each a heading and three or four points, the store listings a
block of bullets, the README the full account.

### 1. Reading — the window is nearly all page

**EN claim:** A page you can stand to look at all day.
**NO claim:** En side du orker å se på hele dagen.

- Smooth scrolling and pinch zoom that stays where you release it; fit width or
  whole page; the opening zoom follows the file's own setting, as Acrobat does
- Four themes — Day, Sepia on warm ivory (the tone matches Apple Books), Night
  and Night+ — plus Auto, which follows Windows. Contrast and brightness
  adjustable within each
- Rotate pages, two-page spread, full-screen presentation mode
- Unpin the toolbar and it hides; hover an edge to bring back the toolbar, the
  contents or the assistant
- Contents, thumbnails, bookmarks, and back/forward after following a
  cross-reference (the mouse side-buttons work too) — the difference between
  reading a paper and losing your place in one
- Remembers reading positions and recent files; tabs and multiple windows, and a
  tab can be dragged out into its own window
- Interface in Norwegian and English, which also sets the AI prompts, exports and
  date formats

### 2. Split view — two pages at once

**EN claim:** Two pages at once.
**NO claim:** To sider samtidig.

- Two columns of the same document, each with its own page, zoom and rotation,
  so a landscape table can sit upright beside portrait text
- Ctrl+click an internal link to open its target in the other column and keep
  the page you are on
- Annotate in either column; it is one document, so a mark appears in both as
  you make it
- Toggling the split away and back returns the column exactly as you left it —
  page, spot on the page, zoom and width

### 3. Annotation — within reach, never in the way

**EN claim:** Marks that are always within reach and never in the way.
**NO claim:** Merknader som alltid er innen rekkevidde og aldri i veien.

**This is the pillar's point, and the one most easily lost.** What the app does
well is not that the marks are durable — durability is what anyone expects of a
PDF annotator, and saying it out loud sounds like an apology. What it does well
is that marking up a paper never interrupts the reading: the tools come to the
text you selected, the marks you have made are one panel away, and neither the
tools nor the marks clutter the page while you read.

**EN body:** Select a passage and the menu comes to you — highlight, underline,
a comment, or a question for the assistant — so marking a paper never costs a
trip to the toolbar and back. Everything you have marked stays one panel away:
the notes tab lists every mark by page, with search and colour and type filters,
comments edit right in the list, and clicking one takes you to it. And when the
comments should be *seen* rather than found — feedback on a draft, a marked-up
student paper — the margin view lays them out as visible text beside the page,
and the export prints them that way.

**NO body:** Merk et avsnitt, og menyen kommer til deg — utheving,
understreking, en kommentar, eller et spørsmål til assistenten — så det å
annotere en artikkel aldri koster en tur innom verktøylinja. Alt du har merket
ligger ett panel unna: Notater-fanen lister hvert merke per side, med søk og
farge- og typefilter, kommentarene redigeres rett i lista, og ett klikk tar deg
dit. Og når kommentarene skal *ses* og ikke letes fram — tilbakemelding på et
utkast, en rettet elevbesvarelse — legger margvisningen dem som synlig tekst ved
siden av siden, og eksporten printer dem slik.

- The toolbar carries the same tools for when you mark several passages in a
  row, and unpins entirely when you want nothing but the page
- Highlight, underline, strikeout and a true-wave squiggly; pen and marker with
  hold-to-straighten; shapes, sticky notes, free text typed on the page in the
  colour and size you pick, and text-anchored comments
- Colour, thickness and opacity per tool, remembered between sessions
- A mark can be corrected rather than redrawn: drag either end of a highlight
  and it snaps to whole words, or a corner of a shape, text box or drawing
- Nothing that pops up has to be dismissed to see past it: the selection menu,
  and the comment and note bubbles, all drag aside by their grip — and the
  bubbles resize. They close on Esc or a click outside
- Comments in the margin: every note and comment as an always-visible card
  beside the page — left or right — colour-keyed to its mark, with a leader
  line to the passage it belongs to; when none is in view, quiet arrows fetch
  the nearest. Comments edit right in the cards
- Export with comments in the margin: a copy of the document with every page
  widened and the comments set in the new margin as real annotations, a
  numbered chip at each anchor tying text to comment on paper. The original is
  untouched
- The notes tab exports a summary — the highlighted text included — to Word,
  Markdown or HTML
- An optional name in settings signs new annotations — the standard PDF author
  field other readers show; left empty, they stay unsigned
- The file is only written when you save it: edits go to a draft, closing
  prompts, and unsaved work survives a crash
- A save guard warns before overwriting a file another program has changed, and
  "save a copy" continues in the copy
- *Supporting, never the headline:* the marks are standard PDF annotations with
  appearance streams, so the file reads the same in Acrobat or anywhere else it
  goes

### 4. The assistant — it shows its work

**EN claim:** An assistant that shows its work.
**NO claim:** En assistent som viser hvor svaret kommer fra.

- Optional, and it runs on your own API key
- Every claim carries a source chip: click one and you land on the sentence the
  claim came from, so you can check the answer rather than take it on trust
- Structured article summaries — research question, method, data, findings,
  limitations
- Explain a figure: drag a box around a chart or table and the region lands in
  the chat for you to ask about. Nothing is sent until you ask
- Search by meaning: describe a topic in your own words and get the passages
  that discuss it, ranked and clickable
- Ask about your own marks: "summarize what I've highlighted"
- Scanned documents are named as such rather than answered about blindly; attach
  a page range as images and the assistant reads those
- Optional web search, off by default: closed, on request, or always on
  (Anthropic and OpenAI only — the toggle simply doesn't appear elsewhere)
- LaTeX/TeX renders properly in answers, so maths stays readable
- Anthropic, OpenAI, Azure OpenAI, OpenRouter, Google Gemini, Grok (xAI),
  Mistral and Groq — one key field each, entered once — plus any
  OpenAI-compatible endpoint and local models via Ollama or LM Studio (local
  servers need no key). Setup is paste-the-key-and-save; each provider's model
  list is fetched live, and the model menu keeps every keyed provider one
  click apart. Big lists (OpenRouter) are sectioned by vendor with a filter
  field. Each answer shows the tokens the provider counted, so the cost stays
  visible

### 5. Where your document goes

**EN claim:** Nowhere, unless you ask a question.
**NO claim:** Ingen steder, med mindre du stiller et spørsmål.

- Reading, annotating and saving are entirely local; the app works with no
  network at all
- When you do use the assistant, the request goes straight to the provider you
  picked — there is no server of ours in between — under your key and their
  terms
- Point it at a local model (Ollama, LM Studio) and even your questions stay
  on your own machine
- The key is kept in the platform's own key store; the exact mode differs per
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
- **Claims about untested platforms.** macOS has not run on Apple hardware; the
  README says so and nothing elsewhere may imply otherwise.
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

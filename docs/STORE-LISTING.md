# Extension store listing — paste-ready copy

Everything needed to submit the **PDF Scholar** browser extension to **Edge
Add-ons** (free) and the **Chrome Web Store** ($5 one-time). Upload
`pdf-scholar-extension-store.zip` (manifest at the zip root — attached to each
release, or run `npm run pack:ext:store` to build it).
See `docs/STORE.md` for the account setup. Privacy policy URL (both stores):
`https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`

**The claims come from [`MESSAGING.md`](MESSAGING.md)** — the master for what we
say about the product here, in the README, on the landing page and in the
Microsoft Store listing. Change a claim there first; this file is one rendering
of it, cut to the extension's audience. Neither store's API can set listing
copy, so this is typed into the dashboards by hand — which is exactly why it
goes stale between releases.

Category: **Productivity**. Language: primary English, add Norwegian if the
store supports a localized listing.

---

## Name
PDF Scholar

## Short description (≤132 chars — Chrome limit)
**EN:** Read and annotate PDFs in the browser: annotation tools within reach, split view, and an optional AI assistant.

**NO:** Les og annoter PDF-er i nettleseren: annoteringsverktøy innen rekkevidde, delt visning og en valgfri AI-assistent.

## Single purpose (Chrome requires this)
PDF Scholar replaces the browser's built-in PDF viewer with a full-featured reader and annotator, so PDFs opened in the browser can be read and marked up in one place.

---

## Detailed description

**EN:**
```
PDF Scholar replaces the browser's built-in PDF viewer with a reader and annotator meant for the documents you have to work through: research articles, reports, books.

Open a PDF and it becomes an ordinary browser tab in the PDF Scholar viewer instead of the browser's basic reader. Make your browser your default PDF app and local PDFs open here too.

READING
• Smooth scrolling and pinch zoom that stays where you release it; fit width or page
• Day, Sepia and two Night themes, with contrast adjustable per theme
• Rotate pages, two-page spread, and a full-screen presentation mode
• Split view: two columns of the same document, each with its own page, zoom and rotation
• Table of contents, thumbnails, bookmarks and search (match case / whole word)
• Remembers your reading position and recent files

ANNOTATION
Marking up a paper never interrupts reading it: the tools come to the text you selected, and everything you have marked is one panel away.
• Select a passage and the menu comes to you — highlight, underline, a comment or a note, without a trip to the toolbar and back
• A Notes panel keeps every mark one click away: grouped by page, searchable, filtered by colour and type, comments editable right in the list — with export to Word, Markdown or HTML
• Comments in the margin: one switch shows every note and comment as visible text beside the page, and an export sets them in a real widened margin, numbered at their anchors, ready to print
• Highlight, underline, strikeout and squiggly; pen and marker with hold-to-straighten; shapes, sticky notes and free text
• With a stylus on a touch screen, the pen draws while a finger scrolls; pen pressure varies the line (beta), and the saved file keeps the varying width
• The text tool writes printed or in handwriting, with the font embedded in the file
• Draw your signature once and stamp it wherever it is needed — it stays on your machine (placing a signature is not the same as digitally signing a document)
• Password-protected documents open: type the password and read, mark up and save as normal
• Colour, thickness and opacity per tool, remembered between sessions
• Correct a mark instead of redrawing it: drag either end of a highlight, or a corner of a shape
• Marks are saved back into the PDF itself as standard annotations, so the file reads the same in Acrobat and every other viewer

AI ASSISTANT (optional, bring your own key)
• Ask questions about the open document; every answer links to the passage it came from
• Structured article summaries; explain, simplify, critique or define selected text
• Snip a figure or a region and ask the assistant to explain it
• Search by meaning: describe a topic in your own words and get the passages that discuss it
• Eight providers, one key each: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral and Groq — or an OpenAI-compatible endpoint such as a local Ollama (no key needed). The document leaves your device only when you ask a question, and goes straight to the provider you chose; with a local model it never leaves at all

Free and open source (MIT). No account, no tracking, no ads. Everything works offline except the optional AI, which uses your own key.
```

**NO:**
```
PDF Scholar erstatter nettleserens innebygde PDF-visning med en leser og annotator laget for dokumentene du må jobbe deg gjennom: forskningsartikler, rapporter, bøker.

Åpne en PDF, og den blir en vanlig nettleserfane i PDF Scholar-leseren i stedet for nettleserens enkle visning. Gjør nettleseren til standard PDF-app, så åpnes lokale PDF-er også her.

LESING
• Jevn rulling og knip-zoom som blir stående der du slipper; tilpass bredde eller side
• Dag-, Sepia- og to Natt-temaer, med kontrast som kan justeres per tema
• Roter sider, tosiders oppslag og en fullskjerms presentasjonsmodus
• Delt visning: to kolonner av samme dokument, hver med egen side, zoom og rotasjon
• Innholdsfortegnelse, miniatyrer, bokmerker og søk (skill store/små, helord)
• Husker leseposisjon og nylige filer

ANNOTERING
Å annotere en artikkel avbryter aldri lesingen: verktøyene kommer til teksten du merket, og alt du har merket ligger ett panel unna.
• Merk et avsnitt, og menyen kommer til deg — utheving, understreking, en kommentar eller et notat, uten en tur innom verktøylinja
• Et Notater-panel holder hvert merke ett klikk unna: gruppert per side, søkbart, filtrert på farge og type, kommentarene redigerbare rett i lista — med eksport til Word, Markdown eller HTML
• Kommentarer i margen: én bryter viser hvert notat og hver kommentar som synlig tekst ved siden av siden, og en eksport setter dem i en ekte, bredere marg, nummerert ved ankrene — klar til utskrift
• Utheving, understreking, gjennomstreking og bølget strek; penn og tusj med hold-for-å-rette; former, gule lapper og fritekst
• Farge, tykkelse og gjennomsiktighet per verktøy, husket mellom økter
• Rett et merke i stedet for å tegne det på nytt: dra i enden av en utheving, eller i hjørnet av en form
• Merkene lagres inn i PDF-en selv som standard annoteringer, så filen ser lik ut i Acrobat og alle andre lesere

AI-ASSISTENT (valgfri, egen nøkkel)
• Still spørsmål om dokumentet du har åpent; hvert svar lenker til avsnittet det kom fra
• Strukturerte artikkelsammendrag; forklar, forenkle, kritiser eller definer merket tekst
• Klipp ut en figur eller et område og be assistenten forklare det
• Søk etter mening: beskriv et tema med dine egne ord og få avsnittene som handler om det
• Åtte leverandører, én nøkkel hver: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral og Groq — eller et OpenAI-kompatibelt endepunkt som en lokal Ollama (uten nøkkel). Dokumentet forlater maskinen bare når du stiller et spørsmål, og går rett til leverandøren du valgte; med en lokal modell forlater det aldri maskinen

Gratis og åpen kildekode (MIT). Ingen konto, ingen sporing, ingen reklame. Alt virker offline bortsett fra den valgfrie AI-en, som bruker din egen nøkkel.
```

---

## Permission justifications (reviewer-facing — Chrome & Edge both ask)

- **declarativeNetRequest** — "A single dynamic rule redirects main-frame navigations to `*.pdf` URLs to the extension's own viewer page, so PDFs open in PDF Scholar instead of the browser's built-in reader. It does not block, read, or modify any other request."
- **host access `<all_urls>` (http://*/*, https://*/*)** — "The PDF-open redirect must be able to fire on a PDF hosted at any address. The extension never reads, injects into, or alters the content of non-PDF web pages; it only acts on navigations that end in a PDF."
- **`file:///*`** — "Lets users open local PDF files (e.g. double-clicking a PDF in File Explorer) in the viewer. It only takes effect if the user additionally turns on 'Allow access to file URLs' on the extension's details page — a toggle only the user can grant."
- **storage** — "Saves the user's own settings (theme, language) and recent-file list locally on the device. Nothing is transmitted."

> **Do not declare `tabs`.** We only call `chrome.tabs.create` (toolbar click →
> viewer tab), which needs no permission; `tabs` only gates the sensitive tab
> fields we never read. Chrome Web Store rejected v0.17.1 for declaring it
> (violation ref "Purple Potassium", 2026-07-24) and removing it changed no
> behaviour.

## Data-use / privacy declarations

Answer the stores' data questions as follows (all true — see `docs/PRIVACY.md`):

- **Does this extension collect or use user data?** The extension itself collects and transmits **nothing** — no analytics, no telemetry, no accounts.
- **Website content:** the extension processes PDF content **locally, on the device**, only to render and annotate it. It is not sent anywhere by the reader.
- **The optional AI assistant** only runs when the user has configured **their own** AI provider and explicitly asks a question. It then sends the relevant document text **directly from the user's browser to the AI provider the user chose** (Anthropic / OpenAI / Azure OpenAI / an OpenAI-compatible endpoint of the user's choice, incl. a local model server), under the user's key and that provider's terms. PDF Scholar operates **no server** and receives none of this data.
- **Not sold or transferred** to third parties, except the user-directed AI call above.
- **No remote code:** all executable code ships inside the package; nothing is fetched and run at runtime. (The AI calls are data requests to the user's provider, not code.)
- **Privacy policy URL:** `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`

> Note on the broad host permissions: `<all_urls>` + `file:///*` +
> `declarativeNetRequest` routinely send a listing to the slower review queue.
> Expect a longer wait, and keep the answers to the single purpose above: PDF
> interception, no page-content access.

---

## Screenshots

Store requirement: **1280×800** PNG. Ready-to-upload files are in
**`docs/store-screenshots/`** (already scaled to exactly 1280×800 — just drag
them in), produced from the shoot by `npm run shoot:store`. Suggested order +
captions:

| File (`docs/store-screenshots/`) | Caption (EN) | Caption (NO) |
|------|-------------|-------------|
| `tricolor.png` | Reading themes: Day, Sepia and Night | Lesetemaer: Dag, Sepia og Natt |
| `annotations.png` | Annotation tools within reach, never in the way | Annoteringsverktøy innen rekkevidde, aldri i veien |
| `assistant.png` | AI assistant grounded in the document | AI-assistent forankret i dokumentet |
| `assistant_figure.png` | Snip a figure and ask what it shows | Klipp ut en figur og spør hva den viser |
| `dual-pane.png` | Two pages side by side in one window | To sider side om side i ett vindu |

Five slots is not many, so the themes share one frame: `tricolor.png` is the
same cover wiped Day → Sepia → Night, composed from the three theme shots
rather than photographed. That buys the two assistant frames their own slots.

Store icon: `src/extension/icons/icon-128.png` (128×128) is already in the
package; the stores pull it automatically. The dashboards additionally ask for
uploaded assets that do NOT come from the package — the 300×300 extension logo
and the 440×280 promo tile, both in `docs/store-assets/` (`npm run
icons:store`). Re-upload them after any icon change: they are the one branding
surface no build refreshes.

---

## Version note
The zip's `manifest.json` version is stamped from `package.json` at build time —
never edit it by hand. Each store update = upload a new zip built from a bumped
`package.json`.

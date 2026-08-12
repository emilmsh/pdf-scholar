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
**EN:** A PDF viewer for the browser, built for research: annotation at the selected text, split view, and an optional AI assistant.

**NO:** En PDF-leser i nettleseren, laget for forskning: annotering ved merket tekst, delt visning og en valgfri AI-assistent.

## Single purpose (Chrome requires this)
PDF Scholar replaces the browser's built-in PDF viewer with a full-featured reader and annotator, so PDFs opened in the browser can be read and marked up in one place.

---

## Detailed description

**EN:**
```
PDF Scholar replaces the browser's built-in PDF viewer with a reader and annotator for the documents you work through rather than skim: research articles, reports, books. The window is nearly all page — one slim toolbar carries the tools, and everything else stays out of the way until called, including the optional AI assistant.

Open a PDF and it becomes an ordinary browser tab in the PDF Scholar viewer instead of the browser's basic reader. Make your browser your default PDF app and local PDFs open here too.

READING
• Smooth scrolling; zoom centres on the cursor or pinch point; fit width or page
• Day, Sepia and two Night themes, with contrast adjustable per theme
• Page rotation, two-page spread, and a full-screen presentation mode
• Split view: two columns of the same document, each with its own page, zoom and rotation
• Table of contents, thumbnails and bookmarks
• Reading positions and recent files are remembered
• Keyboard shortcuts are listed in one map and can be rebound or reset

SEARCH
Both modes live in one search bar, a tab apart.
• By words: match case, whole word, a results list with excerpts, and every match marked on the page
• By meaning: describe a topic in your own words and get the passages that discuss it, ranked (uses the assistant's key)

ANNOTATION
Selecting text opens the annotation menu at the selection; every mark is listed in a panel beside the document.
• A notes panel lists every mark by page, with search and filters; comments are edited directly in the list — with export to Word, Markdown or HTML
• Comments in the margin: notes shown as visible text beside the page, and an export that sets them in a widened margin, numbered at their anchors
• Highlight, underline, strikeout and squiggly; pen and marker with hold-to-straighten; shapes, sticky notes and free text
• With a stylus, the pen draws while a finger scrolls; pen pressure varies the line width (beta) and is preserved in the saved file
• The text tool uses the PDF's standard typefaces — Helvetica, Times or Courier, bold and italic
• A signature can be drawn once and stamped where needed; it is stored locally (placing a signature is not the same as digitally signing a document)
• Password-protected documents open, can be annotated, and keep their protection when saved
• Colour, thickness and opacity are set per tool and remembered between sessions
• Existing marks can be adjusted rather than redrawn: the ends of a highlight, the corner of a shape
• Marks are saved into the PDF as standard annotations, so they open correctly in other PDF readers

AI ASSISTANT (optional, bring your own key)
• Answers cite their sources: each claim links to the passage it came from
• Structured article summaries; explain, simplify, critique or define selected text
• A figure or region can be cropped into the chat and asked about
• The assistant can open in its own tab; a citation click still goes to the passage in the tab showing the document
• Eight major AI services are supported, one key field each, alongside any endpoint that speaks the standard chat-completions API — including a local model server, which needs no key. The providers are listed on the project page. Requests go directly to the provider you chose; with a local model the document never leaves the machine

Free and open source (MIT). No account, no tracking, no ads. Everything works offline except the optional AI, which uses your own key.
```

**NO:**
```
PDF Scholar erstatter nettleserens innebygde PDF-visning med en leser og annotator for dokumentene du jobber deg gjennom og ikke bare skummer: forskningsartikler, rapporter, bøker. Vinduet er nesten bare side — én slank verktøylinje bærer verktøyene, og alt annet holder seg unna til det hentes fram, inkludert den valgfrie AI-assistenten.

Åpne en PDF, og den blir en vanlig nettleserfane i PDF Scholar-leseren i stedet for nettleserens enkle visning. Gjør nettleseren til standard PDF-app, så åpnes lokale PDF-er også her.

LESING
• Jevn rulling; zoom sentreres om pekeren eller knipepunktet; tilpass bredde eller side
• Dag-, Sepia- og to Natt-temaer, med kontrast som kan justeres per tema
• Siderotasjon, tosiders oppslag og en fullskjerms presentasjonsmodus
• Delt visning: to kolonner av samme dokument, hver med egen side, zoom og rotasjon
• Innholdsfortegnelse, miniatyrer og bokmerker
• Leseposisjon og nylige filer huskes
• Hurtigtastene står i ett kart og kan bindes om eller tilbakestilles

SØK
Begge modusene bor i én søkelinje, en fane fra hverandre.
• Etter ord: skill store/små, helord, en treffliste med utdrag, og hvert treff markert på siden
• Etter mening: beskriv et tema med egne ord og få avsnittene som omtaler det, rangert (bruker assistentens nøkkel)

ANNOTERING
Å merke tekst åpner annoteringsmenyen ved merkingen; hvert merke listes i et panel ved siden av dokumentet.
• Notatpanelet lister hvert merke per side, med søk og filtre; kommentarer redigeres direkte i lista — med eksport til Word, Markdown eller HTML
• Kommentarer i margen: notater vist som synlig tekst ved siden av siden, og en eksport som setter dem i en utvidet marg, nummerert ved ankrene
• Utheving, understreking, gjennomstreking og bølget strek; penn og tusj med hold-for-å-rette; former, gule lapper og fritekst
• Med penn på berøringsskjerm tegner pennen mens fingeren blar; pennetrykk varierer strekbredden (beta) og bevares i den lagrede filen
• Tekstverktøyet bruker PDF-ens standardskrifter — Helvetica, Times eller Courier, fet og kursiv
• Signaturen tegnes én gang og stemples inn der den trengs; den lagres lokalt (å plassere en signatur er ikke det samme som å signere digitalt)
• Passordbeskyttede dokumenter åpnes, kan annoteres, og beholder beskyttelsen ved lagring
• Farge, tykkelse og gjennomsiktighet settes per verktøy og huskes mellom økter
• Eksisterende merker kan justeres i stedet for å tegnes på nytt: enden av en utheving, hjørnet av en form
• Merkene lagres i PDF-en som standard annoteringer, så de åpnes riktig i andre PDF-lesere

AI-ASSISTENT (valgfri, egen nøkkel)
• Svarene viser kildene sine: hver påstand lenker til avsnittet den kom fra
• Strukturerte artikkelsammendrag; forklar, forenkle, kritiser eller definer merket tekst
• En figur eller et område kan klippes inn i samtalen og spørres om
• Assistenten kan åpnes i egen fane; et sitatklikk går fortsatt til avsnittet i fanen som viser dokumentet
• Åtte store AI-tjenester støttes, med ett nøkkelfelt hver, i tillegg til ethvert endepunkt som følger den vanlige chat-API-standarden — også en lokal modellserver, som ikke trenger nøkkel. Leverandørene er listet opp på prosjektsiden. Forespørslene går rett til leverandøren du valgte; med en lokal modell forlater dokumentet aldri maskinen

Gratis og åpen kildekode (MIT). Ingen konto, ingen sporing, ingen reklame. Alt virker offline bortsett fra den valgfrie AI-en, som bruker din egen nøkkel.
```

> **No third-party brand name belongs in the two description blocks above.**
> The Chrome Web Store rejected v0.38.2 for keyword spam (violation ref "Yellow
> Argon", 2026-08-12), quoting exactly the roll-call the AI bullet used to
> carry: "OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter,
> Grok (xAI), Mistral and Groq". Eight third-party trademarks in one line reads
> as brand stuffing to a reviewer however true each name is, and the policy
> covers the description as metadata.
>
> The rule here is deliberately stricter than the ruling. "OpenAI-compatible"
> (an interface name) and "opens correctly in Acrobat" (an interoperability
> claim) were both defensible, and both came out anyway: this item has been
> rejected twice without ever being approved, Chrome escalates on repeat
> violations, and it gates the launch — so the last thing a brand scanner could
> latch onto is worth more than the two words cost. Say what the capability
> does; the names live on the surfaces that are ours.
>
> Two carve-outs. The **permission and data-use answers below** are
> reviewer-facing, not metadata — being specific about which provider receives
> what is the point, and naming them there has never been an issue. And the
> **Microsoft Store listing** ([`STORE-LISTING-DESKTOP.md`](STORE-LISTING-DESKTOP.md))
> keeps its full list: it was reviewed with it and passed. Do not "fix" either
> one to match this file.

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
| `annotations.png` | Annotation at the selected text | Annotering ved merket tekst |
| `assistant.png` | AI assistant with source references | AI-assistent med kildehenvisninger |
| `assistant_figure.png` | Ask about a cropped figure | Spør om en utklippet figur |
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

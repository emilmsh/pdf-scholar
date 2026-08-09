# Desktop app store listing — paste-ready copy (Microsoft Store)

Copy for the **PDF Scholar** desktop app on the **Microsoft Store** (MSIX). This is
the *desktop* companion to `docs/STORE-LISTING.md` (which covers the browser
extension). Kept in sync with the app; refresh the "What's new" block on every
submission. Field limits noted per section.

**The claims come from [`MESSAGING.md`](MESSAGING.md)** — the master for what we
say about the product here, in the README, on the landing page and in the
extension listing. Change a claim there first; this file is one rendering of it.
Its shape is also machine-parsed (`scripts/lib/store-listing.ps1`), so keep the
headings and the `**EN:**` / `**NO:**` fenced blocks exactly as they are, and run
`npm run test:listing` after editing.

Category: **Productivity**. Primary language: English; add Norwegian if the
listing supports a localized variant. Privacy policy URL:
`https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`

> **Product declaration (required):** in Properties → Product declarations, tick
> **"This product incorporates generative AI features…"** — the assistant
> generates text (Store policy 11.16). This checkbox failed v0.17.1 certification.

---

## Name
PDF Scholar

## Short / summary description (≤ ~250 chars)
**EN:** A PDF reader for Windows where the window is nearly all page — one slim toolbar, and everything else out of the way until you call it, including an optional AI assistant that cites the passage it used. Free and open source.

**NO:** En PDF-leser for Windows der vinduet er nesten bare side — én slank verktøylinje, og alt annet unna til du henter det fram, inkludert en valgfri AI-assistent som viser hvor svaret kom fra. Gratis og åpen kildekode.

---

## Description (≤ 10 000 chars)

**EN:**
```
PDF Scholar is a PDF reader and annotator for Windows, for the documents you work through rather than skim: research articles, reports, books. The window is nearly all page — one slim toolbar carries the tools, the panels stay out of the way until called, and the toolbar itself can be unpinned. Annotation happens at the text you select, every mark is listed in a panel beside the document, and the optional AI assistant answers from the document and cites the passage it used.

Free and open source (MIT). No account, no sign-in, no tracking, no ads. Everything works offline except the optional AI, which uses your own key. Native x64 and arm64, so Windows-on-ARM machines run the app without emulation. The Store keeps it updated.

READING
• Smooth scrolling; zoom centres on the cursor or pinch point; fit width or page
• Day, Sepia and two Night themes, with contrast and brightness adjustable per theme
• Page rotation, two-page spread, and a full-screen presentation mode
• Table of contents, thumbnails, bookmarks, and search with match-case and whole-word options
• Reading positions and recent files are remembered; back/forward navigation after following internal links
• Going back to the library closes nothing: documents stay open, and returning to one restores your place
• Keyboard shortcuts are listed in one map and can be rebound or reset
• Opens PDFs from File Explorer, with a Recent list on the taskbar

SPLIT VIEW
• Two columns of the same document, each with its own page, zoom and rotation — a table or figure can stay in view beside the text that discusses it
• Annotations made in either column appear in both; two windows on one file also stay in sync
• Ctrl+click on an internal link opens the target in the other column

ANNOTATION
Selecting text opens the annotation menu at the selection; every mark is listed in a panel beside the document.
• Highlight, underline, strikeout and squiggly; pen and marker with hold-to-straighten; shapes, sticky notes, free text and text-anchored comments
• The notes panel lists every mark by page, with search and filters; comments are edited directly in the list; a summary exports to Word, Markdown or HTML
• Comments in the margin: notes shown as visible text beside the page, and an export that sets them in a widened margin, numbered at their anchors — the original untouched
• With a stylus, the pen draws while a finger scrolls and zooms; pen pressure varies the line width (beta) and is preserved in the saved file
• The text tool uses the PDF's standard typefaces — Helvetica, Times or Courier, bold and italic — so the text stays searchable in every reader
• A signature can be drawn once — or added as an image — and stamped where needed. It is stored locally (placing a signature is not the same as digitally signing a document)
• Password-protected documents open, can be annotated, and keep their protection when saved
• Colour, thickness and opacity are set per tool and remembered; existing marks can be adjusted rather than redrawn
• An optional name in settings fills the standard PDF author field on new annotations
• Edits are held in a draft until saved; what is saved is standard PDF annotations, which open correctly in Acrobat and other viewers

AI ASSISTANT (optional — bring your own key)
• Answers cite their sources: each claim links to the passage it came from
• Structured article summaries; explain, simplify, critique or define selected text
• A figure or region can be cropped into the chat and asked about
• Semantic search: describe a topic in your own words and get the passages that discuss it
• Scanned documents are identified as such; a page range can be attached as images for the assistant to read
• LaTeX in answers is rendered; optional web search, off by default
• Providers: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral and Groq — one key field each — plus any OpenAI-compatible endpoint and local models via Ollama or LM Studio (no key needed). Requests go directly to the provider; with a local model the document never leaves the machine. PDF Scholar operates no server.

Source code: https://github.com/emilmsh/pdf-scholar
```

**NO:**
```
PDF Scholar er en PDF-leser og -annotator for Windows, for dokumentene du jobber deg gjennom og ikke bare skummer: forskningsartikler, rapporter, bøker. Vinduet er nesten bare side — én slank verktøylinje bærer verktøyene, panelene holder seg unna til de hentes fram, og verktøylinja kan løsnes helt. Annotering skjer ved teksten du merker, hvert merke listes i et panel ved siden av dokumentet, og den valgfrie AI-assistenten svarer ut fra dokumentet og viser hvilket avsnitt den brukte.

Gratis og åpen kildekode (MIT). Ingen konto, ingen innlogging, ingen sporing, ingen reklame. Alt virker offline bortsett fra den valgfrie AI-en, som bruker din egen nøkkel. Både x64 og arm64, så Windows-på-ARM-maskiner kjører appen uten emulering. Store holder appen oppdatert.

LESING
• Jevn rulling; zoom sentreres om pekeren eller knipepunktet; tilpass bredde eller side
• Dag-, Sepia- og to Natt-temaer, med kontrast og lysstyrke justerbar per tema
• Siderotasjon, tosiders oppslag og fullskjerms presentasjonsmodus
• Innholdsfortegnelse, miniatyrer, bokmerker og søk med skill store/små og helord
• Leseposisjon og nylige filer huskes; fram/tilbake-navigasjon etter fulgte interne lenker
• Å gå til biblioteket lukker ingenting: dokumentene forblir åpne, og du kommer tilbake dit du var
• Hurtigtastene står i ett kart og kan bindes om eller tilbakestilles
• Åpner PDF-er fra Utforsker, med en «Nylig»-liste på oppgavelinjen

DELT VISNING
• To kolonner av samme dokument, hver med egen side, zoom og rotasjon — en tabell eller figur kan stå framme ved siden av teksten som omtaler den
• Merknader satt i én kolonne vises i begge; to vinduer på samme fil holdes også synkronisert
• Ctrl+klikk på en intern lenke åpner målet i den andre kolonnen

ANNOTERING
Å merke tekst åpner annoteringsmenyen ved merkingen; hvert merke listes i et panel ved siden av dokumentet.
• Utheving, understreking, gjennomstreking og bølget strek; penn og tusj med hold-for-å-rette; former, gule lapper, fritekst og tekstforankrede kommentarer
• Notatpanelet lister hvert merke per side, med søk og filtre; kommentarer redigeres direkte i lista; en oppsummering eksporteres til Word, Markdown eller HTML
• Kommentarer i margen: notater vist som synlig tekst ved siden av siden, og en eksport som setter dem i en utvidet marg, nummerert ved ankrene — originalen urørt
• Med penn på berøringsskjerm tegner pennen mens fingeren blar og zoomer; pennetrykk varierer strekbredden (beta) og bevares i den lagrede filen
• Tekstverktøyet bruker PDF-ens standardskrifter — Helvetica, Times eller Courier, fet og kursiv — så teksten forblir søkbar i enhver leser
• Signaturen tegnes én gang — eller legges til som bilde — og stemples inn der den trengs. Den lagres lokalt (å plassere en signatur er ikke det samme som å signere digitalt)
• Passordbeskyttede dokumenter åpnes, kan annoteres, og beholder beskyttelsen ved lagring
• Farge, tykkelse og gjennomsiktighet settes per verktøy og huskes; eksisterende merker kan justeres i stedet for å tegnes på nytt
• Et valgfritt navn i innstillingene fyller PDF-ens standard forfatterfelt på nye merknader
• Endringer holdes i et utkast til du lagrer; det som lagres er standard PDF-annoteringer, som åpnes riktig i Acrobat og andre lesere

AI-ASSISTENT (valgfri — egen nøkkel)
• Svarene viser kildene sine: hver påstand lenker til avsnittet den kom fra
• Strukturerte artikkelsammendrag; forklar, forenkle, kritiser eller definer merket tekst
• En figur eller et område kan klippes inn i samtalen og spørres om
• Semantisk søk: beskriv et tema med egne ord og få avsnittene som omtaler det
• Skannede dokumenter identifiseres som det; et sideutvalg kan legges ved som bilder som assistenten leser
• LaTeX i svar gjengis; valgfritt nettsøk, av som standard
• Leverandører: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral og Groq — ett nøkkelfelt hver — pluss et hvilket som helst OpenAI-kompatibelt endepunkt og lokale modeller via Ollama eller LM Studio (uten nøkkel). Forespørslene går rett til leverandøren; med en lokal modell forlater dokumentet aldri maskinen. PDF Scholar driver ingen egen server.

Kildekode: https://github.com/emilmsh/pdf-scholar
```

---

## What's new in this version (≤ 1 500 chars) — v0.37.0

**EN:**
```
• Every keyboard shortcut is now listed in one map in settings — grouped by task, the whole thing readable at a glance — and any of them can be rebound or reset
• Going back to the library no longer closes your documents: they stay in the tab strip, and clicking one returns you exactly where you were
• The text tool offers a real typeface choice — Helvetica, Times or Courier, bold and italic — picked before you type or changed afterwards on a box that already exists. They are the PDF's own fonts, so the words stay real, searchable text in every reader
• Black is properly black now, for the pen and the text tool alike. It used to be a soft off-black that read as grey in the dark themes
• A slimmer toolbar: print moved in beside Save, and the tools you reach for are less crowded
• Drawing with a mouse is smooth again — the line no longer wanders ahead of the cursor before settling
• A signature can be uploaded or pasted as a picture instead of drawn, and a photographed one has its paper removed so only the ink lands on the page
```

**NO:**
```
• Alle hurtigtaster står nå i ett kart i innstillingene — gruppert etter oppgave, hele oversikten lesbar på én gang — og hver enkelt kan bindes om eller tilbakestilles
• Å gå tilbake til biblioteket lukker ikke lenger dokumentene: de blir stående i fanestripa, og ett klikk tar deg tilbake nøyaktig dit du var
• Tekstverktøyet har fått et ekte skriftvalg — Helvetica, Times eller Courier, fet og kursiv — valgt før du skriver eller endret etterpå på en boks som alt finnes. Det er PDF-ens egne skrifter, så ordene forblir ekte, søkbar tekst i enhver leser
• Svart er ordentlig svart nå, for både penn og tekst. Før var det en myk nesten-svart som leste som grå i mørke temaer
• En slankere verktøylinje: utskrift har flyttet inn ved siden av Lagre, og verktøyene du strekker deg etter har fått bedre plass
• Å tegne med mus er jevnt igjen — streken vandrer ikke lenger foran musepekeren før den faller på plass
• Signaturen kan lastes opp eller limes inn som bilde i stedet for å tegnes, og et fotografert eksemplar får papiret fjernet så bare blekket havner på siden
```

---

---

## Partner Center listing fields

The live listing has **two** languages, `en-us` and `no` (`store-publish.ps1
-CheckOnly` prints what is published), and both blocks below are live copy. The
publish script routes NO copy to `nb`/`nn`/`no` listings and EN to everything
else, so each gets its own description, features and release notes.

### Product features (≤ 20 items, ≤ 200 chars each)

**EN:**
```
PDF reader and annotator for Windows, for long documents: articles, reports, books
Day, Sepia and two Night themes, adjustable per theme
Split view: two columns of one document, each with its own page, zoom and rotation
Selecting text opens the annotation menu at the selection
A notes panel lists every mark, with search, filters and export to Word, Markdown or HTML
Comments in the margin, and a print-ready export with the comments set in a widened margin
Highlight, underline, strikeout, squiggly, pen, marker, shapes, notes and free text
Pressure-sensitive pen (beta); the pen draws while a finger scrolls
Existing marks can be adjusted rather than redrawn
Standard PDF annotations that open correctly in Acrobat and other viewers
Optional AI assistant that cites the passage each answer came from
Bring your own AI key, or run a local model via Ollama/LM Studio with no key
Native x64 and arm64; the Store keeps the app updated
Free and open source (MIT) — no account, no tracking, no ads
```

**NO:**
```
PDF-leser og -annotator for Windows, for lange dokumenter: artikler, rapporter, bøker
Dag-, Sepia- og to Natt-temaer, justerbare per tema
Delt visning: to kolonner av ett dokument, hver med egen side, zoom og rotasjon
Å merke tekst åpner annoteringsmenyen ved merkingen
Et notatpanel lister hvert merke, med søk, filtre og eksport til Word, Markdown eller HTML
Kommentarer i margen, og en utskriftsklar eksport med kommentarene satt i en utvidet marg
Utheving, understreking, gjennomstreking, bølget strek, penn, tusj, former, notater og fritekst
Trykkfølsom penn (beta); pennen tegner mens fingeren blar
Eksisterende merker kan justeres i stedet for å tegnes på nytt
Standard PDF-annoteringer som åpnes riktig i Acrobat og andre lesere
Valgfri AI-assistent som viser hvilket avsnitt hvert svar kom fra
Bruk din egen AI-nøkkel, eller kjør en lokal modell via Ollama/LM Studio uten nøkkel
Både x64 og arm64; Store holder appen oppdatert
Gratis og åpen kildekode (MIT) — ingen konto, ingen sporing, ingen reklame
```

### Search terms (≤ 7, ≤ 30 chars each — not shown to users)

**EN:** `PDF reader`, `PDF annotator`, `annotate PDF`, `highlight PDF`, `PDF viewer`, `research papers`, `AI PDF assistant`

**NO:** `PDF-leser`, `PDF-annotator`, `annoter PDF`, `uthev PDF`, `PDF-visning`, `forskningsartikler`, `AI PDF-assistent`

### Copyright and trademark info (≤ 200 chars)

**EN:** `© 2026 Emil Mathias Strøm Halseth. Free and open source under the MIT License.`

**NO:** `© 2026 Emil Mathias Strøm Halseth. Gratis og åpen kildekode under MIT-lisensen.`

### Additional license terms (≤ 10 000 chars)

**EN:**
```
PDF Scholar is free and open-source software, licensed under the MIT License: https://github.com/emilmsh/pdf-scholar/blob/master/LICENSE

The AI assistant is optional and runs on your own third-party API key (Anthropic, OpenAI, Azure OpenAI or another OpenAI-compatible service) or on a local model server (e.g. Ollama or LM Studio, no key needed). When you use it, the relevant document text is sent from your device directly to the provider you chose, under your key and that provider's terms — with a local model it stays on your device. PDF Scholar operates no server and collects no data. See the privacy policy: https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md
```

**NO:**
```
PDF Scholar er gratis og åpen kildekode, lisensiert under MIT-lisensen: https://github.com/emilmsh/pdf-scholar/blob/master/LICENSE

AI-assistenten er valgfri og bruker din egen tredjeparts API-nøkkel (Anthropic, OpenAI, Azure OpenAI eller en annen OpenAI-kompatibel tjeneste) eller en lokal modellserver (f.eks. Ollama eller LM Studio, uten nøkkel). Når du bruker den, sendes relevant dokumenttekst fra maskinen din direkte til leverandøren du valgte, under din nøkkel og deres vilkår — med en lokal modell blir den på maskinen. PDF Scholar kjører ingen egen server og samler ikke inn data. Se personvernerklæringen: https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md
```

### Developed by (≤ 255 chars)
`Emil Mathias Strøm Halseth`

## Screenshots
1280×800 PNGs live in `docs/store-screenshots/`, and the captioned set in
`docs/STORE-LISTING.md` applies to the desktop listing too: themes, annotation,
assistant, snip-a-figure, split view. Which frame goes to which surface is
listed once in `scripts/lib/shots.json` (rendered as a table in
`docs/RELEASE.md`). Store icon: `build/icon.png` (512×512).

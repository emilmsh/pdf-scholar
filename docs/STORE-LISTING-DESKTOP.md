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
**EN:** A PDF reader and annotator for Windows, for people who read long documents for work. Annotation tools within reach and never in the way, split view, and an optional AI assistant that cites the passage it used. Free and open source.

**NO:** En PDF-leser og -annotator for Windows, for folk som leser lange dokumenter i jobben. Annoteringsverktøy innen rekkevidde og aldri i veien, delt visning, og en valgfri AI-assistent som viser hvor svaret kom fra. Gratis og åpen kildekode.

---

## Description (≤ 10 000 chars)

**EN:**
```
PDF Scholar is a PDF reader and annotator for Windows, for the documents you have to work through rather than skim: research articles, reports, books. Marking up a paper never interrupts reading it — the tools come to the text you selected and everything you have marked stays one panel away. The optional AI assistant answers from the document and shows which passage it used, and the toolbar can be hidden when you want the whole window showing the page.

Free and open source (MIT). No account, no sign-in, no tracking, no ads. Everything works offline except the optional AI, which uses your own key. Native x64 and arm64, so Windows-on-ARM machines like the Surface run the arm64 build rather than x64 under emulation. The Store keeps it updated automatically.

READING
• Smooth scrolling and pinch zoom that stays where you release it; fit width or page; opening zoom follows the file's own setting, as Acrobat does
• Day, Sepia and two Night themes; the Sepia tone matches Apple Books
• Rotate pages, two-page spread, and a full-screen presentation mode
• Table of contents, thumbnails, bookmarks, and search that marks every hit on the page while you look (match case / whole word)
• Remembers your reading position and recent files; the mouse side-buttons move back and forward through your navigation history
• Opens PDFs straight from File Explorer, with a "Recent" Jump List on the taskbar

SPLIT VIEW
• Two columns of the same document, each with its own page, zoom and rotation — keep a figure or a landscape-printed table in view while you read the text about it
• Annotate in either column; it is one document, so a mark shows up in both as you make it
• Ctrl+click an internal link to open the target in the other column, keeping the page you are on
• Two windows on the same file work as well: they share one draft and sync as you annotate

ANNOTATION
• Select a passage and the menu comes to you — highlight, underline, a comment or a note, without a trip to the toolbar and back
• A Notes panel keeps every mark one click away: grouped by page, searchable, filtered by colour and type, and a click takes you to the mark. Comments edit right in the list
• Comments in the margin: one switch shows every note and comment as visible text beside the page — left or right — with a leader line to the passage it belongs to
• Export a copy with the comments set in a real widened margin, numbered at their anchors — ready to print, the original untouched
• The same tools sit in the toolbar for marking several passages in a row, and the toolbar unpins when you want nothing but the page
• Highlight, underline, strikeout and a true-wave squiggly, in your own colours
• Pen and marker with hold-to-straighten, shapes, sticky notes and free text in the colour and size you pick
• Colour, thickness and opacity per tool, remembered between sessions
• Correct a mark instead of redrawing it: drag either end of a highlight, or a corner of a shape, text box or drawing
• Comments anchored to the text they mark
• Export a summary of every mark — the highlighted text included — to Word, Markdown or HTML
• An optional name in settings signs new annotations — the standard PDF author field other readers show
• Standard PDF annotations that open correctly in Acrobat and every other viewer — not flattened images
• A save guard that warns before overwriting a file another program has changed, and "save a copy" that continues in the copy

AI ASSISTANT (optional — bring your own key)
• Ask questions about the open document; every answer links to the passage it came from
• Structured article summaries; explain, simplify, critique, define or ask about selected text
• Snip a figure or region and ask the assistant to explain it
• Search by meaning: describe a topic in your own words and get the passages that discuss it, ranked and clickable
• A scanned PDF — pictures of words, with no text to search — is named as such rather than answered about blindly; attach a page range and the assistant reads those pages as images
• LaTeX/TeX renders properly in answers, so maths stays readable
• Optional web search, off by default: closed, on request, or always on
• Eight providers, one key field each: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral and Groq — plus any OpenAI-compatible endpoint and local models via Ollama or LM Studio (no key needed). The document leaves your device only when you ask a question, and goes straight to the provider you chose, under your key and their terms; with a local model it never leaves at all. PDF Scholar runs no server of its own.

Source code: https://github.com/emilmsh/pdf-scholar
```

**NO:**
```
PDF Scholar er en PDF-leser og -annotator for Windows, for dokumentene du må jobbe deg gjennom og ikke bare skumme: forskningsartikler, rapporter, bøker. Å annotere en artikkel avbryter aldri lesingen — verktøyene kommer til teksten du merket, og alt du har merket ligger ett panel unna. Den valgfrie AI-assistenten svarer ut fra dokumentet og viser hvilket avsnitt den brukte, og verktøylinja kan skjules når du vil at hele vinduet skal vise siden.

Gratis og åpen kildekode (MIT). Ingen konto, ingen innlogging, ingen sporing, ingen reklame. Alt virker offline bortsett fra den valgfrie AI-en, som bruker din egen nøkkel. Både x64 og arm64, så Windows-på-ARM-maskiner som Surface kjører arm64-varianten framfor x64 under emulering. Store holder appen automatisk oppdatert.

LESING
• Jevn rulling og knip-zoom som blir stående der du slipper; tilpass bredde eller side; åpningszoom følger filens egen innstilling, slik Acrobat gjør
• Dag-, Sepia- og to Natt-temaer; Sepia-tonen matcher Apple Books
• Roter sider, tosiders oppslag og en fullskjerms presentasjonsmodus
• Innholdsfortegnelse, miniatyrer, bokmerker og søk som markerer alle treff på siden mens du leter (skill store/små, helord)
• Husker leseposisjon og nylige filer; museknappene på siden går fram og tilbake i navigasjonshistorikken
• Åpner PDF-er rett fra Utforsker, med en «Nylig»-hurtigliste på oppgavelinjen

DELT VISNING
• To kolonner av samme dokument, hver med egen side, zoom og rotasjon — hold en figur eller en liggende tabell framme mens du leser teksten om den
• Annoter i begge kolonner; det er ett dokument, så et merke vises i begge idet du lager det
• Ctrl+klikk en intern lenke for å åpne målet i den andre kolonnen, mens siden du står på blir stående
• To vinduer på samme fil virker også: de deler ett utkast og synkroniseres mens du annoterer

ANNOTERING
• Merk et avsnitt, og menyen kommer til deg — utheving, understreking, en kommentar eller et notat, uten en tur innom verktøylinja
• Et Notater-panel holder hvert merke ett klikk unna: gruppert per side, søkbart, filtrert på farge og type, og ett klikk tar deg til merket. Kommentarene redigeres rett i lista
• Kommentarer i margen: én bryter viser hvert notat og hver kommentar som synlig tekst ved siden av siden — venstre eller høyre — med en strek til avsnittet den hører til
• Eksporter en kopi med kommentarene satt i en ekte, bredere marg, nummerert ved ankrene — klar til utskrift, originalen urørt
• De samme verktøyene ligger i verktøylinja når du skal merke flere avsnitt på rad, og linja kan løsnes når du bare vil ha siden
• Utheving, understreking, gjennomstreking og en ekte bølget strek, i dine egne farger
• Penn og tusj med hold-for-å-rette, former, gule lapper og fritekst i farge og størrelse du velger
• Farge, tykkelse og gjennomsiktighet per verktøy, husket mellom økter
• Rett et merke i stedet for å tegne det på nytt: dra i enden av en utheving, eller i hjørnet av en form, tekstboks eller tegning
• Kommentarer forankret til teksten de merker
• Eksporter en oppsummering av alle merker — den uthevede teksten inkludert — til Word, Markdown eller HTML
• Et valgfritt navn i innstillingene signerer nye merknader — det standard forfatterfeltet andre lesere viser
• Standard PDF-annoteringer som åpnes riktig i Acrobat og alle andre lesere — ikke flate bilder
• En lagringsvakt som varsler før den overskriver en fil et annet program har endret, og «lagre en kopi» som fortsetter i kopien

AI-ASSISTENT (valgfri — egen nøkkel)
• Still spørsmål om dokumentet du har åpent; hvert svar lenker til avsnittet det kom fra
• Strukturerte artikkelsammendrag; forklar, forenkle, kritiser, definer eller spør om merket tekst
• Klipp ut en figur eller et område og be assistenten forklare det
• Søk etter mening: beskriv et tema med dine egne ord og få avsnittene som handler om det, rangert og klikkbare
• En skannet PDF — bilder av ord, uten tekst å søke i — sies det fra om i stedet for å svares på i blinde; legg ved et sideutvalg, så leser assistenten de sidene som bilder
• LaTeX/TeX vises riktig i svar, så matematikk holder seg lesbar
• Valgfritt nettsøk, av som standard: lukket, på forespørsel, eller alltid på
• Åtte leverandører, ett nøkkelfelt hver: OpenAI, Claude (Anthropic), Google Gemini, Azure OpenAI, OpenRouter, Grok (xAI), Mistral og Groq — pluss et hvilket som helst OpenAI-kompatibelt endepunkt og lokale modeller via Ollama eller LM Studio (uten nøkkel). Dokumentet forlater maskinen bare når du stiller et spørsmål, og går rett til leverandøren du valgte, under din nøkkel og deres vilkår; med en lokal modell forlater det aldri maskinen. PDF Scholar kjører ingen egen server.

Kildekode: https://github.com/emilmsh/pdf-scholar
```

---

## What's new in this version (≤ 1 500 chars) — v0.33.x

**EN:**
```
• Comments in the margin: one switch shows every note and comment as visible text beside the page — left or right — with a leader line to the passage it belongs to, and arrows to the nearest comment when none is in view
• Export with comments in the margin: a copy of the document with every page widened and the comments set in the new margin, numbered at their anchors — ready to print, the original untouched
• The Notes panel grew up: comments edit right in the list (even on marks that have none yet), with type and with/without-comment filters beside the colour dots
• The text tool picks up colour and size — red teacher's pen included — and a text box can no longer be shrunk below its own words
• An optional name in settings signs new annotations — the standard PDF author field other readers show
• The assistant works with eight AI providers, one key field each — or local models via Ollama/LM Studio, no key at all
```

**NO:**
```
• Kommentarer i margen: én bryter viser hvert notat og hver kommentar som synlig tekst ved siden av siden — venstre eller høyre — med en strek til avsnittet den hører til, og piler til nærmeste kommentar når ingen er i synsfeltet
• Eksport med kommentarer i margen: en kopi av dokumentet med bredere sider og kommentarene satt i den nye margen, nummerert ved ankrene — klar til utskrift, originalen urørt
• Notater-panelet har vokst: kommentarene redigeres rett i lista (også på merker som ikke har noen ennå), med type- og med/uten-kommentar-filter ved siden av fargeprikkene
• Tekstverktøyet har fått farge og størrelse — rød rettepenn inkludert — og en tekstboks kan ikke lenger krympes under sine egne ord
• Et valgfritt navn i innstillingene signerer nye merknader — det standard forfatterfeltet andre lesere viser
• Assistenten virker med åtte AI-leverandører, ett nøkkelfelt hver — eller lokale modeller via Ollama/LM Studio, helt uten nøkkel
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
PDF reader and annotator for Windows, for reading long documents
Smooth scrolling and pinch zoom that stays where you release it
Day, Sepia and two Night themes for long reading sessions
Two-page spread, page rotation and full-screen presentation mode
Split view: two columns of one document, each with its own page, zoom and rotation
Annotate in both columns at once, or in two windows on the same file
Select text and the annotation menu comes to you — no trip to the toolbar and back
Notes panel that keeps every mark one click away — comments edit right in the list
Comments in the margin: notes as visible text beside the page, left or right
Export a print-ready copy with the comments in a real widened margin, numbered at their anchors
Highlight, underline, strikeout and true-wave squiggly, in your own colours
Pen and marker, shapes, sticky notes, free text and text-anchored comments
Colour, thickness and opacity per tool, remembered between sessions
Correct a mark instead of redrawing it: drag a highlight's end or a shape's corner
Standard PDF annotations that open correctly in Acrobat
Optional AI assistant that links every answer to the passage it came from
Snip a figure and ask the assistant to explain it; LaTeX renders in answers
Bring your own AI key — or run a local model via Ollama/LM Studio, no key at all
Native x64 and arm64; the Store keeps it updated automatically
Free and open source (MIT) — no account, no tracking, no ads
```

**NO:**
```
PDF-leser og -annotator for Windows, for lesing av lange dokumenter
Jevn rulling og knip-zoom som blir stående der du slipper
Dag-, Sepia- og to Natt-temaer for lange leseøkter
Tosiders oppslag, siderotasjon og fullskjerms presentasjonsmodus
Delt visning: to kolonner av ett dokument, hver med egen side, zoom og rotasjon
Annoter i begge kolonner samtidig, eller i to vinduer på samme fil
Merk tekst, og annoteringsmenyen kommer til deg — uten en tur innom verktøylinja
Notater-panel som holder hvert merke ett klikk unna — kommentarene redigeres rett i lista
Kommentarer i margen: notater som synlig tekst ved siden av siden, venstre eller høyre
Eksporter en utskriftsklar kopi med kommentarene i en ekte, bredere marg, nummerert ved ankrene
Utheving, understreking, gjennomstreking og ekte bølget strek, i egne farger
Penn og tusj, former, gule lapper, fritekst og tekstforankrede kommentarer
Farge, tykkelse og gjennomsiktighet per verktøy, husket mellom økter
Rett et merke i stedet for å tegne det på nytt: dra i enden av en utheving eller hjørnet av en form
Standard PDF-annoteringer som åpnes riktig i Acrobat
Valgfri AI-assistent som lenker hvert svar til avsnittet det kom fra
Klipp ut en figur og be assistenten forklare den; LaTeX vises i svar
Bruk din egen AI-nøkkel — eller kjør en lokal modell via Ollama/LM Studio, helt uten nøkkel
Både x64 og arm64; Store holder appen automatisk oppdatert
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

# Extension store listing — paste-ready copy

Everything needed to submit the **PDF Scholar** browser extension to **Edge
Add-ons** (free) and the **Chrome Web Store** ($5 one-time). Upload
`pdf-scholar-extension-store.zip` (manifest at the zip root — from the v0.15.0
release, or run `npm run build:ext` and zip the contents of `dist-extension/`).
See `docs/STORE.md` for the account setup. Privacy policy URL (both stores):
`https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`

Category: **Productivity**. Language: primary English, add Norwegian if the
store supports a localized listing.

---

## Name
PDF Scholar

## Short description (≤132 chars — Chrome limit)
**EN:** Read and annotate PDFs in a calm, distraction-free viewer — highlights, notes, drawing, and an optional AI assistant.

**NO:** Les og annoter PDF-er i en rolig, distraksjonsfri leser — utheving, notater, tegning og en valgfri AI-assistent.

## Single purpose (Chrome requires this)
PDF Scholar replaces the browser's built-in PDF viewer with a full-featured reader and annotator, so PDFs opened in the browser can be read and marked up in one place.

---

## Detailed description

**EN:**
```
PDF Scholar turns your browser into a calm, reading-first PDF workspace — built for people who read to work: research articles, reports, books.

Open a PDF and it becomes an ordinary browser tab in the PDF Scholar viewer instead of the browser's basic reader. Make your browser your default PDF app and local PDFs open here too.

READING
• Smooth scrolling and pinch-zoom that never jumps on release; fit width/page
• Day, Sepia and two Night themes, with per-theme contrast for long sessions
• Rotate pages, two-page spread, and a full-screen presentation mode
• Table of contents, thumbnails, search (match case / whole word), and read-aloud
• Remembers your reading position and recent files

ANNOTATION
• Highlight, underline, strikeout, squiggly — with custom colours
• Pen and marker with hold-to-straighten, shapes, sticky notes, free text
• Real PDF annotations that open correctly in Acrobat and other viewers
• A Notes panel that collects every mark by page, with export to Markdown/HTML/text

AI ASSISTANT (optional, bring your own key)
• Chat with the document — every answer links back to the exact passage
• Structured article summaries; explain, simplify or define selected text
• Works with your own Anthropic, OpenAI or Azure OpenAI key; the document leaves your device only when you ask a question, sent straight to your chosen provider

Free and open source (MIT). No account, no tracking, no ads. Everything works offline except the optional AI, which uses your own key.
```

**NO:**
```
PDF Scholar gjør nettleseren til en rolig, lesevennlig PDF-arbeidsflate — laget for folk som leser for å jobbe: forskningsartikler, rapporter, bøker.

Åpne en PDF, og den blir en vanlig nettleserfane i PDF Scholar-leseren i stedet for nettleserens enkle visning. Gjør nettleseren til standard PDF-app, så åpnes lokale PDF-er også her.

LESING
• Jevn rulling og knip-zoom som aldri hopper; tilpass bredde/side
• Dag-, Sepia- og to Natt-temaer, med kontrast per tema for lange økter
• Roter sider, tosiders oppslag og en fullskjerms presentasjonsmodus
• Innholdsfortegnelse, miniatyrer, søk (skill store/små, helord) og opplesning
• Husker leseposisjon og nylige filer

ANNOTERING
• Utheving, understreking, gjennomstreking, bølget — med egne farger
• Penn og tusj med hold-for-å-rette, former, gule lapper, fritekst
• Ekte PDF-annoteringer som åpnes riktig i Acrobat og andre lesere
• Et Notater-panel som samler alle merker per side, med eksport til Markdown/HTML/tekst

AI-ASSISTENT (valgfri, egen nøkkel)
• Snakk med dokumentet — hvert svar lenker til det nøyaktige avsnittet
• Strukturerte artikkelsammendrag; forklar, forenkle eller definer merket tekst
• Bruker din egen Anthropic-, OpenAI- eller Azure OpenAI-nøkkel; dokumentet forlater maskinen bare når du stiller et spørsmål, sendt rett til din valgte leverandør

Gratis og åpen kildekode (MIT). Ingen konto, ingen sporing, ingen reklame. Alt virker offline bortsett fra den valgfrie AI-en, som bruker din egen nøkkel.
```

---

## Permission justifications (reviewer-facing — Chrome & Edge both ask)

- **declarativeNetRequest** — "A single dynamic rule redirects main-frame navigations to `*.pdf` URLs to the extension's own viewer page, so PDFs open in PDF Scholar instead of the browser's built-in reader. It does not block, read, or modify any other request."
- **host access `<all_urls>` (http://*/*, https://*/*)** — "The PDF-open redirect must be able to fire on a PDF hosted at any address. The extension never reads, injects into, or alters the content of non-PDF web pages; it only acts on navigations that end in a PDF."
- **`file:///*`** — "Lets users open local PDF files (e.g. double-clicking a PDF in File Explorer) in the viewer. It only takes effect if the user additionally turns on 'Allow access to file URLs' on the extension's details page — a toggle only the user can grant."
- **tabs** — "Opens the viewer in a new tab when the toolbar icon is clicked and manages that viewer tab. It is not used to read the user's browsing history."
- **storage** — "Saves the user's own settings (theme, language) and recent-file list locally on the device. Nothing is transmitted."

## Data-use / privacy declarations

Answer the stores' data questions as follows (all true — see `docs/PRIVACY.md`):

- **Does this extension collect or use user data?** The extension itself collects and transmits **nothing** — no analytics, no telemetry, no accounts.
- **Website content:** the extension processes PDF content **locally, on the device**, only to render and annotate it. It is not sent anywhere by the reader.
- **The optional AI assistant** only runs when the user has entered **their own** API key and explicitly asks a question. It then sends the relevant document text **directly from the user's browser to the AI provider the user chose** (Anthropic / OpenAI / Azure OpenAI), under the user's key and that provider's terms. PDF Scholar operates **no server** and receives none of this data.
- **Not sold or transferred** to third parties, except the user-directed AI call above.
- **No remote code:** all executable code ships inside the package; nothing is fetched and run at runtime. (The AI calls are data requests to the user's provider, not code.)
- **Privacy policy URL:** `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`

> Note on the broad host permissions: `<all_urls>` + `file:///*` +
> `declarativeNetRequest` routinely send a listing to the slower review queue.
> The justifications above are written to pre-empt the reviewer's questions —
> the honest single purpose (PDF interception, no page-content access) is the
> whole answer.

---

## Screenshots

Store requirement: **1280×800** PNG. Ready-to-upload files are in
**`docs/store-screenshots/`** (already scaled to exactly 1280×800 — just drag
them in). Suggested order + captions:

| File (`docs/store-screenshots/`) | Caption (EN) | Caption (NO) |
|------|-------------|-------------|
| `reading.png` | Distraction-free reading with themes | Distraksjonsfri lesing med temaer |
| `annotations.png` | Highlight, draw and annotate | Uthev, tegn og annoter |
| `assistant.png` | AI assistant grounded in the document | AI-assistent forankret i dokumentet |
| `parchment.png` | Warm Sepia reading mode | Varm Sepia-lesemodus |
| `night.png` | Two dark modes for late reading | To mørke moduser for sen lesing |

Store icon: `src/extension/icons/icon-128.png` (128×128) is already in the
package; the stores pull it automatically.

---

## Version note
The zip's `manifest.json` version is stamped from `package.json` at build time
(currently **0.15.0**) — never edit it by hand. Each store update = upload a new
zip built from a bumped `package.json`.

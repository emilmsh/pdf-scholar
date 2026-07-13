# PDF Scholar

**A calm, reading-first PDF app for Windows — built for scholars.**

PDF Scholar is a faithful homage to [PDF Expert](https://pdfexpert.com/) (Readdle, iPad/Mac),
rebuilt for Windows and aimed at people who *work* with texts: research articles, reports,
books. Reading comes first — annotation tools stay within reach, AI assistance stays grounded
in the document, and nothing gets between you and the page.

![Reading view](docs/screenshots/reading.png)

## Highlights

**Reading**
- Buttery smooth scrolling, pinch zoom that never jumps on release, fit width/page toggle
- Day / Sepia / Night / Night+ themes — a warm ivory reading mode and two dark modes
  (soft and high-contrast)
- Distraction-free mode: all chrome fades away; hover the top edge for the toolbar,
  the left edge for the table of contents, the right edge for the assistant
- Single-key shortcuts while reading: D (distraction-free), T (contents), A (assistant),
  H (hide annotations), R (read aloud), F (fit width/page)
- Table of contents, thumbnails, back/forward navigation after following internal links
- Remembers your reading position and recent files; opens straight from Explorer
- **Read aloud**: sentence-by-sentence speech with the highlight following along,
  auto-detected Norwegian/English voice, speed control
- Multiple windows: put documents side by side, or two spots in the same file

**Annotation**
- Highlight, underline, strikeout, squiggly — with labeled color rows and custom hex colors
- Pen and marker with hold-to-straighten (hold still mid-stroke to snap a straight line)
- Shapes, sticky notes (draggable), free text typed directly on the page
- Full undo/redo, hover to see comments, export annotated excerpts to Markdown/HTML/text
- **Real PDF annotations** written with appearance streams — they open correctly in
  Acrobat, SumatraPDF and PDF Expert
- **You decide when to save**: edits go to a draft, the file is only touched when you hit
  Save (Ctrl+S); closing prompts you, and unsaved work survives a crash

**AI assistant (bring your own key)**

![AI assistant](docs/screenshots/assistant.png)

- Chat with the document — every claim gets a clickable source chip («s. 12») that jumps to
  and highlights the exact passage, down to sentence level
- Structured article summaries (research question / method / data / findings / limitations)
- Ask your own annotations: “summarize what I've highlighted”
- Explain / simplify / define selected text from the context menu
- Providers: Anthropic (Claude, native citations), OpenAI (gpt-5.6 family) and Azure OpenAI,
  with per-model reasoning-effort control — keys encrypted locally with Windows DPAPI,
  the document leaves your machine only when you ask a question
- Cost transparency: every answer shows its estimated cost

**Scholarly by design**

![Sepia theme](docs/screenshots/parchment.png)

Norwegian and English UI. The Sepia theme brings a warm ivory reading mood with a
terracotta accent — calm on the eyes for long sessions.

## Development

```bash
npm install
npm run dev        # full Electron app with HMR
npm run dev:web    # renderer only, in a plain browser on :5199
npm run typecheck  # tsc for renderer + main/preload
npm run dist       # NSIS installer (Windows)
```

Architecture in short: **pdf.js v6 renders, mupdf WASM writes.** The React renderer draws
annotations in its own overlay (never pdf.js's editor layer); the Electron main process owns
the annotation engine, the AI providers and the draft-based save model. See `CLAUDE.md` and
`ROADMAP.md` for the details and the road ahead.

## Status

Personal project under active development. Not distributed; mupdf is AGPL-licensed, which is
revisited before any distribution.

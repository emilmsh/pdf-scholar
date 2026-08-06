# PDFX — Product Spec (Windows)

The app's own information architecture and toolset: a desktop-first shell (tab bar, split view, task-grouped toolbar) paired with a touch-friendly, expandable toolset concept for reading ergonomics, built natively for Windows.

## 1. Shell & Window
- **Tab bar** at top for multiple open documents. Tab context menu: Rename (renames file), Reveal (show in Explorer), Close Other Tabs. Drag to reorder.
- **Split view**: two documents, or two views of the same document, side by side; horizontal or vertical arrangement.
- **Left sidebar** (toggle via panel icon) with exactly four tabs: **Thumbnails, Outline, Bookmarks, Annotations**.
- **Top toolbar** grouped into task sections: Annotate | Edit | Fill & Sign | Export, with sidebar/layout controls on the left and search on the right. **Toolset** concept: named groups that expand inline; customization with ON TOOLBAR / MORE TOOLS drag sections and user-created toolsets.
- **Distraction-free**: click the page center to hide/show all chrome. A page-number pill ("N of M") stays bottom-right (toggleable) and opens go-to-page when clicked. F11 full-screen removes everything.
- Full **dark mode** app chrome, independent of page theme.

## 2. Reading & View Settings ("aA" popover)
- **Themes: Day (default), Sepia, Night, Night+ (higher contrast), Auto** (follows OS). Implemented as color transforms on the rendered page + matching chrome. **PDFX addition: adjustable contrast slider per theme** (owner requirement).
- **Brightness slider** (in-app overlay).
- **Scroll**: vertical + continuous (desktop default) or horizontal + single-page (page-flip). Two-page spread with "first page alone" toggle.
- **Zoom**: ctrl+wheel / trackpad pinch; fit-width and fit-page snap modes.
- **Crop-margins mode** (hide headers/footers/margins).
- **Keep awake** toggle (powerSaveBlocker).
- Skip: iPhone-only reflow Reading Mode.

## 3. Navigation
- **Outline tab**: hierarchical clickable TOC; right-click → Add Outline Item (from selected text), Rename, Delete, Change Destination; drag to nest.
- **Thumbnails tab**: page grid, click to jump.
- **Bookmarks tab**: user page markers; rename, delete, drag-reorder, search. *Shipped 2026-07-29 without drag-reorder or search:* the list is kept in page order, which is the order a reader wants and removes the need to arrange it, and a handful of named pages does not need a search field. Two windows on the same file both write the whole list, so the last one wins — the same last-write-wins the reading position has.
- **Go to page**: click the page pill and type a number (Ctrl+G).
- **Page scrubber**: slim slider on the right edge (vertical scroll) or bottom edge (horizontal).
- **Navigation history back**: after ANY jump (internal hyperlink, outline, bookmark, search result, go-to-page) show a **"Back to p. N"** pill bottom-left returning to the previous reading position; maintain a full back stack.

## 4. Annotation Tools
- **Text markup**: Highlight, Underline, Strikeout (+ Squiggly). Two flows: (a) select text → context-menu action; (b) arm the tool from the toolbar, then drag across text — tool stays armed. A finished mark is **adjustable**: select it and drag either end to cover more or less text (snapping to whole words), rather than deleting it and marking again.
- **Pen**: presets — fixed-width and pressure-sensitive (stylus pressure → line width); adjustable color, thickness, opacity. Pen is opaque; **Marker** is a translucent freehand highlighter. **Eraser** removes ink.
- **Shapes**: rectangle, ellipse, line, arrow; border color/thickness, fill color, opacity. Move by drag, resize via corner handles.
- **Text comment** (typed on page) and **Pop-up Note** (sticky note; click to place, type in popup; color picker inside; can be attached to selected text via context menu → Note).
- **Stamps**: built-in collection; custom text stamps with auto-updating date/time; custom image stamps with white-to-transparent + tolerance slider.
- **Signature** (under Fill & Sign): draw/type/image, visual only.
- **Colors**: every tool has a persistent **5-slot palette**; a color-wheel button opens a full picker; right-click slot → Restore Default Colors. Palettes persist per tool across files.
- **Editing existing annotations** (including ones authored by other apps): click → popover with Properties (color/thickness/opacity) / Delete; drag to move, corner handles to resize. Rectangular lasso multi-selects ink for batch restyle/delete.
- **Undo/redo**: toolbar button with press-and-hold multi-step history; Ctrl+Z/Ctrl+Y.

## 5. Text-Selection Context Menu
- PDF actions: **Copy, Highlight, Underline, Strikeout, Note**.
- System-style actions (owner requirement): **Search Web** (default browser), **Define/Dictionary**, **Translate selection** (per-selection, not just whole-document translation), optionally Speak (Windows TTS).
- Right-click empty page area → place Note.

## 6. Annotations Panel + Export (sidebar 4th tab)
- Lists ALL annotations sorted/grouped by page: markup types show the **actual marked-up text excerpt**; notes show contents; ink shows a pen icon.
- Click to jump. Search field over markup text + note contents (NOT ink/signatures). Color-wheel filter.
- Delete per item; Clear all with confirmation.
- **Export Annotation Summary**: formats HTML, plain Text, Markdown; includes markup text, note contents, stamps, shapes; excludes ink and signatures; grouped by page.
- **Annotated Pages** export: new PDF containing only pages that carry annotations.

## 7. Search
- Find bar (Ctrl+F): Match Case, Whole Words; highlight-all; results as a text list; search history with Clear.
- Later: cross-file content search in the file browser.

## 8. Files, Recents, Windows Integration
- **No internal library** — native filesystem. Home screen with Recents (last 20, newest first, Clear) and Favorites (custom order, color tags).
- **Explorer integration**: registered .pdf handler ("Open with"; first-run hint for setting default); single-instance routing; taskbar Jump List with Recent category.
- **Remember per file**: last read position, zoom, view settings.
- **Cloud (deferred, Phase 8)**: several established desktop PDF readers ship without 2-way sync — precedent that native filesystem + sync-client folders (OneDrive/Dropbox) is acceptable.

## 9. Interop Requirement (non-negotiable)
Every annotation is written into the PDF as a standard annotation object with a proper appearance stream. Two write paths, chosen by file size: **below 150 MB the file is rewritten in full** from a cached document behind a debounced flush (`src/main/doc-cache.ts`), and **at or above 150 MB an incremental appender** (`src/main/incremental-appender.ts`) appends the new objects and an xref section to the original bytes. Acceptance test per annotation type: create in PDFX → open in Acrobat Reader, SumatraPDF → renders identically and remains editable.

## 10. Keyboard Map (shipped 2026-08-05)
Every command the keyboard can reach is declared in one registry
(`src/renderer/src/keymap.ts`) rather than as branches in two keydown handlers,
and the gear menu opens it as a **map**: grouped by task (Fil, Faner,
Navigasjon, Visning, Zoom, Paneler, Søk, Redigering, Verktøy), one row per
command, its keys as chips.

- **Rebindable.** Click a key to replace it, «+» to give a command a second one
  (several commands ship with two — redo is Ctrl+Y *and* Ctrl+Shift+Z, rotate
  right is Shift+R *and* `]`). A chord belongs to one command at a time: taking
  a key says which command lost it and offers one-click undo.
- **Reset per row and for everything**, the per-row one shown only where the
  command is off its shipped default.
- **The fourteen annotation tools are in the map but unbound as shipped** —
  which tool deserves a letter is the reader's call, not ours.
- **Fixed keys are listed too** (Esc, scrolling, the presentation arrows) so the
  map is complete rather than merely editable.
- Overrides live in `Settings.keymap` (command id → chords, absent = default),
  so they follow the reader across desktop, extension and web, and the gear
  menu's Reset clears them with everything else.
- Tooltips read their key names out of the same registry, so none of them can
  advertise a key that was rebound.

## 11. Explicitly Out of Scope (post-parity stretch)
Whole-document translation, measurement tools, OCR/Scan, reflow mode, page editing UI, form creation, sound notes, stickers.

Two items have left this list since it was written. **AI chat** became its own phase and shipped — see Phase 9 in `docs/ROADMAP.md`. **Text-to-speech reading** was built as well, but is hidden on every platform behind the `READ_ALOUD` flag (`src/renderer/src/flags.ts`) until a local neural voice replaces the robotic SAPI ones.

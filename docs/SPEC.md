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
- **Themes: Day (default), Sepia, Night, Auto** (follows OS). Implemented as color transforms on the rendered page + matching chrome. **PDFX addition: adjustable contrast slider per theme** (owner requirement).
- **Brightness slider** (in-app overlay).
- **Scroll**: vertical + continuous (desktop default) or horizontal + single-page (page-flip). Two-page spread with "first page alone" toggle.
- **Zoom**: ctrl+wheel / trackpad pinch; fit-width and fit-page snap modes.
- **Crop-margins mode** (hide headers/footers/margins).
- **Keep awake** toggle (powerSaveBlocker).
- Skip: iPhone-only reflow Reading Mode.

## 3. Navigation
- **Outline tab**: hierarchical clickable TOC; right-click → Add Outline Item (from selected text), Rename, Delete, Change Destination; drag to nest.
- **Thumbnails tab**: page grid, click to jump.
- **Bookmarks tab**: user page markers; rename, delete, drag-reorder, search.
- **Go to page**: click the page pill and type a number (Ctrl+G).
- **Page scrubber**: slim slider on the right edge (vertical scroll) or bottom edge (horizontal).
- **Navigation history back**: after ANY jump (internal hyperlink, outline, bookmark, search result, go-to-page) show a **"Back to p. N"** pill bottom-left returning to the previous reading position; maintain a full back stack.

## 4. Annotation Tools
- **Text markup**: Highlight, Underline, Strikeout (+ Squiggly). Two flows: (a) select text → context-menu action; (b) arm the tool from the toolbar, then drag across text — tool stays armed.
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
Every annotation is written into the PDF as a standard annotation object with a proper appearance stream, via **incremental save** (original bytes preserved). Acceptance test per annotation type: create in PDFX → open in Acrobat Reader, SumatraPDF → renders identically and remains editable.

## 10. Explicitly Out of Scope (post-parity stretch)
AI chat, whole-document translation, measurement tools, OCR/Scan, text-to-speech reading, reflow mode, page editing UI, form creation, sound notes, stickers.

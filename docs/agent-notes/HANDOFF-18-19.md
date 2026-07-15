# Handoff: web panel (#18), rotate/spread (#19), tab drag between windows (#30)

Status as of branch `feature/ai-scholar-tools` (merged into `master`). The
four-task AI batch is otherwise done: #13 chat history, #14 reference lookup,
#15 annotation select/move, #16 semantic search all landed and verified.
**#18, #19 and #30 remain — this file is their brief.** Do #18 and #19 first
(they're the substantive ones); #30 is a smaller polish task, spec at the end.

## Read first (hard-won context)

- **Sacred invariants (must not regress):** pinch/Ctrl+wheel zoom must NEVER
  jump on release (commit anchors an exact page point via `pendingAnchorRef`
  and removes the transform in the same `useLayoutEffect` that sets scroll —
  Emil cares deeply); text selection is the default interaction and full-page
  overlay hosts inside `.pdf-page` are `pointer-events:none`; search maps text
  offsets → screen via text-layer spans 1:1 with `getTextContent()` items.
- **The plans below predate the parallel session's view-mode rework.**
  `PdfViewer.tsx`, `Toolbar.tsx`, `SearchBar.tsx` and the theme code changed
  (presentation mode, pinnable toolbar, edge-rail panels, auto light/dark).
  Anchor edits to **function names / patterns, not line numbers**, and re-read
  each file before editing.
- **Environment:** multiple Claude sessions run against this repo concurrently
  (see `MEMORY.md` → parallel-sessions). If files mutate under you mid-edit,
  it's a peer session, not disk corruption — check `git log`/worktrees, don't
  fight it with reverts. Edit source ONLY with Edit/Write (never PowerShell
  pipelines — BOM/encoding corruption). Every new UI string goes in BOTH nb and
  en dicts in `src/renderer/src/i18n.ts`. No new npm deps.
- Work in a fresh branch off `master`, verify `npm run typecheck` green after
  every step, commit per feature, don't push/merge to master unprompted
  (coordinate with Emil — a stress-test session may be active).

---

## #18 — Web search in a side panel (Electron WebContentsView)

Design source: `docs/agent-notes/ux-planer.md` §4. Today the selection menu's
"Søk på nettet" (`onMenuAction` `case 'search'`) opens the system browser;
replace that with an in-app Edge-sidebar-style panel.

**Architecture**
- **Main owns the view.** New `src/main/web-search.ts` with a lazy
  `WebContentsView` **per window** (`Map<hostWebContentsId, Entry>` — the app
  is multi-window). Attach/detach via `win.contentView.addChildView/
  removeChildView`. Keep the WebContents alive on panel close (fast reopen);
  destroy on window `closed` with `isDestroyed()` guards (this bug class has
  bitten us). Harden a `persist:websearch` session once: sandbox, no preload,
  no nodeIntegration, `setWindowOpenHandler → shell.openExternal`, deny all
  permission requests, block downloads. Reject `<webview>`/`BrowserView`
  (deprecated) and `<iframe>` (search engines send X-Frame-Options deny).
- **Bounds from a placeholder.** Renderer `WebSearchPanel.tsx` renders header
  chrome + an empty `.web-panel-body`; a ResizeObserver on the body **plus** a
  window `resize` listener (ResizeObserver misses pure position changes) pushes
  `getBoundingClientRect()`, rAF-coalesced, over `web-search:set-bounds`. The
  window is frameless so client CSS px map 1:1 to `view.setBounds` DIP; the
  placeholder sits below the titlebar strip naturally because `.viewer-body` is
  under TabBar+Toolbar. Only render the placeholder for the **active** tab-view
  (inactive tab-views are `visibility:hidden`, not `display:none` — a stale
  rect would float the native view over another document).
- Load DuckDuckGo (`https://duckduckgo.com/?q=…`) per the note. Header: back /
  forward (from `wc.navigationHistory.canGoBack/Forward` — Electron ≥32, we're
  on 43), reload, open-in-browser (`shell.openExternal`), close ✕.

**Touchpoints**
- `src/shared/types.ts`: `WebSearchBounds`, `WebSearchState`, and 6 `PdfxApi`
  methods (`webSearchOpen(query?)`, `webSearchClose()`, `webSearchSetBounds`,
  `webSearchBack/Forward/Reload`, plus an `onWebSearchState` subscription).
- `src/preload/index.ts` + `src/renderer/src/bridge.ts`: wire the 6 methods;
  web fallback = `window.open(duckduckgo…)` so `dev:web` keeps working.
- `src/main/index.ts`: `registerWebSearchIpc()` next to `registerAiIpc()`.
- `PdfViewer.tsx`: `webOpen`/`webQuery` state; `openWebSearch(text)`; add `web`
  to the drag-resize `PANEL_DEFAULTS/MIN/MAX` (380/300/560) and `--web-w`;
  render `<WebSearchPanel>` in `.viewer-body` (active tab only); rewrite
  `case 'search'` to `openWebSearch(selText)`; add to Esc chain and close on
  presentation/distraction-free; web panel and AI panel are mutually exclusive
  (opening one closes the other — decide precedence, keep it calm).
- `WebSearchPanel.tsx` (new), `icons.tsx` (`IconReload`, `IconExternal`),
  `i18n.ts` (`web.*` keys, both dicts), `app.css` (`.web-panel`, NO width
  transition — `setBounds` snaps and a CSS-animated placeholder desyncs).

**Cannot be verified in `dev:web`** (WebContentsView is Electron-only) — must
`npm run dev` and test in a real window. Key checks: panel opens with results,
PDF text selection still works, pinch-zoom still anchors after the pages
container narrows, divider drag makes the native surface follow the placeholder
exactly, Ctrl+F search bar dodges LEFT of the panel, second tab/window
isolation, close-window-while-loading = no "Object has been destroyed", HMR
reload doesn't orphan the view, `dev:web` still opens a DDG browser tab.

**Risks:** the native view floats above ALL renderer DOM in its rect (right-
anchored popups can be covered — CSS-dodge them); bounds must reach main
before attach (useLayoutEffect for bounds before useEffect for open + a
`lastBounds` map); `did-navigate` HMR-detach guard also fires on first renderer
load (harmless, don't "optimize").

---

## #19 — Rotate pages + two-page spread (HIGHEST RISK IN THE BATCH)

**Rotation scope decision (middle path — keep it):** under rotation, ENABLE
correct painting of all annotations, hit-testing/hover/popover/delete, and
creating text-markup + notes from selections; DISABLE the draw tools
(pen/marker/eraser/shapes/freetext) — selecting one while rotated (or rotating
with one active) deactivates it and shows a `viewer.rotatedToolsOff` toast.
Rationale: draw tools flow through the live-preview pointer machinery + freetext
editor positioning — largest, riskiest surface, least value on rotated pages.

**The whole feature is a coordinate-transform problem.** A single missed
view→page conversion at a pointer/selection boundary writes CORRUPTED coords
into the PDF via mupdf = permanent file damage. Mitigation is architectural:
put ALL transforms in one new pure module and route every boundary through it.

**Plan**
1. `src/shared/types.ts`: `ViewRotation = 0|90|180|270`; add optional
   `rotation` + `spread` to `ReadingPosition`.
2. New `src/renderer/src/rotation.ts` (pure, no React): `viewSize`,
   `pagePointToView`, `viewPointToPage`, `pageRectToView`, `viewRectToPage`,
   `viewDeltaToPage`, `svgRotationTransform`, `buildRows`. **Write a
   scratchpad node spike first** asserting `viewRectToPage(pageRectToView(q))`
   round-trips exactly for all four rotations before wiring any UI.
3. `annotations.ts`: `annotationCss(a, q, scale, pageSize, rotation)` — compute
   the geometry rect in PAGE space per type (markup bar thicknesses included),
   then rotate. The refactor from CSS-px to page-unit thicknesses must be
   numerically identical at rotation 0 (`max(1.5, scale*1.2)px ≡
   max(1.5/scale,1.2)*scale`) — diff a highlighted page before/after.
4. `PdfPage.tsx`: `rotation` prop; `page.getViewport({ scale, rotation:
   (page.rotate + rotation) % 360 })` (ADD to intrinsic /Rotate, don't replace).
5. `PdfViewer.tsx`: `rotation`/`spread` state (from `initialPosition`);
   row-based layout builder (`buildRows`, `SPREAD_GAP`); `computeCurrent` finds
   the row (reports LEFT page of a pair); `fitWidthScale` accounts for pair
   width; `rotateView(dir)`/`toggleSpread()` re-anchor viewport center through
   `pendingAnchorRef` + `schedulePositionSave`; a `pagePointFromClient` helper
   (using `sizesRef`/`rotationRef`) replaces the four raw
   `(clientX-rect.left)/scale` sites feeding `annotationAtPoint`/`inkHitTest`;
   tool-select guard + persistence + keyboard (rotation branch must run BEFORE
   the `k==='r'` read-aloud check).
6. `Toolbar.tsx`/`icons.tsx` (`IconRotateCw/Ccw`)/`i18n.ts`/`app.css`: rotate +
   spread controls in the view menu.

**Owner-critical verification (mandatory before commit):**
- **Zoom anchoring at rotation 90 AND in spread AND combined** — ctrl+wheel
  around a specific word repeatedly incl. a long pinch that triggers the
  mid-gesture commit; must never jump. The commit `useLayoutEffect` MUST gain
  `rotation` in its deps (else 0→180 leaves a stale `pendingAnchorRef` a later
  zoom consumes with wrong coords).
- **Annotation placement under rotation** — highlight a sentence at 0, rotate
  90/180/270, confirm it tracks the text; create a highlight while rotated and
  confirm it lands correctly (round-trip through mupdf).
- Regression sweep at rotation 0 / single-page must be pixel-identical.
- Persistence round-trip (rotation+spread survive close/reopen), search-hit
  highlight lands exactly under rotation, tool guard toast, i18n both languages.

The full original plans (with code sketches / exact formulas) were produced by
the planning workflow; if this file is insufficient, they can be regenerated,
but everything needed to execute is above.

---

## #30 — Drag a tab to another window (Edge-style tear-off / merge)

Smaller task, no plan was pre-written — spec it yourself. The app is
multi-window with tabs in the titlebar (`TabBar.tsx`, frameless window). Goal:
drag a document tab out of its window to (a) a new window (tear-off) and/or
(b) another existing window's tab strip (merge), moving the document — open in
the target, close in the source.

Reality check on Electron: HTML5 drag events do NOT cross OS window
boundaries, so "drop onto another window" can't be done with plain
`dragover`/`drop` between renderers. Two workable routes:

- **Pragmatic (recommended first):** make each tab draggable; on `dragend`,
  ask main (over IPC) which window sits under the cursor via
  `screen.getCursorScreenPoint()` + `BrowserWindow.getBounds()` hit-testing. If
  it's another PDF Scholar window → main sends that window an `open-path` for
  the doc and tells the source to close its tab (reuse the existing
  `open-path` channel + tab-close flow). If it's outside every window → tear
  off into a new window (`createWindow(path)` then close source tab). This
  keeps all cross-window coordination in main, where the multi-window state
  already lives (`openDocs`, `pendingPaths`).
- Simpler fallback if drag proves fiddly: a tab context-menu item "Flytt til
  vindu ▸" listing open windows (main already tracks them), plus the existing
  "Åpne i nytt vindu". Ships the capability without the drag choreography.

Guards: the source tab's unsaved-changes (draft) state must travel with the
move — moving a dirty doc must not silently drop the draft; simplest is to
require save/confirm on move, or move the draft file with it (see
`src/main/drafts.ts`). Reuse the close-confirm flow. `isDestroyed()` guards on
every cross-window `webContents.send` (this bug class has bitten us). Verify in
a real `npm run dev` window (drag between two windows; tear-off to new window;
dirty-doc move; no orphaned/duplicated tabs).

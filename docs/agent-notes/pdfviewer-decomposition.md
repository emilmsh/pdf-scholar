# Breaking up PdfViewer.tsx — an ordered plan

`src/renderer/src/components/PdfViewer.tsx` was ~4 900 lines when this was
written: one default-exported component holding 71 `useState`, 86 `useRef`,
33 `useEffect`, 4 `useLayoutEffect` and 124 `useCallback` in a single function
body. 64 commits had touched it. It is the largest single piece of debt in the
repo. Three extractions have since taken it to ~4 610.

It is also not a file you can safely split in one pass. This note exists so the
work can be done in small, individually verifiable steps instead — and so the
next person does not have to re-derive which seams are cheap and which are traps.

## Why it cannot be done in one pass

There are no renderer unit tests. `package.json` ships `test:engine`,
`test:appender`, `test:cache`, `test:rotation`, `test:windows`, `test:listing`
and `test:ext-publish` — every one of them tests the write engines, the pure
transforms, or packaging. Nothing tests this component. So each extraction has to
be verified by `npm run shoot` plus actually using the app, which only works if
the steps are small enough to attribute a regression to one of them.

The entanglement is measurable rather than a matter of taste: eleven late-bound
function refs exist purely to break declaration cycles inside the one body
(`handleForRef`, `followLinkFromRef`, `toggleSplitRef`, `whenPaneReadyRef`,
`schedulePositionSaveRef`, `goToPaneBPageRef`, `pagesAreaWidthRef`,
`runSemanticSearchRef`, `wakeHudRef`, `pagePointFromClientRef`, `markDirtyRef`),
four of them with a comment naming the temporal dead zone outright. Every one of
those refs is a seam that a careless split turns into a runtime `undefined`.

## Extract in this order

Put them in `src/renderer/src/hooks/`. Steps 1 and 2 are **done**; the estimates
below them are estimates, and step 3 turned out to be wrong — see the postmortem.

1. ~~**Read aloud** → `useReadAloud`~~ **Done** (298 lines out). The plan said
   "its only outbound dependency is page text". That was wrong: it needs ten
   injected values (`pdf`, `active`, `currentPage`, `containerRef`, `layoutRef`,
   `pageTextsRef`, `scaleRef`, `updateRange`, `waitForTextLayer`,
   `setSearchHits`), because `highlightSentence` drives pane A's scroller and
   paints through the search-hit overlay. Still a clean seam — ten parameters, no
   late-bound ref crossing it — just not a cheap one. Starting here was right for
   the other reason: `READ_ALOUD` hides it, so a mistake could not reach a user.
2. ~~**Panel resizing** → `usePanelWidths(pagesHostRef)`~~ **Done** (153 lines
   out). One injected ref. Also returns `persistPanelWidths`, which `toggleSplit`
   calls from outside the region, and exports `PANEL_DEFAULTS` / `PANEL_LS_KEY`
   because the gear menu's reset clears them. `pagesAreaWidthRef` — one of the
   eleven — is read and assigned only inside this region, so it travelled intact.
3. **Search + semantic search** — **DO NOT extract as `useDocumentSearch(paneHandle)`.**
   Attempted and abandoned; see the postmortem below. A different seam might
   exist, but it is not this one.
4. ~~**Undo/redo** → `useUndoStack(engineCreate, engineDelete, engineChange)`~~
   **Done** (40 lines out). The one estimate the plan got right: three injected
   callbacks, no other coupling. `AnnotHandle`, `AnnotPatch` and `UndoEntry` are
   now exported from the component and imported type-only, so there is no runtime
   cycle — the same pattern `useReadAloud` uses for `PaneId`.
5. **Navigation history** → `useNavHistory(paneHandle)`. Already keyed per pane.
   NOTE: verify against the step-3 postmortem first — if it dispatches on the
   active pane the same way search does, it has the same problem.
6. **Touch input** → `useTouchGestures(containerRef, innerRef, gestureRef)`.
   Requires one change first: pass `pagePointFromClient` in as a parameter
   instead of reading it from the closure through its late-bound ref.
7. **Save model** → `useSaveModel(payload, onDirtyChange, onExternalSaveConflict)`.

## Postmortem: why search is not the seam it looks like

Worth reading before attempting steps 5–7, because the same two shapes are what
make a seam fake.

**A single `PaneHandle` parameter is a behaviour change, not a refactor.**
`gotoMatch` and `waitForTextLayer` do not act on *a* pane; they act on the
*active* one, via `activePaneRef` → `handleForRef.current(pane)`. Hand the hook
one `PaneHandle` and every search hit lands in column A — silently, and only in
split view, which is exactly the kind of regression no typecheck catches and no
test covers. `handleForRef` is one of the eleven, assigned as a fresh inline
closure and read from about fifteen places; there is no value to pass in without
first restructuring that dispatcher.

**The recursion crosses the cut in both directions.** `pickSemanticHit` (inside
the region) calls `jumpToAiCitation` (below it), which reads `waitForTextLayer`,
`gotoSeqRef` and `setSearchHits` from inside the region — and lists
`waitForTextLayer` in its dependency array, so it is evaluated during render, not
at call time. The hook would have to be called before `jumpToAiCitation` exists,
and `pickSemanticHit` could then only reach it through a newly invented twelfth
late-bound ref. Adding to the eleven to remove 175 lines is not progress.

Measured cost if forced anyway: seven inbound values, twenty-four outbound, for
~175 lines moved. That is the "replace closure access with a wide context object
and make things worse" case this document warns about — it just wears a smaller
number than the annotation block does.

## Leave these alone

- **The annotation block** (persist/remove, dragging, markup, context menu,
  snip, notes). It reads *and writes* `annots`, `selected`, `annotPopover`, the
  undo stacks, `dirty` and the pane geometry in every direction. Extracting it
  means replacing closure access with a context object of ~40 fields, which is
  strictly worse than the big file.
- **The render section** at the end. It closes over ~60 locals. Same argument.

Splitting either of these is not a smaller version of the work above; it is a
different and much riskier job.

## Related, and cheaper

`PagesPane.tsx` re-implements this component's scroll/layout/zoom orchestration —
around 110 near-identical lines across 15 blocks (the `layout` useMemo, the pinch
gesture shape, four zoom-commit blocks, four page-render JSX blocks, `fitDenom`,
the 0.35-viewport current-page probe). The six layout constants they both need
have already been moved to `rotation.ts`, which fixed a real divergence
(`RENDER_MARGIN` was 700 in one and 800 in the other under a comment insisting
they "must match exactly").

The orchestration itself could follow, as `usePageColumn({sizes, scale, rotation,
spread, onPageChange})` returning `{containerRef, layout, range, fitDenom,
gestureHandlers}` — leaving each caller only its own chrome and its own decision
about what to do with the current page. Doing that BEFORE the extractions above
is probably wrong: it touches the same regions and would make step 6 harder.

## Also known, deliberately not done

- **Toolbar.tsx** takes 76 props into one ~1 250-line body, with pane A and pane
  B passed as two parallel flat prop sets. The fix is a `PaneControls` object per
  pane rather than more decomposition; it is mechanical but wide.
- **app.css** is ~5 100 lines with an append-only tail, which is why five
  selectors are declared in two places. `npm run check:css` reports both that and
  unreferenced selectors. Splitting per-component is plausible but the file is
  imported once by three targets, so the win is readability only.
- **incremental-appender.ts** is ~1 800 lines and looks like a candidate. It is
  not: it is well-sectioned, near-zero-churn, and the one thing standing between
  a 400 MB document and the wasm heap ceiling. Leave it.

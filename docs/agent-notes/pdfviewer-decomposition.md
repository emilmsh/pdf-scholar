# Breaking up PdfViewer.tsx — an ordered plan

`src/renderer/src/components/PdfViewer.tsx` is ~4 900 lines: one default-exported
component holding 71 `useState`, 86 `useRef`, 33 `useEffect`, 4 `useLayoutEffect`
and 124 `useCallback` in a single function body. 64 commits have touched it. It is
the largest single piece of debt in the repo.

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

Each of these owns its state, and reaches the rest of the component only through
refs it already reads or a `PaneHandle` it is handed. None of the eleven
late-bound refs crosses these seams. Put them in `src/renderer/src/hooks/`.

1. **Read aloud** → `useReadAloud(pdf, active)`. Four `useState`, three
   `useRef`; its only outbound dependency is page text. Start here: the feature
   is hidden behind `READ_ALOUD` (see `src/renderer/src/flags.ts`), so a mistake
   cannot reach a user. It is the free rehearsal for the pattern.
2. **Panel resizing** → `usePanelWidths()`. Owns `panelW` / `resizingPanel` plus
   the localStorage load and save that currently sit near the top of the file.
3. **Search + semantic search** → `useDocumentSearch(paneHandle)`. Talks to the
   rest only through `searchHits` and a `PaneHandle`.
4. **Undo/redo** → `useUndoStack(engineCreate, engineDelete, engineChange)`.
   Pure refs, ~50 lines, three injected callbacks.
5. **Navigation history** → `useNavHistory(paneHandle)`. Already keyed per pane.
6. **Touch input** → `useTouchGestures(containerRef, innerRef, gestureRef)`.
   Requires one change first: pass `pagePointFromClient` in as a parameter
   instead of reading it from the closure through its late-bound ref.
7. **Save model** → `useSaveModel(payload, onDirtyChange, onExternalSaveConflict)`.

That is roughly 1 200 lines out of the component with no new prop-drilling,
because each hook takes what it already reads.

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

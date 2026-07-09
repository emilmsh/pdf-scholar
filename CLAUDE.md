# PDFX — PDF Expert clone for Windows

A faithful Windows clone of PDF Expert (Readdle). Owner: Emil (communicates in Norwegian — respond in Norwegian). Product spec: `docs/SPEC.md`. Phased plan + architecture decisions: `ROADMAP.md`.

## Commands
- `npm run dev` — full Electron app with HMR
- `npm run dev:web` — renderer only in a plain browser on port 5199 (for UI preview/automation; Electron APIs are shimmed via `src/renderer/src/bridge.ts`)
- `npm run typecheck` — tsc for renderer (`tsconfig.web.json`) and main/preload (`tsconfig.node.json`)
- `npm run build` — electron-vite production build to `out/`
- `npm run sample` — regenerate `src/renderer/public/sample.pdf` (test document)

## Architecture
- **electron-vite** layout: `src/main` (Electron main), `src/preload` (contextBridge → `window.api`), `src/renderer` (React 19 + TS), `src/shared/types.ts` (types shared across all three; `PdfxApi` is the single IPC surface).
- **pdf.js (pdfjs-dist v6) renders; it never writes.** Planned: **mupdf WASM writes annotations** (standard annots + appearance streams, incremental save) behind an `AnnotationEngine` interface in the main process; annotations are drawn by our own React overlay, NOT pdf.js's editor layer. See ROADMAP.md for rationale.
- Renderer works in a plain browser: `bridge.ts` falls back to fetch/localStorage/file-input when `window.api` is missing. Keep new platform calls going through `PdfxApi` so this stays true.
- App state (recents, per-file reading positions, theme, window bounds) is a hand-rolled JSON store in `userData/pdfx-state.json` (`src/main/storage.ts`).
- Themes = CSS variables on `<html data-theme="day|sepia|night">` in `src/renderer/src/styles/app.css`; page recoloring is a CSS `filter` on the page canvas (`--page-filter`).
- Viewer (`PdfViewer.tsx`): pages absolutely positioned from a computed layout (tops array); visibility range computed mathematically on scroll (no IntersectionObserver); only pages within 800px of the viewport mount a canvas + text layer.

## Gotchas (hard-won)
- **pdfjs-dist v6 API**: `page.render({ canvas, viewport })` — pass the canvas, not `canvasContext`. Worker must be loaded via Vite's `?worker` import assigned to `GlobalWorkerOptions.workerPort` (a bare `?url` workerSrc hangs in dev).
- **pdf.js renders via requestAnimationFrame** → in a *hidden* tab (automated preview) rendering stalls and scroll events don't fire. `main.tsx` has a dev-only rAF→setTimeout shim; when driving the preview programmatically, dispatch `new Event('scroll')` manually after setting `scrollTop`. These are preview-environment artifacts, not app bugs.
- **Version pins**: electron-vite 5 requires vite ≤7 (vite 8 is out — do not upgrade blindly). pdf.js ships monthly majors — upgrade deliberately, `render`/TextLayer APIs churn.
- pdf.js transfers the `data` buffer to its worker — always pass a copy (`payload.data.slice()`).
- Drag-drop needs `webUtils.getPathForFile` in preload to recover the real path (`File.path` is gone in modern Electron).
- The dev preview panel may attach multiple browser contexts to the same URL: console logs appear N times and `preview_click`/`preview_eval` can hit different contexts — do click + assert inside a single `preview_eval`.

## Conventions
- UI strings in Norwegian bokmål. Code, comments, commit messages in English.
- No new dependencies without checking the maintained/ESM story; prefer hand-rolling small things (see storage.ts).
- Design language: PDF Expert — calm, muted chrome, accent `--accent` blue, generous whitespace; every visual choice should survive comparison with the original side by side.

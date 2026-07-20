# PDFX — PDF Expert clone for Windows

A faithful Windows clone of PDF Expert (Readdle). Owner: Emil (communicates in Norwegian — respond in Norwegian). Product spec: `docs/SPEC.md`. Phased plan + architecture decisions: `docs/ROADMAP.md`. **Platform tiers + parity contract: `docs/PLATFORMS.md`** — Windows x64 is the reference; win-arm64/macOS/Linux and the extension are held to it, and any cross-platform divergence must be listed there. CI (`.github/workflows/ci.yml`) builds all three OSes on every push.

## Commands
- `npm run dev` — full Electron app with HMR
- `npm run dev:web` — renderer only in a plain browser on port 5199 (for UI preview/automation; Electron APIs are shimmed via `src/renderer/src/bridge.ts`)
- `npm run build:ext` / `npm run dev:ext` — build the browser-extension target to `dist-extension/` (a third `PdfxApi` platform alongside Electron; see `docs/BROWSER-EXTENSION.md`). Load unpacked in `edge://extensions`.
- `npm run typecheck` — tsc for renderer (`tsconfig.web.json`) and main/preload (`tsconfig.node.json`)
- `npm run build` — electron-vite production build to `out/`
- `npm run sample` — regenerate `src/renderer/public/sample.pdf` (test document)
- `npm run dist` / `dist:mac` / `dist:linux` — local installer builds (host-OS-bound: mac/linux targets only build on those OSes; release artifacts come from CI). `dist:store` — MSIX for Microsoft Store (needs identity env vars, see `docs/STORE.md`)

## Architecture
- **electron-vite** layout: `src/main` (Electron main), `src/preload` (contextBridge → `window.api`), `src/renderer` (React 19 + TS), `src/shared/types.ts` (types shared across all three; `PdfxApi` is the single IPC surface).
- **pdf.js (pdfjs-dist v6) renders; it never writes.** **EmbedPDF (@embedpdf/pdfium + @embedpdf/engines, MIT/BSD-3) writes annotations** (standard annots + appearance streams; full-rewrite save behind a debounced document cache, `src/main/doc-cache.ts`) via `src/main/annotation-engine-embedpdf.ts` in the main process; annotations are drawn by our own React overlay, NOT pdf.js's editor layer. mupdf (AGPL) is a devDependency used ONLY as an independent verifier in `npm run test:engine` / `bench:engine` — never import it from `src/`. The app is MIT-licensed; keep every runtime dependency permissive. See docs/ROADMAP.md for rationale.
- Renderer works in a plain browser: `bridge.ts` falls back to fetch/localStorage/file-input when `window.api` is missing. Keep new platform calls going through `PdfxApi` so this stays true.
- App state (recents, per-file reading positions, theme, window bounds) is a hand-rolled JSON store in `userData/pdfx-state.json` (`src/main/storage.ts`).
- Themes = CSS variables on `<html data-theme="day|sepia|night">` in `src/renderer/src/styles/app.css`; page recoloring is a CSS `filter` on the page canvas (`--page-filter`, also applied to the annotation-marks overlay and live draw layer) plus `mix-blend-mode: var(--page-blend)` — sepia multiplies the canvas against the cream `--page-bg` so white paper takes the exact cream tone without washing out figure colours.
- Viewer (`PdfViewer.tsx`): pages absolutely positioned from a computed layout (tops array); visibility range computed mathematically on scroll (no IntersectionObserver); only pages within 800px of the viewport mount a canvas + text layer.

## Gotchas (hard-won)
- **pdfjs-dist v6 API**: `page.render({ canvas, viewport })` — pass the canvas, not `canvasContext`. Worker must be loaded via Vite's `?worker` import assigned to `GlobalWorkerOptions.workerPort` (a bare `?url` workerSrc hangs in dev).
- **pdf.js renders via requestAnimationFrame** → in a *hidden* tab (automated preview) rendering stalls and scroll events don't fire. `main.tsx` has a dev-only rAF→setTimeout shim; when driving the preview programmatically, dispatch `new Event('scroll')` manually after setting `scrollTop`. **CSS transitions also freeze at their start value in hidden tabs** — getComputedStyle will forever report pre-transition values even though the rule matches; to verify layout logic, inject `* { transition: none !important }` first. These are preview-environment artifacts, not app bugs.
- **Column-flex children have `min-height: auto`**, which beats `max-height: 0` — collapsing a bar (e.g. `.tab-bar`) needs an explicit `min-height: 0`.
- **Version pins**: electron-vite 5 requires vite ≤7 (vite 8 is out — do not upgrade blindly). pdf.js ships monthly majors — upgrade deliberately, `render`/TextLayer APIs churn.
- pdf.js transfers the `data` buffer to its worker — always pass a copy (`payload.data.slice()`).
- Drag-drop needs `webUtils.getPathForFile` in preload to recover the real path (`File.path` is gone in modern Electron).
- **Full-page overlay hosts inside `.pdf-page` MUST be `pointer-events: none`** (only their interactive children `auto`) — otherwise they silently kill text selection. This bit us with the link layer.
- **`mix-blend-mode` dies silently inside ANY stacking context** (per CSS compositing, every stacking context is an isolated group — `z-index` on a positioned ancestor is enough): the child then blends against the ancestor's transparent background, degrading to a plain alpha wash. This shipped broken for a while (highlights greyed the text) and survived several "fixes" because `getComputedStyle` still reports the blend mode — the ONLY valid proof is composited pixels (an SVG `foreignObject` fixture drawn to a canvas works in-page). Blend hosts inside `.page-raster` need `z-index: auto`; to blend a whole layer that must keep its z-index (e.g. `.draw-layer`), put the blend on the stacking-context element itself. Inline `<svg>` children never blend with HTML behind them — the blend goes on the `<svg>` element.
- **Zoom commits must anchor an exact page point** (pageIndex + in-page coords), not multiply scroll by the ratio — gaps/margins don't scale with zoom, and the transform must be removed in the same `useLayoutEffect` that sets the new scroll or pinch-release visibly jumps. Owner cares a lot about this being seamless.
- Search maps text offsets → screen via the text-layer spans; spans correspond 1:1 to `getTextContent()` items with `str !== ''` (in order). If that invariant breaks (e.g. `includeMarkedContent` gets enabled), `resolveMatchRects` returns null.
- **EmbedPDF `getPageAnnotations` makes PDFium synthesize `/AP` for border-only Link annots** (hyperref's `/Border[0 0 1]/C[0 1 0]` — the green/red citation boxes arXiv PDFs define but no modern viewer draws). pdf.js only skips those boxes BECAUSE the appearance is missing, so a save after that call bakes them visible everywhere. Both engines bracket every op with `src/shared/link-ap-guard.ts` (snapshot AP-less links → strip exactly those after); keep the guard around any NEW engine call that loads page annotations. Regression-tested in `test:engine` ("linkguard").
- The dev preview panel may attach multiple browser contexts to the same URL: console logs appear N times and `preview_click`/`preview_eval` can hit different contexts — do click + assert inside a single `preview_eval`.

## Conventions
- UI strings in Norwegian bokmål. Code, comments, commit messages in English.
- No new dependencies without checking the maintained/ESM story; prefer hand-rolling small things (see storage.ts).
- Design language: PDF Expert — calm, muted chrome, accent `--accent` blue, generous whitespace; every visual choice should survive comparison with the original side by side.

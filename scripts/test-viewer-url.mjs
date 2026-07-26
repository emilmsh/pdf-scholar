// Round-trip proof for src/shared/viewer-url.ts — the handoff between the
// extension's redirect rule and the viewer page. A regression here is invisible
// until a specific KIND of link breaks: the rule writes the document URL into the
// page URL verbatim (declarativeNetRequest cannot percent-encode), so anything
// that parses it as an ordinary query param silently truncates every signed CDN
// link and every `?utm_source=chatgpt.com&…` link at the first `&`.
// Run: node scripts/test-viewer-url.mjs
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/viewer-url.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'viewer-url-'))
const out = join(dir, 'viewer-url.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const V = await import(pathToFileURL(out).href)

const EXT = 'chrome-extension://abcdefghijklmnop/viewer.html'
let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${got}\n      want ${want}`)
  }
}

// --- What the background redirect rule produces (URL folded in raw) ----------
// Each of these is a real shape: a plain link, a tracker-tagged link (what the
// ChatGPT app hands out), a signed CDN link, a link with a page anchor, and a
// local file opened from File Explorer.
for (const url of [
  'https://example.org/papers/attention.pdf',
  'https://example.org/papers/attention.pdf?utm_source=chatgpt.com',
  'https://example.org/papers/attention.pdf?utm_source=chatgpt.com&utm_medium=app',
  'https://cdn.example.org/a.pdf?Expires=1784&Signature=aBc%2Fd&Key-Pair-Id=K123',
  'https://example.org/my+report.pdf',
  'file:///C:/Users/emil/Documents/paper.pdf'
]) {
  eq(V.parseViewerTarget(`${EXT}?${V.RAW_FILE_PARAM}=${url}`), url, `raw round-trip: ${url}`)
}

// A citation anchor rides along on the redirect; it must NOT become part of the
// document's identity (that key drives recents and the saved reading position).
eq(
  V.parseViewerTarget(`${EXT}?${V.RAW_FILE_PARAM}=https://example.org/a.pdf#page=6`),
  'https://example.org/a.pdf',
  'anchor dropped from the document identity'
)
eq(
  V.parseViewerTarget(`${EXT}?${V.RAW_FILE_PARAM}=https://example.org/a.pdf?v=2#page=6`),
  'https://example.org/a.pdf?v=2',
  'anchor dropped, query kept'
)

// --- What we produce ourselves (encoded) ------------------------------------
for (const path of [
  'https://example.org/a.pdf?x=1&y=2',
  'file:///C:/Users/emil/a b.pdf',
  'fsa:min rapport.pdf'
]) {
  eq(V.parseViewerTarget(V.buildViewerUrl(EXT, path)), path, `encoded round-trip: ${path}`)
}

// --- No document ------------------------------------------------------------
eq(V.parseViewerTarget(EXT), null, 'bare viewer → null')
eq(V.buildViewerUrl(EXT, ''), EXT, 'empty path → bare viewer URL')
eq(V.parseViewerTarget(`${EXT}?${V.RAW_FILE_PARAM}=`), null, 'empty raw param → null')
eq(V.parseViewerTarget(`${EXT}#min%20fil.pdf`), null, 'picked-file hash is not a target')

// --- Producer and consumer must agree on the param name ----------------------
// background.ts keeps the name as a literal so the service worker stays a single
// self-contained file (see the comment there); this is the guard against the two
// drifting apart.
const bg = readFileSync(new URL('../src/extension/background.ts', import.meta.url), 'utf8')
eq(
  bg.includes(`const RAW_FILE_PARAM = '${V.RAW_FILE_PARAM}'`),
  true,
  `background.ts declares RAW_FILE_PARAM = '${V.RAW_FILE_PARAM}'`
)
eq(
  bg.includes('regexSubstitution: `${viewer}?${RAW_FILE_PARAM}=\\\\0`'),
  true,
  'background.ts folds the matched URL in through RAW_FILE_PARAM'
)

// --- Display names ----------------------------------------------------------
eq(V.fileNameFromUrl('https://example.org/p/attention.pdf'), 'attention.pdf', 'plain name')
eq(
  V.fileNameFromUrl('https://example.org/p/attention.pdf?utm_source=chatgpt.com'),
  'attention.pdf',
  'query stripped from name'
)
eq(V.fileNameFromUrl('https://example.org/a.pdf#page=6'), 'a.pdf', 'fragment stripped from name')
eq(V.fileNameFromUrl('https://example.org/min%20fil.pdf'), 'min fil.pdf', 'percent-decoded name')
eq(V.fileNameFromUrl('https://example.org/100%.pdf'), '100%.pdf', 'malformed escape survives')

if (failures === 0) {
  console.log('\nALL VIEWER-URL ROUND-TRIPS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

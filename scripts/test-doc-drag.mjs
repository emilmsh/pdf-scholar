// The extension's document drag — src/renderer/src/doc-drag.ts, the stand-in for
// the desktop's tab-as-file drag. Chromium reads the `DownloadURL` drag type as
// `mime:filename:url` and makes the drop a file; what is under test is that
// payload's shape (a colon in the name would split it, a separator would leave
// the drop folder), the in-app MIME riding along, and that NO text/plain is set —
// the drag ends over other programs, and a path pasted into a text field there
// was half of the double effect the desktop drag once had.
// Run: node scripts/test-doc-drag.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/doc-drag.ts', import.meta.url))
const TYPES = fileURLToPath(new URL('../src/renderer/src/drag-types.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'doc-drag-'))
const out = join(dir, 'doc-drag.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const D = await import(pathToFileURL(out).href)
const typesOut = join(dir, 'drag-types.mjs')
await build({ entryPoints: [TYPES], outfile: typesOut, format: 'esm', bundle: false, logLevel: 'silent' })
const T = await import(pathToFileURL(typesOut).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${got}\n      want ${want}`)
  }
}

/** A DataTransfer stand-in that records what was set. */
function sink() {
  const data = new Map()
  return { effectAllowed: 'uninitialized', setData: (t, v) => data.set(t, v), data }
}

// --- The DownloadURL payload ----------------------------------------------------
{
  const dt = sink()
  D.setDocumentDragData(dt, {
    path: 'https://example.org/papers/attention.pdf?utm_source=chatgpt.com',
    name: 'attention.pdf',
    url: 'blob:chrome-extension://abcdefghijklmnop/1234-5678'
  })
  eq(
    dt.data.get(D.DOWNLOAD_URL_TYPE),
    'application/pdf:attention.pdf:blob:chrome-extension://abcdefghijklmnop/1234-5678',
    'DownloadURL is mime:name:url, the url verbatim (its own colons are fine — only the first two split)'
  )
  eq(dt.data.get(T.TAB_DRAG_MIME), 'https://example.org/papers/attention.pdf?utm_source=chatgpt.com', 'the in-app MIME carries the path verbatim')
  eq(dt.data.has('text/plain'), false, 'no text/plain — nothing to paste into a foreign text field')
  eq(dt.data.has('text/uri-list'), false, 'no text/uri-list either — a drop on a page must not navigate')
  eq(dt.effectAllowed, 'copy', 'a copy: the source keeps its document')
  eq(dt.data.size, 2, 'exactly the two types')
}

// --- The file name the drop produces --------------------------------------------
const n = D.documentDragName
eq(n('attention.pdf'), 'attention.pdf', 'plain name unchanged')
eq(n('Vinmonopolet Pricing Policy.PDF'), 'Vinmonopolet Pricing Policy.PDF', 'existing .PDF suffix kept as is')
eq(n('2401.12345'), '2401.12345.pdf', 'a name without the suffix reads as a PDF')
eq(n('Report: Q3 2026.pdf'), 'Report Q3 2026.pdf', 'a colon would split the payload — scrubbed')
eq(n('a/b\\c.pdf'), 'a b c.pdf', 'path separators would leave the drop folder — scrubbed')
eq(n('  ::  '), 'document.pdf', 'nothing left → a plain name, never an empty file name')
eq(n(''), 'document.pdf', 'empty name → a plain name')
eq(n('blå rapport.pdf'), 'blå rapport.pdf', 'non-ASCII survives')

// The scrub is applied INSIDE the payload, not only by the helper.
{
  const dt = sink()
  D.setDocumentDragData(dt, { path: 'fsa:Report: Q3.pdf', name: 'Report: Q3.pdf', url: 'blob:x/y' })
  eq(dt.data.get(D.DOWNLOAD_URL_TYPE), 'application/pdf:Report Q3.pdf:blob:x/y', 'payload uses the scrubbed name')
  eq(dt.data.get(T.TAB_DRAG_MIME), 'fsa:Report: Q3.pdf', 'the path itself is NOT scrubbed — it is the document key')
}

if (failures === 0) {
  console.log('\nALL DOC-DRAG ASSERTIONS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

// End-to-end test for the document that is still being WRITTEN when we are
// asked to open it.
//
//   npm run test:torn-read        (needs `npm run build` first)
//
// Why this case is not exotic: a PDF handler is launched by the program doing
// the writing. A LaTeX rebuild, a download completing, an app copying an
// attachment out of its own storage and opening it in the same breath — each can
// hand us a path whose bytes are half there. The parser can only report a broken
// PDF, which is a lie about a file that is fine two seconds later.
//
// So the app does two things, and this test drives both through the real UI:
//   1. The error names what it actually read (byte count and the two ends), so a
//      truncated read is distinguishable from a genuinely broken document.
//   2. Retrying re-reads the file and waits for it to be WHOLE first — main
//      polls for the %%EOF marker rather than trusting timestamps, because a
//      copy that pauses mid-write looks settled by mtime alone.
//
// The retry is driven by clicking the button rather than by racing the app's own
// automatic retry: same code path, no timing assumptions, no flake.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9336
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const FILE = join(tmpdir(), 'pdfx-torn-read-test.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** What the viewer is showing: pages, the error detail line, the retry button. */
const read = (send) =>
  evaluate(
    send,
    `
    const detail = document.querySelector('.viewer-error-detail');
    return {
      pages: document.querySelectorAll('.pdf-page').length,
      error: detail ? detail.textContent : null,
      hasRetry: !!document.querySelector('.viewer-error-actions .btn-primary')
    };
  `
  )

async function waitUntil(send, ready, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await read(send)
    if (ready(last)) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

async function run() {
  if (!existsSync(SAMPLE)) throw new Error(`missing ${SAMPLE} — run npm run sample`)
  const whole = readFileSync(SAMPLE)
  // A prefix of a real PDF is exactly what an interrupted write leaves behind:
  // valid header, no trailer, no %%EOF.
  const truncated = whole.subarray(0, Math.floor(whole.length * 0.55))
  writeFileSync(FILE, truncated)

  const app = launchApp({
    root: ROOT,
    mainJs: join(ROOT, 'out', 'main', 'index.js'),
    args: [FILE],
    port: PORT
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    const failed = await waitUntil(send, (s) => s.error !== null, 'the load to fail')
    check('a truncated file reports a failure instead of an empty page', failed.pages === 0)
    // The count is the whole point: "Invalid PDF structure" alone cannot tell a
    // half-written file from a broken one. Either language spells the unit
    // "byte", so the assertion holds without pinning the app to English.
    check(
      'the failure says how many bytes it read',
      /\d{3,}\s*byte/i.test(failed.error ?? ''),
      failed.error ?? 'no detail'
    )
    check('the header it saw is quoted', (failed.error ?? '').includes('%PDF'), failed.error ?? '')
    check('the failure offers a retry', failed.hasRetry === true)

    // The writer finishes. Nothing tells the app; the user just presses retry.
    writeFileSync(FILE, whole)
    await evaluate(
      send,
      `document.querySelector('.viewer-error-actions .btn-primary')
         .dispatchEvent(new MouseEvent('click', { bubbles: true }));`
    )

    const opened = await waitUntil(send, (s) => s.pages > 0, 'the document to open')
    check('retrying opens the completed file', opened.pages > 0, `pages=${opened.pages}`)
    check('no error remains after the retry', opened.error === null, opened.error ?? '')
  } finally {
    await app.cleanup()
    try {
      unlinkSync(FILE)
    } catch {
      /* leftover temp file is harmless */
    }
  }
}

run()
  .then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\ntest-torn-read failed:', err)
    process.exit(1)
  })

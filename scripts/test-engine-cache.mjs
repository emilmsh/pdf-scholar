// Document-open cache test for the production write engine
// (annotation-engine-embedpdf.ts — the only engine since the 2026-07-16 switch
// to EmbedPDF/MIT; mupdf here is purely the independent verifier). Verifies
// the cache's two promises on a multi-hundred-page corpus:
//
//   1. SPEED: 5 consecutive applyAnnotation on a cached doc (no flush between)
//      cost far less than 5x one full open->write->flush cycle.
//   2. CORRECTNESS: the debounced flush lands on disk by itself; a write AFTER
//      a flush still works (the doc stays open across saveAsCopy); and after
//      flushAnnotations a mupdf reopen shows EVERY annotation under the exact
//      object number the adapter reported to the renderer.
//
// Self-bundling: builds the adapter with the same esbuild settings as
// package.json's test:engine, then deletes the bundle afterwards.
// Run: node scripts/test-engine-cache.mjs
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as mupdf from 'mupdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'pdfx-engine-cache-test')
fs.mkdirSync(TMP, { recursive: true })

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const ms = (n) => `${n.toFixed(1)} ms`
const sleep = (t) => new Promise((r) => setTimeout(r, t))

// --- corpus: 150 text pages so open/serialize cost is measurable ------------
async function corpus() {
  const file = path.join(TMP, 'corpus-150p.pdf')
  if (fs.existsSync(file)) return file
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 150; i++) {
    const page = doc.addPage([595, 842])
    page.setFont(font)
    page.setFontSize(11)
    for (let line = 0; line < 40; line++) {
      page.drawText(`Side ${i + 1}, linje ${line + 1}: tekst for cache-testen av annotasjonsmotoren.`, {
        x: 60,
        y: 800 - line * 18
      })
    }
  }
  fs.writeFileSync(file, await doc.save())
  return file
}

// --- bundle both adapters with the test:engine esbuild settings -------------
const { build } = await import('esbuild')
const BUNDLES = {
  embedpdf: { entry: 'src/main/annotation-engine-embedpdf.ts', out: path.join(__dirname, '.engine-cache-test-embed.mjs') }
}
for (const { entry, out } of Object.values(BUNDLES)) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: out,
    logLevel: 'silent'
  })
}

function mupdfObjNums(file, pageIndex) {
  const pdf = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf').asPDF()
  const nums = pdf.loadPage(pageIndex).getAnnotations().map((a) => a.getObject().asIndirect())
  pdf.destroy()
  return nums
}

const srcFile = await corpus()

try {
  for (const [name, { out }] of Object.entries(BUNDLES)) {
    console.log(`\n===== ${name} adapter =====`)
    const { applyAnnotation, flushAnnotations } = await import(`file://${out}`)
    const FILE = path.join(TMP, `run-${name}.pdf`)
    fs.copyFileSync(srcFile, FILE)

    const req = (y) => ({
      path: FILE,
      pageIndex: 0,
      type: 'highlight',
      quads: [{ x: 60, y, w: 400, h: 14 }],
      color: [1, 0.84, 0.29],
      opacity: 0.5,
      author: 'cache-test'
    })
    const ids = []

    // 1. baseline: one full cycle (open -> write -> flush+evict) — this is
    // what EVERY annotation used to cost before the cache
    const t0 = performance.now()
    const r0 = await applyAnnotation(req(80))
    await flushAnnotations(FILE)
    const baseline = performance.now() - t0
    check('baseline write+flush ok', 'ok' in r0, 'ok' in r0 ? ms(baseline) : r0.error)
    if ('ok' in r0) ids.push(r0.id)

    // 2. burst: 5 consecutive writes, no flush between (one reopen, then
    // pure in-memory mutations) — must be far below 5x the baseline
    const t1 = performance.now()
    for (let i = 0; i < 5; i++) {
      const r = await applyAnnotation(req(110 + i * 24))
      check(`burst write #${i + 1} ok`, 'ok' in r, 'ok' in r ? `obj#${r.id}` : r.error)
      if ('ok' in r) ids.push(r.id)
    }
    const burst = performance.now() - t1
    check(
      'burst of 5 far below 5x single cycle',
      burst < baseline * 5 * 0.6,
      `burst ${ms(burst)} vs 5x baseline ${ms(baseline * 5)}`
    )

    // 3. the debounced flush (1200 ms) lands on disk without an explicit flush
    await sleep(2000)
    const afterDebounce = mupdfObjNums(FILE, 0)
    check('debounced flush wrote all 6 to disk', afterDebounce.length === 6, `${afterDebounce.length} annots`)

    // 4. write AFTER a flush: EmbedPDF continues on the kept-open doc (the
    // save-then-keep-editing case), mupdf transparently reopens
    const r6 = await applyAnnotation(req(260))
    check('write after flush ok', 'ok' in r6, 'ok' in r6 ? `obj#${r6.id}` : r6.error)
    if ('ok' in r6) ids.push(r6.id)

    // 5. explicit flush + independent mupdf reopen: every annotation present
    // under the exact object number the adapter reported
    await flushAnnotations(FILE)
    const final = mupdfObjNums(FILE, 0)
    const finalSet = new Set(final)
    check('all 7 annotations on disk', final.length === 7, `${final.length} annots`)
    check('every reported id present after reopen', ids.length === 7 && ids.every((id) => finalSet.has(id)),
      `ids ${ids.join(',')} vs file ${final.join(',')}`)
    check('no leftover tmp file', !fs.existsSync(`${FILE}.pdfx-tmp`))
  }
} finally {
  for (const { out } of Object.values(BUNDLES)) fs.rmSync(out, { force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

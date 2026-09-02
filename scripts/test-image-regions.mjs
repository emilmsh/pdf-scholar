// Proof for src/renderer/src/image-regions.ts — where the pictures are, from
// the operator list. Two tiers:
//   1) The pure CTM walk against synthetic op lists (fake ops table): nesting,
//      a restore past the bottom of the stack, rotated placement, the repeat
//      op, form-XObject brackets, and that masks/unknown ops are ignored.
//   2) The real pipeline: a hand-built PDF with one uncompressed RGB Image
//      XObject through pdf.js's own getOperatorList (legacy build — the
//      modern one needs DOMMatrix and refuses plain Node), asserting the
//      known placement rect ±1pt for /Rotate 0 and /Rotate 90 pages, and that
//      a page-covering image (a scan) is dropped by pageImageRects.
// sample.pdf is deliberately NOT used: it contains no raster images (see
// scripts/make-sample-pdf.mjs) and it feeds the marketing screenshots.
// Run: node scripts/test-image-regions.mjs
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SRC = fileURLToPath(new URL('../src/renderer/src/image-regions.ts', import.meta.url))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-regions-'))
const out = path.join(dir, 'image-regions.mjs')
// bundle:false — the module has no value imports by design (the ops table is
// injected), which is exactly what lets this test import it in plain Node
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol
const rectNear = (r, x0, y0, x1, y1, tol = 1) =>
  near(r.x0, x0, tol) && near(r.y0, y0, tol) && near(r.x1, x1, tol) && near(r.y1, y1, tol)

// ---------------------------------------------------------- tier 1: pure walk
const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintImageXObject: 4,
  paintInlineImageXObject: 5,
  paintImageXObjectRepeat: 6,
  paintFormXObjectBegin: 7,
  paintFormXObjectEnd: 8
}
const UNKNOWN = 99 // stands in for text ops, masks, everything else
const walk = (ops) =>
  M.imageRectsFromOps(
    ops.map(([fn]) => fn),
    ops.map(([, args]) => args ?? null),
    OPS
  )

{
  const rects = walk([
    [OPS.transform, [200, 0, 0, 100, 50, 600]],
    [OPS.paintImageXObject, ['img']]
  ])
  check('plain placement: unit square through the CTM', rects.length === 1 && rectNear(rects[0], 50, 600, 250, 700), JSON.stringify(rects))
}
{
  const rects = walk([
    [OPS.save],
    [OPS.transform, [2, 0, 0, 2, 0, 0]],
    [OPS.save],
    [OPS.transform, [100, 0, 0, 50, 10, 20]],
    [OPS.paintImageXObject, ['img']], // 2×(10..110, 20..70) = (20..220, 40..140)
    [OPS.restore],
    [OPS.restore],
    [OPS.transform, [10, 0, 0, 10, 0, 0]],
    [OPS.paintImageXObject, ['img']] // restore landed back at identity → 0..10
  ])
  check(
    'nested save/restore tracks the CTM',
    rects.length === 2 && rectNear(rects[0], 20, 40, 220, 140) && rectNear(rects[1], 0, 0, 10, 10),
    JSON.stringify(rects)
  )
}
{
  const rects = walk([
    [OPS.restore], // malformed: restore past the bottom → identity, not a throw
    [OPS.transform, [10, 0, 0, 10, 5, 5]],
    [OPS.paintImageXObject, ['img']]
  ])
  check('restore past the stack bottom degrades to identity', rects.length === 1 && rectNear(rects[0], 5, 5, 15, 15), JSON.stringify(rects))
}
{
  // 90° rotation: [0, 1, -1, 0] with a 200×100 image footprint
  const rects = walk([
    [OPS.transform, [0, 200, -100, 0, 300, 100]],
    [OPS.paintInlineImageXObject, [{}]]
  ])
  check('rotated CTM yields the covering AABB', rects.length === 1 && rectNear(rects[0], 200, 100, 300, 300), JSON.stringify(rects))
}
{
  const rects = walk([
    [OPS.transform, [1, 0, 0, 1, 100, 100]],
    [OPS.paintImageXObjectRepeat, ['img', 50, 30, [0, 0, 60, 0]]]
  ])
  check(
    'repeat op: one rect per position, scaled',
    rects.length === 2 && rectNear(rects[0], 100, 100, 150, 130) && rectNear(rects[1], 160, 100, 210, 130),
    JSON.stringify(rects)
  )
}
{
  const rects = walk([
    [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 10, 10], null]],
    [OPS.transform, [100, 0, 0, 100, 0, 0]],
    [OPS.paintImageXObject, ['img']], // (10..210, 10..210)
    [OPS.paintFormXObjectEnd],
    [OPS.transform, [10, 0, 0, 10, 0, 0]],
    [OPS.paintImageXObject, ['img']] // form end restored → 0..10
  ])
  check(
    'form XObject brackets act as save+matrix / restore',
    rects.length === 2 && rectNear(rects[0], 10, 10, 210, 210) && rectNear(rects[1], 0, 0, 10, 10),
    JSON.stringify(rects)
  )
}
{
  const rects = walk([
    [UNKNOWN, ['whatever']],
    [OPS.transform, [10, 0, 0, 10, 0, 0]],
    [UNKNOWN],
    [OPS.paintImageXObject, ['img']]
  ])
  check('unknown ops (text, masks, …) are ignored', rects.length === 1 && rectNear(rects[0], 0, 0, 10, 10), JSON.stringify(rects))
}

// ------------------------------------------------- tier 2: the real pipeline
// A hand-built PDF (the test-signatures way): one 2×2 uncompressed DeviceRGB
// Image XObject, placed at a known rect. Three pages: normal, /Rotate 90, and
// one where the image covers the whole page (a scan — must be dropped).
function imageFixture() {
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  const objs = []
  const add = (body) => {
    objs.push(body)
    return objs.length
  }
  const img = add(
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels.toString('latin1')}\nendstream`
  )
  const place = (cm) => `q ${cm} cm /Im1 Do Q`
  const mkContent = (text) => add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  const c1 = mkContent(place('200 0 0 100 50 600'))
  const c2 = mkContent(place('200 0 0 100 50 600'))
  const c3 = mkContent(place('612 0 0 792 0 0')) // full page = a scan
  const pagesNum = objs.length + 4 // pages object comes after the three pages
  const res = `/Resources << /XObject << /Im1 ${img} 0 R >> >>`
  const p1 = add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ${res} /Contents ${c1} 0 R >>`)
  const p2 = add(
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Rotate 90 ${res} /Contents ${c2} 0 R >>`
  )
  const p3 = add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ${res} /Contents ${c3} 0 R >>`)
  const pages = add(`<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R ${p3} 0 R] /Count 3 >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`)

  let outStr = '%PDF-1.7\n'
  const offsets = [0]
  for (let i = 0; i < objs.length; i++) {
    offsets.push(outStr.length)
    outStr += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = outStr.length
  outStr += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) {
    outStr += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  outStr += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const file = path.join(dir, 'image-fixture.pdf')
  fs.writeFileSync(file, Buffer.from(outStr, 'latin1'))
  return file
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
).href

const file = imageFixture()
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise
check('fixture parses (3 pages)', doc.numPages === 3, `${doc.numPages}`)

{
  const page = await doc.getPage(1)
  const rects = await M.pageImageRects(page, pdfjs.OPS)
  check('real op list: the placement rect, ±1pt', rects.length === 1 && rectNear(rects[0], 50, 600, 250, 700), JSON.stringify(rects))
  const again = await M.pageImageRects(page, pdfjs.OPS)
  check('per-proxy cache returns the same promise result', again === rects || JSON.stringify(again) === JSON.stringify(rects))
  // The viewport maps user space to view px — the same call PdfPage makes
  const vp = page.getViewport({ scale: 1, rotation: page.rotate })
  const [vx, vy] = vp.convertToViewportPoint(rects[0].x0, rects[0].y1)
  check('viewport maps the rect top-left into the page box', near(vx, 50) && near(vy, 792 - 700), `(${vx}, ${vy})`)
}
{
  // /Rotate 90: user-space rects are ROTATION-BLIND by design — the viewport
  // (which PdfPage always applies) carries the rotation
  const page = await doc.getPage(2)
  const rects = await M.pageImageRects(page, pdfjs.OPS)
  check('/Rotate 90 page: same user-space rect', rects.length === 1 && rectNear(rects[0], 50, 600, 250, 700), JSON.stringify(rects))
  const vp = page.getViewport({ scale: 1, rotation: page.rotate })
  const corners = [
    vp.convertToViewportPoint(rects[0].x0, rects[0].y0),
    vp.convertToViewportPoint(rects[0].x1, rects[0].y0),
    vp.convertToViewportPoint(rects[0].x0, rects[0].y1),
    vp.convertToViewportPoint(rects[0].x1, rects[0].y1)
  ]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  check(
    'rotated viewport lands it inside the rotated box (792×612)',
    Math.min(...xs) >= -1 && Math.max(...xs) <= 793 && Math.min(...ys) >= -1 && Math.max(...ys) <= 613,
    JSON.stringify(corners)
  )
}
{
  const page = await doc.getPage(3)
  const rects = await M.pageImageRects(page, pdfjs.OPS)
  check('a page-covering image (scan) is dropped', rects.length === 0, JSON.stringify(rects))
}

// Release the worker so Node can exit (the proxy has no destroy of its own)
await doc.loadingTask?.destroy?.()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll image-region checks passed.')

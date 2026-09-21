// Proof for src/renderer/src/image-regions.ts — where the pictures are, from
// the operator list — and for src/renderer/src/image-export.ts, the arithmetic
// that turns one of those regions into a file. Three tiers:
//   1) The pure CTM walk against synthetic op lists (fake ops table): nesting,
//      a restore past the bottom of the stack, rotated placement, the repeat
//      op, form-XObject brackets, and that masks/unknown ops are ignored.
//   2) The real pipeline: a hand-built PDF with one uncompressed RGB Image
//      XObject through pdf.js's own getOperatorList (legacy build — the
//      modern one needs DOMMatrix and refuses plain Node), asserting the
//      known placement rect ±1pt for /Rotate 0 and /Rotate 90 pages, and that
//      a page-covering image (a scan) is dropped by pageImageRects.
//   3) image-export.ts: the render scale a crop gets (the densest overlapping
//      image's own pixel grid, else 300 dpi, never coarser than the screen,
//      never past the canvas ceiling), which outlined box a click takes, and
//      what the saved file is called.
// Both modules also carry the NATIVE PIXEL SIZE of each image now — the whole
// point of «Kopier bilde», since it is what separates the file's own picture
// from a screenshot of it — so tiers 1 and 2 assert that too.
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
const SRC_EXPORT = fileURLToPath(new URL('../src/renderer/src/image-export.ts', import.meta.url))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-regions-'))
const out = path.join(dir, 'image-regions.mjs')
// bundle:false — the module has no value imports by design (the ops table is
// injected), which is exactly what lets this test import it in plain Node
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)
// Same deal for image-export.ts: its only import is `import type`, which
// esbuild erases, so it too runs in plain Node with nothing bundled.
const outExport = path.join(dir, 'image-export.mjs')
await build({ entryPoints: [SRC_EXPORT], outfile: outExport, format: 'esm', bundle: false, logLevel: 'silent' })
const X = await import(pathToFileURL(outExport).href)

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
  // The pixel size is the reason this walk grew a second output: a 1200×800
  // photo placed in a 200×100pt box must come out of «Kopier bilde» at 1200
  // px, not at the ~200 the screen shows.
  const rects = walk([
    [OPS.transform, [200, 0, 0, 100, 0, 0]],
    [OPS.paintImageXObject, ['img', 1200, 800]],
    [OPS.transform, [1, 0, 0, 1, 0, 0]],
    [OPS.paintInlineImageXObject, [{ width: 64, height: 32 }]]
  ])
  check(
    'image XObject carries its own pixel size (args[1], args[2])',
    rects[0]?.px?.w === 1200 && rects[0]?.px?.h === 800,
    JSON.stringify(rects[0])
  )
  check(
    'inline image takes the size off the decoded bitmap',
    rects[1]?.px?.w === 64 && rects[1]?.px?.h === 32,
    JSON.stringify(rects[1])
  )
}
{
  const rects = walk([
    [OPS.transform, [10, 0, 0, 10, 0, 0]],
    [OPS.paintImageXObject, ['img']], // no dimensions in the op at all
    [OPS.paintImageXObject, ['img', 0, 50]], // nonsense width
    [OPS.paintImageXObjectRepeat, ['img', 5, 5, [0, 0, 10, 0]]] // op has none
  ])
  check(
    'a missing or absurd pixel size is simply absent, never zero',
    rects.length === 4 && rects.every((r) => r.px === undefined),
    JSON.stringify(rects.map((r) => r.px))
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
  check(
    "real op list: the 2×2 fixture image reports its own pixel size",
    rects[0]?.px?.w === 2 && rects[0]?.px?.h === 2,
    JSON.stringify(rects[0]?.px)
  )
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

// ------------------------------------------- tier 3: turning one into a file
{
  // A 200x100pt box holding a 1200x800 image: 6 px per user unit across,
  // 8 down. The taller density wins - too many pixels is a bigger file, too
  // few is a blurry figure, and only one of those is recoverable.
  const region = { x0: 0, y0: 0, x1: 200, y1: 100, px: { w: 1200, h: 800 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [region], 1)
  check("a crop that IS the picture takes its own pixel grid", near(r.scale, 8, 1e-9) && r.native === true, JSON.stringify(r))
}
{
  // The case that made this rule: a 240x160 image placed at 240x160pt is a
  // 72-dpi picture. Shown at 208 % it fills 498 px on screen, and the first
  // cut of this exported it at 498 px and called that "the image's own
  // resolution". Upsampling adds no detail; the picture is 240 px wide.
  const region = { x0: 0, y0: 0, x1: 240, y1: 160, px: { w: 240, h: 160 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 240, y1: 160 }, [region], 2.08)
  check(
    'a low-dpi picture is NOT upsampled to the zoom it is read at',
    near(r.scale, 1, 1e-9) && r.native === true,
    JSON.stringify(r)
  )
}
{
  // A drag that took the caption in as well: still mostly the figure, but
  // the caption is text and must not be rendered at the figure's 72 dpi.
  const region = { x0: 0, y0: 0, x1: 240, y1: 160, px: { w: 240, h: 160 } }
  const r = X.exportScale({ x0: -4, y0: -18, x1: 244, y1: 164 }, [region], 2.08)
  check(
    'a box slightly larger than the figure is page content, not the picture',
    near(r.scale, 300 / 72, 1e-9) && r.native === false,
    JSON.stringify(r)
  )
}
{
  // Half the crop is page: text around a figure must not be rendered at the
  // figure's 72 dpi, so print dpi applies and the answer is not "native".
  const region = { x0: 0, y0: 0, x1: 100, y1: 100, px: { w: 100, h: 100 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [region], 1)
  check(
    'a crop only half covered by the image is page content at print dpi',
    near(r.scale, 300 / 72, 1e-9) && r.native === false,
    JSON.stringify(r)
  )
}
{
  // ...unless the image it does contain is finer than print dpi.
  const region = { x0: 0, y0: 0, x1: 100, y1: 100, px: { w: 1000, h: 1000 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [region], 1)
  check('a fine image inside a page crop still raises the scale', near(r.scale, 10, 1e-9), JSON.stringify(r))
}
{
  // A crop spanning a coarse logo and a fine plot must serve the plot.
  const coarse = { x0: 0, y0: 0, x1: 100, y1: 100, px: { w: 100, h: 100 } }
  const fine = { x0: 100, y0: 0, x1: 200, y1: 100, px: { w: 600, h: 600 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [coarse, fine], 1)
  check('the densest overlapping image sets the scale', near(r.scale, 6, 1e-9), JSON.stringify(r))
}
{
  // A region the crop misses does not get a vote.
  const far = { x0: 500, y0: 500, x1: 600, y1: 600, px: { w: 6000, h: 6000 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [far], 1)
  check(
    'a region outside the crop does not vote; 300 dpi applies',
    near(r.scale, 300 / 72, 1e-9) && r.native === false,
    JSON.stringify(r)
  )
}
{
  // A region with no pixel size (the repeat op) covers the crop but cannot
  // say at what resolution - print dpi, not "native".
  const sized = { x0: 0, y0: 0, x1: 200, y1: 100 }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 200, y1: 100 }, [sized], 1)
  check('a covering region with no pixel size is not a native answer', r.native === false && near(r.scale, 300 / 72, 1e-9), JSON.stringify(r))
}
{
  // Vector figures, tables, equations: no raster image anywhere near.
  const r = X.exportScale({ x0: 0, y0: 0, x1: 300, y1: 200 }, [], 1)
  check('no image at all -> print dpi, and it says so', near(r.scale, 300 / 72, 1e-9) && r.native === false, JSON.stringify(r))
}
{
  // Zoomed to 800 %, a crop of page content must not come back softer.
  const r = X.exportScale({ x0: 0, y0: 0, x1: 100, y1: 100 }, [], 8)
  check('page content is never coarser than what is already on screen', near(r.scale, 8, 1e-9), JSON.stringify(r))
}
{
  // A whole A4 page at 300 dpi would be 3500x2480 - fine. A page-sized image
  // at 20000 px is not, and the ceiling is what stops the canvas refusing.
  const huge = { x0: 0, y0: 0, x1: 612, y1: 792, px: { w: 20000, h: 26000 } }
  const r = X.exportScale({ x0: 0, y0: 0, x1: 612, y1: 792 }, [huge], 1)
  check(
    'the canvas ceiling clamps the scale, and native goes false',
    near(r.scale, X.MAX_EXPORT_SIDE / 792, 1e-9) && r.native === false,
    JSON.stringify(r)
  )
}
{
  const boxes = [
    { x: 0, y: 0, w: 400, h: 400 }, // a background panel
    { x: 50, y: 50, w: 100, h: 100 }, // the figure sitting on it
    { x: 300, y: 300, w: 50, h: 50 }
  ]
  check('a click takes the SMALLEST box under it, not the panel', X.smallestBoxAt(boxes, 100, 100) === 1)
  check('a click on the panel alone takes the panel', X.smallestBoxAt(boxes, 250, 20) === 0)
  check('a click outside every box picks nothing', X.smallestBoxAt(boxes, 900, 900) === -1)
  check('an empty list picks nothing', X.smallestBoxAt([], 10, 10) === -1)
}
{
  const boxes = [
    { x: 0, y: 0, w: 200, h: 150 },
    { x: 0.2, y: 0.4, w: 200.3, h: 150.1 }, // the same figure, placed twice
    { x: 10, y: 10, w: 4, h: 4 }, // a bullet glyph
    { x: 20, y: 20, w: 300, h: 1 } // a hairline rule
  ]
  const out = X.pickableBoxes(boxes)
  check('specks, rules and duplicates are not offered as click targets', out.length === 1, JSON.stringify(out))
}
{
  const n = X.imageExportName('Attention Is All You Need.pdf', 'bilde s. 6')
  check('file name: document, suffix, .png', n === 'Attention Is All You Need - bilde s. 6.png', n)
  const bad = X.imageExportName('a/b:c*d?e\\f.pdf', 'bilde s. 1')
  check('characters Windows forbids are replaced, not dropped', !/[\\/:*?"<>|]/.test(bad), bad)
  const dotted = X.imageExportName('Report. .pdf', 'image p. 2')
  check(
    'a name cannot end in a dot or space before the extension',
    dotted === 'Report - image p. 2.png',
    dotted
  )
  const long = X.imageExportName('x'.repeat(400) + '.pdf', 'bilde s. 9')
  check('an absurd title is cut to a writable length', long.length <= 125 && long.endsWith('.png'), String(long.length))
  const none = X.imageExportName('.pdf', 'bilde s. 3')
  check('a document with no name still yields a file name', none === 'bilde s. 3.png', none)
}

// Release the worker so Node can exit (the proxy has no destroy of its own)
await doc.loadingTask?.destroy?.()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll image-region checks passed.')

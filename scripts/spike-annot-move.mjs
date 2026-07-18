// Round-trip: create Line + Ink annotations, then MOVE them the way the
// engine's translate path will — read current geometry (getLine / getInkList /
// getRect), write it back shifted, update(), save incrementally — and verify
// after reopening. Companion to spike-note-move.mjs (setRect path).
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = path.join(import.meta.dirname, '../src/renderer/public/sample.pdf')
const TMP = path.join(os.tmpdir(), 'annot-move-test.pdf')
copyFileSync(SRC, TMP)

const DX = 40
const DY = -25

// 1. Create a line (with arrowhead, like our 'arrow' type) and an ink stroke
let doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
let page = doc.loadPage(0)

const line = page.createAnnotation('Line')
line.setLine([100, 200], [180, 140]) // downhill-right→uphill: order matters
line.setLineEndingStyles('None', 'ClosedArrow')
line.setBorderWidth(2)
line.setColor([0.9, 0.3, 0.3])
line.update()
const lineId = line.getObject().asIndirect()

const ink = page.createAnnotation('Ink')
const stroke = [[300, 300], [310, 320], [325, 305], [340, 330]]
ink.setInkList([stroke])
ink.setBorderWidth(2)
ink.setColor([0.2, 0.4, 0.8])
ink.update()
const inkId = ink.getObject().asIndirect()

writeFileSync(TMP, doc.saveToBuffer('incremental').asUint8Array())

// 2. Reopen, find by object number, translate — the engine update path
doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
page = doc.loadPage(0)
const byId = (id) => page.getAnnotations().find((a) => a.getObject().asIndirect() === id)

const foundLine = byId(lineId)
const [a, b] = foundLine.getLine()
console.log('line endpoints before:', a, b) // must be [100,200],[180,140] IN ORDER
foundLine.setLine([a[0] + DX, a[1] + DY], [b[0] + DX, b[1] + DY])
foundLine.setModificationDate(new Date())
foundLine.update()

const foundInk = byId(inkId)
const inkList = foundInk.getInkList()
console.log('ink stroke before:', JSON.stringify(inkList))
foundInk.setInkList(inkList.map((s) => s.map(([x, y]) => [x + DX, y + DY])))
foundInk.setModificationDate(new Date())
foundInk.update()

writeFileSync(TMP, doc.saveToBuffer('incremental').asUint8Array())

// 3. Reopen and verify geometry AND bounds (/Rect must follow for both)
doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
page = doc.loadPage(0)

const line2 = page.getAnnotations().find((x) => x.getObject().asIndirect() === lineId)
const [a2, b2] = line2.getLine()
// NB: getRect()/setRect() THROW on Line annots in mupdf 1.28 ("Line
// annotations have no Rect property") — bounds must come from getBounds()
const lineRect = line2.getBounds()
console.log('line endpoints after:', a2, b2)
console.log('line bounds after:', lineRect.map((v) => Math.round(v)))
const lineOk =
  Math.abs(a2[0] - (100 + DX)) < 0.5 && Math.abs(a2[1] - (200 + DY)) < 0.5 &&
  Math.abs(b2[0] - (180 + DX)) < 0.5 && Math.abs(b2[1] - (140 + DY)) < 0.5
const endings = line2.getLineEndingStyles()
console.log('line endings kept:', endings)

const ink2 = page.getAnnotations().find((x) => x.getObject().asIndirect() === inkId)
const list2 = ink2.getInkList()
const inkRect = ink2.getBounds()
console.log('ink stroke after:', JSON.stringify(list2))
console.log('ink rect after:', inkRect.map((v) => Math.round(v)))
const inkOk =
  list2.length === 1 &&
  list2[0].every(
    ([x, y], i) => Math.abs(x - (stroke[i][0] + DX)) < 0.5 && Math.abs(y - (stroke[i][1] + DY)) < 0.5
  )
const rectsOk =
  lineRect[0] < 100 + DX && lineRect[2] > 180 + DX && // line rect spans moved endpoints
  inkRect[0] < 300 + DX && inkRect[2] > 340 + DX

console.log('line move:', lineOk ? 'PASS' : 'FAIL')
console.log('ink move:', inkOk ? 'PASS' : 'FAIL')
console.log('rects follow:', rectsOk ? 'PASS' : 'FAIL')
console.log('endings kept:', endings.end === 'ClosedArrow' ? 'PASS' : 'FAIL')
process.exit(lineOk && inkOk && rectsOk && endings.end === 'ClosedArrow' ? 0 : 1)

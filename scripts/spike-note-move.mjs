// Round-trip: create a Text (note) annotation, move it via setRect, reopen
// and verify the rect moved. Mirrors annotation-engine's update path.
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = path.join(import.meta.dirname, '../src/renderer/public/sample.pdf')
const TMP = path.join(os.tmpdir(), 'note-move-test.pdf')
copyFileSync(SRC, TMP)

// 1. Create a note at (100, 100)
let doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
let page = doc.loadPage(0)
let annot = page.createAnnotation('Text')
annot.setRect([100, 100, 120, 120])
annot.setContents('flytt meg')
annot.update()
const id = annot.getObject().asIndirect()
writeFileSync(TMP, doc.saveToBuffer('incremental').asUint8Array())

// 2. Reopen, find by object number, move to (250, 300) — engine update path
doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
page = doc.loadPage(0)
const found = page.getAnnotations().find((a) => a.getObject().asIndirect() === id)
if (!found) throw new Error('annotation not found after reopen')
if (found.getType() !== 'Line') {
  found.setRect([250, 300, 270, 320])
}
found.setModificationDate(new Date())
found.update()
writeFileSync(TMP, doc.saveToBuffer('incremental').asUint8Array())

// 3. Reopen and verify
doc = mupdf.PDFDocument.openDocument(readFileSync(TMP), 'application/pdf')
page = doc.loadPage(0)
const final = page.getAnnotations().find((a) => a.getObject().asIndirect() === id)
const rect = final.getRect()
console.log('moved rect:', rect.map((v) => Math.round(v)))
console.log('contents kept:', final.getContents())
const ok = Math.abs(rect[0] - 250) < 1 && Math.abs(rect[1] - 300) < 1
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)

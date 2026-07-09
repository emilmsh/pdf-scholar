// SPIKE: prove the exact mupdf.js (npm "mupdf", Artifex WASM build) API calls
// for the PDFX annotation engine.
//
// Run: node scripts/spike-mupdf-annot.mjs
//
// Proves:
//   1. Open a PDF from a Node buffer          -> mupdf.Document.openDocument(bytes, "application/pdf")
//   2. Cast to PDFDocument                    -> doc.asPDF()  (null if not a PDF)
//   3. Search text on a page                  -> page.search(needle) : Quad[][]  (one Quad[] per hit)
//   4. Create Highlight / Underline / Text    -> page.createAnnotation(type) on a PDFPage
//   5. Style + commit                         -> setQuadPoints / setColor / setOpacity / setContents /
//                                                setAuthor / setRect / setIcon, then annot.update()
//   6. Incremental save                       -> doc.canBeSavedIncrementally(), doc.saveToBuffer("incremental")
//   7. Round-trip                             -> reopen saved bytes, enumerate annotations + properties
//   8. Coordinate facts                       -> page.getBounds() vs. quads of text near the top of the page
//
// mupdf npm package: ESM-only, TypeScript-documented (node_modules/mupdf/dist/mupdf.d.ts).
// Quad = [ulx, uly, urx, ury, llx, lly, lrx, lry]  (upper-left, upper-right, lower-left, lower-right)
// Rect = [x0, y0, x1, y1]

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as mupdf from "mupdf"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_PDF = path.join(__dirname, "..", "src", "renderer", "public", "sample.pdf")
const OUTPUT_PDF = path.join(__dirname, "spike-output.pdf")

const fmt = (n) => Math.round(n * 100) / 100
const fmtArr = (a) => "[" + Array.from(a, fmt).join(", ") + "]"

// ---------------------------------------------------------------------------
// 1. Open the sample PDF from a Node buffer
// ---------------------------------------------------------------------------
const bytes = fs.readFileSync(SAMPLE_PDF) // Node Buffer (a Uint8Array) is accepted directly
let doc = mupdf.Document.openDocument(bytes, "application/pdf")

console.log("== open ==")
console.log("isPDF:", doc.isPDF())
console.log("needsPassword:", doc.needsPassword())
console.log("pageCount:", doc.countPages())

// Cast to PDFDocument to get PDF-only APIs (saveToBuffer, canBeSavedIncrementally, ...).
// asPDF() returns null for non-PDF documents (epub etc).
const pdf = doc.asPDF()
if (!pdf) throw new Error("not a PDF document")

// ---------------------------------------------------------------------------
// 2. Page 2 (index 1): bounds + text search -> quads
// ---------------------------------------------------------------------------
const page = pdf.loadPage(1) // PDFPage on a PDFDocument
const bounds = page.getBounds() // Rect [x0, y0, x1, y1] in PDF points, y-DOWN (MuPDF space)

console.log("\n== page 2 (index 1) ==")
console.log("getBounds():", fmtArr(bounds))

// Structured text (for completeness — search() is the simpler path for quads)
const stext = page.toStructuredText()
const pageText = stext.asText()
console.log("first 120 chars of text:", JSON.stringify(pageText.slice(0, 120)))

// page.search(needle) returns Quad[][]: one entry per hit; each hit is an array
// of Quads (one quad per line fragment the hit spans).
let needle = "PDFX"
let hits = page.search(needle)
if (hits.length === 0) {
	// fallback: first word of the page
	needle = pageText.split(/\s+/).find((w) => w.length > 2) ?? "the"
	hits = page.search(needle)
}
console.log(`search(${JSON.stringify(needle)}): ${hits.length} hit(s)`)
if (hits.length === 0) throw new Error("no search hits on page 2 — cannot continue spike")
console.log("hit[0] quads:", hits[0].map(fmtArr).join(" "))

// Coordinate-direction proof: compare a quad's y values against page bounds.
// In MuPDF, origin is top-left and y increases DOWNWARD, so text near the top
// of the page has SMALL y values.
{
	const q = hits[0][0] // [ulx, uly, urx, ury, llx, lly, lrx, lry]
	console.log("\n== coordinate facts ==")
	console.log(`page height: ${fmt(bounds[3] - bounds[1])} pts (bounds y0=${fmt(bounds[1])} .. y1=${fmt(bounds[3])})`)
	console.log(`first hit quad: upper-left y=${fmt(q[1])}, lower-left y=${fmt(q[5])}`)
	console.log(q[5] > q[1]
		? "=> lower edge y > upper edge y: y increases DOWNWARD (origin at TOP-left)"
		: "=> lower edge y < upper edge y: y increases UPWARD (origin at BOTTOM-left)")
	console.log(`hit is ${q[1] < (bounds[1] + bounds[3]) / 2 ? "in the TOP half" : "in the BOTTOM half"} of the page (uly=${fmt(q[1])})`)
}

// ---------------------------------------------------------------------------
// 3a. Highlight annotation from search quads
// ---------------------------------------------------------------------------
console.log("\n== create annotations ==")

const highlight = page.createAnnotation("Highlight")
highlight.setQuadPoints(hits[0])          // Quad[] — all quads of the first hit
highlight.setColor([1, 0.9, 0.3])         // RGB 0..1 (yellow). 1/3/4 components = Gray/RGB/CMYK
highlight.setOpacity(0.5)                 // 0..1
highlight.setContents("Test note")        // /Contents (the note text)
highlight.setAuthor("PDFX Spike")         // /T (title = author) — markup annots only
highlight.setCreationDate(new Date())
highlight.update()                        // REQUIRED: regenerates the appearance stream
// GOTCHA: getRect() THROWS on quad-based markup annots ("Highlight annotations
// have no Rect property"). Use getBounds() (works for all types), or guard with hasRect().
console.log("Highlight created. bounds:", fmtArr(highlight.getBounds()), "type:", highlight.getType())

// ---------------------------------------------------------------------------
// 3b. Underline annotation on a different hit / word
// ---------------------------------------------------------------------------
let underlineQuads = hits.length > 1 ? hits[1] : null
if (!underlineQuads) {
	// find some other word on the page to underline
	for (const w of pageText.split(/\s+/)) {
		if (w.length > 3 && w !== needle) {
			const h = page.search(w)
			if (h.length > 0) { underlineQuads = h[0]; break }
		}
	}
}
if (!underlineQuads) underlineQuads = hits[0] // last resort: same quads

const underline = page.createAnnotation("Underline")
underline.setQuadPoints(underlineQuads)
underline.setColor([0.85, 0.1, 0.1])      // red
underline.setContents("Underlined by spike")
underline.setAuthor("PDFX Spike")
underline.update()
console.log("Underline created. bounds:", fmtArr(underline.getBounds()))

// ---------------------------------------------------------------------------
// 3c. Text (sticky note) annotation at a fixed point
// ---------------------------------------------------------------------------
const note = page.createAnnotation("Text")
// Rect in PDF points, y-down; icon is drawn inside this rect (~20x20 is typical).
note.setRect([72, 72, 92, 92])            // near top-left of the page
note.setColor([1, 0.8, 0])                // icon color
note.setContents("Sticky note from spike")
note.setAuthor("PDFX Spike")
note.setIcon("Note")                      // "Note" | "Comment" | "Help" | "Insert" | ...
note.setIsOpen(false)
note.update()
console.log("Text note created. rect:", fmtArr(note.getRect()), "icon:", note.getIcon())

// ---------------------------------------------------------------------------
// 4. Incremental save to a buffer, write to disk
// ---------------------------------------------------------------------------
console.log("\n== save ==")
console.log("hasUnsavedChanges:", pdf.hasUnsavedChanges())
console.log("canBeSavedIncrementally:", pdf.canBeSavedIncrementally())

const saveOpts = pdf.canBeSavedIncrementally() ? "incremental" : ""
const outBuf = pdf.saveToBuffer(saveOpts) // mupdf.Buffer
fs.writeFileSync(OUTPUT_PDF, outBuf.asUint8Array())
console.log(`saved (${saveOpts || "full rewrite"}) -> ${OUTPUT_PDF} (${outBuf.getLength()} bytes; original ${bytes.length} bytes)`)

// Free native memory (WASM heap is not garbage collected reliably)
outBuf.destroy()
page.destroy()
doc.destroy()

// ---------------------------------------------------------------------------
// 5. RE-OPEN the saved file fresh and enumerate all annotations (round-trip)
// ---------------------------------------------------------------------------
console.log("\n== round-trip: reopen and enumerate ==")
const savedBytes = fs.readFileSync(OUTPUT_PDF)
const doc2 = mupdf.Document.openDocument(savedBytes, "application/pdf")
const pdf2 = doc2.asPDF()
if (!pdf2) throw new Error("reopened file is not a PDF")

let totalAnnots = 0
for (let i = 0; i < pdf2.countPages(); i++) {
	const p = pdf2.loadPage(i)
	const annots = p.getAnnotations() // PDFAnnotation[] (excludes Widgets)
	for (const a of annots) {
		totalAnnots++
		console.log(`page ${i + 1}: ${a.getType()}`)
		// hasRect() gates getRect(); getBounds() is always safe
		console.log(`  bounds:   ${fmtArr(a.getBounds())}`)
		if (a.hasRect())
			console.log(`  rect:     ${fmtArr(a.getRect())}`)
		if (a.hasQuadPoints())
			console.log(`  quads:    ${a.getQuadPoints().map(fmtArr).join(" ")}`)
		console.log(`  color:    ${fmtArr(a.getColor())}`) // AnnotColor: [] | [g] | [r,g,b] | [c,m,y,k]
		console.log(`  opacity:  ${a.getOpacity()}`)
		console.log(`  contents: ${JSON.stringify(a.getContents())}`)
		console.log(`  author:   ${a.hasAuthor() ? JSON.stringify(a.getAuthor()) : "(n/a)"}`)
	}
	p.destroy()
}
console.log(`\ntotal annotations after round-trip: ${totalAnnots}`)
if (totalAnnots < 3) throw new Error("round-trip FAILED: expected at least 3 annotations")
doc2.destroy()

console.log("\nSPIKE OK")

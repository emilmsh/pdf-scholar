// XFA forms open read-only — and turning pdf.js's XFA support on changes
// NOTHING for any other document.
//
// The flag lives in src/renderer/src/pdf-doc.ts (`enableXfa: true`); the
// layout goes on the page through src/renderer/src/xfa.ts, which needs a DOM
// and is exercised by hand. What this test pins is the contract underneath,
// against pdf.js itself:
//
//   1. A dynamic XFA form (/NeedsRendering true, /XFA stream, no AcroForm
//      fields) lays out from its XML: isPureXfa, the form's text — headings,
//      captions — comes back from getTextContent, and the HTML tree carries
//      its controls. Without the flag the same bytes are the one-page
//      «Please wait…» placeholder, which is what the app showed before.
//   2. The gate is exactly pdf.js's: a form carrying an /XFA stream but NO
//      /NeedsRendering (a static form with an AcroForm twin) is left alone.
//   3. sample.pdf — the ordinary document every screenshot is taken of — opens
//      identically with and without the flag: same page count, same sizes,
//      same text on every page, isPureXfa false. This is the «no regression
//      elsewhere» promise (Emil, 2026-09-21), checked rather than assumed.
//   4. buildPageText's XFA rule is mirrored here: the items pdf.js gives for
//      an XFA page have no positions and no hasEOL, so the app ends every item
//      with a newline — the text must not glue captions into one word.
//
// The XFA fixture is hand-written (the real thing is a government form under
// Crown copyright). pdf.js's parser wants `reserve` on every caption — a real
// LiveCycle export always sets it; a caption without one crashes the layout
// with a bare TypeError (pdfjs-dist 6.1.200), so the fixture says so.
//
// Run: node scripts/test-xfa.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')
const STANDARD_FONTS = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const HEADING = 'PDFX XFA fixture heading'
const CAPTION = 'Applicant name'
const CHECK_CAPTION = 'I agree'

/** The XML of a small dynamic form: one page, a heading, a text field with a
 *  caption and a checkbox with a caption. */
const XDP = `<?xml version="1.0" encoding="UTF-8"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb" locale="en_US">
<pageSet>
<pageArea name="Page1" id="Page1">
<contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/>
<medium stock="letter" short="8.5in" long="11in"/>
</pageArea>
</pageSet>
<subform w="8in" layout="tb">
<draw name="Title" w="6in" h="0.5in"><value><text>${HEADING}</text></value><font typeface="Helvetica" size="14pt"/></draw>
<field name="Applicant" w="4in" h="0.35in"><ui><textEdit/></ui><caption placement="left" reserve="1.5in"><value><text>${CAPTION}</text></value></caption><value><text>Prefilled value</text></value></field>
<field name="Agree" w="2in" h="0.3in"><ui><checkButton/></ui><caption placement="right" reserve="1.5in"><value><text>${CHECK_CAPTION}</text></value></caption><items><integer>1</integer><integer>0</integer></items><value><integer>0</integer></value></field>
</subform>
</subform>
</template>
<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Applicant>Prefilled value</Applicant></form1></xfa:data></xfa:datasets>
</xdp:xdp>`

/** A one-page PDF whose catalog carries the XDP above. `dynamic` decides the
 *  /NeedsRendering flag — with it, this is what LiveCycle writes; without it,
 *  a static form pdf.js must keep showing from its PDF page. */
function xfaFixture({ dynamic }) {
  const enc = new TextEncoder()
  const content = 'BT /F1 12 Tf 72 720 Td (Please wait...) Tj ET'
  const xdp = enc.encode(XDP)
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R${dynamic ? ' /NeedsRendering true' : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    '<< /Fields [] /XFA 7 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    { head: `<< /Length ${xdp.length} >>\nstream\n`, body: xdp, tail: '\nendstream' }
  ]
  const parts = []
  let len = 0
  const push = (s) => {
    const b = typeof s === 'string' ? enc.encode(s) : s
    parts.push(b)
    len += b.length
  }
  push('%PDF-1.7\n')
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(len)
    push(`${i + 1} 0 obj\n`)
    if (typeof o === 'string') push(o)
    else {
      push(o.head)
      push(o.body)
      push(o.tail)
    }
    push('\nendobj\n')
  })
  const xref = len
  push(
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  )
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(len)
  let p = 0
  for (const b of parts) {
    out.set(b, p)
    p += b.length
  }
  return out
}

async function open(bytes, enableXfa) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa,
    standardFontDataUrl: STANDARD_FONTS,
    // pdf.js warns about the fixture's minimal /Resources; keep the run quiet
    verbosity: 0
  }).promise
}

/** The app's buildPageText rule (src/renderer/src/search.ts), for the text
 *  comparison below: same concatenation, same XFA newline. */
async function pageText(doc, n) {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  const xfa = doc.isPureXfa
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    text += item.str
    if (item.hasEOL || xfa) text += '\n'
  }
  return text
}

function controls(xfaHtml) {
  const found = []
  const walk = (n) => {
    if (!n) return
    if (n.name === 'input' || n.name === 'textarea' || n.name === 'select') {
      found.push(n.attributes?.type ?? n.name)
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(xfaHtml)
  return found
}

// ---- 1. A dynamic XFA form lays out from its XML ----
{
  const bytes = xfaFixture({ dynamic: true })
  const off = await open(bytes, false)
  const p = await off.getPage(1)
  check('flag off: the placeholder page is all there is', off.isPureXfa === false && off.numPages === 1)
  check(
    'flag off: the text is Adobe\'s «Please wait…»',
    (await pageText(off, 1)).startsWith('Please wait'),
    JSON.stringify(await pageText(off, 1))
  )
  check('flag off: getXfa() has nothing to give', (await p.getXfa()) === null)

  const on = await open(bytes, true)
  const page = await on.getPage(1)
  const text = await pageText(on, 1)
  const xfaHtml = await page.getXfa()
  check('flag on: the document is a pure XFA form', on.isPureXfa === true)
  check('flag on: one laid-out page', on.numPages === 1)
  const vp = page.getViewport({ scale: 1 })
  check('flag on: the page has the form\'s letter size', vp.width === 612 && vp.height === 792, `${vp.width}x${vp.height}`)
  check('flag on: the heading is in the text', text.includes(HEADING), JSON.stringify(text))
  check('flag on: the field captions are in the text', text.includes(CAPTION) && text.includes(CHECK_CAPTION))
  check('flag on: «Please wait» is gone', !text.includes('Please wait'))
  check(
    'flag on: each text item ends its own line (buildPageText\'s XFA rule)',
    text.includes(`${HEADING}\n`) && text.includes(`${CAPTION}\n`),
    JSON.stringify(text)
  )
  check('flag on: the HTML tree is the page (div.xfaPage)', xfaHtml?.name === 'div' && xfaHtml.attributes?.class?.includes('xfaPage'))
  const kinds = controls(xfaHtml)
  check('flag on: a text field and a checkbox are laid out', kinds.includes('text') && kinds.includes('checkbox'), kinds.join(','))
  check('flag on: the page has no PDF annotations to write to', (await page.getAnnotations()).length === 0)
  const ops = await page.getOperatorList()
  check('flag on: the canvas paints nothing (the HTML layer IS the page)', ops.fnArray.length === 0, `${ops.fnArray.length} ops`)
}

// ---- 2. The gate: a static XFA form stays a PDF ----
{
  const doc = await open(xfaFixture({ dynamic: false }), true)
  check('static form (no /NeedsRendering): not treated as XFA', doc.isPureXfa === false)
  check('static form: shows its PDF page', (await pageText(doc, 1)).startsWith('Please wait'))
}

// ---- 3. An ordinary document is untouched by the flag ----
{
  const bytes = new Uint8Array(fs.readFileSync(SAMPLE))
  const a = await open(bytes, false)
  const b = await open(bytes, true)
  check('sample.pdf: not an XFA form', b.isPureXfa === false)
  check('sample.pdf: same page count', a.numPages === b.numPages, `${a.numPages} vs ${b.numPages}`)
  let sameSize = true
  let sameText = true
  let annots = true
  for (let n = 1; n <= a.numPages; n++) {
    const pa = await a.getPage(n)
    const pb = await b.getPage(n)
    const va = pa.getViewport({ scale: 1 })
    const vb = pb.getViewport({ scale: 1 })
    if (va.width !== vb.width || va.height !== vb.height) sameSize = false
    if ((await pageText(a, n)) !== (await pageText(b, n))) sameText = false
    if ((await pa.getAnnotations()).length !== (await pb.getAnnotations()).length) annots = false
  }
  check('sample.pdf: same page sizes', sameSize)
  check('sample.pdf: same text on every page', sameText)
  check('sample.pdf: same annotations on every page', annots)
  check('sample.pdf: getXfa() stays null', (await (await b.getPage(1)).getXfa()) === null)
}

console.log(failures === 0 ? '\nAll XFA checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

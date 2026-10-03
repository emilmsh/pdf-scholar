// Files embedded in a PDF: what the app may do with one, and that it finds them.
//
//   1. The rules (src/shared/attachments.ts) — the part that keeps «Åpne» from
//      being the way a PDF delivers malware. The allow list opens documents,
//      data and media and nothing else; the name is checked AS IT WILL EXIST ON
//      DISK, so a bidi override, a trailing dot, an NTFS stream suffix or a
//      double extension cannot dress an executable up as a spreadsheet; and
//      the Mark of the Web is inherited from the document, never invented.
//   2. The reading (src/renderer/src/attachments.ts) against pdf.js itself:
//      both kinds of attachment are listed — the document's /EmbeddedFiles
//      first, then the paperclips by page — their bytes come back intact, also
//      from a SECOND pdf.js document opened from the same bytes (every
//      annotation write re-opens the file, so the bytes are always read from a
//      document other than the one the list came from), /PageMode
//      /UseAttachments is recognised, and sample.pdf — an ordinary paper —
//      has none and costs none.
//
// That the files SURVIVE an annotation save is test:engine's section 13.
// Run: node scripts/test-attachments.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'attachments-'))
async function load(src, name) {
  const out = join(dir, name)
  await build({ entryPoints: [here(src)], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
  return import(pathToFileURL(out).href)
}
const A = await load('../src/shared/attachments.ts', 'shared.mjs')
const R = await load('../src/renderer/src/attachments.ts', 'renderer.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}`)

// --- 1. The rules ---------------------------------------------------------------

// What may be opened
for (const name of ['Bilag 3.xlsx', 'beregning.XLS', 'notat.docx', 'brev.doc', 'rapport.pdf', 'tabell.csv',
  'bilde.jpg', 'opptak.mp3', 'epost.msg', 'lysark.pptx', 'regneark.ods']) {
  check(`opens: ${name}`, A.canOpenAttachment(name))
}
// …and what is only ever saved
for (const name of ['setup.exe', 'install.msi', 'run.bat', 'run.cmd', 'script.ps1', 'script.js', 'script.vbs',
  'app.hta', 'snarvei.lnk', 'skjerm.scr', 'lib.jar', 'arkiv.zip', 'arkiv.7z', 'side.html', 'side.htm',
  'figur.svg', 'makro.xlsm', 'makro.docm', 'makro.pptm', 'binær.xlsb', 'tillegg.xlam', 'mal.dotm', 'uten-endelse']) {
  check(`only saved: ${name}`, !A.canOpenAttachment(name))
}
// The disguises: each of these is an executable once the name reaches disk
check('a bidi override cannot fake the extension', !A.canOpenAttachment('rapport\u202Excod.exe'),
  A.cleanAttachmentName('rapport\u202Excod.exe'))
eq('…and the override is gone from the name shown', A.cleanAttachmentName('rapport\u202Excod.exe'), 'rapportxcod.exe')
check('a double extension is judged by the last one', !A.canOpenAttachment('Bilag 1.pdf.exe'))
check('a trailing dot (Windows drops it) does not hide .exe', !A.canOpenAttachment('Bilag 1.exe.'))
eq('…the dot is trimmed, as Windows would', A.cleanAttachmentName('Bilag 1.exe.'), 'Bilag 1.exe')
check('trailing spaces likewise', !A.canOpenAttachment('Bilag 1.exe   '))
check('an NTFS stream suffix cannot become the extension', !A.canOpenAttachment('Bilag.xlsx:skjult.exe'))
eq('…the colon is replaced', A.cleanAttachmentName('Bilag.xlsx:skjult.exe'), 'Bilag.xlsx_skjult.exe')
check('zero-width characters inside the extension are removed, not trusted',
  !A.canOpenAttachment('Bilag.e\u200Bxe') && A.attachmentExtension('Bilag.e\u200Bxe') === 'exe')

// Names made safe to write
eq('a path is cut to its last segment', A.cleanAttachmentName('C:\\Users\\x\\..\\Bilag 2.xlsx'), 'Bilag 2.xlsx')
eq('…forward slashes too', A.cleanAttachmentName('../../etc/Bilag 2.xlsx'), 'Bilag 2.xlsx')
eq('forbidden characters become _', A.cleanAttachmentName('Bilag <1>: "a|b?".xlsx'), 'Bilag _1__ _a_b__.xlsx')
eq('control characters are dropped', A.cleanAttachmentName('Bil\u0000ag\u0007 1.xlsx'), 'Bilag 1.xlsx')
eq('a device name is defused', A.cleanAttachmentName('CON.xlsx'), '_CON.xlsx')
eq('…in any case', A.cleanAttachmentName('nul'), '_nul')
eq('an empty name takes the fallback', A.cleanAttachmentName('', 'vedlegg'), 'vedlegg')
eq('…so does one of only dots', A.cleanAttachmentName('...', 'vedlegg'), 'vedlegg')
eq('…and one that is only a path', A.cleanAttachmentName('mappe/', 'vedlegg'), 'vedlegg')
{
  const long = A.cleanAttachmentName(`${'x'.repeat(400)}.xlsx`)
  check('a long name is capped with its extension kept', long.length === 150 && long.endsWith('.xlsx'), `${long.length}`)
}
eq('extension is lower-cased', A.attachmentExtension('BILAG.PDF'), 'pdf')
eq('a leading dot is not an extension', A.attachmentExtension('.xlsx'), '')
check('PDF is recognised for the in-app tab', A.isPdfAttachment('Bilag 4.PDF') && !A.isPdfAttachment('Bilag.pdf.zip'))

// Numbering in a folder that already has the name
eq('n = 1 is the name itself', A.numberedName('Bilag 1.xlsx', 1), 'Bilag 1.xlsx')
eq('then « (2)» before the extension', A.numberedName('Bilag 1.xlsx', 2), 'Bilag 1 (2).xlsx')
eq('…or at the end without one', A.numberedName('README', 3), 'README (3)')

// Download types: a wrong one makes Chromium rename the file
eq('xlsx downloads as a spreadsheet',
  A.attachmentMime('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
eq('anything unknown downloads as octet-stream (left alone)', A.attachmentMime('a.exe'), 'application/octet-stream')

// The Mark of the Web
{
  const downloaded = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://mail.example/\r\nHostUrl=https://mail.example/x\r\n'
  const out = A.propagatedZoneIdentifier(downloaded, 'C:\\Users\\x\\Downloads\\Prosesskriv.pdf')
  check('an internet-zone document passes its zone on', !!out && /ZoneId=3/.test(out), JSON.stringify(out))
  check('…naming the document it came out of, and NOT the source URL',
    !!out && out.includes('ReferrerUrl=C:\\Users\\x\\Downloads\\Prosesskriv.pdf') && !out.includes('mail.example'))
  eq('a document with no mark gives none', A.propagatedZoneIdentifier(null, 'C:\\x.pdf'), null)
  eq('an unreadable mark gives none', A.propagatedZoneIdentifier('garbage', 'C:\\x.pdf'), null)
  eq('a zone out of range gives none', A.propagatedZoneIdentifier('[ZoneTransfer]\nZoneId=7\n', 'C:\\x.pdf'), null)
  const forged = A.propagatedZoneIdentifier('[ZoneTransfer]\nZoneId=3\n', 'C:\\x.pdf\r\nZoneId=0')
  check('a path with a line break cannot forge a second key', !!forged && !forged.includes('ZoneId=0'), JSON.stringify(forged))
}

// --- 2. The reading, against pdf.js ---------------------------------------------

const sheet = new TextEncoder().encode('PK\u0003\u0004 a spreadsheet, as far as this test cares')
const memo = new TextEncoder().encode('%PDF-1.7 an exhibit that is itself a PDF')
const pinnedBytes = new TextEncoder().encode('the file behind the paperclip on page 2')

/** A two-page filing: two files attached to the document (the second one's
 *  name sorting FIRST, so tree order is what is under test), and a paperclip
 *  annotation on page 2 carrying a third. */
function filing({ pageMode } = {}) {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  const res = doc.addObject({ Font: { F1: font } })
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'BT /F1 24 Tf 72 760 Td (Prosesskriv) Tj ET'))
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'BT /F1 24 Tf 72 760 Td (Bilag) Tj ET'))
  const when = new Date('2026-10-01T12:00:00Z')
  const a = doc.addEmbeddedFile('Bilag 2 - beregning.xlsx', 'application/vnd.ms-excel', sheet, when, when)
  a.put('Desc', doc.newString('Beregningsgrunnlag'))
  doc.insertEmbeddedFile('Bilag 2 - beregning.xlsx', a)
  doc.insertEmbeddedFile('Bilag 1 - avtale.pdf', doc.addEmbeddedFile('Bilag 1 - avtale.pdf', 'application/pdf', memo, when, when))
  const page = doc.loadPage(1)
  const clip = page.createAnnotation('FileAttachment')
  clip.setRect([500, 700, 520, 724])
  clip.setContents('Se vedlagt')
  clip.setFileSpec(doc.addEmbeddedFile('Bilag 3.docx', 'application/msword', pinnedBytes, when, when))
  clip.update()
  if (pageMode) doc.getTrailer().get('Root').put('PageMode', doc.newName(pageMode))
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

/** pdf.js v6 destroys through the loading task, not the document */
const tasks = []
const open = (bytes) => {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false })
  tasks.push(task)
  return task.promise
}
const same = (x, y) => !!x && !!y && Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0

{
  const bytes = filing()
  const doc = await open(bytes)
  const list = await R.collectAttachments(doc, 'vedlegg')
  eq('three attachments listed', list.length, 3)
  eq('the document\'s own come first, in tree order', list.map((a) => a.name).join(' | '),
    'Bilag 1 - avtale.pdf | Bilag 2 - beregning.xlsx | Bilag 3.docx')
  eq('a document-level file has no page', list[0].page, null)
  eq('its description comes from /Desc', list[1].description, 'Beregningsgrunnlag')
  eq('the paperclip is on page 2', list[2].page, 2)
  eq('…and its description comes from the annotation\'s /Contents', list[2].description, 'Se vedlagt')
  check('the bytes come back: document-level', same(await R.readAttachment(doc, list[1]), sheet))
  check('…a PDF exhibit', same(await R.readAttachment(doc, list[0]), memo))
  check('…the paperclip\'s', same(await R.readAttachment(doc, list[2]), pinnedBytes))

  // Every write swaps in a new pdf.js document: the list stays, the document
  // under it does not. An annotation's id only exists in a worker that has
  // parsed that page — readAttachment must see to that itself.
  const again = await open(bytes)
  check('after a re-open: the document-level file still reads', same(await R.readAttachment(again, list[1]), sheet))
  check('after a re-open: the paperclip\'s file still reads', same(await R.readAttachment(again, list[2]), pinnedBytes))
  eq('an entry that names nothing reads as null, not a throw',
    await R.readAttachment(again, { id: 'attachmentRef:999R', name: 'x', description: '', page: null }), null)
  eq('no /PageMode: opens on the pages as usual', await R.opensOnAttachments(doc), false)
}
{
  const doc = await open(filing({ pageMode: 'UseAttachments' }))
  eq('/PageMode /UseAttachments is recognised', await R.opensOnAttachments(doc), true)
}
{
  const sample = new Uint8Array(fs.readFileSync(here('../src/renderer/public/sample.pdf')))
  const doc = await open(sample)
  const t0 = performance.now()
  const list = await R.collectAttachments(doc, 'vedlegg')
  eq('sample.pdf — an ordinary paper — has no attachments', list.length, 0)
  console.log(`      (${(performance.now() - t0).toFixed(1)} ms for ${doc.numPages} pages, cold)`)
}

await Promise.all(tasks.map((t) => t.destroy()))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

// Files embedded in a PDF, end to end in the REAL desktop app.
//
//   npm run test:attachments-desktop        (needs `npm run build` first)
//
// test:attachments pins the rules and the pdf.js reading in Node; this drives
// what only the built app has — main's IPC handlers and the UI around them:
//
//   1. A filing with four attachments shows the «4 vedlegg» chip, and the chip
//      opens «Innhold» with the list on top.
//   2. The rows offer what the allow list allows: «Åpne» on a spreadsheet and
//      a PDF, only «Lagre» on an .exe (whose type chip is marked).
//   3. «Åpne» on a PDF attachment opens it as a NEW TAB here, read from a temp
//      copy — and on Windows that copy carries the filing's Mark of the Web
//      (ZoneId=3 in, ZoneId=3 out), naming the filing as where it came from.
//      Opening it again reuses the same copy instead of writing a second one.
//   4. main refuses on its own what the UI never offers: an .exe or a macro
//      workbook through window.api.openAttachment is `attach-blocked`, and
//      no bytes at all is `attach-unreadable` — without starting anything.
//
// Not driven: «Lagre …» (a native save dialog CDP cannot reach) and «Åpne» on
// a non-PDF (it starts Excel). Both are hand checks before a release.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9341
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const WORK = mkdtempSync(join(tmpdir(), 'pdfx-attach-'))
const FILING = join(WORK, 'Prosesskriv med bilag.pdf')
const EXHIBIT = 'Bilag 1 – Avtale.pdf'
const TEMP_ROOT = join(tmpdir(), 'PDF Scholar', 'attachments')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** A real one-page PDF to attach — it has to open as a tab */
function exhibitBytes() {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, doc.addObject({ Font: { F1: font } }),
    'BT /F1 24 Tf 72 760 Td (Bilag 1) Tj ET'))
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

function makeFiling(exhibit) {
  const doc = mupdf.Document.openDocument(readFileSync(SAMPLE), 'application/pdf').asPDF()
  const when = new Date('2026-10-01T12:00:00Z')
  const add = (name, mime, bytes) => {
    const fs = doc.addEmbeddedFile(name, mime, bytes, when, when)
    doc.insertEmbeddedFile(name, fs)
    return fs
  }
  const text = (s) => new TextEncoder().encode(s)
  add(EXHIBIT, 'application/pdf', exhibit)
  add('Bilag 2 – Beregning.xlsx', 'application/vnd.ms-excel', text('PK not really'))
  add('oppdater.exe', 'application/octet-stream', text('MZ'))
  const clip = doc.loadPage(1).createAnnotation('FileAttachment')
  clip.setRect([520, 60, 540, 84])
  clip.setFileSpec(doc.addEmbeddedFile('Rådata.csv', 'text/csv', text('a,b\n1,2\n'), when, when))
  clip.update()
  writeFileSync(FILING, doc.saveToBuffer('').asUint8Array())
  doc.destroy()
  // Downloaded from the internet, as far as Windows is concerned
  if (process.platform === 'win32') {
    writeFileSync(`${FILING}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.org/\r\n')
  }
}

const tempCopies = () => {
  if (!existsSync(TEMP_ROOT)) return []
  return readdirSync(TEMP_ROOT).filter((d) => existsSync(join(TEMP_ROOT, d, EXHIBIT)))
}

async function waitFor(send, expr, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(send, `return (${expr})`)
    if (last) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

async function run() {
  const exhibit = exhibitBytes()
  makeFiling(exhibit)
  const copiesBefore = new Set(tempCopies())

  const app = launchApp({ root: ROOT, mainJs: join(ROOT, 'out', 'main', 'index.js'), args: [FILING], port: PORT })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    // 1. The chip, and what it opens
    const chip = await waitFor(send,
      `[...document.querySelectorAll('.signature-info button')].map(b => b.textContent).find(t => /vedlegg|attachment/i.test(t))`,
      'the attachments chip')
    check('the chip counts every attachment, the paperclip included', /^4\b/.test(chip), chip)
    await evaluate(send, `[...document.querySelectorAll('.signature-info button')].find(b => /vedlegg|attachment/i.test(b.textContent)).click()`)
    const rows = await waitFor(send, `document.querySelectorAll('.attach-row').length || 0`, 'the list')
    check('the chip opens the list', rows === 4, `${rows} rows`)
    const tab = await evaluate(send, `return document.querySelector('.sidebar-tabs button.active')?.textContent`)
    check('…on «Innhold»', /Innhold|Contents/.test(tab ?? ''), tab)

    // 2. What each row offers
    const offer = await evaluate(send, `
      const row = (needle) => [...document.querySelectorAll('.attach-row')].find(r => r.textContent.includes(needle));
      const info = (r) => ({ buttons: r.querySelectorAll('.attach-btn').length, blocked: !!r.querySelector('.attach-ext.is-blocked') });
      return { exe: info(row('oppdater.exe')), xlsx: info(row('Beregning.xlsx')), pdf: info(row('Avtale.pdf')), csv: info(row('Rådata.csv')),
               page: row('Rådata.csv').querySelector('.attach-page')?.textContent ?? null }`)
    check('an .exe gets «Lagre» only', offer.exe.buttons === 1, JSON.stringify(offer.exe))
    check('…and its type chip says so', offer.exe.blocked)
    check('a spreadsheet gets «Åpne» and «Lagre»', offer.xlsx.buttons === 2 && !offer.xlsx.blocked, JSON.stringify(offer.xlsx))
    check('a PDF too', offer.pdf.buttons === 2, JSON.stringify(offer.pdf))
    check('the paperclip names its page', /2/.test(offer.page ?? ''), offer.page)

    // The name of a save-only type opens the bubble that SAYS why, rather than
    // a save dialog for an .exe without a word (and a tooltip never reaches a
    // finger)
    const bubble = await evaluate(send, `
      const r = [...document.querySelectorAll('.attach-row')].find(r => r.textContent.includes('oppdater.exe'));
      r.querySelector('.attach-name').click();
      await new Promise(res => setTimeout(res, 400));
      const pop = document.querySelector('.attach-pop');
      const out = pop && {
        note: pop.querySelector('.attach-pop-note')?.textContent ?? null,
        buttons: [...pop.querySelectorAll('.attach-pop-actions button')].map(b => b.textContent.trim())
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(res => setTimeout(res, 200));
      return { ...out, closed: !document.querySelector('.attach-pop') }`)
    check('the .exe name opens its bubble with the reason in words', /\.exe/i.test(bubble.note ?? ''),
      JSON.stringify(bubble.note))
    check('…offering «Lagre» and no «Åpne»', bubble.buttons?.length === 1 && /Lagre|Save/.test(bubble.buttons[0]),
      JSON.stringify(bubble.buttons))
    check('…and Esc closes it', bubble.closed)

    // 3. «Åpne» on the PDF: a new tab, from a marked temp copy
    await evaluate(send, `
      const r = [...document.querySelectorAll('.attach-row')].find(r => r.textContent.includes('Avtale.pdf'));
      r.querySelector('.attach-btn').click()`)
    const tabs = await waitFor(send,
      `(() => { const t = [...document.querySelectorAll('.tab')].map(e => e.textContent); return t.some(x => x.includes('Avtale')) && t })()`,
      'the exhibit tab')
    check('the PDF attachment opens as a new tab', tabs.length === 2, JSON.stringify(tabs))
    const copies = tempCopies().filter((d) => !copiesBefore.has(d))
    check('…read from one temp copy', copies.length === 1, copies.join(', '))
    const copy = copies[0] ? join(TEMP_ROOT, copies[0], EXHIBIT) : null
    check('…holding the attachment\'s exact bytes',
      !!copy && Buffer.compare(readFileSync(copy), Buffer.from(exhibit)) === 0)
    if (process.platform === 'win32' && copy) {
      let zone = ''
      try {
        zone = readFileSync(`${copy}:Zone.Identifier`, 'utf8')
      } catch {
        /* no stream */
      }
      check('…carrying the filing\'s Mark of the Web', /ZoneId=3/.test(zone), JSON.stringify(zone))
      check('…naming the filing as its source, not the filing\'s URL',
        zone.includes(FILING) && !zone.includes('example.org'))
    }
    const reopened = await evaluate(send, `
      const bytes = new Uint8Array(${JSON.stringify(Array.from(exhibit))});
      return window.api.openAttachment(${JSON.stringify(EXHIBIT)}, bytes, ${JSON.stringify(FILING)})`)
    check('opening it again succeeds', reopened && reopened.ok === true, JSON.stringify(reopened))
    check('…from the same copy, not a second one',
      tempCopies().filter((d) => !copiesBefore.has(d)).length === 1)

    // 4. main's own refusals — nothing is started for any of these
    const refusals = await evaluate(send, `
      const f = ${JSON.stringify(FILING)};
      return {
        exe: await window.api.openAttachment('oppdater.exe', new Uint8Array([77, 90]), f),
        disguised: await window.api.openAttachment('Bilag\\u202Excod.exe', new Uint8Array([77, 90]), f),
        macro: await window.api.openAttachment('modell.xlsm', new Uint8Array([80, 75]), f),
        empty: await window.api.openAttachment('Bilag.xlsx', new Uint8Array(0), f),
        notBytes: await window.api.openAttachment('Bilag.xlsx', 'MZ', f)
      }`)
    check('main refuses an .exe', refusals.exe?.code === 'attach-blocked', JSON.stringify(refusals.exe))
    check('…and one disguised with a bidi override', refusals.disguised?.code === 'attach-blocked',
      JSON.stringify(refusals.disguised))
    check('…and a macro workbook', refusals.macro?.code === 'attach-blocked', JSON.stringify(refusals.macro))
    check('no bytes is unreadable, not a launch', refusals.empty?.code === 'attach-unreadable', JSON.stringify(refusals.empty))
    check('…nor is a string posing as bytes', refusals.notBytes?.code === 'attach-unreadable',
      JSON.stringify(refusals.notBytes))
  } finally {
    await app.cleanup()
    for (const d of tempCopies()) if (!copiesBefore.has(d)) rmSync(join(TEMP_ROOT, d), { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\ntest-attachments-desktop failed:', err)
    process.exit(1)
  })

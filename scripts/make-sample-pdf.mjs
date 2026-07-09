// Generates src/renderer/public/sample.pdf — a multi-page test document used
// by the browser preview ("Åpne eksempeldokument") and for manual testing.
// pdf-lib lays out the content; mupdf then adds an outline (TOC) and clickable
// internal/external links so navigation features can be exercised.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'public', 'sample.pdf')

const W = 595.28
const H = 841.89
const MARGIN = 68
const BODY_SIZE = 11.5
const LEADING = 17

const LOREM = [
  'Dette er et eksempeldokument for PDFX, en tro kopi av PDF Expert for Windows.',
  'Målet med appen er en vakker og distraksjonsfri leseopplevelse, med annoteringsverktøy som alltid er lett tilgjengelige, god navigasjon i dokumentet og full kontroll over lesemodus og kontrast.',
  'Avsnittet du leser nå finnes bare for å fylle siden med tekst, slik at tekstmarkering, søk og annotering kan testes på ekte innhold. Marker gjerne en setning for å prøve markeringsverktøyet.',
  'God typografi og rolige farger er en stor del av grunnen til at PDF Expert oppleves så behagelig. Denne kopien forsøker å gjenskape den samme roen: dempede verktøylinjer, myke skygger og et lesefelt som får all oppmerksomheten.',
  'Når du følger en intern lenke i et dokument, skal det alltid være enkelt å komme tilbake til der du var. Navigasjonshistorikk med en tydelig tilbake-knapp er derfor en sentral del av planen.',
  'Sepia- og nattmodus er mer enn bare estetikk. For lange lesestunder betyr riktig kontrast mindre slitne øyne, og derfor skal kontrasten i hver lesemodus kunne justeres.'
]

const SECTIONS = [
  { title: '1. Innledning', paragraphs: [LOREM[0], LOREM[1], LOREM[2]] },
  { title: '2. Leseopplevelsen', paragraphs: [LOREM[3], LOREM[2], LOREM[5]] },
  { title: '3. Annotering', paragraphs: [LOREM[2], LOREM[1], LOREM[3]] },
  { title: '4. Navigasjon', paragraphs: [LOREM[4], LOREM[0], LOREM[2]] },
  { title: '5. Lesemodus og kontrast', paragraphs: [LOREM[5], LOREM[3], LOREM[1]] },
  { title: '6. Veien videre', paragraphs: [LOREM[1], LOREM[4], LOREM[0]] }
]

function wrap(text, font, size, maxWidth) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

const doc = await PDFDocument.create()
const body = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)

doc.setTitle('PDFX eksempeldokument')

// Cover page (TOC list is drawn after the sections are laid out)
const cover = doc.addPage([W, H])
cover.drawText('PDFX', { x: MARGIN, y: H - 260, size: 64, font: bold, color: rgb(0.2, 0.45, 0.95) })
cover.drawText('Eksempeldokument', { x: MARGIN, y: H - 300, size: 20, font: body, color: rgb(0.2, 0.2, 0.22) })
cover.drawText('En tro kopi av PDF Expert – for Windows', {
  x: MARGIN,
  y: H - 326,
  size: 12,
  font: body,
  color: rgb(0.45, 0.45, 0.48)
})

let page = null
let y = 0
let pageNo = 1

function newPage() {
  page = doc.addPage([W, H])
  pageNo += 1
  y = H - MARGIN
  page.drawText(String(pageNo), {
    x: W / 2 - 5,
    y: 36,
    size: 9,
    font: body,
    color: rgb(0.55, 0.55, 0.58)
  })
}

function ensureSpace(needed) {
  if (!page || y - needed < MARGIN) newPage()
}

// { title, pageIndex (0-based), destY (PDF user space, bottom-up) } per section
const sectionMeta = []

for (const section of SECTIONS) {
  ensureSpace(120)
  y -= 14
  sectionMeta.push({ title: section.title, pageIndex: doc.getPageCount() - 1, destY: y + 24 })
  page.drawText(section.title, { x: MARGIN, y, size: 17, font: bold, color: rgb(0.12, 0.12, 0.14) })
  y -= 26
  // Repeat paragraphs so each section spans more than one screenful
  for (let rep = 0; rep < 3; rep++) {
    for (const paragraph of section.paragraphs) {
      const lines = wrap(paragraph, body, BODY_SIZE, W - MARGIN * 2)
      ensureSpace(lines.length * LEADING + 10)
      for (const line of lines) {
        ensureSpace(LEADING)
        page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: body, color: rgb(0.15, 0.15, 0.17) })
        y -= LEADING
      }
      y -= 9
    }
  }
}

// Clickable TOC on the cover — record rects for the mupdf link pass
cover.drawText('Innhold', { x: MARGIN, y: H - 420, size: 13, font: bold, color: rgb(0.25, 0.25, 0.28) })
const tocLinks = []
{
  const size = 12
  let ty = H - 448
  for (const meta of sectionMeta) {
    const label = `${meta.title}  ·  s. ${meta.pageIndex + 1}`
    cover.drawText(label, { x: MARGIN, y: ty, size, font: body, color: rgb(0.2, 0.45, 0.95) })
    tocLinks.push({
      rect: [MARGIN - 2, H - (ty + size + 2), MARGIN + body.widthOfTextAtSize(label, size) + 4, H - ty + 4],
      pageIndex: meta.pageIndex,
      destY: meta.destY
    })
    ty -= 22
  }
  cover.drawText('Les mer på pdfexpert.com', { x: MARGIN, y: 80, size: 10, font: body, color: rgb(0.45, 0.45, 0.48) })
}

const generated = await doc.save()

// ---- mupdf pass: outline + link annotations ----
const mupdf = await import('mupdf')
const mdoc = mupdf.Document.openDocument(generated, 'application/pdf')
const pdf = mdoc.asPDF()

const destUri = (pageIndex, destY) =>
  pdf.formatLinkURI({ type: 'XYZ', chapter: 0, page: pageIndex, x: 0, y: destY, width: 0, height: 0, zoom: 0 })

const iterator = pdf.outlineIterator()
for (const meta of sectionMeta) {
  iterator.insert({ title: meta.title, uri: destUri(meta.pageIndex, meta.destY), open: true })
}

const coverPage = pdf.loadPage(0)
for (const link of tocLinks) {
  coverPage.createLink(link.rect, destUri(link.pageIndex, link.destY))
}
coverPage.createLink([MARGIN - 2, H - 94, MARGIN + 140, H - 74], 'https://pdfexpert.com/')

const buffer = pdf.saveToBuffer('garbage=2,compress=yes')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, buffer.asUint8Array())
console.log(`Wrote ${OUT} (${pdf.countPages()} pages, ${sectionMeta.length} outline items, ${tocLinks.length + 1} links)`)

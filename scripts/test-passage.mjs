// Where a quoted passage IS in a PDF: the rule a source chip in the assistant
// and «Les sammen» both use (resolveQuote in ai.ts, and locatePassage, which
// walks it over the whole document for a tool outside the app), on the text real pdf.js
// reads out of a hand-built report — the things a report has and a clean
// paragraph has not: a running header and a page number on every page, a word
// hyphenated at a line's end, a footnote marker inside a sentence, two
// columns, a sentence over a page break, the same sentence twice, a table,
// typeset marks quoted as plain ones.
//
// What is under test is that a passage is found on the page it is on, and —
// as much — that words which are NOT in the document are never reported as
// found whole: a tool citing them is told so (2026-11-26: an outside tool's
// citation landed on another page than its words; that one was the caller's
// own look-up in a Word file, and this is the same question asked of ours).
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const dir = mkdtempSync(join(tmpdir(), 'passage-'))
const src = (name) => fileURLToPath(new URL(`../src/renderer/src/${name}`, import.meta.url)).replaceAll('\\', '/')
const entry = join(dir, 'entry.ts')
writeFileSync(
  entry,
  `export { locatePassage } from '${src('ai.ts')}'\nexport { buildPageTexts } from '${src('search.ts')}'\n`
)
const out = join(dir, 'entry.mjs')
await build({
  entryPoints: [entry],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  external: ['pdfjs-dist', 'pdfjs-dist/*'],
  loader: { '.png': 'empty', '.svg': 'empty', '.css': 'empty' },
  logLevel: 'error'
})
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.navigator ??= { language: 'nb', languages: ['nb'] }
const { locatePassage, buildPageTexts } = await import(pathToFileURL(out).href)

// ---------- The report ----------

/** WinAnsi, as an escaped PDF string: æøå and the typeset marks included */
const WIN = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85 }
const pdfString = (s) =>
  [...s]
    .map((c) => {
      const code = WIN[c] ?? c.charCodeAt(0)
      if (code > 0xff) throw new Error(`not in WinAnsi: ${c}`)
      if (c === '(' || c === ')' || c === '\\') return `\\${c}`
      return code < 0x80 ? c : `\\${code.toString(8).padStart(3, '0')}`
    })
    .join('')

const W = 595
const H = 842
const FILL = [
  'Etaten betaler ytelsen hver måned, og hver utbetaling avstemmes mot registeret',
  'ved utgangen av kvartalet. Avvik følges opp av en egen enhet, som rapporterer',
  'til direktoratet to ganger i året.'
]

/** Lines set under each other from `y` (measured from the top), 15 pt apart */
const block = (x, y, lines, size = 11, step = 15) => lines.map((s, i) => [x, y + i * step, size, s])

const pagesOf = [
  // 1: plain, a hyphenated word, a footnote marker inside a sentence
  [
    [72, 90, 15, '1 Bakgrunn'],
    ...block(72, 120, [
      'Sverige bruker innloggingsdata til å anslå uoppgitt samboerskap i bidragsforskudd.',
      ...FILL,
      'IP-data brukes til å identi-',
      'fisere foreldre som systematisk og over tid logger inn fra',
      'samme lokasjon, og funnene sendes til saksbehandler.'
    ]),
    [72, 260, 11, 'Kontrollen dekker alle mottakere'],
    [229, 256, 7, '12'],
    [239, 260, 11, 'av ytelsen i året 2023.'],
    [72, 290, 11, 'Hver mottaker fikk utbetalt 12 500 kroner i snitt.'],
    [72, 760, 8, '12 Se vedlegg B for utvalget.']
  ],
  // 2: two columns
  [
    [72, 90, 15, '2 To spalter'],
    ...block(72, 120, [...FILL.map((s) => s.slice(0, 40)), 'Venstre spalte slutter med at andelen', 'feil var'], 10, 14),
    ...block(310, 120, ['fire prosent i den siste målingen.', 'Høyre spalte sier at Danmark kobler', 'registre hver natt.'], 10, 14)
  ],
  // 3 and 4: a sentence over the page break
  [
    [72, 90, 15, '3 Over sideskiftet'],
    ...block(72, 120, FILL),
    [72, 740, 11, 'Finland anslo i 2022 at feilutbetalingene i bostøtten utgjorde']
  ],
  [
    [72, 90, 11, 'omtrent 1,9 prosent av utbetalt beløp, målt i et utvalg på 4 000 saker.'],
    ...block(72, 120, FILL)
  ],
  // 5: the first page's sentence again
  [
    [72, 90, 15, '4 Oppsummering'],
    ...block(72, 120, [...FILL, 'Sverige bruker innloggingsdata til å anslå uoppgitt samboerskap i bidragsforskudd.'])
  ],
  // 6: a table, typeset marks
  [
    [72, 90, 15, '5 Tabell'],
    ...[
      ['Land', 'Andel feil', 'År'],
      ['Sverige', '4,1 %', '2023'],
      ['Danmark', '2,7 %', '2022'],
      ['Finland', '1,9 %', '2022']
    ].flatMap((row, r) => row.map((cell, c) => [[72, 220, 360][c], 130 + r * 18, 11, cell])),
    ...block(72, 240, [
      'Etaten kaller dette «et forsiktig anslag» – og viser til at mørketallene er',
      'store. Tallet gjelder 2019–2023, ifølge direktøren, som kaller det “et gulv”.'
    ])
  ]
]

function reportPdf() {
  const fonts = 2 + pagesOf.length * 2
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`]
  const kids = pagesOf.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pagesOf.length} >>`)
  pagesOf.forEach((lines, i) => {
    const all = [[72, 40, 9, 'Delrapport 1 – utkast til oppdragsgiver'], [290, 810, 9, `Side ${i + 1}`], ...lines]
    const content = all
      .map(([x, y, size, s]) => `BT /F1 ${size} Tf ${x} ${H - y} Td (${pdfString(s)}) Tj ET`)
      .join('\n')
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fonts + 1} 0 R >> >> >>`
    )
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>')
  let body = '%PDF-1.7\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body + tail, 'latin1'))
}

// pdf.js in Node reads the fonts with fs: a plain path, trailing slash
const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/')
const pdf = await pdfjs.getDocument({ data: reportPdf(), standardFontDataUrl: fonts, verbosity: 0 }).promise
const pages = await buildPageTexts(pdf)

let failures = 0
let checks = 0
/** `page` 0 = not in the document at all; `whole` false = only an anchor of
 *  it may be marked, and the tool is told the quote was not found whole */
function expect(why, quote, cited, page, whole = true, holds = null) {
  checks++
  const hit = locatePassage(pages, cited, quote)
  const at = hit?.target.pageNumber ?? 0
  const marked = hit ? pages[at - 1].text.slice(hit.target.start, hit.target.end) : ''
  const ok = at === page && (at === 0 || hit.whole === whole) && (holds === null || marked.includes(holds))
  if (ok) return
  failures++
  console.error(`FAIL  ${why}`)
  console.error(`      quote:  ${quote}`)
  console.error(`      page ${at} (want ${page}), whole ${hit?.whole} (want ${whole})`)
  if (hit) console.error(`      marked: ${JSON.stringify(marked)}`)
}

if (pages.length !== 6 || !pages[0].text.includes('innloggingsdata')) {
  failures++
  console.error('FAIL  the report did not come out as six pages of text')
}

const SWEDEN = 'Sverige bruker innloggingsdata til å anslå uoppgitt samboerskap i bidragsforskudd.'
const IP = 'IP-data brukes til å identifisere foreldre som systematisk og over tid logger inn fra samme lokasjon'

// Found, on the page it is on
expect('a plain sentence', SWEDEN, 1, 1, true, 'innloggingsdata')
expect('a word hyphenated at the line’s end', IP, 1, 1, true, 'identi-')
expect('cited four pages off', IP, 5, 1)
expect('cited past the last page', IP, 40, 1)
expect('a footnote marker inside the sentence', 'Kontrollen dekker alle mottakere av ytelsen i året 2023.', 1, 1, true, 'mottakere')
expect('in the right column', 'Høyre spalte sier at Danmark kobler registre hver natt.', 2, 2)
expect(
  'from the foot of one column to the top of the next',
  'Venstre spalte slutter med at andelen feil var fire prosent i den siste målingen.',
  2,
  2
)
expect('the half of a sentence on the next page, cited one page off', 'omtrent 1,9 prosent av utbetalt beløp, målt i et utvalg på 4 000 saker.', 3, 4)
expect('twice in the document: the cited page wins', SWEDEN, 5, 5)
expect('twice in the document, cited on the first', SWEDEN, 1, 1)
expect('twice in the document, cited where it is not: the first', SWEDEN, 3, 1)
expect('a table row', 'Danmark 2,7 % 2022', 6, 6)
expect('plain marks for typeset ones', 'Etaten kaller dette "et forsiktig anslag" - og viser til at mørketallene er store.', 6, 6)
expect('a plain hyphen for a dash', 'Tallet gjelder 2019-2023, ifølge direktøren', 6, 6)
expect('plain quotation marks for curly ones', 'som kaller det "et gulv".', 6, 6)
expect('other letter case', SWEDEN.toUpperCase(), 1, 1)

// Found only in part: an anchor is marked, and the tool is told so
expect(
  'a sentence over the page break',
  'Finland anslo i 2022 at feilutbetalingene i bostøtten utgjorde omtrent 1,9 prosent av utbetalt beløp, målt i et utvalg på 4 000 saker.',
  3,
  3,
  false
)
expect(
  'shortened with an ellipsis',
  'Etaten kaller dette «et forsiktig anslag» … Tallet gjelder 2019–2023, ifølge direktøren',
  6,
  6,
  false
)
expect(
  'a real opening with an invented ending',
  'Sverige bruker innloggingsdata til å anslå uoppgitt samboerskap i barnebidrag og andre ytelser som krever at mottakeren bor alene.',
  1,
  1,
  false
)

// The LAST word wrong, «2024» for the page's «2023»: the anchor is the quote
// less that word, and it was once reported as found word for word
expect('only the last word wrong', 'Kontrollen dekker alle mottakere av ytelsen i året 2024.', 1, 1, false)

// NOT in the document: never found whole
expect('a figure that is not there', 'Danmark 3,7 % 2022', 6, 0)
expect('one word changed in a short phrase', 'i året 2024.', 1, 0)
expect('a footnote marker is not a figure: 500 is not 12 500', 'Hver mottaker fikk utbetalt 500 kroner i snitt.', 1, 0)
expect('words of two pages put together', 'Høyre spalte sier at Finland anslo i 2022', 2, 0)
{
  // One word changed in a long sentence: an anchor of the rest may be marked,
  // but the quote is never reported as found whole
  checks++
  const hit = locatePassage(pages, 1, SWEDEN.replace('Sverige', 'Norge'))
  if (hit?.whole) {
    failures++
    console.error('FAIL  one word changed in a long sentence was reported as found whole')
  }
}

if (failures) {
  console.error(`\n${failures} of ${checks} failed`)
  process.exit(1)
}
console.log(`passage: ${checks} checks passed`)

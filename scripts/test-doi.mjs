// Proof for src/shared/doi.ts — the DOI reserve behind the save menu's
// reference section for a document outside Zotero. Everything here runs
// without a network: the matching/URL/CSL logic is pure, and the three-request
// client takes its fetch injected, so the whole flow (DOI in text → doi.org →
// in-text citation + reference + BibTeX, error mapping, the success-only
// cache) is asserted against a scripted doi.org.
// Run: node scripts/test-doi.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/doi.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'doi-'))
const out = join(dir, 'doi.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const D = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// --- Finding a DOI in text -------------------------------------------------------
// The footer forms a paper prints, with the decorations print adds around them.
eq(D.findDoi('TechTrends 51(3) · https://doi.org/10.1007/s11528-007-0040-x'), '10.1007/s11528-007-0040-x', 'URL form')
eq(D.findDoi('doi:10.1007/s11528-007-0040-x.'), '10.1007/s11528-007-0040-x', 'doi: prefix, trailing full stop')
eq(D.findDoi('(DOI 10.1257/aer.20161500).'), '10.1257/aer.20161500', 'inside parentheses')
eq(D.findDoi('see 10.1000/abc(12).'), '10.1000/abc(12)', 'balanced parentheses are part of the suffix')
eq(D.findDoi('DOI: 10.1093/qje/qjab001;'), '10.1093/qje/qjab001', 'trailing semicolon')
eq(D.findDoi('https://doi.org/10.48550/arXiv.1706.03762'), '10.48550/arXiv.1706.03762', 'arXiv DOI keeps its case')
eq(D.findDoi('Version 10.2 of the software; see section 10.3/4'), null, 'version numbers are not DOIs (registrant code too short)')
eq(D.findDoi('no identifier here'), null, 'nothing')
// A pdf.js text layer joins items without a separator; the DOI must survive
// being glued to the word before it and cut by a line end after it.
eq(D.findDoi('Received 2007.Published online:10.1007/s11528-007-0040-x\nKeywords'), '10.1007/s11528-007-0040-x', 'glued to the previous word, stopped by the newline')

// The first match wins across texts and inside one: a paper's own DOI is
// printed before the ones it cites.
eq(
  D.doiFromTexts(['', 'Own: 10.1111/own.1 … cites 10.2222/other.2']),
  '10.1111/own.1',
  'first DOI in the first text that has one'
)
eq(D.doiFromTexts(['10.1111/meta.1', 'page text 10.2222/page.2']), '10.1111/meta.1', 'metadata text ranks before page text')
eq(D.doiFromTexts([]), null, 'no texts')

// --- Strict form and the URL ----------------------------------------------------
eq(D.isDoi('10.1007/s11528-007-0040-x'), true, 'a DOI')
eq(D.isDoi('10.1007/with space'), false, 'whitespace inside')
eq(D.isDoi('11.1007/x'), false, 'wrong prefix')
eq(D.isDoi('10.100/x'), false, 'registrant code too short')
eq(D.doiUrl('10.1007/s11528-007-0040-x'), 'https://doi.org/10.1007/s11528-007-0040-x', 'plain URL')
eq(D.doiUrl('10.1000/a#b?c%d'), 'https://doi.org/10.1000/a%23b%3Fc%25d', 'reserved characters in the suffix are encoded')
eq(D.doiUrl('https://evil.example/10.1000/x'), null, 'not a DOI → no URL at all')

// --- CSL JSON → fields → APA in-text -------------------------------------------
const csl = {
  title: 'It’s Time to Consider Open Source Software',
  author: [{ family: 'Pfaffman', given: 'Jay' }],
  issued: { 'date-parts': [[2007, 5]] },
  'container-title': 'TechTrends'
}
eq(D.parseCslJson(csl), { title: 'It’s Time to Consider Open Source Software', creators: ['Pfaffman'], year: '2007' }, 'Crossref item')
eq(D.apaInText(D.parseCslJson(csl)), '(Pfaffman, 2007)', 'one author')
eq(
  D.apaInText({ title: 'T', creators: ['Vaswani', 'Shazeer'], year: '2017' }),
  '(Vaswani & Shazeer, 2017)',
  'two authors'
)
eq(
  D.apaInText({ title: 'T', creators: ['Vaswani', 'Shazeer', 'Parmar'], year: '2017' }),
  '(Vaswani et al., 2017)',
  'three or more'
)
eq(D.apaInText({ title: 'A Report', creators: [], year: '' }), '(A Report, n.d.)', 'no author, no date')
eq(D.apaInText({ title: '', creators: [], year: '2020' }), '', 'nothing to cite by')
eq(
  D.parseCslJson({ title: ['Array title'], author: [{ literal: 'World Bank' }], created: { 'date-parts': [[2019]] } }),
  { title: 'Array title', creators: ['World Bank'], year: '2019' },
  'array title, corporate author, year from created'
)
eq(D.parseCslJson({ issued: { raw: 'May 2001' } }).year, '2001', 'year out of issued.raw')
eq(D.parseCslJson(null), { title: '', creators: [], year: '' }, 'garbage degrades to empty fields')

// --- The client against a scripted doi.org -------------------------------------
const calls = []
function scripted(map) {
  return async (url, accept) => {
    calls.push({ url, accept })
    const key = accept.split(';')[0]
    const hit = map[key]
    if (hit === undefined) return { status: 404, text: '' }
    if (hit === null) return { status: null, text: '' }
    return { status: 200, text: hit }
  }
}
const ok = {
  [D.ACCEPT_CSL_JSON]: JSON.stringify(csl),
  'text/x-bibliography': 'Pfaffman, J. (2007). It’s Time to Consider Open Source Software. TechTrends, 51(3), 38–43.\n',
  [D.ACCEPT_BIBTEX]: ' @article{Pfaffman_2007, title={It’s Time}, year={2007}, author={Pfaffman, Jay} }\n'
}
{
  const client = D.createDoiClient(scripted(ok))
  const info = await client.cite('10.1007/s11528-007-0040-x')
  eq(info, {
    doi: '10.1007/s11528-007-0040-x',
    title: 'It’s Time to Consider Open Source Software',
    creators: ['Pfaffman'],
    year: '2007',
    citation: '(Pfaffman, 2007)',
    bib: 'Pfaffman, J. (2007). It’s Time to Consider Open Source Software. TechTrends, 51(3), 38–43.',
    bibtex: '@article{Pfaffman_2007, title={It’s Time}, year={2007}, author={Pfaffman, Jay} }'
  }, 'the three answers assembled')
  eq(calls.length, 3, 'three requests, one per format')
  eq(new Set(calls.map((c) => c.url)).size, 1, 'all to the same doi.org URL')
  eq(calls[0].url, 'https://doi.org/10.1007/s11528-007-0040-x', 'the doi.org URL')
  eq(calls.map((c) => c.accept).sort(), [D.ACCEPT_BIBTEX, D.ACCEPT_CSL_JSON, D.ACCEPT_BIBLIOGRAPHY].sort(), 'the three Accept headers')
  eq(D.ACCEPT_BIBLIOGRAPHY, 'text/x-bibliography; style=apa', 'style is APA, like the Zotero section')
  // Cached: a second ask makes no request
  calls.length = 0
  await client.cite('10.1007/s11528-007-0040-x')
  eq(calls.length, 0, 'success cached for the session')
}
{
  // The reference and BibTeX are optional; CSL JSON is not
  const client = D.createDoiClient(scripted({ [D.ACCEPT_CSL_JSON]: JSON.stringify(csl) }))
  const info = await client.cite('10.1007/s11528-007-0040-x')
  eq([info.citation, info.bib, info.bibtex], ['(Pfaffman, 2007)', '', ''], 'formats missing → rows disabled, lookup still succeeds')
}
{
  calls.length = 0
  const client = D.createDoiClient(scripted({}))
  const err = await client.cite('10.9999/unknown')
  eq(err.code, 'doi-unknown', '404 → unknown DOI')
  await client.cite('10.9999/unknown')
  eq(calls.length, 6, 'failure not cached: asked again')
}
{
  const client = D.createDoiClient(scripted({ [D.ACCEPT_CSL_JSON]: null }))
  const err = await client.cite('10.1007/s11528-007-0040-x')
  eq(err.code, 'doi-offline', 'no answer → offline')
}
{
  const client = D.createDoiClient(scripted({ [D.ACCEPT_CSL_JSON]: 'not json' }))
  const err = await client.cite('10.1007/s11528-007-0040-x')
  eq(err.code, 'doi-unknown', 'unparsable CSL JSON → unknown, never a throw')
}
{
  calls.length = 0
  const client = D.createDoiClient(scripted(ok))
  const err = await client.cite('https://evil.example/x')
  eq(err.code, 'doi-unknown', 'not a DOI → refused')
  eq(calls.length, 0, '… without a single request')
}
eq(D.doiCodeForStatus(null), 'doi-offline', 'code for no answer')
eq(D.doiCodeForStatus(500), 'doi-unknown', 'code for a server error')

if (failures > 0) {
  console.error(`\ntest:doi — ${failures} failure(s)`)
  process.exit(1)
}
console.log('test:doi — all assertions passed')

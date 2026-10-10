// Proof for src/shared/abstract.ts — the abstract behind a citation (the link
// preview's «Sammendrag», issue #31). Runs without a network: the parsing and
// matching are pure, and the client takes its fetch (and clock) injected, so
// the whole chain — the entry's own DOI/arXiv id, else Crossref's matcher
// believed only through the title/year check, then Europe PMC / Crossref /
// OpenAlex by DOI with the arXiv API as the fallback, its three-second queue,
// the error codes and what is and is not cached — is asserted against
// scripted sources.
// Run: node scripts/test-abstract.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/abstract.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'abstract-'))
const out = join(dir, 'abstract.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: true, logLevel: 'silent' })
const A = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}
const ok = (cond, msg) => eq(!!cond, true, msg)

// --- Joining an entry's lines ------------------------------------------------------
ok(A.joinEntryLines('Fama, E. (2015). J. Fin. Econ.\nhttps://doi.org/10.1016/j.\njfineco.2015.06.010').includes('10.1016/j.jfineco.2015.06.010'), 'a DOI broken after its dot is joined')
ok(A.joinEntryLines('Acta 228:103657. https://doi.\norg/10.1016/j.actpsy.2022.103657').includes('https://doi.org/10.1016/j.actpsy.2022.103657'), 'a URL broken inside the host is joined')
ok(A.joinEntryLines('BMC genomics. https://doi.org/10.1186/1471-\n2164-14-293').includes('10.1186/1471-2164-14-293'), 'a DOI broken after a hyphen keeps it')
eq(A.joinEntryLines('Bump hunting to identify differen-\ntially methylated regions'), 'Bump hunting to identify differentially methylated regions', 'a hyphenated word is rejoined')
eq(A.joinEntryLines('Long short-term memory. Neural computation,\n9(8):1735–1780, 1997.'), 'Long short-term memory. Neural computation, 9(8):1735–1780, 1997.', 'ordinary lines join with a space')

// --- Identifiers in the entry -------------------------------------------------------
eq(A.findArxivId('arXiv preprint arXiv:1607.06450, 2016.'), '1607.06450', 'arXiv:NNNN.NNNNN')
eq(A.findArxivId('CoRR, abs/1409.0473, 2014.'), '1409.0473', 'CoRR abs/ form')
eq(A.findArxivId('https://arxiv.org/abs/2103.01280v2'), '2103.01280', 'abs URL, version dropped')
eq(A.findArxivId('potential local projections. arXiv: 2103.01280.'), '2103.01280', 'arXiv: with a space')
eq(A.findArxivId('https://doi.org/10.48550/arXiv.1706.03762'), '1706.03762', 'the 10.48550 DOI')
eq(A.findArxivId('arXiv:hep-th/9901001'), 'hep-th/9901001', 'old scheme')
eq(A.findArxivId('Econometrica 56, 931–954.'), null, 'none')
eq(A.yearsIn('Neural computation, 9(8):1735–1780, 1997. doi:10.1162/neco.1997.9.8.1735'), [1997], 'years, not DOI fragments or pages')

// --- Does a selection read like a reference? (the selection menu's «Sammendrag») ----
ok(A.looksLikeReference('[13] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 9(8):1735–1780, 1997.'), 'a numbered reference entry')
ok(A.looksLikeReference('Robinson, P. M. (1988). Root-N-consistent semiparametric regression. Econometrica 56, 931–954.'), 'an author–year entry')
ok(A.looksLikeReference('Gai W, Ji L, et al. Liver-and colon-specific DNA methylation markers. Clin Chem. 2018; 64(8):1239–1249.'), 'a Vancouver entry')
ok(A.looksLikeReference('see https://doi.org/10.1093/ije/dyr238 for the details'), 'a printed DOI is enough')
ok(A.looksLikeReference('Kuchaiev and Ginsburg. Factorization tricks. arXiv:1703.10722'), 'an arXiv id is enough')
ok(!A.looksLikeReference('In 2019 the economy grew faster than the central bank had expected.'), 'prose with a year is not a reference')
ok(!A.looksLikeReference('Long short-term memory'), 'a title alone is too short to offer')
ok(!A.looksLikeReference('The model architecture is described in detail in the following section of this paper.'), 'prose without a year')

// --- Is the hit the cited work? ------------------------------------------------------
const LSTM = 'Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 9(8):1735–1780, 1997.'
ok(A.acceptMatch(LSTM, 'Long Short-Term Memory', 1997), 'whole title in the entry, same year')
ok(!A.acceptMatch(LSTM, 'Commentary on «Long short-term memory»', 1997), 'a commentary on the cited work is not the work')
ok(!A.acceptMatch(LSTM, 'Long Short-Term Memory', 2009), 'the right title twelve years later is a different work')
ok(A.acceptMatch('Smith, J. (2015). A theory of everything in particular. NBER Working Paper 21000.', 'A Theory of Everything in Particular', 2019), 'a working paper cited four years before its journal version')
ok(!A.acceptMatch('Smith, J. (2010). A theory of everything in particular. Mimeo.', 'A Theory of Everything in Particular', 2018), 'eight years apart is too far')
ok(A.acceptMatch('Belloni, A., Chernozhukov, V. (2017), “Program evaluation and causal inference with high-dimensional data,” Econometrica', 'Program Evaluation and Causal Inference With High‐Dimensional Data', 2017), 'case, quotes and hyphen variants do not matter')
ok(!A.acceptMatch(LSTM, 'Memory', 1997), 'a one-word title proves nothing')
ok(!A.acceptMatch('Jones, K. (2001). Learning to forget in recurrent networks. Machine Learning.', 'Learning to forget: continual prediction with LSTM', 2001), 'shared words are not the same title')

// --- Reading the sources ---------------------------------------------------------------
eq(A.plainAbstract('<jats:title>Abstract</jats:title><jats:p>We study &amp; test.</jats:p><jats:p>Second.</jats:p>'), 'We study & test.\n\nSecond.', 'JATS → paragraphs, the «Abstract» heading dropped')
eq(A.plainAbstract('<h4>Background</h4>Text here.'), 'Background\n\nText here.', 'Europe PMC section headings stay as their own paragraph')
eq(A.plainAbstract('Abstract We propose.'), 'We propose.', 'an inline «Abstract» label is dropped')
ok(A.plainAbstract('x '.repeat(5000)).length <= 6002, 'capped')
eq(A.invertedIndexText({ Hello: [0], world: [1], again: [3], big: [2] }), 'Hello world big again', 'OpenAlex inverted index')
eq(A.invertedIndexText(null), '', 'no index')
const atom = '<feed><entry><id>http://arxiv.org/abs/1703.10722v3</id><published>2017-03-31T00:00:00Z</published><title>Factorization tricks\n for LSTM networks</title><summary>  We present two simple ways &amp; more.\n</summary></entry></feed>'
eq(A.parseArxivAtom(atom), { title: 'Factorization tricks for LSTM networks', year: '2017', venue: 'arXiv', abstract: 'We present two simple ways & more.' }, 'arXiv Atom entry')
eq(A.parseArxivAtom('<feed><entry><title>Error</title><summary>incorrect id format</summary></entry></feed>'), null, 'arXiv error entry')
eq(A.parseArxivAtom('<feed></feed>'), null, 'empty feed')

// --- The client against scripted sources ------------------------------------------------
const HOSTS = ['https://api.crossref.org/', 'https://www.ebi.ac.uk/', 'https://api.openalex.org/', 'https://export.arxiv.org/']
function scripted(routes) {
  const calls = []
  const fetchUrl = async (url) => {
    calls.push(url)
    if (!HOSTS.some((h) => url.startsWith(h))) throw new Error(`request outside the four sources: ${url}`)
    for (const [test, res] of routes) if (test(url)) return typeof res === 'function' ? res(url) : res
    return { status: 404, text: '' }
  }
  return { fetchUrl, calls }
}
const json = (v) => ({ status: 200, text: JSON.stringify(v) })
const isSearch = (u) => u.startsWith('https://api.crossref.org/works?')
const isCrWork = (u) => u.startsWith('https://api.crossref.org/works/')
const isEpmc = (u) => u.startsWith('https://www.ebi.ac.uk/')
const isOa = (u) => u.startsWith('https://api.openalex.org/')
const isArxiv = (u) => u.startsWith('https://export.arxiv.org/')
const clock = () => {
  let t = 1_000_000
  const slept = []
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms }, slept, tick: (ms) => (t += ms) }
}

{
  // A DOI in the entry: no search; Europe PMC's abstract wins, Crossref's title
  const { fetchUrl, calls } = scripted([
    [isEpmc, json({ resultList: { result: [{ title: 'LSTM.', pubYear: '1997', abstractText: '<h4>Abstract</h4>EPMC text.' }] } })],
    [isCrWork, json({ message: { title: ['Long Short-Term Memory'], issued: { 'date-parts': [[1997, 11]] }, 'container-title': ['Neural Computation'], abstract: '<jats:p>Crossref text.</jats:p>' } })],
    [isOa, json({ title: 'LSTM', publication_year: 1997, abstract_inverted_index: { OA: [0] } })]
  ])
  const c = A.createAbstractClient(fetchUrl)
  const r = await c.lookup(`${LSTM} doi:10.1162/neco.1997.9.8.1735`)
  eq([r.source, r.via, r.title, r.year, r.venue, r.abstract], ['europepmc', 'doi', 'Long Short-Term Memory', '1997', 'Neural Computation', 'EPMC text.'], 'DOI in the entry → Europe PMC abstract, Crossref metadata')
  ok(!calls.some(isSearch), 'no search when the entry prints its DOI')
  ok(!calls.some(isArxiv), 'no arXiv request without an arXiv id')
}
{
  // No identifier: the matcher's FIRST hit is a commentary and must be passed over
  const { fetchUrl, calls } = scripted([
    [isSearch, json({ message: { items: [
      { DOI: '10.1000/comment', title: ['Commentary on long short-term memory'], issued: { 'date-parts': [[1999]] }, score: 120 },
      { DOI: '10.1162/neco.1997.9.8.1735', title: ['Long Short-Term Memory'], issued: { 'date-parts': [[1997]] }, score: 96 }
    ] } })],
    [isEpmc, json({ resultList: { result: [] } })],
    [isCrWork, json({ message: { title: ['Long Short-Term Memory'], issued: { 'date-parts': [[1997]] }, abstract: '<jats:p>Learning to store information.</jats:p>' } })],
    [isOa, { status: 404, text: '' }]
  ])
  const c = A.createAbstractClient(fetchUrl)
  const r = await c.lookup(LSTM)
  eq([r.doi, r.source, r.via, r.abstract], ['10.1162/neco.1997.9.8.1735', 'crossref', 'match', 'Learning to store information.'], 'the matcher skips a commentary and takes the verified hit')
  ok(calls.filter(isSearch).length === 1 && decodeURIComponent(calls.find(isSearch)).includes('Long short-term memory'), 'the search carries the entry text')
}
{
  // Nothing verifiable → unidentified, and that verdict is cached
  const { fetchUrl, calls } = scripted([
    [isSearch, json({ message: { items: [{ DOI: '10.1000/other', title: ['Something else entirely different'], issued: { 'date-parts': [[1997]] }, score: 80 }] } })]
  ])
  const c = A.createAbstractClient(fetchUrl)
  eq((await c.lookup(LSTM)).code, 'abstract-unidentified', 'no hit passes the check → unidentified')
  const n = calls.length
  eq((await c.lookup(LSTM)).code, 'abstract-unidentified', 'asked again')
  eq(calls.length, n, 'unidentified is cached: no second request')
}
{
  // Offline → its own code, never cached
  const { fetchUrl, calls } = scripted([[() => true, { status: null, text: '' }]])
  const c = A.createAbstractClient(fetchUrl)
  eq((await c.lookup(LSTM)).code, 'abstract-offline', 'no answer from Crossref → offline')
  const n = calls.length
  await c.lookup(LSTM)
  ok(calls.length > n, 'offline is not cached: the next click asks again')
  const d = await A.createAbstractClient(scripted([[() => true, { status: null, text: '' }]]).fetchUrl).lookup(`${LSTM} https://doi.org/10.1162/neco.1997.9.8.1735`)
  eq(d.code, 'abstract-offline', 'a DOI entry with every source silent → offline')
}
{
  // Found, but no source has the abstract → a success with an empty abstract
  const { fetchUrl } = scripted([
    [isEpmc, json({ resultList: { result: [] } })],
    [isCrWork, json({ message: { title: ['A Book of Things'], issued: { 'date-parts': [[2001]] }, 'container-title': [] } })],
    [isOa, json({ title: 'A Book of Things', publication_year: 2001, abstract_inverted_index: null })]
  ])
  const r = await A.createAbstractClient(fetchUrl).lookup('Doe, J. (2001). A book of things. Press. doi:10.1000/book.1')
  eq([r.title, r.abstract, r.source, 'code' in r], ['A Book of Things', '', '', false], 'identified without an abstract is not an error')
}
{
  // arXiv id: OpenAlex by the 10.48550 DOI first; the arXiv API is not asked
  const { fetchUrl, calls } = scripted([
    [isOa, json({ title: 'Factorization tricks for LSTM networks', publication_year: 2017, abstract_inverted_index: { We: [0], present: [1] } })]
  ])
  const r = await A.createAbstractClient(fetchUrl).lookup('Kuchaiev and Ginsburg. Factorization tricks for LSTM networks. arXiv preprint arXiv:1703.10722, 2017.')
  eq([r.source, r.arxiv, r.abstract], ['openalex', '1703.10722', 'We present'], 'arXiv paper → OpenAlex by its 10.48550 DOI')
  ok(calls.some((u) => isOa(u) && u.includes('10.48550/arXiv.1703.10722')), 'OpenAlex asked by the arXiv DOI')
  ok(!calls.some(isArxiv), 'the arXiv API is not asked when OpenAlex has the abstract')
}
{
  // …and the arXiv API when OpenAlex has none, queued three seconds apart
  const k = clock()
  const { fetchUrl, calls } = scripted([
    [isOa, json({ title: 'X', publication_year: 2017, abstract_inverted_index: null })],
    [isArxiv, (u) => ({ status: 200, text: `<feed><entry><published>2016-01-01</published><title>T ${u.slice(-20)}</title><summary>Abstract from arXiv.</summary></entry></feed>` })]
  ])
  const c = A.createAbstractClient(fetchUrl, { now: k.now, sleep: k.sleep })
  const [a, b] = await Promise.all([
    c.lookup('Cheng et al. Long short-term memory-networks for machine reading. arXiv:1601.06733, 2016.'),
    c.lookup('Ba et al. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.')
  ])
  eq([a.source, b.source, a.abstract], ['arxiv', 'arxiv', 'Abstract from arXiv.'], 'OpenAlex without an abstract → the arXiv API')
  eq(calls.filter(isArxiv).length, 2, 'one arXiv request per paper')
  eq(k.slept, [A.ARXIV_MIN_INTERVAL_MS], 'the second arXiv request waits three seconds after the first')
}
{
  // Input guards and URL building
  const { fetchUrl, calls } = scripted([])
  const c = A.createAbstractClient(fetchUrl)
  eq((await c.lookup(42)).code, 'abstract-unidentified', 'not a string')
  eq((await c.lookup('x'.repeat(5000))).code, 'abstract-unidentified', 'too long to be an entry')
  eq((await c.lookup('[1] Short')).code, 'abstract-unidentified', 'too short to identify')
  eq(calls.length, 0, 'none of those reach the network')
  await c.lookup('Doe, J. (2020). Odd. doi:10.1000/abc?x=1#frag')
  ok(calls.length > 0 && calls.every((u) => HOSTS.some((h) => u.startsWith(h))), 'every request goes to one of the four sources')
  ok(calls.filter((u) => isCrWork(u) || isOa(u)).every((u) => !u.includes('?x=1') && !u.includes('#frag')), 'a DOI with ? and # cannot reshape the URL')
}

if (failures) {
  console.error(`\n${failures} abstract check(s) failed`)
  process.exit(1)
}
console.log('All abstract checks passed')

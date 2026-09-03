// Proof for src/shared/zotero.ts — the mapping between a PDF's own path and the
// Zotero item it belongs to. Everything here runs without Electron, a network,
// or Zotero: the path/URL/JSON logic is pure, and the two-request client takes
// its fetch injected, so the whole flow (attachment → parent → citation, error
// mapping, the success-only cache) is asserted against a scripted API.
// Run: node scripts/test-zotero.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/zotero.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'zotero-'))
const out = join(dir, 'zotero.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const Z = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  }
}

// --- Path → attachment key ----------------------------------------------------
// The invariant is `…/storage/<8-char KEY>/<file>` with the key as the file's
// immediate parent — not that the data dir is called "Zotero" (it is renameable).
eq(
  Z.zoteroKeyFromPath('C:\\Users\\emil\\Zotero\\storage\\ABCD2345\\paper.pdf'),
  'ABCD2345',
  'Windows storage path'
)
eq(
  Z.zoteroKeyFromPath('/home/emil/Zotero/storage/ABCD2345/paper.pdf'),
  'ABCD2345',
  'POSIX storage path'
)
eq(
  Z.zoteroKeyFromPath('D:\\data\\zot-lib\\storage\\XK9Q2RTM\\a b.pdf'),
  'XK9Q2RTM',
  'renamed data directory still detected'
)
// The extension's document identity is a file:// URL, percent-encoded
eq(
  Z.zoteroKeyFromPath('file:///C:/Users/emil/Zotero/storage/ABCD2345/My%20paper.pdf'),
  'ABCD2345',
  'file:// URL form (percent-decoded)'
)
eq(
  Z.zoteroKeyFromPath('file:///C:/Users/emil/Zotero/storage/ABCD2345/100%.pdf'),
  'ABCD2345',
  'file:// with a malformed escape still matches on the raw form'
)
// Rejections — each is a real non-Zotero shape
eq(Z.zoteroKeyFromPath('C:\\papers\\linked\\paper.pdf'), null, 'linked attachment (no /storage/)')
eq(Z.zoteroKeyFromPath('C:\\x\\storage\\abcd2345\\p.pdf'), null, 'lowercase key rejected')
eq(Z.zoteroKeyFromPath('C:\\x\\storage\\ABCD234\\p.pdf'), null, '7-char key rejected')
eq(Z.zoteroKeyFromPath('C:\\x\\storage\\ABCD23456\\p.pdf'), null, '9-char key rejected')
eq(Z.zoteroKeyFromPath('C:\\x\\mystorage\\ABCD2345\\p.pdf'), null, 'storage not a full segment')
eq(
  Z.zoteroKeyFromPath('C:\\x\\storage\\ABCD2345\\sub\\p.pdf'),
  null,
  'key must be the immediate parent directory'
)
eq(Z.zoteroKeyFromPath('fsa:min rapport.pdf'), null, 'picked file (basename only)')
eq(Z.zoteroKeyFromPath('https://arxiv.org/pdf/2401.12345'), null, 'web PDF')
// Windows is case-insensitive about the segment name, the key is not about its content
eq(Z.zoteroKeyFromPath('C:\\x\\Storage\\ABCD2345\\p.pdf'), 'ABCD2345', 'Storage segment, any case')

// --- zotero:// URL construction ----------------------------------------------
// Main builds this URL itself; anything but a clean key must come back null so
// renderer input can never smuggle an arbitrary target through.
eq(Z.zoteroSelectUrl('ABCD2345'), 'zotero://select/library/items/ABCD2345', 'valid key → URL')
eq(Z.zoteroSelectUrl('../../etc'), null, 'path traversal rejected')
eq(Z.zoteroSelectUrl('ABCD234?'), null, 'query char rejected')
eq(Z.zoteroSelectUrl('abcd2345'), null, 'lowercase rejected')
eq(Z.zoteroSelectUrl('ABCD23456'), null, '9 chars rejected')
eq(Z.zoteroSelectUrl(''), null, 'empty rejected')

// --- Attachment item parsing ---------------------------------------------------
eq(
  Z.parseAttachmentItem({ key: 'ABCD2345', data: { itemType: 'attachment', parentItem: 'QRST6789' } }),
  { parentKey: 'QRST6789' },
  'attachment with parent'
)
eq(
  Z.parseAttachmentItem({ key: 'ABCD2345', data: { itemType: 'attachment' } }),
  { parentKey: null },
  'standalone attachment'
)
eq(Z.parseAttachmentItem(null), { parentKey: null }, 'malformed JSON degrades to standalone')
eq(
  Z.parseAttachmentItem({ data: { parentItem: 'not a key' } }),
  { parentKey: null },
  'invalid parent key rejected'
)

// --- Item parsing (metadata + citation forms) ----------------------------------
const item = (data, citation, bib) => ({ key: 'QRST6789', citation, bib, data })
const parsed = Z.parseZoteroItem(
  item(
    {
      title: 'Attention Is All You Need',
      date: '2017-06-12',
      creators: [
        { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
        { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
        { creatorType: 'author', name: 'The Team' }
      ]
    },
    '<span>(Vaswani et al., 2017)</span>',
    '<div class="csl-bib-body">\n  <div class="csl-entry">Vaswani, A., &amp; Shazeer, N. (2017). <i>Attention</i> &#8212; NIPS.</div>\n</div>'
  )
)
eq(parsed.title, 'Attention Is All You Need', 'title')
eq(parsed.creators, ['Vaswani', 'Shazeer', 'The Team'], 'creators: lastName and single-field name')
eq(parsed.year, '2017', 'year from a full date')
eq(parsed.citation, '(Vaswani et al., 2017)', 'citation: tags stripped')
eq(
  parsed.bib,
  'Vaswani, A., & Shazeer, N. (2017). Attention — NIPS.',
  'bib: tags stripped, &amp; and numeric entity decoded, whitespace collapsed'
)
eq(Z.parseZoteroItem(item({ date: '2026' }, '', '')).year, '2026', 'year from a bare year')
const degenerate = Z.parseZoteroItem(item({}, '', ''))
eq(degenerate.creators, [], 'no creators → empty list')
eq(degenerate.year, '', 'no date → empty year')
eq(Z.parseZoteroItem(undefined).title, '', 'malformed item JSON never throws')
eq(Z.htmlToText('a &amp;lt; b'), 'a &lt; b', '&amp; decodes last (no double-decode)')
eq(Z.htmlToText('x&nbsp;&#160;y'), 'x y', 'nbsp in both spellings collapses to one space')

// --- Status → named code --------------------------------------------------------
eq(Z.zoteroCodeForStatus(null), 'zotero-off', 'no response → zotero-off')
eq(Z.zoteroCodeForStatus(403), 'zotero-api-disabled', '403 → API toggle off')
eq(Z.zoteroCodeForStatus(404), 'zotero-item-unknown', '404 → unknown item')
eq(Z.zoteroCodeForStatus(500), 'zotero-item-unknown', 'odd status lands on the harmless hint')

// --- The client: two requests, success-only cache, key preference ---------------
const PATH = 'C:\\Users\\emil\\Zotero\\storage\\ABCD2345\\paper.pdf'
function scriptedFetch(script) {
  const calls = []
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url)
      for (const [pattern, outcome] of script) {
        if (url.includes(pattern)) return outcome
      }
      return { status: 404, json: null }
    }
  }
}

// Happy path: attachment → parent, both citation forms, then cached
{
  const f = scriptedFetch([
    ['/items/ABCD2345', { status: 200, json: { data: { parentItem: 'QRST6789' } } }],
    [
      '/items/QRST6789?include=data,bib,citation&style=apa',
      {
        status: 200,
        json: item({ title: 'T', date: '2026-05-04', creators: [{ lastName: 'Halseth' }] }, '<span>(Halseth, 2026)</span>', '<div>Halseth (2026). T.</div>')
      }
    ]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  eq(client.selectUrl(PATH), 'zotero://select/library/items/ABCD2345', 'before info(): attachment key')
  const info = await client.info(PATH)
  eq(info.parentKey, 'QRST6789', 'parent key resolved')
  eq(info.citation, '(Halseth, 2026)', 'citation flattened')
  eq(f.calls.length, 2, 'exactly two requests')
  await client.info(PATH)
  eq(f.calls.length, 2, 'success cached — no third request')
  eq(
    client.selectUrl(PATH),
    'zotero://select/library/items/QRST6789',
    'after info(): parent key preferred'
  )
}

// Standalone attachment: second request goes to the attachment's own key
{
  const f = scriptedFetch([
    ['?include=', { status: 200, json: item({ title: 'Standalone' }, '', '') }],
    ['/items/ABCD2345', { status: 200, json: { data: {} } }]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  const info = await client.info(PATH)
  eq(info.parentKey, null, 'standalone: no parent')
  eq(f.calls[1].includes('/items/ABCD2345?include='), true, 'standalone: cites the attachment item')
}

// Failures: named, and never cached (the user may start Zotero and retry)
{
  const f = scriptedFetch([['/items/', { status: null, json: null }]])
  const client = Z.createZoteroClient(f.fetchJson)
  eq((await client.info(PATH)).code, 'zotero-off', 'refused → zotero-off')
  await client.info(PATH)
  eq(f.calls.length, 2, 'failure not cached — retried')
}
{
  const client = Z.createZoteroClient(scriptedFetch([['/items/', { status: 403, json: null }]]).fetchJson)
  eq((await client.info(PATH)).code, 'zotero-api-disabled', '403 → zotero-api-disabled')
}
{
  const client = Z.createZoteroClient(scriptedFetch([]).fetchJson)
  eq((await client.info(PATH)).code, 'zotero-item-unknown', '404 → zotero-item-unknown')
}
// Off a storage path the LIBRARY is asked (linked attachments carry no key):
// one listing, no match → null, and nothing else is fetched
{
  const f = scriptedFetch([['itemType=attachment', { status: 200, json: [] }]])
  const client = Z.createZoteroClient(f.fetchJson)
  eq(await client.info('C:\\papers\\loose.pdf'), null, 'non-storage path, not in the library → null')
  eq(client.selectUrl('C:\\papers\\loose.pdf'), null, 'non-storage path → no select URL')
  eq(f.calls.length, 1, 'exactly one listing request, no item request')
}

// --- Linked attachments: path helpers -------------------------------------------
eq(Z.pathBasename('G:\\Min disk\\Library\\Research Papers\\Foo (2022) - Bar.pdf'), 'Foo (2022) - Bar.pdf', 'basename: Windows path')
eq(Z.pathBasename('attachments:Research Papers/ICA/Foo.pdf'), 'Foo.pdf', 'basename: Zotero attachments: prefix')
eq(Z.pathBasename('file:///G:/Min%20disk/Library/Foo%20Bar.pdf'), 'Foo Bar.pdf', 'basename: file URL, percent-decoded')
eq(Z.pathSegments('attachments:Research Papers/ICA/Foo.pdf').join('|'), 'Research Papers|ICA|Foo.pdf', 'segments drop the prefix')
eq(Z.pathTailMatch('G:\\Lib\\Research Papers\\ICA\\Foo.pdf', 'attachments:Research Papers/ICA/Foo.pdf'), 3, 'tail match: three shared segments')
eq(Z.pathTailMatch('G:\\Lib\\Old\\Foo.pdf', 'attachments:Research Papers/ICA/Foo.pdf'), 1, 'tail match: filename only')
eq(Z.pathTailMatch('G:\\Lib\\ICA\\foo.PDF', 'attachments:ICA/Foo.pdf'), 2, 'tail match is case-insensitive')
eq(Z.pathTailMatch('G:\\Lib\\ICA\\Other.pdf', 'attachments:ICA/Foo.pdf'), 0, 'different filename → 0')
{
  const page = Z.parseAttachmentList([
    { data: { key: 'WE23ALSN', linkMode: 'linked_file', path: 'attachments:A/Foo.pdf', parentItem: '9JV4599V' } },
    { data: { key: 'ABCD2345', linkMode: 'imported_file', path: 'storage:Foo.pdf', parentItem: '9JV4599V' } },
    { data: { key: 'bad', linkMode: 'linked_file', path: 'attachments:B/Bar.pdf' } },
    { data: { key: 'D7GWCMYP', linkMode: 'linked_file', path: 'C:\\abs\\Baz.pdf' } }
  ])
  eq(page.count, 4, 'attachment page: count is the raw page length')
  eq(page.linked.map((a) => a.key).join(','), 'WE23ALSN,D7GWCMYP', 'attachment page: linked files only, bad keys dropped')
  eq(page.linked[1].parentKey, null, 'attachment page: standalone linked file has no parent')
  eq(Z.parseAttachmentList({ nope: true }).count, 0, 'attachment page: non-array → empty')
}

// --- Linked attachments: the client --------------------------------------------
const LINKED = 'G:\\Min disk\\Library\\Research Papers\\ICA Papers\\Foo (2022) - Bar.pdf'
const listing = [
  { data: { key: 'AAAA1111', linkMode: 'linked_file', path: 'attachments:Old/Foo (2022) - Bar.pdf', parentItem: 'PPPP1111' } },
  { data: { key: 'WE23ALSN', linkMode: 'linked_file', path: 'attachments:Research Papers/ICA Papers/Foo (2022) - Bar.pdf', parentItem: '9JV4599V' } },
  { data: { key: 'BBBB2222', linkMode: 'linked_file', path: 'attachments:Other.pdf' } }
]
// Two records share the filename; the one that also shares the folder wins
{
  const f = scriptedFetch([
    ['itemType=attachment', { status: 200, json: listing }],
    ['/items/9JV4599V?include=', { status: 200, json: item({ title: 'Bar', date: '2022', creators: [{ lastName: 'Foo' }] }, '<span>(Foo, 2022)</span>', '<div>Foo (2022). Bar.</div>') }],
    ['/items/BBBB2222?include=', { status: 200, json: item({ title: 'Other' }, '', '') }]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  eq(client.selectUrl(LINKED), null, 'linked file before info(): no select URL yet')
  const info = await client.info(LINKED)
  eq(info.attachmentKey, 'WE23ALSN', 'linked: the record sharing the folder wins over the same filename elsewhere')
  eq(info.parentKey, '9JV4599V', 'linked: parent resolved')
  eq(info.citation, '(Foo, 2022)', 'linked: citation flattened')
  eq(f.calls.length, 2, 'linked: one listing page + one item request')
  await client.info(LINKED)
  eq(f.calls.length, 2, 'linked: success cached — no further requests')
  eq(client.selectUrl(LINKED), 'zotero://select/library/items/9JV4599V', 'linked after info(): parent key')
  // A second linked file reuses the index: one item request, no new listing
  const info2 = await client.info('G:\\Min disk\\Library\\Other.pdf')
  eq(info2.attachmentKey, 'BBBB2222', 'linked: second file found in the cached index')
  eq(info2.parentKey, null, 'linked: standalone attachment cites itself')
  eq(f.calls.length, 3, 'linked: the index is built once per session')
  eq(f.calls[2].includes('/items/BBBB2222?include='), true, 'linked standalone: cites the attachment item')
}
// The extension's file:// form resolves the same record
{
  const f = scriptedFetch([
    ['itemType=attachment', { status: 200, json: listing }],
    ['?include=', { status: 200, json: item({ title: 'Bar' }, '', '') }]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  const info = await client.info('file:///G:/Min%20disk/Library/Research%20Papers/ICA%20Papers/Foo%20(2022)%20-%20Bar.pdf')
  eq(info.attachmentKey, 'WE23ALSN', 'linked: file:// URL resolves the same record')
}
// The listing pages: a full page asks for the next, a short one stops
{
  const full = Array.from({ length: Z.ZOTERO_PAGE }, (_, i) => ({
    data: { key: 'K' + String(i).padStart(7, '0'), linkMode: 'linked_file', path: 'attachments:p' + i + '.pdf' }
  }))
  const f = scriptedFetch([
    ['start=0&', { status: 200, json: full }],
    ['start=100&', { status: 200, json: listing }],
    ['?include=', { status: 200, json: item({ title: 'Bar' }, '', '') }]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  const info = await client.info(LINKED)
  eq(info.attachmentKey, 'WE23ALSN', 'paging: a record on the second page is found')
  eq(f.calls.filter((u) => u.includes('itemType=attachment')).length, 2, 'paging: two listing requests, stopped on the short page')
}
// Zotero off: a linked file cannot be recognised → null (no error UI), and the
// next call asks again — the user may have started Zotero since
{
  const f = scriptedFetch([['itemType=attachment', { status: null, json: null }]])
  const client = Z.createZoteroClient(f.fetchJson)
  eq(await client.info(LINKED), null, 'linked with Zotero off → null, not an error')
  eq(await client.info(LINKED), null, 'linked with Zotero off → still null')
  eq(f.calls.length, 2, 'linked with Zotero off: the listing is retried, never cached')
}
// API disabled (403) reads the same way for a linked file
{
  const client = Z.createZoteroClient(scriptedFetch([['itemType=attachment', { status: 403, json: null }]]).fetchJson)
  eq(await client.info(LINKED), null, 'linked with the API disabled → null')
}
// The record matched but its item cannot be read: it IS Zotero's file, so the
// failure is named like a storage path's
{
  const f = scriptedFetch([
    ['itemType=attachment', { status: 200, json: listing }],
    ['?include=', { status: 404, json: null }]
  ])
  const client = Z.createZoteroClient(f.fetchJson)
  eq((await client.info(LINKED)).code, 'zotero-item-unknown', 'linked: matched record, item 404 → named failure')
}

if (failures === 0) {
  console.log('\nALL ZOTERO MAPPINGS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

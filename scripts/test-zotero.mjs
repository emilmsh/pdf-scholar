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
// Off a storage path nothing fetches and nothing renders
{
  const f = scriptedFetch([])
  const client = Z.createZoteroClient(f.fetchJson)
  eq(await client.info('C:\\papers\\loose.pdf'), null, 'non-storage path → null')
  eq(client.selectUrl('C:\\papers\\loose.pdf'), null, 'non-storage path → no select URL')
  eq(f.calls.length, 0, 'no requests for a non-storage path')
}

if (failures === 0) {
  console.log('\nALL ZOTERO MAPPINGS PASS ✓')
  process.exit(0)
} else {
  console.error(`\n${failures} ASSERTION(S) FAILED ✗`)
  process.exit(1)
}

// A document's identity across a move or a rename (issue #46): the rule in
// src/shared/doc-identity.ts, and the claim it stands on — that the PDF's own
// /ID[0] survives BOTH of our save paths.
//
// What would go wrong silently without these: a fingerprint read from the
// wrong trailer (a linearized file's head, an earlier revision), a literal
// /ID string misread so every such file shares one fingerprint; a COPY
// stealing its original's history while the original is still on disk; a
// record moved away from a path that was only unreadable (offline, no
// permission); a document already used at its new path losing its own
// bookmarks or position to the old ones; and — the one the whole rule rests
// on — an annotation save that rewrites /ID[0], which would make every file
// we touch a stranger to its own past.
// Run: node scripts/test-doc-identity.mjs
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-identity-'))
// Beside this script, not in TMP: the engine keeps its packages external, and
// Node resolves those from where the bundle sits (gitignored, like the others)
const bundle = async (entry, name) => {
  const outfile = path.join(__dirname, `.identity-test-${name}`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  return outfile
}
const I = await import(pathToFileURL(await bundle(path.join(ROOT, 'src/shared/doc-identity.ts'), 'identity.mjs')).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'))

console.log('\n1. reading /ID[0] from the bytes')
{
  const hexId = 'AB12CD34EF56789001234567890ABCDE'
  check('hex form, lower-cased', I.pdfFingerprint(bytes(`%PDF-1.7\n...trailer\n<</Size 3/ID[<${hexId}><FFFF0000FFFF0000>]>>\n%%EOF`)) === hexId.toLowerCase())
  check('whitespace inside the hex string is ignored', I.pdfFingerprint(bytes('trailer <</ID [ <ab12 cd34 ef56> <00> ] >>')) === 'ab12cd34ef56')
  check('a literal string with escapes', I.pdfFingerprint(bytes('trailer <</ID[(\\001\\377ab\\)cd\\n)(x)]>>')) === '01ff6162296364' + '0a')
  check('the LAST trailer wins (an incremental update’s own)',
    I.pdfFingerprint(bytes('trailer <</ID[<11111111aaaaaaaa><00>]>> ... trailer <</ID[<22222222bbbbbbbb><01>]>>')) === '22222222bbbbbbbb')
  check('no /ID → null', I.pdfFingerprint(bytes('%PDF-1.4\ntrailer <</Size 3/Root 1 0 R>>\n%%EOF')) === null)
  check('a too-short /ID is not an identifier', I.pdfFingerprint(bytes('trailer <</ID[<ab><ab>]>>')) === null)
  check('an empty file → null', I.pdfFingerprint(new Uint8Array(0)) === null)
  // A linearized file carries its first-page trailer at the HEAD; a big file
  // whose tail holds no /ID must still find it there
  const big = new Uint8Array(3 * 1024 * 1024).fill(0x20)
  big.set(bytes('%PDF-1.7\n1 0 obj <</Linearized 1>> endobj\ntrailer <</ID[<cafebabe00112233><00>]>>'), 0)
  check('a linearized head trailer is found when the tail has none', I.pdfFingerprint(big) === 'cafebabe00112233')
  const sample = new Uint8Array(fs.readFileSync(path.join(ROOT, 'src/renderer/public/sample.pdf')))
  check('sample.pdf carries no /ID (so the fixture below adds one)', I.pdfFingerprint(sample) === null)
}

console.log('\n2. the stored map is untrusted input')
{
  const m = I.sanitizeFingerprints({ a: 'abcdef0123', b: 'ABCDEF0123', c: 'xyz', d: 7, '': 'abcdef0123', e: 'abc' })
  check('only lower-case hex of a real length survives', JSON.stringify(m) === '{"a":"abcdef0123"}', JSON.stringify(m))
  check('not an object → {}', JSON.stringify(I.sanitizeFingerprints([1])) === '{}' && JSON.stringify(I.sanitizeFingerprints(null)) === '{}')
}

/** In-memory stores, with a set of paths that still exist on «disk» */
function memoryStores(present) {
  const db = { positions: {}, bookmarks: {}, chats: {}, recents: [] }
  const stores = {
    exists: async (p) => present.has(p),
    position: {
      get: async (p) => db.positions[p] ?? null,
      set: async (p, pos) => { if (pos) db.positions[p] = pos; else delete db.positions[p] }
    },
    bookmarks: {
      get: async (p) => db.bookmarks[p] ?? [],
      set: async (p, list) => { if (list.length) db.bookmarks[p] = list; else delete db.bookmarks[p] }
    },
    conversations: {
      get: async (p) => db.chats[p] ?? [],
      set: async (p, _n, list) => { if (list.length) db.chats[p] = list; else delete db.chats[p] }
    },
    recents: {
      takeOut: async (p) => {
        const e = db.recents.find((r) => r.path === p)
        db.recents = db.recents.filter((r) => r.path !== p)
        return { pinned: !!e?.pinnedAt }
      },
      pin: async (p) => { db.recents = db.recents.map((r) => (r.path === p ? { ...r, pinnedAt: 1 } : r)) }
    }
  }
  return { db, stores }
}
const conv = (id, updatedAt) => ({ id, title: id, createdAt: updatedAt, updatedAt, messages: [] })
const FP = 'aaaabbbbccccdddd'

console.log('\n3. the rule: records follow a moved file')
{
  const OLD = 'C:\\inbox\\paper.pdf'
  const NEW = 'C:\\papers\\Vaswani 2017.pdf'
  const { db, stores } = memoryStores(new Set([NEW]))
  db.positions[OLD] = { page: 6, zoom: 1.25 }
  db.bookmarks[OLD] = [{ page: 3, title: 'Method' }]
  db.chats[OLD] = [conv('c1', 100)]
  db.recents = [{ path: OLD, name: 'paper.pdf', lastOpened: 1, pinnedAt: 5 }, { path: NEW, name: 'Vaswani 2017.pdf', lastOpened: 2 }]
  const res = await I.rebindIdentity(NEW, 'Vaswani 2017.pdf', FP, { [OLD]: FP }, stores)
  check('the gone path is named', JSON.stringify(res.from) === JSON.stringify([OLD]))
  check('the position followed', db.positions[NEW]?.page === 6 && !(OLD in db.positions))
  check('the bookmarks followed', db.bookmarks[NEW]?.[0]?.title === 'Method' && !(OLD in db.bookmarks))
  check('the conversations followed', db.chats[NEW]?.[0]?.id === 'c1' && !(OLD in db.chats))
  check('the dead recents entry went, its pin came along', db.recents.length === 1 && db.recents[0].path === NEW && db.recents[0].pinnedAt === 1)
  check('the map holds the new path only', JSON.stringify(res.map) === JSON.stringify({ [NEW]: FP }), JSON.stringify(res.map))
}

console.log('\n4. a COPY does not steal its original’s history')
{
  const ORIG = '/home/e/paper.pdf'
  const COPY = '/home/e/paper (copy).pdf'
  const { db, stores } = memoryStores(new Set([ORIG, COPY]))
  db.positions[ORIG] = { page: 9, zoom: 1 }
  db.chats[ORIG] = [conv('c1', 1)]
  const res = await I.rebindIdentity(COPY, 'paper (copy).pdf', FP, { [ORIG]: FP }, stores)
  check('nothing moved while the original is there', res.from.length === 0 && db.positions[ORIG]?.page === 9 && db.chats[ORIG]?.length === 1)
  check('both paths are recorded', res.map[ORIG] === FP && res.map[COPY] === FP)
  check('no records invented for the copy', !(COPY in db.positions) && !(COPY in db.chats))
}

console.log('\n5. the new path keeps what it already has')
{
  const OLD = 'C:\\a\\x.pdf'
  const NEW = 'C:\\b\\x.pdf'
  const { db, stores } = memoryStores(new Set([NEW]))
  db.positions[OLD] = { page: 2, zoom: 1 }
  db.positions[NEW] = { page: 40, zoom: 1 }
  db.bookmarks[OLD] = [{ page: 2, title: 'old' }]
  db.bookmarks[NEW] = [{ page: 40, title: 'new' }]
  db.chats[OLD] = [conv('shared', 50), conv('old-only', 10)]
  db.chats[NEW] = [conv('shared', 90), conv('new-only', 70)]
  await I.rebindIdentity(NEW, 'x.pdf', FP, { [OLD]: FP }, stores)
  check('its own position stays', db.positions[NEW].page === 40)
  check('its own bookmarks stay', db.bookmarks[NEW][0].title === 'new')
  check('conversations are merged, the newer record wins', db.chats[NEW].map((c) => c.id).join(',') === 'shared,new-only,old-only' && db.chats[NEW][0].updatedAt === 90, db.chats[NEW].map((c) => c.id).join(','))
  check('the old path is cleared in every case', !(OLD in db.positions) && !(OLD in db.bookmarks) && !(OLD in db.chats))
}

console.log('\n6. what never moves')
{
  const { db, stores } = memoryStores(new Set())
  db.positions['p1'] = { page: 3, zoom: 1 }
  const other = await I.rebindIdentity('p2', 'n', 'eeeeffff00001111', { p1: FP }, stores)
  check('another fingerprint moves nothing', other.from.length === 0 && db.positions.p1?.page === 3)
  const self = await I.rebindIdentity('p1', 'n', FP, { p1: FP }, stores)
  check('reopening the same path moves nothing', self.from.length === 0 && db.positions.p1?.page === 3)
  // A path that only READS as present (offline URL, no file access) keeps its records
  const { db: db2, stores: s2 } = memoryStores(new Set(['https://x.org/a.pdf']))
  db2.chats['https://x.org/a.pdf'] = [conv('c', 1)]
  await I.rebindIdentity('file:///C:/a.pdf', 'a.pdf', FP, { 'https://x.org/a.pdf': FP }, s2)
  check('a path that cannot be proven gone keeps its records', db2.chats['https://x.org/a.pdf']?.length === 1)
  // Two old copies, both gone: both lists merge, the first position found wins
  const { db: db3, stores: s3 } = memoryStores(new Set(['N']))
  db3.chats.A = [conv('a', 1)]
  db3.chats.B = [conv('b', 2)]
  db3.positions.A = { page: 1, zoom: 1 }
  db3.positions.B = { page: 2, zoom: 1 }
  const two = await I.rebindIdentity('N', 'n', FP, { B: FP, A: FP }, s3)
  check('several gone paths: all conversations come along', db3.chats.N.map((c) => c.id).join(',') === 'b,a' && two.from.length === 2)
  check('…one position (in path order), the others cleared', db3.positions.N.page === 1 && !('A' in db3.positions) && !('B' in db3.positions))
}

console.log('\n7. /ID[0] survives both of our save paths (the real engine)')
{
  const sample = fs.readFileSync(path.join(ROOT, 'src/renderer/public/sample.pdf'), 'latin1')
  const ID0 = '0123456789abcdef0123456789abcdef'
  // Give sample.pdf a trailer /ID. The xref table sits before the trailer, so
  // growing the trailer dictionary moves no offset anything points at.
  const fixture = sample.replace('<</Size 37/Info 3 0 R/Root 2 0 R>>', `<</Size 37/Info 3 0 R/Root 2 0 R/ID[<${ID0}><${ID0}>]>>`)
  check('the fixture carries the /ID', fixture !== sample && I.pdfFingerprint(bytes(fixture)) === ID0)

  const engineEntry = path.join(ROOT, 'src/main/annotation-engine-embedpdf.ts')
  const fullRewrite = await import(pathToFileURL(await bundle(engineEntry, 'engine-full.mjs')).href)
  const FULL = path.join(TMP, 'full.pdf')
  fs.writeFileSync(FULL, Buffer.from(fixture, 'latin1'))
  const req = { path: FULL, pageIndex: 1, type: 'highlight', quads: [{ x: 70, y: 70, w: 200, h: 16 }], color: [1, 0.84, 0.29], opacity: 0.5, author: 'test' }
  const r1 = await fullRewrite.applyAnnotation(req)
  await fullRewrite.flushAnnotations(FULL)
  const afterFull = new Uint8Array(fs.readFileSync(FULL))
  check('full-rewrite save: the annotation landed', 'ok' in r1, 'error' in r1 ? r1.error : '')
  check('full-rewrite save: the file was rewritten', afterFull.length !== fixture.length)
  check('full-rewrite save: /ID[0] unchanged', I.pdfFingerprint(afterFull) === ID0, String(I.pdfFingerprint(afterFull)))

  // The incremental appender (files over 150 MB), forced onto the small
  // fixture the way test:appender does it — the threshold is read at load
  process.env.PDFX_APPENDER_THRESHOLD = '1024'
  const appender = await import(pathToFileURL(await bundle(engineEntry, 'engine-appender.mjs')).href)
  const INC = path.join(TMP, 'incremental.pdf')
  fs.writeFileSync(INC, Buffer.from(fixture, 'latin1'))
  const r2 = await appender.applyAnnotation({ ...req, path: INC })
  const afterInc = new Uint8Array(fs.readFileSync(INC))
  check('incremental save: the annotation landed', 'ok' in r2, 'error' in r2 ? r2.error : '')
  check('incremental save: bytes were appended, the original kept', afterInc.length > fixture.length && Buffer.from(afterInc.subarray(0, fixture.length)).toString('latin1') === fixture)
  check('incremental save: /ID[0] unchanged in the newest trailer', I.pdfFingerprint(afterInc) === ID0, String(I.pdfFingerprint(afterInc)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

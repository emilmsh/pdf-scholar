// Reading the digital signatures a document already carries, through the
// production engine (readSignatures in annotation-engine-embedpdf.ts).
//
// The fixture is a hand-written PDF with a real /Sig dictionary. That is enough
// and it is the point: we report that signatures EXIST and what they say about
// themselves — we never verify them, which would need a PKCS#7 parser and a
// trust store. So the fixture's /Contents is deliberately not a valid
// signature, and the test asserts we still read the file's own claims (when,
// why, which handler, whether it locks the document) without pretending to
// judge them.
//
// Run: node scripts/test-signatures.mjs   (after esbuild bundling)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSignatures } from './.engine-test-bundle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** A minimal one-page PDF carrying a signature field. Written by hand because
 *  producing a genuinely signed PDF would need a certificate — and this test is
 *  about READING the dictionary, which is all the app ever does. */
function signedFixture({ reason, time, subFilter, docMDP }) {
  const objs = []
  const add = (body) => {
    objs.push(body)
    return objs.length // 1-based object number
  }
  // Contents must be a fixed-width hex string; content is irrelevant to us.
  const contents = '<' + '00'.repeat(64) + '>'
  const mdp = docMDP
    ? ` /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${docMDP} /V /1.2 >> >>]`
    : ''
  const sig = add(
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} ` +
      `/ByteRange [0 0 0 0] /Contents ${contents} ` +
      `/M (${time}) /Reason (${reason})${mdp} >>`
  )
  const widget = add(
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /F 4 ` +
      `/Rect [72 600 300 660] /V ${sig} 0 R /P 4 0 R >>`
  )
  const pages = add('<< /Type /Pages /Kids [4 0 R] /Count 1 >>')
  add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Annots [${widget} 0 R] >>`)
  const acro = `/AcroForm << /Fields [${widget} 0 R] /SigFlags 3 >>`
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R ${acro} >>`)

  let out = '%PDF-1.7\n'
  const offsets = [0]
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const file = path.join(os.tmpdir(), `pdfx-signed-${subFilter}-${docMDP ?? 0}.pdf`)
  fs.writeFileSync(file, Buffer.from(out, 'latin1'))
  return file
}

// -------------------------------------------------- 1. an unsigned document
{
  const file = path.join(os.tmpdir(), 'pdfx-sig-unsigned.pdf')
  fs.copyFileSync(SAMPLE, file)
  const res = await readSignatures(file)
  check('unsigned document reports an empty list', Array.isArray(res) && res.length === 0,
    Array.isArray(res) ? `${res.length} found` : res.error)
}

// ------------------------------------------------ 2. an approval signature
{
  const file = signedFixture({
    reason: 'Godkjent av avdelingsleder',
    time: "D:20260415103000+02'00'",
    subFilter: 'adbe.pkcs7.detached',
    docMDP: 0
  })
  const res = await readSignatures(file)
  const ok = Array.isArray(res) && res.length === 1
  check('signed document reports one signature', ok, Array.isArray(res) ? `${res.length}` : res.error)
  if (ok) {
    const s = res[0]
    check('  reads /Reason', s.reason === 'Godkjent av avdelingsleder', JSON.stringify(s.reason))
    check('  reads /M (signing time)', s.time.startsWith('D:20260415'), JSON.stringify(s.time))
    check('  reads /SubFilter', /adbe\.pkcs7\.detached/.test(s.subFilter), JSON.stringify(s.subFilter))
    check('  an approval signature is NOT flagged as certifying', s.certifying === false,
      String(s.certifying))
  }
}

// --------------------------------------------- 3. a certifying signature
// DocMDP means "no changes after this" — worth telling the user apart from an
// ordinary approval, because annotating such a document breaks the seal.
{
  const file = signedFixture({
    reason: 'Sertifisert',
    time: "D:20260101090000+01'00'",
    subFilter: 'ETSI.CAdES.detached',
    docMDP: 1
  })
  const res = await readSignatures(file)
  const ok = Array.isArray(res) && res.length === 1
  check('certifying document reports one signature', ok, Array.isArray(res) ? `${res.length}` : res.error)
  if (ok) {
    check('  PAdES sub-filter read', /ETSI\.CAdES/.test(res[0].subFilter), JSON.stringify(res[0].subFilter))
    check('  flagged as certifying (DocMDP)', res[0].certifying === true, String(res[0].certifying))
  }
}

console.log(failures === 0 ? '\nAll signature checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

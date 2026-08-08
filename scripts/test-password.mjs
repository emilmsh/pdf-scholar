// Encrypted PDFs, end to end through the PRODUCTION write engine
// (annotation-engine-embedpdf.ts, bundled by esbuild — the same code the app
// runs). mupdf builds the encrypted fixtures and independently verifies the
// result, exactly as test:engine does for the plain path.
//
// The facts this pins down, each of which cost something to learn:
//
//  1. PDFium reports a locked document as FPDF_ERR_PASSWORD (reason.code 4)
//     behind the generic message "FPDF_LoadMemDocument failed". The word
//     "password" NEVER appears. All three write paths used to match /password/i
//     on that message, so the named failure they had a code for could not fire
//     and a locked file surfaced as raw engine prose. `isPasswordError` reads
//     the reason code; this test fails if that regresses.
//  2. saveAsCopy PRESERVES the encryption, with the same user password. That is
//     what makes annotating a locked file safe to offer at all — if it silently
//     decrypted, saving would publish a protected document in the clear.
//  3. The incremental appender (>150 MB) cannot do any of this: it writes object
//     bytes with plain Node and has no cipher. It must refuse with its OWN code,
//     because by then the document is already unlocked and "password protected"
//     would send the user to fix something that is not broken.
//
// Run: node scripts/test-password.mjs   (after esbuild bundling)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import {
  applyAnnotation,
  flushAnnotations,
  forgetPassword,
  rememberPassword
} from './.engine-test-bundle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sample.pdf')
const PASSWORD = 'hemmelig'
const OWNER = 'eier'

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** An encrypted copy of the sample, written with mupdf (the independent side). */
function encryptedFixture(name, opts) {
  const doc = mupdf.PDFDocument.openDocument(fs.readFileSync(SAMPLE), 'application/pdf')
  const file = path.join(os.tmpdir(), `pdfx-pw-${name}.pdf`)
  fs.writeFileSync(file, doc.saveToBuffer(opts).asUint8Array())
  return file
}

const annot = (file) => ({
  path: file,
  pageIndex: 1,
  type: 'highlight',
  quads: [{ x: 70, y: 70, w: 200, h: 16 }],
  color: [1, 0.84, 0.29],
  opacity: 0.5,
  author: 'test'
})

// ---------------------------------------------------------------- 1. ciphers
// All three the sample can be written with. RC4 is here because old documents
// in the wild still use it and PDFium treats it as a different code path.
const CIPHERS = ['aes-256', 'aes-128', 'rc4-128']

for (const cipher of CIPHERS) {
  console.log(`\n--- ${cipher} ---`)
  const file = encryptedFixture(cipher, `encrypt=${cipher},user-password=${PASSWORD},owner-password=${OWNER}`)

  // The fixture really is encrypted (guards against a silent mupdf option change)
  const probe = mupdf.PDFDocument.openDocument(fs.readFileSync(file), 'application/pdf')
  check('fixture needs a password', probe.needsPassword())

  // (a) No password registered -> the NAMED failure, not raw engine prose.
  forgetPassword(file)
  const locked = await applyAnnotation(annot(file))
  check(
    'locked file refused with pdf-password-protected',
    'error' in locked && locked.code === 'pdf-password-protected',
    'error' in locked ? (locked.code ?? locked.error) : 'unexpectedly succeeded'
  )

  // (b) Wrong password -> a DIFFERENT code, so the prompt can say "try again"
  rememberPassword(file, 'feil-passord')
  const wrong = await applyAnnotation(annot(file))
  check(
    'wrong password refused with pdf-password-wrong',
    'error' in wrong && wrong.code === 'pdf-password-wrong',
    'error' in wrong ? (wrong.code ?? wrong.error) : 'unexpectedly succeeded'
  )

  // (c) Correct password -> the write goes through
  rememberPassword(file, PASSWORD)
  const ok = await applyAnnotation(annot(file))
  check('annotation written with the password', 'ok' in ok && ok.id > 0,
    'ok' in ok ? `obj#${ok.id}` : ok.error)
  await flushAnnotations(file)

  // (d) The saved file is STILL encrypted, with the SAME password — verified by
  // mupdf, which has no stake in what PDFium believes it did.
  const saved = fs.readFileSync(file)
  check('saved file still carries /Encrypt', /\/Encrypt/.test(saved.toString('latin1')))
  const after = mupdf.PDFDocument.openDocument(saved, 'application/pdf')
  check('saved file still needs a password', after.needsPassword())
  check('the ORIGINAL password still opens it', after.authenticatePassword(PASSWORD) !== 0)

  // (e) …and the annotation is actually in there. Page 1 of the sample already
  // carries a highlight of its own, so identify OURS by its box: quads
  // {x:70,y:70,w:200,h:16} in top-left space put it at x 70..270.
  after.authenticatePassword(PASSWORD)
  const marks = after.loadPage(1).getAnnotations()
  const rectOf = (a) => (String(a.getObject().get('Rect')).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const ours = marks.filter((a) => {
    const r = rectOf(a)
    return a.getType() === 'Highlight' && r.length === 4 && Math.abs(r[0] - 70) < 1 && Math.abs(r[2] - 270) < 1
  })
  check('our highlight is in the encrypted file', ours.length === 1,
    `${ours.length} match of ${marks.length} annot(s)`)
  forgetPassword(file)
}

// ------------------------------------------------- 2. owner-password-only
// No user password: the document opens freely and must NOT be treated as locked.
console.log('\n--- owner password only (opens freely) ---')
{
  const file = encryptedFixture('owner-only', `encrypt=aes-256,owner-password=${OWNER},permissions=-3844`)
  forgetPassword(file)
  const res = await applyAnnotation(annot(file))
  check('annotates with no password registered', 'ok' in res, 'error' in res ? (res.code ?? res.error) : '')
  await flushAnnotations(file)
  const after = mupdf.PDFDocument.openDocument(fs.readFileSync(file), 'application/pdf')
  check('still encrypted after save', /\/Encrypt/.test(fs.readFileSync(file).toString('latin1')))
  check('still opens without a password', !after.needsPassword())
}

// --------------------------------------------------- 3. the appender's refusal
// Forced onto a small file by the threshold env override, the same way
// test:appender does it — the point is the code path, not the size.
console.log('\n--- incremental appender (>150 MB path) ---')
{
  const file = encryptedFixture('appender', `encrypt=aes-256,user-password=${PASSWORD},owner-password=${OWNER}`)
  const bundle = path.join(__dirname, '.engine-test-bundle.mjs')
  const { execFileSync } = await import('node:child_process')
  // A fresh process: APPENDER_THRESHOLD is read once at module load.
  const script = `
    import { applyAnnotation, rememberPassword } from ${JSON.stringify('file://' + bundle.replace(/\\/g, '/'))}
    rememberPassword(${JSON.stringify(file)}, ${JSON.stringify(PASSWORD)})
    const res = await applyAnnotation(${JSON.stringify(annot(file))})
    console.log(JSON.stringify(res))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PDFX_APPENDER_THRESHOLD: '1' },
    encoding: 'utf8'
  })
  const res = JSON.parse(out.trim().split('\n').pop())
  check(
    'appender refuses with append-encrypted',
    'error' in res && res.code === 'append-encrypted',
    res.code ?? res.error ?? JSON.stringify(res)
  )
}

console.log(failures === 0 ? '\nAll password checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
